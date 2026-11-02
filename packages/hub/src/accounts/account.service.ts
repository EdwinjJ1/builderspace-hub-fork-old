import { z } from "zod";

import type { AuditActor } from "../audit";
import type { Db } from "../db";
import type { ProjectMembership } from "../kan/accounts.gateway";
import type { SiteAccess } from "../site/site.policy";
import type { AccountFacts } from "./account.repo";
import type { HubRole } from "./roles";
import { findOpenGrantByEmail, markGrantRevoked } from "../access/grant.repo";
import { recordAudit, withAudit } from "../audit";
import {
  deleteSessions,
  disableApiKeys,
  getUserById,
  insertPasswordUser,
  listMemberships,
  listUsers,
  renameUser,
  setMembershipRole,
  setPasswordHash,
} from "../kan/accounts.gateway";
import { ensureProjectMember } from "../kan/members.gateway";
import { findProjectByPublicId } from "../kan/projects.gateway";
import { findUserByEmail } from "../kan/users.gateway";
import { hubRoles, projectRoles } from "../schema";
import { normalizeEmail } from "../shared/email";
import { HubError } from "../shared/errors";
import { siteAccessLabels } from "../site/site.policy";
import {
  countOwners,
  findAccount,
  findAccounts,
  ORDINARY_ACCOUNT,
  upsertAccount,
} from "./account.repo";
import { generateTemporaryPassword, hashAccountPassword } from "./password";
import { can, canChangeRole, canManageStatus, roleLabels } from "./roles";

/** Someone acting in the back office: who they are and their role. */
export interface AdminActor extends AuditActor {
  userId: string;
  role: HubRole | null;
}

export interface AccountSummary {
  userId: string;
  name: string | null;
  email: string;
  createdAt: Date;
  role: HubRole | null;
  siteAccess: AccountFacts["siteAccess"];
  mailAccess: AccountFacts["mailAccess"];
  status: AccountFacts["status"];
  projects: ProjectMembership[];
}

export const ACCOUNTS_PAGE_SIZE = 50;

const nameSchema = z.string().trim().min(1).max(64);

function requirePermission(
  actor: AdminActor,
  permission: Parameters<typeof can>[1],
  message = "没有执行这个操作的权限",
): void {
  if (!can(actor.role, permission)) throw new HubError("FORBIDDEN", message);
}

/**
 * The rule for touching someone else's account: account management, plus being
 * an owner when the target holds a back-office role. Without the second part an
 * admin could reset an owner's password and sign in as them.
 */
function requireCanManage(
  actor: AdminActor,
  target: AccountFacts,
  options: { allowSelf: boolean; targetUserId: string },
): void {
  requirePermission(actor, "accounts.manage", "没有管理账号的权限");
  const isSelf = actor.userId === options.targetUserId;
  if (isSelf && !options.allowSelf) {
    throw new HubError(
      "FORBIDDEN",
      "不能对自己的账号做这个操作，请到设置里修改",
    );
  }
  if (!isSelf && target.role !== null && !can(actor.role, "admins.manage")) {
    throw new HubError("FORBIDDEN", "只有所有者能管理后台成员的账号");
  }
}

async function requireUser(db: Db, userId: string) {
  const user = await getUserById(db, userId);
  if (!user) throw new HubError("NOT_FOUND", "找不到这个账号");
  return user;
}

/** Role and status of any user; ordinary and active when nothing is recorded. */
export async function getAccessFacts(
  db: Db,
  userId: string,
): Promise<AccountFacts> {
  return (await findAccount(db, userId)) ?? ORDINARY_ACCOUNT;
}

export async function listAccounts(
  db: Db,
  query: { page: number; search?: string },
): Promise<{ items: AccountSummary[]; total: number; pageSize: number }> {
  const page = Math.max(1, Math.floor(query.page));
  const { users, total } = await listUsers(db, {
    search: query.search,
    limit: ACCOUNTS_PAGE_SIZE,
    offset: (page - 1) * ACCOUNTS_PAGE_SIZE,
  });
  const ids = users.map((user) => user.id);
  const [facts, memberships] = await Promise.all([
    findAccounts(db, ids),
    listMemberships(db, ids),
  ]);

  return {
    items: users.map((user) => ({
      userId: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      ...(facts.get(user.id) ?? ORDINARY_ACCOUNT),
      projects: memberships.get(user.id) ?? [],
    })),
    total,
    pageSize: ACCOUNTS_PAGE_SIZE,
  };
}

export async function getAccount(
  db: Db,
  userId: string,
): Promise<AccountSummary | null> {
  const user = await getUserById(db, userId);
  if (!user) return null;
  const memberships = await listMemberships(db, [userId]);
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    ...(await getAccessFacts(db, userId)),
    projects: memberships.get(userId) ?? [],
  };
}

const createAccountSchema = z.object({
  name: nameSchema,
  email: z.string(),
  hubRole: z.enum(hubRoles).nullable(),
  projects: z
    .array(
      z.object({
        projectPublicId: z.string().min(1),
        role: z.enum(projectRoles),
      }),
    )
    .max(20),
  now: z.date().optional(),
});

export type CreateAccountInput = z.input<typeof createAccountSchema>;

/**
 * Adds an account directly, without a registration link. The initial password
 * is generated here and returned once for the admin to pass on; the member
 * changes it in their settings.
 */
export async function createAccount(
  db: Db,
  actor: AdminActor,
  rawInput: CreateAccountInput,
): Promise<{ userId: string; email: string; temporaryPassword: string }> {
  requirePermission(actor, "accounts.manage", "没有管理账号的权限");

  const parsed = createAccountSchema.safeParse(rawInput);
  if (!parsed.success) throw new HubError("INVALID_INPUT", "请填写称呼和邮箱");
  const input = parsed.data;
  const now = input.now ?? new Date();

  if (input.hubRole !== null) {
    requirePermission(actor, "admins.manage", "只有所有者能创建后台成员");
  }

  const email = normalizeEmail(input.email);
  if (!email) throw new HubError("INVALID_INPUT", "邮箱格式不正确");
  if (await findUserByEmail(db, email)) {
    throw new HubError("CONFLICT", "这个邮箱已经有账号了");
  }

  const projects: {
    workspaceId: number;
    role: (typeof projectRoles)[number];
  }[] = [];
  for (const requested of input.projects) {
    const project = await findProjectByPublicId(db, requested.projectPublicId);
    if (!project) {
      throw new HubError(
        "NOT_FOUND",
        `找不到项目 ${requested.projectPublicId}`,
      );
    }
    projects.push({ workspaceId: project.id, role: requested.role });
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashAccountPassword(temporaryPassword);

  const user = await withAudit(
    db,
    async (tx) => {
      const created = await insertPasswordUser(tx, {
        name: input.name,
        email,
        passwordHash,
        now,
      });
      if (input.hubRole !== null) {
        await upsertAccount(tx, created.id, { role: input.hubRole, now });
      }
      // A pending link for this address can no longer be used; close it.
      const grant = await findOpenGrantByEmail(tx, email);
      if (grant) {
        await markGrantRevoked(tx, grant.id, { userId: actor.userId, at: now });
      }
      return created;
    },
    (created) => ({
      actor,
      action: "account.created",
      entityType: "account",
      entityId: created.id,
      summary: `添加账号 ${email}`,
      detail: { hubRole: input.hubRole, projects: projects.length },
    }),
  );

  // Kan's repositories cannot join the transaction above; this step is
  // idempotent, so re-running it after a failure only adds what is missing.
  for (const project of projects) {
    await ensureProjectMember(db, {
      userId: user.id,
      email,
      workspaceId: project.workspaceId,
      role: project.role,
      addedBy: actor.userId,
    });
  }

  return { userId: user.id, email, temporaryPassword };
}

/** Replaces the password with a new temporary one and signs the account out. */
export async function resetPassword(
  db: Db,
  actor: AdminActor,
  userId: string,
  now: Date = new Date(),
): Promise<{ temporaryPassword: string }> {
  const user = await requireUser(db, userId);
  requireCanManage(actor, await getAccessFacts(db, userId), {
    allowSelf: false,
    targetUserId: userId,
  });

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashAccountPassword(temporaryPassword);

  await withAudit(
    db,
    async (tx) => {
      await setPasswordHash(tx, { userId, passwordHash, now });
      await deleteSessions(tx, userId);
    },
    () => ({
      actor,
      action: "account.password_reset",
      entityType: "account",
      entityId: userId,
      summary: `重置 ${user.email} 的密码`,
    }),
  );

  return { temporaryPassword };
}

export async function renameAccount(
  db: Db,
  actor: AdminActor,
  userId: string,
  rawName: string,
  now: Date = new Date(),
): Promise<void> {
  const user = await requireUser(db, userId);
  requireCanManage(actor, await getAccessFacts(db, userId), {
    allowSelf: true,
    targetUserId: userId,
  });
  const parsed = nameSchema.safeParse(rawName);
  if (!parsed.success)
    throw new HubError("INVALID_INPUT", "称呼不能为空，最多 64 个字");

  await withAudit(
    db,
    (tx) => renameUser(tx, { userId, name: parsed.data, now }),
    () => ({
      actor,
      action: "account.renamed",
      entityType: "account",
      entityId: userId,
      summary: `把 ${user.email} 的称呼改为 ${parsed.data}`,
    }),
  );
}

export async function changeHubRole(
  db: Db,
  actor: AdminActor,
  userId: string,
  role: HubRole | null,
  now: Date = new Date(),
): Promise<void> {
  const user = await requireUser(db, userId);
  const target = await getAccessFacts(db, userId);
  const decision = canChangeRole({
    actorRole: actor.role,
    isSelf: actor.userId === userId,
    targetRole: target.role,
    newRole: role,
    ownerCount: await countOwners(db, { activeOnly: false }),
  });
  if (!decision.allowed) throw new HubError("FORBIDDEN", decision.reason);
  if (target.role === role) return;

  await withAudit(
    db,
    (tx) => upsertAccount(tx, userId, { role, now }),
    () => ({
      actor,
      action: "account.role_changed",
      entityType: "account",
      entityId: userId,
      summary: `${user.email} 的后台角色：${target.role ? roleLabels[target.role] : "无"} → ${role ? roleLabels[role] : "无"}`,
      detail: { from: target.role, to: role },
    }),
  );
}

/**
 * Gives someone access to the official website's data, or takes it away.
 * Only owners decide this, for anyone including themselves: the website's
 * lists hold personal details, so access follows who works on the website,
 * not who runs the back office.
 */
export async function setSiteAccess(
  db: Db,
  actor: AdminActor,
  userId: string,
  siteAccess: SiteAccess | null,
  now: Date = new Date(),
): Promise<void> {
  requirePermission(actor, "admins.manage", "只有所有者能设置官网权限");
  const user = await requireUser(db, userId);
  const target = await getAccessFacts(db, userId);
  if (target.siteAccess === siteAccess) return;

  const label = (access: SiteAccess | null) =>
    access ? siteAccessLabels[access] : "无";
  await withAudit(
    db,
    (tx) => upsertAccount(tx, userId, { siteAccess, now }),
    () => ({
      actor,
      action: "account.site_access_changed",
      entityType: "account",
      entityId: userId,
      summary: `${user.email} 的官网权限：${label(target.siteAccess)} → ${label(siteAccess)}`,
      detail: { from: target.siteAccess, to: siteAccess },
    }),
  );
}

/**
 * Lets someone read the club mailbox (hello@), or stops them. Owners only,
 * for anyone including themselves, like website access: the mail is from
 * people outside the club and may hold their personal details.
 */
export async function setMailAccess(
  db: Db,
  actor: AdminActor,
  userId: string,
  mailAccess: boolean,
  now: Date = new Date(),
): Promise<void> {
  requirePermission(actor, "admins.manage", "只有所有者能设置邮箱权限");
  const user = await requireUser(db, userId);
  const target = await getAccessFacts(db, userId);
  if (target.mailAccess === mailAccess) return;

  const label = (access: boolean) => (access ? "可查看" : "无");
  await withAudit(
    db,
    (tx) => upsertAccount(tx, userId, { mailAccess, now }),
    () => ({
      actor,
      action: "account.mail_access_changed",
      entityType: "account",
      entityId: userId,
      summary: `${user.email} 的邮箱权限：${label(target.mailAccess)} → ${label(mailAccess)}`,
      detail: { from: target.mailAccess, to: mailAccess },
    }),
  );
}

async function setStatus(
  db: Db,
  actor: AdminActor,
  userId: string,
  status: AccountFacts["status"],
  now: Date,
): Promise<void> {
  const user = await requireUser(db, userId);
  const target = await getAccessFacts(db, userId);
  const activeOwners = await countOwners(db, { activeOnly: true });
  const decision = canManageStatus({
    actorRole: actor.role,
    isSelf: actor.userId === userId,
    targetRole: target.role,
    targetIsLastActiveOwner:
      status === "suspended" &&
      target.role === "owner" &&
      target.status === "active" &&
      activeOwners <= 1,
  });
  if (!decision.allowed) throw new HubError("FORBIDDEN", decision.reason);
  if (target.status === status) return;

  await withAudit(
    db,
    async (tx) => {
      if (status === "suspended") {
        await upsertAccount(tx, userId, {
          status,
          suspendedAt: now,
          suspendedBy: actor.userId,
          now,
        });
        await deleteSessions(tx, userId);
        await disableApiKeys(tx, userId);
      } else {
        await upsertAccount(tx, userId, {
          status,
          suspendedAt: null,
          suspendedBy: null,
          now,
        });
      }
    },
    () => ({
      actor,
      action: status === "suspended" ? "account.suspended" : "account.restored",
      entityType: "account",
      entityId: userId,
      summary: `${status === "suspended" ? "停用" : "恢复"}账号 ${user.email}`,
    }),
  );
}

/** Blocks sign-in, signs the account out everywhere and disables its API keys. */
export function suspendAccount(
  db: Db,
  actor: AdminActor,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  return setStatus(db, actor, userId, "suspended", now);
}

/** Lets the account sign in again. API keys stay disabled; they make new ones. */
export function restoreAccount(
  db: Db,
  actor: AdminActor,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  return setStatus(db, actor, userId, "active", now);
}

/**
 * Adds someone to a project, changes their role there, or removes them
 * (`role: null`).
 */
export async function setProjectRole(
  db: Db,
  actor: AdminActor,
  userId: string,
  projectPublicId: string,
  role: (typeof projectRoles)[number] | null,
  now: Date = new Date(),
): Promise<void> {
  const user = await requireUser(db, userId);
  requireCanManage(actor, await getAccessFacts(db, userId), {
    allowSelf: true,
    targetUserId: userId,
  });
  const project = await findProjectByPublicId(db, projectPublicId);
  if (!project) throw new HubError("NOT_FOUND", "找不到这个项目");

  let changed = await setMembershipRole(db, {
    userId,
    workspaceId: project.id,
    role,
    actorUserId: actor.userId,
    now,
  });
  if (!changed && role !== null) {
    await ensureProjectMember(db, {
      userId,
      email: user.email,
      workspaceId: project.id,
      role,
      addedBy: actor.userId,
    });
    changed = true;
  }
  if (!changed) throw new HubError("NOT_FOUND", "这个账号不在该项目里");

  await recordAudit(db, {
    actor,
    action:
      role === null
        ? "account.project_removed"
        : "account.project_role_changed",
    entityType: "account",
    entityId: userId,
    summary:
      role === null
        ? `把 ${user.email} 移出 ${project.name}`
        : `${user.email} 在 ${project.name} 的角色设为 ${role}`,
    detail: { project: project.publicId, role },
  });
}

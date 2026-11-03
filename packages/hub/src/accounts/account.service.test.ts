import { verifyPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { account, apikey, session, workspaceMembers } from "@kan/db/schema";

import type { Db } from "../db";
import type { AdminActor } from "./account.service";
import { issueGrant } from "../access";
import { listAudit } from "../audit";
import { hubAccessGrants } from "../schema";
import { createHubTestDb, seedProject, seedUser } from "../testing/test-db";
import { upsertAccount } from "./account.repo";
import {
  changeHubRole,
  createAccount,
  getAccessFacts,
  getAccount,
  listAccounts,
  renameAccount,
  resetPassword,
  restoreAccount,
  setMailAccess,
  setProjectRole,
  setSiteAccess,
  suspendAccount,
} from "./account.service";

const now = new Date("2026-10-14T12:00:00Z");

let db: Db;
let owner: AdminActor;
let admin: AdminActor;
let project: { id: number; publicId: string; name: string };

const actorFor = async (
  email: string,
  role: AdminActor["role"],
): Promise<AdminActor> => {
  const user = await seedUser(db, { email });
  if (role) await upsertAccount(db, user.id, { role, now });
  return { userId: user.id, email: user.email, role };
};

const passwordOf = async (userId: string) => {
  const [row] = await db
    .select({ password: account.password })
    .from(account)
    .where(
      and(eq(account.userId, userId), eq(account.providerId, "credential")),
    );
  return row?.password ?? null;
};

const actions = async () =>
  (await listAudit(db, { limit: 100, offset: 0 })).map((e) => e.action);

beforeEach(async () => {
  db = await createHubTestDb();
  owner = await actorFor("owner@example.test", "owner");
  admin = await actorFor("admin@example.test", "admin");
  project = await seedProject(
    db,
    { id: owner.userId, email: owner.email },
    { name: "CourseMate" },
  );
});

describe("createAccount", () => {
  it("creates a password account, joins its projects and shows the password once", async () => {
    const created = await createAccount(db, admin, {
      name: "  新成员 ",
      email: "New@Example.test",
      hubRole: null,
      projects: [{ projectPublicId: project.publicId, role: "member" }],
      now,
    });

    expect(created.email).toBe("new@example.test");
    expect(created.temporaryPassword).toMatch(/^[A-Za-z2-9]{16}$/);

    const hash = await passwordOf(created.userId);
    expect(hash).not.toContain(created.temporaryPassword);
    expect(
      await verifyPassword({
        hash: hash ?? "",
        password: created.temporaryPassword,
      }),
    ).toBe(true);

    const detail = await getAccount(db, created.userId);
    expect(detail).toMatchObject({
      name: "新成员",
      email: "new@example.test",
      role: null,
      status: "active",
      projects: [{ projectPublicId: project.publicId, role: "member" }],
    });

    const [entry] = await listAudit(db, { limit: 1, offset: 0 });
    expect(entry).toMatchObject({
      action: "account.created",
      actorEmail: "admin@example.test",
      entityId: created.userId,
    });
    expect(JSON.stringify(entry)).not.toContain(created.temporaryPassword);
  });

  it("lets an owner create a back-office member, but not an admin", async () => {
    const byOwner = await createAccount(db, owner, {
      name: "管理员二号",
      email: "admin2@example.test",
      hubRole: "admin",
      projects: [],
      now,
    });
    expect((await getAccessFacts(db, byOwner.userId)).role).toBe("admin");

    await expect(
      createAccount(db, admin, {
        name: "x",
        email: "admin3@example.test",
        hubRole: "admin",
        projects: [],
        now,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("withdraws an open registration link for the same address", async () => {
    await issueGrant(db, admin, {
      email: "new@example.test",
      source: "direct",
      projects: [],
      now,
    });

    await createAccount(db, admin, {
      name: "新成员",
      email: "new@example.test",
      hubRole: null,
      projects: [],
      now,
    });

    const [grant] = await db.select().from(hubAccessGrants);
    expect(grant?.revokedAt).toEqual(now);
  });

  it.each([
    ["an existing address", { email: "owner@example.test" }, "CONFLICT"],
    ["an unusable address", { email: "nope" }, "INVALID_INPUT"],
    ["an empty name", { name: "   " }, "INVALID_INPUT"],
    [
      "an unknown project",
      {
        projects: [
          { projectPublicId: "missing12345", role: "member" as const },
        ],
      },
      "NOT_FOUND",
    ],
  ])("refuses %s and creates nothing", async (_, overrides, code) => {
    const before = await listAccounts(db, { page: 1 });

    await expect(
      createAccount(db, admin, {
        name: "新成员",
        email: "new@example.test",
        hubRole: null,
        projects: [],
        now,
        ...overrides,
      }),
    ).rejects.toMatchObject({ code });

    expect((await listAccounts(db, { page: 1 })).total).toBe(before.total);
  });

  it("refuses an actor without account management", async () => {
    const viewer = await actorFor("viewer@example.test", "viewer");
    await expect(
      createAccount(db, viewer, {
        name: "x",
        email: "x@example.test",
        hubRole: null,
        projects: [],
        now,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("resetPassword", () => {
  it("sets a new temporary password and signs the account out everywhere", async () => {
    const member = await createAccount(db, admin, {
      name: "成员",
      email: "member@example.test",
      hubRole: null,
      projects: [],
      now,
    });
    await db.insert(session).values({
      token: "tok",
      userId: member.userId,
      expiresAt: new Date("2030-01-01"),
      createdAt: now,
      updatedAt: now,
    });

    const { temporaryPassword } = await resetPassword(
      db,
      admin,
      member.userId,
      now,
    );

    expect(temporaryPassword).not.toBe(member.temporaryPassword);
    expect(
      await verifyPassword({
        hash: (await passwordOf(member.userId)) ?? "",
        password: temporaryPassword,
      }),
    ).toBe(true);
    expect(
      await db.select().from(session).where(eq(session.userId, member.userId)),
    ).toEqual([]);
    expect((await actions())[0]).toBe("account.password_reset");
  });

  it("adds a password to an account that never had one", async () => {
    const user = await seedUser(db, { email: "nopass@example.test" });

    const { temporaryPassword } = await resetPassword(db, admin, user.id, now);

    expect(
      await verifyPassword({
        hash: (await passwordOf(user.id)) ?? "",
        password: temporaryPassword,
      }),
    ).toBe(true);
  });

  it("does not let an admin reset an owner's password", async () => {
    await expect(
      resetPassword(db, admin, owner.userId, now),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("sends people to their own settings for their own password", async () => {
    await expect(
      resetPassword(db, admin, admin.userId, now),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reports an unknown account", async () => {
    await expect(
      resetPassword(db, admin, "00000000-0000-0000-0000-000000000000", now),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("renameAccount", () => {
  it("renames and logs", async () => {
    const user = await seedUser(db, { email: "rename@example.test" });

    await renameAccount(db, admin, user.id, "新名字", now);

    expect((await getAccount(db, user.id))?.name).toBe("新名字");
    expect((await actions())[0]).toBe("account.renamed");
  });

  it("lets people rename themselves, but not an admin rename an owner", async () => {
    await renameAccount(db, admin, admin.userId, "我自己", now);
    await expect(
      renameAccount(db, admin, owner.userId, "x", now),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("changeHubRole", () => {
  it("lets an owner appoint and remove back-office members", async () => {
    const user = await seedUser(db, { email: "u@example.test" });

    await changeHubRole(db, owner, user.id, "viewer", now);
    expect((await getAccessFacts(db, user.id)).role).toBe("viewer");

    await changeHubRole(db, owner, user.id, null, now);
    expect((await getAccessFacts(db, user.id)).role).toBeNull();
    expect((await actions()).slice(0, 2)).toEqual([
      "account.role_changed",
      "account.role_changed",
    ]);
  });

  it("refuses an admin, self-changes and removing the last owner", async () => {
    const user = await seedUser(db, { email: "u@example.test" });
    await expect(
      changeHubRole(db, admin, user.id, "viewer", now),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      changeHubRole(db, owner, owner.userId, "admin", now),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const second = await actorFor("owner2@example.test", "owner");
    await changeHubRole(db, second, owner.userId, "admin", now);
    await expect(
      changeHubRole(db, owner, second.userId, "admin", now),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("suspendAccount / restoreAccount", () => {
  it("suspends: signs out, disables API keys, and restores", async () => {
    const member = await createAccount(db, admin, {
      name: "成员",
      email: "member@example.test",
      hubRole: null,
      projects: [],
      now,
    });
    await db.insert(session).values({
      token: "tok2",
      userId: member.userId,
      expiresAt: new Date("2030-01-01"),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(apikey).values({
      key: "hashed-key",
      userId: member.userId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    } as typeof apikey.$inferInsert);

    await suspendAccount(db, admin, member.userId, now);

    expect(await getAccessFacts(db, member.userId)).toEqual({
      role: null,
      siteAccess: null,
      mailAccess: false,
      status: "suspended",
    });
    expect(
      await db.select().from(session).where(eq(session.userId, member.userId)),
    ).toEqual([]);
    const [key] = await db
      .select({ enabled: apikey.enabled })
      .from(apikey)
      .where(eq(apikey.userId, member.userId));
    expect(key?.enabled).toBe(false);

    await restoreAccount(db, admin, member.userId, now);
    expect((await getAccessFacts(db, member.userId)).status).toBe("active");
    expect((await actions()).slice(0, 2)).toEqual([
      "account.restored",
      "account.suspended",
    ]);
  });

  it("follows the status rules", async () => {
    await expect(
      suspendAccount(db, admin, owner.userId, now),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      suspendAccount(db, admin, admin.userId, now),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      suspendAccount(db, owner, owner.userId, now),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("setProjectRole", () => {
  it("adds to a project, changes the role and removes", async () => {
    const user = await seedUser(db, { email: "m@example.test" });

    await setProjectRole(db, admin, user.id, project.publicId, "guest", now);
    expect((await getAccount(db, user.id))?.projects).toMatchObject([
      { projectPublicId: project.publicId, role: "guest" },
    ]);

    await setProjectRole(db, admin, user.id, project.publicId, "admin", now);
    expect((await getAccount(db, user.id))?.projects).toMatchObject([
      { role: "admin" },
    ]);

    await setProjectRole(db, admin, user.id, project.publicId, null, now);
    expect((await getAccount(db, user.id))?.projects).toEqual([]);

    const rows = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deletedAt).toEqual(now);

    expect((await actions()).slice(0, 3)).toEqual([
      "account.project_removed",
      "account.project_role_changed",
      "account.project_role_changed",
    ]);
  });

  it("refuses an unknown project and removing someone who is not a member", async () => {
    const user = await seedUser(db, { email: "m@example.test" });
    await expect(
      setProjectRole(db, admin, user.id, "missing12345", "member", now),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      setProjectRole(db, admin, user.id, project.publicId, null, now),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("listAccounts", () => {
  it("lists everyone with role, status and projects, and searches", async () => {
    const page = await listAccounts(db, { page: 1 });
    expect(page.total).toBe(2);
    expect(page.items.map((a) => [a.email, a.role])).toEqual([
      ["owner@example.test", "owner"],
      ["admin@example.test", "admin"],
    ]);
    expect(page.items[0]?.projects).toMatchObject([{ role: "admin" }]);

    const found = await listAccounts(db, { page: 1, search: "ADMIN@" });
    expect(found.items.map((a) => a.email)).toEqual(["admin@example.test"]);
  });
});

describe("setSiteAccess", () => {
  it("lets an owner grant website access to anyone, themselves included", async () => {
    const member = await seedUser(db, { email: "web@example.test" });

    await setSiteAccess(db, owner, member.id, "manage", now);
    await setSiteAccess(db, owner, owner.userId, "people", now);

    expect(await getAccessFacts(db, member.id)).toMatchObject({
      role: null,
      siteAccess: "manage",
    });
    expect((await getAccount(db, owner.userId))?.siteAccess).toBe("people");
    const [latest] = await listAudit(db, { limit: 1, offset: 0 });
    expect(latest).toMatchObject({
      action: "account.site_access_changed",
      summary: "owner@example.test 的官网权限：无 → 名单",
    });
  });

  it("keeps the back-office role when website access changes, and back", async () => {
    await setSiteAccess(db, owner, admin.userId, "people", now);
    await setSiteAccess(db, owner, admin.userId, null, now);
    expect(await getAccessFacts(db, admin.userId)).toMatchObject({
      role: "admin",
      siteAccess: null,
    });
  });

  it("refuses admins: only owners decide who sees the website's data", async () => {
    const member = await seedUser(db, { email: "web@example.test" });
    await expect(
      setSiteAccess(db, admin, member.id, "manage", now),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      setSiteAccess(db, admin, admin.userId, "manage", now),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does nothing, and logs nothing, when access is unchanged", async () => {
    const before = (await actions()).length;
    await setSiteAccess(db, owner, admin.userId, null, now);
    expect(await actions()).toHaveLength(before);
  });

  it("refuses an unknown account", async () => {
    await expect(
      setSiteAccess(
        db,
        owner,
        "00000000-0000-4000-8000-000000000000",
        "manage",
        now,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("setMailAccess", () => {
  it("is off for everyone until an owner turns it on, themselves included", async () => {
    const member = await seedUser(db, { email: "mail@example.test" });
    expect((await getAccessFacts(db, owner.userId)).mailAccess).toBe(false);

    await setMailAccess(db, owner, member.id, true, now);
    await setMailAccess(db, owner, owner.userId, true, now);

    expect(await getAccessFacts(db, member.id)).toMatchObject({
      role: null,
      siteAccess: null,
      mailAccess: true,
    });
    expect((await getAccount(db, owner.userId))?.mailAccess).toBe(true);
    const [latest] = await listAudit(db, { limit: 1, offset: 0 });
    expect(latest).toMatchObject({
      action: "account.mail_access_changed",
      summary: "owner@example.test 的邮箱权限：无 → 可查看",
    });
  });

  it("is independent of website access and the back-office role", async () => {
    await setSiteAccess(db, owner, admin.userId, "manage", now);
    await setMailAccess(db, owner, admin.userId, true, now);
    await setMailAccess(db, owner, admin.userId, false, now);
    expect(await getAccessFacts(db, admin.userId)).toMatchObject({
      role: "admin",
      siteAccess: "manage",
      mailAccess: false,
    });
  });

  it("refuses admins: only owners decide who reads the mailbox", async () => {
    const member = await seedUser(db, { email: "mail@example.test" });
    await expect(
      setMailAccess(db, admin, member.id, true, now),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      setMailAccess(db, admin, admin.userId, true, now),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does nothing, and logs nothing, when access is unchanged", async () => {
    const before = (await actions()).length;
    await setMailAccess(db, owner, admin.userId, false, now);
    expect(await actions()).toHaveLength(before);
  });
});

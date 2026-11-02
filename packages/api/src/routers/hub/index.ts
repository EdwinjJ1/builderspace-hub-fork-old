import { z } from "zod";

import {
  changeGrantHubRoleById,
  countOpenGrants,
  issueGrant,
  listGrants,
  provisionUser,
  revokeGrant,
} from "@kan/hub/access";
import {
  changeHubRole,
  createAccount,
  getAccount,
  hubRoles,
  listAccounts,
  permissionsOf,
  renameAccount,
  resetPassword,
  restoreAccount,
  setMailAccess,
  setProjectRole,
  setSiteAccess,
  suspendAccount,
} from "@kan/hub/accounts";
import { getArchive } from "@kan/hub/archive";
import { countAudit, listAudit } from "@kan/hub/audit";
import {
  addProjectRepo,
  disconnectGitHub,
  getGitHubSummary,
  gitHubAppConfig,
  gitHubDeps,
  listProjectRepos,
  removeProjectRepo,
  syncGitHub,
} from "@kan/hub/github";
import {
  getNudgeMail,
  listNudgeable,
  nudgePerson,
  setNudgeMail,
} from "@kan/hub/nudges";
import {
  editablePermissions,
  editableProjectRoles,
  getPermissionMatrix,
  setProjectRolePermission,
} from "@kan/hub/permissions";
import {
  boardAudiences,
  getBoardPrivacy,
  setBoardAudience,
} from "@kan/hub/private-boards";
import { can } from "@kan/hub/public";
import {
  blockInputs,
  createBlock,
  editBlock,
  getSchedule,
  planTask,
  removeBlock,
} from "@kan/hub/schedule";
import { projectRoles } from "@kan/hub/schema";
import { getFunctionColors, setFunctionColors } from "@kan/hub/settings";
import { HubError } from "@kan/hub/shared";
import { siteAccessLevels } from "@kan/hub/site";
import { listProjects } from "@kan/hub/structure";
import { getHome, getTaskBoard, taskViews } from "@kan/hub/tasks";

import { createTRPCRouter } from "../../trpc";
import { departmentsRouter } from "./departments";
import { documentsRouter } from "./documents";
import { formsRouter } from "./forms";
import { inboxRouter } from "./inbox";
import { mcpRouter } from "./mcp/router";
import { hubAdminProcedure, hubProcedure, runHub } from "./procedures";
import { siteRouter } from "./site";

/**
 * The Hub's own API, mounted at `hub.*`: the back office, plus the home page
 * and the task board every member uses. Thin by design: validate the
 * input, call a use case from `@kan/hub`, map its errors. Every procedure is
 * left out of the public REST API (no `openapi` meta).
 *
 * No input here ever carries a secret: Kan's logging middleware records every
 * procedure's input. Temporary passwords and link tokens only appear in
 * outputs, once.
 */

const userIdInput = z.object({ userId: z.string().uuid() });
const pageInput = z.object({ page: z.number().int().min(1).max(10_000) });
const projectInput = z.object({
  projectPublicId: z.string().min(1).max(32),
  role: z.enum(projectRoles),
});

const meRouter = createTRPCRouter({
  get: hubProcedure.query(async ({ ctx }) => {
    // Finishes a registration whose after-hook failed; a no-op otherwise.
    await provisionUser(ctx.db, {
      userId: ctx.actor.userId,
      email: ctx.actor.email,
      now: new Date(),
    }).catch(() => undefined);

    return {
      userId: ctx.actor.userId,
      email: ctx.actor.email,
      role: ctx.actor.role,
      permissions: permissionsOf(ctx.actor.role),
      siteAccess: ctx.siteAccess,
      mailAccess: ctx.mailAccess,
    };
  }),
});

const accountsRouter = createTRPCRouter({
  list: hubAdminProcedure("admin.view")
    .input(pageInput.extend({ search: z.string().max(100).optional() }))
    .query(({ ctx, input }) => runHub(() => listAccounts(ctx.db, input))),

  get: hubAdminProcedure("admin.view")
    .input(userIdInput)
    .query(({ ctx, input }) => runHub(() => getAccount(ctx.db, input.userId))),

  create: hubAdminProcedure("accounts.manage")
    .input(
      z.object({
        name: z.string().max(64),
        email: z.string().max(255),
        hubRole: z.enum(hubRoles).nullable(),
        projects: z.array(projectInput).max(20),
      }),
    )
    .mutation(({ ctx, input }) =>
      runHub(() => createAccount(ctx.db, ctx.actor, input)),
    ),

  resetPassword: hubAdminProcedure("accounts.manage")
    .input(userIdInput)
    .mutation(({ ctx, input }) =>
      runHub(() => resetPassword(ctx.db, ctx.actor, input.userId)),
    ),

  rename: hubAdminProcedure("accounts.manage")
    .input(userIdInput.extend({ name: z.string().max(64) }))
    .mutation(({ ctx, input }) =>
      runHub(() => renameAccount(ctx.db, ctx.actor, input.userId, input.name)),
    ),

  setRole: hubAdminProcedure("admins.manage")
    .input(userIdInput.extend({ role: z.enum(hubRoles).nullable() }))
    .mutation(({ ctx, input }) =>
      runHub(() => changeHubRole(ctx.db, ctx.actor, input.userId, input.role)),
    ),

  /** 官网权限: who may see the official website's data. Owners only. */
  setSiteAccess: hubAdminProcedure("admins.manage")
    .input(userIdInput.extend({ access: z.enum(siteAccessLevels).nullable() }))
    .mutation(({ ctx, input }) =>
      runHub(() =>
        setSiteAccess(ctx.db, ctx.actor, input.userId, input.access),
      ),
    ),

  /** 邮箱权限: who may read hello@'s mail. Owners only. */
  setMailAccess: hubAdminProcedure("admins.manage")
    .input(userIdInput.extend({ access: z.boolean() }))
    .mutation(({ ctx, input }) =>
      runHub(() =>
        setMailAccess(ctx.db, ctx.actor, input.userId, input.access),
      ),
    ),

  suspend: hubAdminProcedure("accounts.manage")
    .input(userIdInput)
    .mutation(({ ctx, input }) =>
      runHub(() => suspendAccount(ctx.db, ctx.actor, input.userId)),
    ),

  restore: hubAdminProcedure("accounts.manage")
    .input(userIdInput)
    .mutation(({ ctx, input }) =>
      runHub(() => restoreAccount(ctx.db, ctx.actor, input.userId)),
    ),

  setProjectRole: hubAdminProcedure("accounts.manage")
    .input(
      userIdInput.extend({
        projectPublicId: z.string().min(1).max(32),
        role: z.enum(projectRoles).nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runHub(() =>
        setProjectRole(
          ctx.db,
          ctx.actor,
          input.userId,
          input.projectPublicId,
          input.role,
        ),
      ),
    ),
});

const grantsRouter = createTRPCRouter({
  list: hubAdminProcedure("admin.view")
    .input(pageInput)
    .query(({ ctx, input }) => runHub(() => listGrants(ctx.db, input))),

  /** Returns the link token once; the page builds the link from it. */
  issue: hubAdminProcedure("access.manage")
    .input(
      z.object({
        email: z.string().max(255),
        hubRole: z.enum(hubRoles).nullable(),
        note: z.string().max(280).nullable(),
        projects: z.array(projectInput).max(20),
      }),
    )
    .mutation(({ ctx, input }) =>
      runHub(() => {
        // A link that makes someone an owner or admin is itself an
        // appointment, so it needs the same permission.
        if (input.hubRole !== null && !can(ctx.actor.role, "admins.manage")) {
          throw new HubError("FORBIDDEN", "只有所有者能为后台成员发放注册链接");
        }
        return issueGrant(ctx.db, ctx.actor, { ...input, source: "direct" });
      }),
    ),

  revoke: hubAdminProcedure("access.manage")
    .input(z.object({ grantPublicId: z.string().min(1).max(32) }))
    .mutation(({ ctx, input }) =>
      runHub(() => revokeGrant(ctx.db, ctx.actor, input.grantPublicId)),
    ),

  /** Changes the back-office role an unused link will give; same link. */
  setRole: hubAdminProcedure("admins.manage")
    .input(
      z.object({
        grantPublicId: z.string().min(1).max(32),
        hubRole: z.enum(hubRoles).nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runHub(() => changeGrantHubRoleById(ctx.db, ctx.actor, input)),
    ),
});

const permissionsRouter = createTRPCRouter({
  /** What members and guests may do, per project. */
  get: hubAdminProcedure("admin.view").query(({ ctx }) =>
    getPermissionMatrix(ctx.db),
  ),

  /** One permission on or off for a role, in one project or (null) all. */
  set: hubAdminProcedure("permissions.manage")
    .input(
      z.object({
        projectPublicId: z.string().min(1).max(32).nullable(),
        role: z.enum(editableProjectRoles),
        permission: z
          .string()
          .refine(
            (value) =>
              (editablePermissions as readonly string[]).includes(value),
            "这项权限不能在这里修改",
          ),
        granted: z.boolean(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runHub(() => setProjectRolePermission(ctx.db, ctx.actor, input)),
    ),
});

/** 全部 when `project` is left out, otherwise one project the caller is in. */
const scopeInput = z.object({ project: z.string().min(1).max(32).optional() });

const tasksRouter = createTRPCRouter({
  /** The home page: tile counts, my open tasks, the project × function grid. */
  home: hubProcedure.input(scopeInput).query(({ ctx, input }) =>
    runHub(() =>
      getHome(ctx.db, {
        userId: ctx.actor.userId,
        projectPublicId: input.project,
        now: new Date(),
      }),
    ),
  ),

  /**
   * The cross-project task board for one view, split into columns.
   * `onlyMine` (只看我的) narrows it to the tasks assigned to the caller.
   */
  board: hubProcedure
    .input(
      scopeInput.extend({
        view: z.enum(taskViews),
        onlyMine: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) =>
      runHub(() =>
        getTaskBoard(ctx.db, {
          userId: ctx.actor.userId,
          projectPublicId: input.project,
          view: input.view,
          onlyMine: input.onlyMine,
          now: new Date(),
        }),
      ),
    ),
});

const reposRouter = createTRPCRouter({
  /** Every project with the GitHub repositories it is made of. */
  list: hubAdminProcedure("admin.view").query(({ ctx }) =>
    listProjectRepos(ctx.db),
  ),

  add: hubAdminProcedure("settings.manage")
    .input(
      z.object({
        projectPublicId: z.string().min(1).max(32),
        repo: z.string().min(1).max(300),
      }),
    )
    .mutation(({ ctx, input }) =>
      runHub(() => addProjectRepo(ctx.db, ctx.actor, input)),
    ),

  remove: hubAdminProcedure("settings.manage")
    .input(z.object({ repoPublicId: z.string().min(1).max(32) }))
    .mutation(({ ctx, input }) =>
      runHub(() => removeProjectRepo(ctx.db, ctx.actor, input.repoPublicId)),
    ),
});

/** The GitHub App's settings, or a refusal people can read when it is missing. */
function requireGitHubApp() {
  const config = gitHubAppConfig();
  if (!config) {
    throw new HubError(
      "CONFLICT",
      "管理员还没有配置 GitHub App，暂时不能连接。",
    );
  }
  return config;
}

const githubRouter = createTRPCRouter({
  /** My connection, the repositories that count for me, and my activity in them. */
  summary: hubProcedure.query(async ({ ctx }) => ({
    configured: gitHubAppConfig() !== null,
    ...(await getGitHubSummary(ctx.db, {
      userId: ctx.actor.userId,
      now: new Date(),
    })),
  })),

  sync: hubProcedure.mutation(({ ctx }) =>
    runHub(() =>
      syncGitHub(
        ctx.db,
        { userId: ctx.actor.userId, now: new Date() },
        gitHubDeps(requireGitHubApp()),
      ),
    ),
  ),

  disconnect: hubProcedure.mutation(({ ctx }) =>
    runHub(() =>
      disconnectGitHub(ctx.db, ctx.actor, gitHubDeps(requireGitHubApp())),
    ),
  ),
});

const archiveRouter = createTRPCRouter({
  /** 我完成的: my finished tasks, counted by month in the viewer's time zone. */
  get: hubProcedure
    .input(z.object({ timeZone: z.string().min(1).max(64) }))
    .query(({ ctx, input }) =>
      runHub(() =>
        getArchive(ctx.db, {
          userId: ctx.actor.userId,
          timeZone: input.timeZone,
          now: new Date(),
        }),
      ),
    ),
});

const scheduleRouter = createTRPCRouter({
  /** My calendar for a window: my blocks plus my unfinished tasks. */
  get: hubProcedure
    .input(z.object({ from: z.date(), to: z.date() }))
    .query(({ ctx, input }) =>
      runHub(() =>
        getSchedule(ctx.db, {
          userId: ctx.actor.userId,
          ...input,
          now: new Date(),
        }),
      ),
    ),

  create: hubProcedure
    .input(blockInputs.manual)
    .mutation(({ ctx, input }) =>
      runHub(() => createBlock(ctx.db, ctx.actor.userId, input)),
    ),

  planTask: hubProcedure
    .input(blockInputs.task)
    .mutation(({ ctx, input }) =>
      runHub(() => planTask(ctx.db, ctx.actor.userId, input, new Date())),
    ),

  edit: hubProcedure
    .input(blockInputs.edit)
    .mutation(({ ctx, input }) =>
      runHub(() => editBlock(ctx.db, ctx.actor.userId, input)),
    ),

  remove: hubProcedure
    .input(z.object({ blockPublicId: z.string().min(1).max(32) }))
    .mutation(({ ctx, input }) =>
      runHub(() => removeBlock(ctx.db, ctx.actor.userId, input.blockPublicId)),
    ),
});

const nudgesRouter = createTRPCRouter({
  /** Teammates whose tasks have stalled, for the bell on the home page. */
  list: hubProcedure.query(({ ctx }) =>
    runHub(() =>
      listNudgeable(ctx.db, { userId: ctx.actor.userId, now: new Date() }),
    ),
  ),

  /** One anonymous mail to one of them; who asked is never stored. */
  send: hubProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      runHub(() =>
        nudgePerson(ctx.db, {
          userId: ctx.actor.userId,
          recipientId: input.userId,
          now: new Date(),
        }),
      ),
    ),

  /** Whether I get 催一下 mail. */
  mail: hubProcedure.query(({ ctx }) => getNudgeMail(ctx.db, ctx.actor.userId)),

  setMail: hubProcedure
    .input(z.object({ on: z.boolean() }))
    .mutation(({ ctx, input }) =>
      runHub(() => setNudgeMail(ctx.db, ctx.actor, input.on)),
    ),
});

const boardInput = z.object({ boardPublicId: z.string().min(1).max(32) });

const boardsRouter = createTRPCRouter({
  /**
   * Whether a board is 仅自己可见 or 仅管理员可见, and where I may move it.
   */
  privacy: hubProcedure
    .input(boardInput)
    .query(({ ctx, input }) =>
      runHub(() =>
        getBoardPrivacy(ctx.db, ctx.actor.userId, input.boardPublicId),
      ),
    ),

  /** `audience: null` hands the board back to every project member. */
  setAudience: hubProcedure
    .input(boardInput.extend({ audience: z.enum(boardAudiences).nullable() }))
    .mutation(({ ctx, input }) =>
      runHub(() => setBoardAudience(ctx.db, ctx.actor, input)),
    ),
});

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "颜色要写成 #RRGGBB 的形式");

const settingsRouter = createTRPCRouter({
  /** Every page paints 技术 / 活动 / 运营 in these, so every member reads them. */
  functionColors: hubProcedure.query(({ ctx }) => getFunctionColors(ctx.db)),

  setFunctionColors: hubAdminProcedure("settings.manage")
    .input(z.object({ dev: hexColor, ops: hexColor, marketing: hexColor }))
    .mutation(({ ctx, input }) =>
      runHub(() => setFunctionColors(ctx.db, ctx.actor, input)),
    ),
});

const AUDIT_PAGE_SIZE = 50;

const auditRouter = createTRPCRouter({
  list: hubAdminProcedure("audit.view")
    .input(pageInput)
    .query(async ({ ctx, input }) => {
      const [items, total] = await Promise.all([
        listAudit(ctx.db, {
          limit: AUDIT_PAGE_SIZE,
          offset: (input.page - 1) * AUDIT_PAGE_SIZE,
        }),
        countAudit(ctx.db),
      ]);
      return { items, total, pageSize: AUDIT_PAGE_SIZE };
    }),
});

export const hubRouter = createTRPCRouter({
  me: meRouter,
  accounts: accountsRouter,
  grants: grantsRouter,
  audit: auditRouter,
  permissions: permissionsRouter,
  settings: settingsRouter,
  tasks: tasksRouter,
  schedule: scheduleRouter,
  departments: departmentsRouter,
  documents: documentsRouter,
  forms: formsRouter,
  repos: reposRouter,
  github: githubRouter,
  site: siteRouter,
  inbox: inboxRouter,
  archive: archiveRouter,
  boards: boardsRouter,
  nudges: nudgesRouter,
  mcp: mcpRouter,

  projects: hubAdminProcedure("admin.view").query(({ ctx }) =>
    listProjects(ctx.db),
  ),

  overview: hubAdminProcedure("admin.view").query(async ({ ctx }) => {
    const [accounts, projects, openGrants] = await Promise.all([
      listAccounts(ctx.db, { page: 1 }),
      listProjects(ctx.db),
      countOpenGrants(ctx.db),
    ]);
    return {
      accounts: accounts.total,
      projects: projects.length,
      openGrants,
    };
  }),
});

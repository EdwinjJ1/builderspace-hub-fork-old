import { TRPCError } from "@trpc/server";

import type { AdminActor, HubPermission } from "@kan/hub/accounts";
import type { InboxActor } from "@kan/hub/inbox";
import type { SiteActor, SitePermission } from "@kan/hub/site";
import { can, getAccessFacts } from "@kan/hub/accounts";
import { canReadMail, connectInbox } from "@kan/hub/inbox";
import { canOnSite, connectSiteDb } from "@kan/hub/site";

import { protectedProcedure } from "../../trpc";

export { runHub } from "./run-hub";

/** True when the request authenticated with an API key rather than a browser session. */
const usesApiKey = (headers: Headers): boolean =>
  headers.has("x-api-key") ||
  /^bearer\s/i.test(headers.get("authorization") ?? "");

/**
 * A signed-in, non-suspended person using the app in a browser: every Hub
 * page, the home page included. Adds `ctx.actor` (who they are and their
 * back-office role, which is null for most members), `ctx.siteAccess`
 * (their access to the official website's data, null for most) and
 * `ctx.mailAccess` (whether they may read the club mailbox, false for most).
 *
 * Refusals use FORBIDDEN, never UNAUTHORIZED: Kan's client sends anyone who
 * gets UNAUTHORIZED back to the login page.
 */
export const hubProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const user = ctx.user;
  if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });

  if (usesApiKey(ctx.headers)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Hub 的接口只能在网页里使用，不接受 API key",
    });
  }

  const facts = await getAccessFacts(ctx.db, user.id);
  if (facts.status === "suspended") {
    throw new TRPCError({ code: "FORBIDDEN", message: "这个账号已被停用" });
  }

  const actor: AdminActor = {
    userId: user.id,
    email: user.email,
    role: facts.role,
  };
  return next({
    ctx: {
      ...ctx,
      actor,
      siteAccess: facts.siteAccess,
      mailAccess: facts.mailAccess,
    },
  });
});

/** `hubProcedure` that also requires one back-office permission. */
export const hubAdminProcedure = (permission: HubPermission) =>
  hubProcedure.use(({ ctx, next }) => {
    if (!can(ctx.actor.role, permission)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "没有执行这个操作的权限",
      });
    }
    return next();
  });

/**
 * `hubProcedure` for the back office's 官网 section: requires one website
 * permission and a connected website database. Adds `ctx.site` (that
 * database) and `ctx.siteActor`.
 */
export const hubSiteProcedure = (permission: SitePermission) =>
  hubProcedure.use(({ ctx, next }) => {
    if (!canOnSite(ctx.siteAccess, permission)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "没有查看或处理官网数据的权限",
      });
    }
    const site = connectSiteDb();
    if (!site) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "还没有连接官网数据库",
      });
    }
    const siteActor: SiteActor = {
      userId: ctx.actor.userId,
      email: ctx.actor.email,
      hubRole: ctx.actor.role,
      siteAccess: ctx.siteAccess,
    };
    return next({ ctx: { ...ctx, site, siteActor } });
  });

/**
 * `hubProcedure` for the 官网 section's mailbox page: requires mailbox access
 * and a configured Resend key. Adds `ctx.inbox` (Resend) and `ctx.inboxActor`.
 */
export const hubInboxProcedure = hubProcedure.use(({ ctx, next }) => {
  if (!canReadMail(ctx.mailAccess)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "没有查看邮箱的权限",
    });
  }
  const inbox = connectInbox();
  if (!inbox) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "还没有连接邮箱",
    });
  }
  const inboxActor: InboxActor = {
    userId: ctx.actor.userId,
    mailAccess: ctx.mailAccess,
  };
  return next({ ctx: { ...ctx, inbox, inboxActor } });
});

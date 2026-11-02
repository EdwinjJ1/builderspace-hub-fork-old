import type { HubRole, TaskView } from "@kan/hub/public";
import { can, HUB_JOIN_PATH } from "@kan/hub/public";

/**
 * Every path the Hub's own pages link to, in one place.
 */
export const hubRoutes = {
  /** Where a signed-in person lands. */
  afterLogin: "/home",
  home: "/home",
  personal: "/me",
  personalDone: "/me/done",
  personalGitHub: "/me/github",
  personalReminders: "/me/reminders",
  login: "/login",
  signup: "/signup",
  join: HUB_JOIN_PATH,
} as const;

/**
 * Where the back office starts for someone: the 官网 section if that is all
 * they have, the mailbox if only that.
 */
export function adminHome(access: {
  role: HubRole | null;
  siteAccess: unknown;
  mailAccess: boolean;
}): string {
  if (can(access.role, "admin.view")) return "/admin";
  if (!access.siteAccess && access.mailAccess) return "/admin/site/inbox";
  return "/admin/site";
}

/** The home page, scoped to one project or (no id) to 全部. */
export function homeHref(projectPublicId?: string | null): string {
  return withProject(hubRoutes.home, projectPublicId);
}

/** `?assigned=me` on a task board: 只看我的 is on. */
export const onlyMineParam = { name: "assigned", value: "me" } as const;

/** The task board for one view, scoped like the home page. */
export function taskBoardHref(
  view: TaskView,
  projectPublicId?: string | null,
  onlyMine = false,
): string {
  const path = withProject(`/tasks/${view}`, projectPublicId);
  if (!onlyMine) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}${onlyMineParam.name}=${onlyMineParam.value}`;
}

export function cardHref(cardPublicId: string): string {
  return `/cards/${cardPublicId}`;
}

function withProject(path: string, projectPublicId?: string | null): string {
  return projectPublicId
    ? `${path}?project=${encodeURIComponent(projectPublicId)}`
    : path;
}

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as kanSchema from "@kan/db/schema";

import type { Db } from "../db";
import type { ProjectRole } from "../schema";
import { ensureProjectMember } from "../kan/members.gateway";
import { HubError } from "../shared/errors";
import { createHubTestDb, seedProject, seedUser } from "../testing/test-db";
import { DONE_COLUMN_LIMIT } from "./task.policy";
import { getHome, getTaskBoard, HOME_MY_TASKS_LIMIT } from "./task.service";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-14T00:00:00Z");

interface User {
  id: string;
  email: string;
}
interface Project {
  id: number;
  publicId: string;
  name: string;
}

let db: Db;
let owner: User;
let me: User;
let uid = 0;
const nextId = () => `t${(uid += 1).toString().padStart(11, "0")}`;

/** The list ids of a seeded board, one per column. */
interface BoardLists {
  todo: number;
  doing: number;
  review: number;
  done: number;
  /** A list someone renamed: its cards belong in "other". */
  ideas: number;
}

const LIST_NAMES: Record<keyof BoardLists, string> = {
  todo: "待办",
  doing: "进行中",
  review: "待验收",
  done: "已完成",
  ideas: "灵感池",
};

/** A board with the standard columns plus one renamed list. */
async function seedBoard(
  project: Project,
  name: string,
  options: { type?: "regular" | "template"; isArchived?: boolean } = {},
): Promise<BoardLists> {
  const [board] = await db
    .insert(kanSchema.boards)
    .values({
      publicId: nextId(),
      name,
      slug: nextId(),
      workspaceId: project.id,
      createdBy: owner.id,
      type: options.type ?? "regular",
      isArchived: options.isArchived ?? false,
    })
    .returning({ id: kanSchema.boards.id });
  if (!board) throw new Error("no board");

  const ids: Partial<BoardLists> = {};
  for (const [index, key] of (
    Object.keys(LIST_NAMES) as (keyof BoardLists)[]
  ).entries()) {
    const [list] = await db
      .insert(kanSchema.lists)
      .values({
        publicId: nextId(),
        name: LIST_NAMES[key],
        index,
        boardId: board.id,
      })
      .returning({ id: kanSchema.lists.id });
    if (!list) throw new Error("no list");
    ids[key] = list.id;
  }
  return ids as BoardLists;
}

/** A board someone set up with their own lists; their ids, by name. */
async function seedCustomBoard(
  project: Project,
  name: string,
  listNames: string[],
): Promise<Map<string, number>> {
  const [board] = await db
    .insert(kanSchema.boards)
    .values({
      publicId: nextId(),
      name,
      slug: nextId(),
      workspaceId: project.id,
      createdBy: owner.id,
    })
    .returning({ id: kanSchema.boards.id });
  if (!board) throw new Error("no board");

  const ids = new Map<string, number>();
  for (const [index, listName] of listNames.entries()) {
    const [list] = await db
      .insert(kanSchema.lists)
      .values({ publicId: nextId(), name: listName, index, boardId: board.id })
      .returning({ id: kanSchema.lists.id });
    if (!list) throw new Error("no list");
    ids.set(listName, list.id);
  }
  return ids;
}

async function seedCard(
  listId: number,
  title: string,
  options: {
    dueInDays?: number;
    assignees?: { user: User; project: Project }[];
    updatedDaysAgo?: number;
    deleted?: boolean;
  } = {},
): Promise<string> {
  const publicId = nextId();
  const [card] = await db
    .insert(kanSchema.cards)
    .values({
      publicId,
      title,
      index: 0,
      listId,
      dueDate:
        options.dueInDays === undefined
          ? null
          : new Date(now.getTime() + options.dueInDays * DAY),
      updatedAt:
        options.updatedDaysAgo === undefined
          ? null
          : new Date(now.getTime() - options.updatedDaysAgo * DAY),
      deletedAt: options.deleted ? now : null,
    })
    .returning({ id: kanSchema.cards.id });
  if (!card) throw new Error("no card");

  for (const { user, project } of options.assignees ?? []) {
    const member = await memberOf(user, project);
    await db
      .insert(kanSchema.cardToWorkspaceMembers)
      .values({ cardId: card.id, workspaceMemberId: member });
  }
  return publicId;
}

async function memberOf(user: User, project: Project): Promise<number> {
  const [member] = await db
    .select({ id: kanSchema.workspaceMembers.id })
    .from(kanSchema.workspaceMembers)
    .where(
      and(
        eq(kanSchema.workspaceMembers.userId, user.id),
        eq(kanSchema.workspaceMembers.workspaceId, project.id),
      ),
    );
  if (!member) throw new Error("not a member");
  return member.id;
}

const join = (user: User, project: Project, role: ProjectRole = "member") =>
  ensureProjectMember(db, {
    userId: user.id,
    email: user.email,
    workspaceId: project.id,
    role,
    addedBy: owner.id,
  });

const titles = (tasks: { title: string }[]) => tasks.map((t) => t.title);

let coursemate: Project;
let community: Project;
let echo: Project;

beforeEach(async () => {
  db = await createHubTestDb();
  owner = await seedUser(db, { email: "owner@example.test" });
  me = await seedUser(db, { email: "me@example.test" });
  // Created out of order on purpose: the team's order comes from the structure.
  echo = await seedProject(db, owner, {
    name: "EchoAgent",
    slug: "bss-echoagent",
  });
  community = await seedProject(db, owner, {
    name: "BuilderSpace 社团",
    slug: "bss-community",
  });
  coursemate = await seedProject(db, owner, {
    name: "CourseMate",
    slug: "bss-coursemate",
  });
});

describe("which projects someone sees", () => {
  it("shows only the projects they are in, in the team's order", async () => {
    await join(me, echo);
    await join(me, coursemate, "guest");

    const home = await getHome(db, { userId: me.id, now });

    expect(home.scope.projects.map((p) => p.name)).toEqual([
      "CourseMate",
      "EchoAgent",
    ]);
    expect(home.scope.current).toBeNull();
  });

  it("never counts tasks from a project they are not in", async () => {
    await join(me, coursemate);
    const theirs = await seedBoard(community, "开发");
    await seedCard(theirs.todo, "社团的任务", { dueInDays: -1 });
    const mine = await seedBoard(coursemate, "开发");
    await seedCard(mine.todo, "CourseMate 的任务");

    const home = await getHome(db, { userId: me.id, now });
    const board = await getTaskBoard(db, { userId: me.id, view: "all", now });

    expect(home.tiles).toEqual({ mine: 0, dueSoon: 0, overdue: 0, open: 1 });
    expect(board.columns.flatMap((c) => titles(c.tasks))).toEqual([
      "CourseMate 的任务",
    ]);
  });

  it("drops a project whose card permission was taken away from them", async () => {
    await join(me, coursemate);
    await db.insert(kanSchema.workspaceMemberPermissions).values({
      workspaceMemberId: await memberOf(me, coursemate),
      permission: "card:view",
      granted: false,
    });

    const home = await getHome(db, { userId: me.id, now });
    expect(home.scope.projects).toEqual([]);
  });

  it("ignores pending invitations and removed memberships", async () => {
    await join(me, coursemate);
    await join(me, community);
    await db
      .update(kanSchema.workspaceMembers)
      .set({ status: "invited" })
      .where(eq(kanSchema.workspaceMembers.id, await memberOf(me, coursemate)));
    await db
      .update(kanSchema.workspaceMembers)
      .set({ deletedAt: now })
      .where(eq(kanSchema.workspaceMembers.id, await memberOf(me, community)));

    const home = await getHome(db, { userId: me.id, now });
    expect(home.scope.projects).toEqual([]);
  });

  it("refuses a project they are not in with the same answer as a missing one", async () => {
    await join(me, coursemate);
    const attempt = (projectPublicId: string) =>
      getHome(db, { userId: me.id, projectPublicId, now });

    await expect(attempt(community.publicId)).rejects.toEqual(
      new HubError("NOT_FOUND", "没有这个项目，或者你不在这个项目里。"),
    );
    await expect(attempt("doesnotexist")).rejects.toEqual(
      new HubError("NOT_FOUND", "没有这个项目，或者你不在这个项目里。"),
    );
  });
});

describe("getHome", () => {
  beforeEach(async () => {
    await join(me, coursemate);
    await join(me, echo);
  });

  it("counts open tasks per tile and lists mine soonest first", async () => {
    const dev = await seedBoard(coursemate, "开发");
    const ops = await seedBoard(echo, "活动");
    const mine = [{ user: me, project: coursemate }];
    await seedCard(dev.todo, "下周到期", { dueInDays: 6, assignees: mine });
    await seedCard(dev.doing, "已经逾期", {
      dueInDays: -2,
      assignees: mine,
    });
    await seedCard(dev.todo, "没有期限", { assignees: mine });
    await seedCard(dev.done, "做完了", {
      dueInDays: -5,
      assignees: mine,
    });
    await seedCard(ops.review, "别人的", { dueInDays: 30 });

    const home = await getHome(db, { userId: me.id, now });

    expect(home.tiles).toEqual({ mine: 3, dueSoon: 1, overdue: 1, open: 4 });
    expect(titles(home.myTasks)).toEqual(["已经逾期", "下周到期", "没有期限"]);
    expect(home.myTasks[0]).toMatchObject({
      dueState: "overdue",
      stage: "doing",
      functionKey: "dev",
      project: { publicId: coursemate.publicId, name: "CourseMate" },
      assignedToMe: true,
    });
    expect(home.myTasks[0]).not.toHaveProperty("sortDate");
  });

  it("caps the list of my tasks", async () => {
    const dev = await seedBoard(coursemate, "开发");
    for (let i = 0; i < HOME_MY_TASKS_LIMIT + 2; i += 1) {
      await seedCard(dev.todo, `任务 ${i}`, {
        assignees: [{ user: me, project: coursemate }],
      });
    }

    const home = await getHome(db, { userId: me.id, now });
    expect(home.myTasks).toHaveLength(HOME_MY_TASKS_LIMIT);
    expect(home.tiles.mine).toBe(HOME_MY_TASKS_LIMIT + 2);
  });

  it("narrows everything to one project", async () => {
    const dev = await seedBoard(coursemate, "开发");
    const echoDev = await seedBoard(echo, "开发");
    await seedCard(dev.todo, "CourseMate 的");
    await seedCard(echoDev.todo, "EchoAgent 的");

    const home = await getHome(db, {
      userId: me.id,
      projectPublicId: echo.publicId,
      now,
    });

    expect(home.scope.current).toEqual({
      publicId: echo.publicId,
      name: "EchoAgent",
    });
    expect(home.scope.projects).toHaveLength(2);
    expect(home.tiles.open).toBe(1);
  });

  it("leaves out templates, archived boards and deleted cards", async () => {
    const template = await seedBoard(coursemate, "开发", { type: "template" });
    const archived = await seedBoard(coursemate, "活动", { isArchived: true });
    const live = await seedBoard(coursemate, "营销");
    await seedCard(template.todo, "模板里的");
    await seedCard(archived.todo, "归档的");
    await seedCard(live.todo, "删掉的", { deleted: true });

    const home = await getHome(db, { userId: me.id, now });
    expect(home.tiles.open).toBe(0);
  });
});

describe("getTaskBoard", () => {
  beforeEach(async () => {
    await join(me, coursemate);
    await join(me, echo);
  });

  it("splits a view into columns, soonest due first", async () => {
    const dev = await seedBoard(coursemate, "开发");
    const echoDev = await seedBoard(echo, "开发");
    await seedCard(dev.todo, "晚", { dueInDays: 9 });
    await seedCard(echoDev.todo, "早", { dueInDays: 1 });
    await seedCard(dev.review, "验收中");
    await seedCard(dev.ideas, "改过名的列");

    const board = await getTaskBoard(db, { userId: me.id, view: "dev", now });

    expect(board.columns.map((c) => [c.stage, titles(c.tasks)])).toEqual([
      ["todo", ["早", "晚"]],
      ["doing", []],
      ["review", ["验收中"]],
      ["done", []],
      ["other", ["改过名的列"]],
    ]);
  });

  it("hides an empty other column and the done column of due views", async () => {
    const dev = await seedBoard(coursemate, "开发");
    await seedCard(dev.todo, "逾期", { dueInDays: -1 });

    const board = await getTaskBoard(db, {
      userId: me.id,
      view: "overdue",
      now,
    });

    expect(board.columns.map((c) => c.stage)).toEqual([
      "todo",
      "doing",
      "review",
    ]);
    expect(titles(board.columns[0]?.tasks ?? [])).toEqual(["逾期"]);
  });

  it("shows only the most recent finished tasks but reports the total", async () => {
    const dev = await seedBoard(coursemate, "开发");
    for (let i = 0; i < DONE_COLUMN_LIMIT + 1; i += 1) {
      await seedCard(dev.done, `完成 ${i}`, { updatedDaysAgo: i });
    }

    const board = await getTaskBoard(db, { userId: me.id, view: "all", now });
    const done = board.columns.find((c) => c.stage === "done");

    expect(done?.total).toBe(DONE_COLUMN_LIMIT + 1);
    expect(done?.tasks).toHaveLength(DONE_COLUMN_LIMIT);
    expect(done?.tasks[0]?.title).toBe("完成 0");
  });

  it("shows my tasks across projects, including finished ones", async () => {
    const dev = await seedBoard(coursemate, "开发");
    const echoOps = await seedBoard(echo, "活动");
    await seedCard(dev.doing, "我的 CourseMate", {
      assignees: [{ user: me, project: coursemate }],
    });
    await seedCard(echoOps.done, "我的 EchoAgent", {
      assignees: [{ user: me, project: echo }],
    });
    await seedCard(dev.todo, "不是我的", {
      assignees: [{ user: owner, project: coursemate }],
    });

    const board = await getTaskBoard(db, { userId: me.id, view: "mine", now });

    expect(board.columns.flatMap((c) => titles(c.tasks))).toEqual([
      "我的 CourseMate",
      "我的 EchoAgent",
    ]);
  });
});

describe("getTaskBoard with 只看我的", () => {
  beforeEach(async () => {
    await join(me, coursemate);
    await join(me, echo);
  });

  it("keeps only my tasks and counts only those", async () => {
    const dev = await seedBoard(coursemate, "开发");
    const mine = [{ user: me, project: coursemate }];
    await seedCard(dev.todo, "我的待办", { assignees: mine });
    await seedCard(dev.todo, "别人的待办");
    await seedCard(dev.review, "我的待验收", { assignees: mine });
    await seedCard(dev.ideas, "别人的灵感");

    const all = await getTaskBoard(db, { userId: me.id, view: "all", now });
    const board = await getTaskBoard(db, {
      userId: me.id,
      view: "all",
      onlyMine: true,
      now,
    });

    expect(all.onlyMine).toBe(false);
    expect(all.columns.map((c) => c.stage)).toContain("other");
    expect(board.onlyMine).toBe(true);
    expect(
      board.columns.map((c) => [c.stage, titles(c.tasks), c.total]),
    ).toEqual([
      ["todo", ["我的待办"], 1],
      ["doing", [], 0],
      ["review", ["我的待验收"], 1],
      ["done", [], 0],
    ]);
  });

  it("narrows before cutting the done column", async () => {
    const dev = await seedBoard(coursemate, "开发");
    await seedCard(dev.done, "别人刚完成的", { updatedDaysAgo: 0 });
    for (let i = 0; i < DONE_COLUMN_LIMIT + 1; i += 1) {
      await seedCard(dev.done, `我完成的 ${i}`, {
        updatedDaysAgo: i + 1,
        assignees: [{ user: me, project: coursemate }],
      });
    }

    const board = await getTaskBoard(db, {
      userId: me.id,
      view: "all",
      onlyMine: true,
      now,
    });
    const done = board.columns.find((c) => c.stage === "done");

    expect(done?.total).toBe(DONE_COLUMN_LIMIT + 1);
    expect(done?.tasks).toHaveLength(DONE_COLUMN_LIMIT);
    expect(done?.tasks[0]?.title).toBe("我完成的 0");
    expect(done?.tasks.every((task) => task.assignedToMe)).toBe(true);
  });

  it("works within one project and within any view", async () => {
    const dev = await seedBoard(coursemate, "开发");
    const echoDev = await seedBoard(echo, "开发");
    const echoOps = await seedBoard(echo, "活动");
    await seedCard(dev.todo, "我的 CourseMate", {
      assignees: [{ user: me, project: coursemate }],
    });
    await seedCard(echoDev.todo, "我的 EchoAgent 技术", {
      assignees: [{ user: me, project: echo }],
    });
    await seedCard(echoOps.todo, "我的 EchoAgent 活动", {
      assignees: [{ user: me, project: echo }],
    });
    await seedCard(echoDev.todo, "别人的 EchoAgent");

    const inEcho = await getTaskBoard(db, {
      userId: me.id,
      view: "all",
      projectPublicId: echo.publicId,
      onlyMine: true,
      now,
    });
    const devInEcho = await getTaskBoard(db, {
      userId: me.id,
      view: "dev",
      projectPublicId: echo.publicId,
      onlyMine: true,
      now,
    });

    expect(inEcho.columns.flatMap((c) => titles(c.tasks)).sort()).toEqual([
      "我的 EchoAgent 技术",
      "我的 EchoAgent 活动",
    ]);
    expect(devInEcho.columns.flatMap((c) => titles(c.tasks))).toEqual([
      "我的 EchoAgent 技术",
    ]);
  });
});

describe("what the task board lets someone do", () => {
  it("says per project whether they may create and edit tasks", async () => {
    await join(me, coursemate, "member");
    await join(me, echo, "guest");

    const board = await getTaskBoard(db, { userId: me.id, view: "all", now });

    expect(board.access[coursemate.publicId]).toMatchObject({
      canCreate: true,
      canEdit: true,
      canAddLists: true,
    });
    expect(board.access[echo.publicId]).toMatchObject({
      canCreate: false,
      canEdit: false,
      canAddLists: false,
    });
    expect(board.access[coursemate.publicId]?.memberPublicId).toHaveLength(12);
    expect(board.access[community.publicId]).toBeUndefined();
  });

  it("lists every board in scope with the list behind each column, cards or not", async () => {
    await join(me, coursemate);
    await seedBoard(coursemate, "营销");
    await seedBoard(coursemate, "开发");
    await seedBoard(coursemate, "Roadmap");
    await seedBoard(community, "开发");

    const board = await getTaskBoard(db, {
      userId: me.id,
      view: "all",
      projectPublicId: coursemate.publicId,
      now,
    });

    expect(board.boards.map((b) => b.name)).toEqual([
      "开发",
      "营销",
      "Roadmap",
    ]);
    expect(Object.keys(board.boards[0]?.listsByStage ?? {})).toEqual([
      "todo",
      "doing",
      "review",
      "done",
    ]);
    expect(board.boards[0]?.functionKey).toBe("dev");
    expect(board.boards[2]?.functionKey).toBeNull();
    // Nothing is missing on a standard board.
    expect(board.boards[0]?.newListIndex).toEqual({});
  });

  it("says where a board's missing columns would go, and reads 完成 as done", async () => {
    await join(me, community, "admin");
    const lists = await seedCustomBoard(community, "private", [
      "待办",
      "进行中",
      "卡住（暂停）",
      "完成",
      "每日日报",
    ]);
    await seedCard(lists.get("完成") ?? 0, "做完了的");

    const board = await getTaskBoard(db, {
      userId: me.id,
      view: "all",
      projectPublicId: community.publicId,
      now,
    });
    const target = board.boards.find((b) => b.name === "private");

    expect(Object.keys(target?.listsByStage ?? {})).toEqual([
      "todo",
      "doing",
      "done",
    ]);
    // 待验收 goes in front of 完成, after the list the board added itself.
    expect(target?.newListIndex).toEqual({ review: 3 });
    expect(
      board.columns.find((c) => c.stage === "done")?.tasks.map((t) => t.title),
    ).toEqual(["做完了的"]);
  });

  it("names the people a task is assigned to", async () => {
    await join(me, coursemate);
    await join(owner, coursemate, "admin");
    const dev = await seedBoard(coursemate, "开发");
    await seedCard(dev.todo, "两个人的任务", {
      assignees: [
        { user: me, project: coursemate },
        { user: owner, project: coursemate },
      ],
    });

    const board = await getTaskBoard(db, { userId: me.id, view: "all", now });
    const task = board.columns[0]?.tasks[0];

    expect(task?.assignees).toHaveLength(2);
    expect(task?.assignees.every((name) => name.length > 0)).toBe(true);
    expect(task?.assignedToMe).toBe(true);
  });
});

import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import * as kanSchema from "@kan/db/schema";

import type { Db } from "../db";
import type { ProjectRole } from "../schema";
import { getArchive } from "../archive/archive.service";
import { listExpiredArchivedCards } from "../kan/archived-tasks.gateway";
import { ensureProjectMember } from "../kan/members.gateway";
import { listTaskRows } from "../kan/tasks.gateway";
import { getSchedule, planTask } from "../schedule/schedule.service";
import { hubArchivedCards, hubAuditLog, hubPrivateBoards } from "../schema";
import { HubError } from "../shared/errors";
import {
  getArchivedTasks,
  getHome,
  getMyTasks,
  getTaskBoard,
} from "../tasks/task.service";
import { createHubTestDb, seedProject, seedUser } from "../testing/test-db";
import { deletionCutoff } from "./archived-task.policy";
import {
  archivedCardIds,
  archiveIfStillDue,
  archiveTask,
  deleteIfStillExpired,
  restoreTask,
  tidyTasks,
  tidyTasksIfDue,
} from "./archived-task.service";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const now = new Date("2026-10-26T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);
const daysLater = (days: number) => new Date(now.getTime() + days * DAY);

interface User {
  id: string;
  email: string;
}
interface Project {
  id: number;
  publicId: string;
  name: string;
}
interface Board {
  id: number;
  todo: number;
  done: number;
}

let db: Db;
let owner: User;
let me: User;
let project: Project;
let board: Board;
let uid = 0;
const nextId = () => `h${(uid += 1).toString().padStart(11, "0")}`;

async function seedBoard(
  options: { type?: "regular" | "template" } = {},
): Promise<Board> {
  const [row] = await db
    .insert(kanSchema.boards)
    .values({
      publicId: nextId(),
      name: "技术",
      slug: nextId(),
      workspaceId: project.id,
      createdBy: owner.id,
      type: options.type ?? "regular",
    })
    .returning({ id: kanSchema.boards.id });
  if (!row) throw new Error("no board");
  const ids: number[] = [];
  for (const [index, name] of ["待办", "已完成"].entries()) {
    const [list] = await db
      .insert(kanSchema.lists)
      .values({ publicId: nextId(), name, index, boardId: row.id })
      .returning({ id: kanSchema.lists.id });
    if (!list) throw new Error("no list");
    ids.push(list.id);
  }
  const [todo = 0, done = 0] = ids;
  return { id: row.id, todo, done };
}

interface Card {
  id: number;
  publicId: string;
}

/** A card in `listId`, assigned to me, created long ago. */
async function seedCard(listId: number, title: string): Promise<Card> {
  const publicId = nextId();
  const [card] = await db
    .insert(kanSchema.cards)
    .values({
      publicId,
      title,
      index: 0,
      listId,
      createdAt: daysAgo(60),
    })
    .returning({ id: kanSchema.cards.id });
  if (!card) throw new Error("no card");
  const [member] = await db
    .select({ id: kanSchema.workspaceMembers.id })
    .from(kanSchema.workspaceMembers)
    .where(
      and(
        eq(kanSchema.workspaceMembers.userId, me.id),
        eq(kanSchema.workspaceMembers.workspaceId, project.id),
      ),
    );
  if (member) {
    await db
      .insert(kanSchema.cardToWorkspaceMembers)
      .values({ cardId: card.id, workspaceMemberId: member.id });
  }
  return { id: card.id, publicId };
}

/** A card moved into 已完成 by me, `days` ago. */
async function finishedDaysAgo(
  days: number,
  title: string,
  on: Board = board,
): Promise<Card> {
  const card = await seedCard(on.done, title);
  await db.insert(kanSchema.cardActivities).values({
    publicId: nextId(),
    type: "card.updated.list",
    cardId: card.id,
    toListId: on.done,
    createdBy: me.id,
    createdAt: daysAgo(days),
  });
  return card;
}

const join = (user: User, role: ProjectRole = "member") =>
  ensureProjectMember(db, {
    userId: user.id,
    email: user.email,
    workspaceId: project.id,
    role,
    addedBy: owner.id,
  });

const actorOf = (user: User) => ({ userId: user.id, email: user.email });

const archive = (card: Card, by: User = me, at: Date = now) =>
  archiveTask(db, actorOf(by), { cardPublicId: card.publicId }, at);

const restore = (card: Card, by: User = me, at: Date = now) =>
  restoreTask(db, actorOf(by), { cardPublicId: card.publicId }, at);

/** The 操作日志, oldest first. */
const auditEntries = () =>
  db
    .select({
      actorEmail: hubAuditLog.actorEmail,
      action: hubAuditLog.action,
      entityId: hubAuditLog.entityId,
      summary: hubAuditLog.summary,
    })
    .from(hubAuditLog)
    .orderBy(asc(hubAuditLog.id));

async function boardTitles(user: User = me, at: Date = now) {
  const result = await getTaskBoard(db, {
    userId: user.id,
    view: "all",
    now: at,
  });
  return result.columns.flatMap((column) => column.tasks.map((t) => t.title));
}

async function archivedTitles(user: User = me, at: Date = now) {
  const result = await getArchivedTasks(db, { userId: user.id, now: at });
  return result.tasks.map((task) => task.title);
}

async function errorOf(work: Promise<unknown>): Promise<HubError> {
  const error: unknown = await work.then(
    () => null,
    (cause: unknown) => cause,
  );
  if (!(error instanceof HubError)) throw new Error("expected a HubError");
  return error;
}

async function deletionOf(card: Card) {
  const [row] = await db
    .select({
      deletedAt: kanSchema.cards.deletedAt,
      deletedBy: kanSchema.cards.deletedBy,
    })
    .from(kanSchema.cards)
    .where(eq(kanSchema.cards.id, card.id));
  return row;
}

beforeEach(async () => {
  db = await createHubTestDb();
  owner = await seedUser(db, { email: "owner@example.test" });
  me = await seedUser(db, { email: "me@example.test" });
  project = await seedProject(db, owner, { name: "CourseMate" });
  await join(me);
  board = await seedBoard();
});

describe("putting a task in 归档 by hand", () => {
  it("takes it off the board and the home page, into 归档", async () => {
    const card = await seedCard(board.todo, "不做了");
    await seedCard(board.todo, "还要做");

    await archive(card);

    expect(await boardTitles()).toEqual(["还要做"]);
    const home = await getHome(db, { userId: me.id, now });
    expect(home.tiles.open).toBe(1);
    expect(home.myTasks.map((t) => t.title)).toEqual(["还要做"]);

    const archived = await getArchivedTasks(db, { userId: me.id, now });
    expect(archived.tasks).toHaveLength(1);
    expect(archived.tasks[0]).toMatchObject({
      title: "不做了",
      archivedAt: now,
      automatic: false,
      deletesAt: daysLater(7),
    });
    expect(archived.access[project.publicId]).toMatchObject({
      canEdit: true,
    });
  });

  it("changes nothing when the task is already there", async () => {
    const card = await seedCard(board.todo, "不做了");
    await archive(card);
    await archive(card, me, daysLater(2));

    const archived = await getArchivedTasks(db, { userId: me.id, now });
    expect(archived.tasks[0]?.archivedAt).toEqual(now);
  });

  it("is refused to someone who may not edit tasks in the project", async () => {
    const guest = await seedUser(db, { email: "guest@example.test" });
    await join(guest, "guest");
    const card = await seedCard(board.todo, "任务");

    expect((await errorOf(archive(card, guest))).code).toBe("FORBIDDEN");
    expect(await boardTitles()).toEqual(["任务"]);
  });

  it("answers NOT_FOUND outside the project and on a board they cannot see", async () => {
    const stranger = await seedUser(db, { email: "stranger@example.test" });
    const card = await seedCard(board.todo, "任务");
    expect((await errorOf(archive(card, stranger))).code).toBe("NOT_FOUND");

    const hidden = await seedBoard();
    await db
      .insert(hubPrivateBoards)
      .values({ boardId: hidden.id, ownerUserId: owner.id, audience: "owner" });
    const secret = await seedCard(hidden.todo, "私人任务");
    expect((await errorOf(archive(secret))).code).toBe("NOT_FOUND");
    expect(await archivedTitles()).toEqual([]);
  });
});

describe("who may delete a task", () => {
  it("follows Kan: the project's card:delete, or having created the card", async () => {
    const guest = await seedUser(db, { email: "guest@example.test" });
    await join(guest, "guest");
    await seedCard(board.todo, "别人建的");
    await db.insert(kanSchema.cards).values({
      publicId: nextId(),
      title: "访客自己建的",
      index: 1,
      listId: board.todo,
      createdBy: guest.id,
    });

    const flags = async (user: User) =>
      (await getTaskBoard(db, { userId: user.id, view: "all", now })).columns
        .flatMap((column) => column.tasks)
        .map((task) => [task.title, task.canDelete])
        .sort();

    expect(await flags(guest)).toEqual(
      [
        ["别人建的", false],
        ["访客自己建的", true],
      ].sort(),
    );
    expect(await flags(me)).toEqual(
      [
        ["别人建的", true],
        ["访客自己建的", true],
      ].sort(),
    );
  });
});

describe("bringing a task back", () => {
  it("puts it back on its board", async () => {
    const card = await seedCard(board.todo, "又要做了");
    await archive(card);

    await restore(card);

    expect(await boardTitles()).toEqual(["又要做了"]);
    expect(await archivedTitles()).toEqual([]);
  });

  it("is a conflict when the task is not in 归档", async () => {
    const card = await seedCard(board.todo, "任务");
    expect((await errorOf(restore(card))).code).toBe("CONFLICT");
  });

  it("is refused to someone who may not edit tasks in the project", async () => {
    const guest = await seedUser(db, { email: "guest@example.test" });
    await join(guest, "guest");
    const card = await seedCard(board.todo, "任务");
    await archive(card);

    expect((await errorOf(restore(card, guest))).code).toBe("FORBIDDEN");
  });
});

describe("the clean-up", () => {
  it("puts tasks finished three days ago in 归档, on their own", async () => {
    await finishedDaysAgo(3, "三天前完成");
    await finishedDaysAgo(2, "两天前完成");
    await seedCard(board.todo, "很久以前的待办");

    expect(await tidyTasks(db, now)).toEqual({ archived: 1, deleted: 0 });

    expect((await boardTitles()).sort()).toEqual(
      ["两天前完成", "很久以前的待办"].sort(),
    );
    const archived = await getArchivedTasks(db, { userId: me.id, now });
    expect(archived.tasks.map((t) => [t.title, t.automatic])).toEqual([
      ["三天前完成", true],
    ]);
  });

  it("leaves templates alone", async () => {
    const template = await seedBoard({ type: "template" });
    await finishedDaysAgo(30, "模板里的卡片", template);

    expect(await tidyTasks(db, now)).toEqual({ archived: 0, deleted: 0 });
  });

  it("gives a restored task its full wait again", async () => {
    const card = await finishedDaysAgo(10, "恢复过");
    await tidyTasks(db, now);
    await restore(card, me, now);

    expect((await tidyTasks(db, daysLater(2))).archived).toBe(0);
    expect(await boardTitles(me, daysLater(2))).toEqual(["恢复过"]);
    expect((await tidyTasks(db, daysLater(3))).archived).toBe(1);
  });

  it("deletes a task seven days after it went to 归档", async () => {
    const card = await seedCard(board.todo, "不做了");
    await archive(card);

    expect((await tidyTasks(db, daysLater(6.9))).deleted).toBe(0);
    expect(await deletionOf(card)).toEqual({
      deletedAt: null,
      deletedBy: null,
    });

    const later = daysLater(7);
    expect((await tidyTasks(db, later)).deleted).toBe(1);
    expect(await deletionOf(card)).toEqual({
      deletedAt: later,
      deletedBy: null,
    });
    expect(await archivedTitles(me, later)).toEqual([]);
    expect(await boardTitles(me, later)).toEqual([]);

    // Once is enough.
    expect((await tidyTasks(db, daysLater(8))).deleted).toBe(0);
  });

  it("keeps a finished task in 我完成的 after deleting it", async () => {
    await finishedDaysAgo(3, "做完了");
    await tidyTasks(db, now);
    await tidyTasks(db, daysLater(7));

    const done = await getArchive(db, {
      userId: me.id,
      timeZone: "Australia/Sydney",
      now: daysLater(7),
    });
    expect(done.total).toBe(1);
    expect(done.recent[0]?.task).toMatchObject({
      title: "做完了",
      deleted: true,
    });
  });

  it("does not bring back to 我完成的 a task someone deleted by hand", async () => {
    const card = await finishedDaysAgo(3, "删掉的");
    await tidyTasks(db, now);
    await db
      .update(kanSchema.cards)
      .set({ deletedAt: daysLater(1), deletedBy: me.id })
      .where(eq(kanSchema.cards.id, card.id));

    expect((await tidyTasks(db, daysLater(7))).deleted).toBe(0);
    const done = await getArchive(db, {
      userId: me.id,
      timeZone: "Australia/Sydney",
      now: daysLater(7),
    });
    expect(done.total).toBe(0);
  });

  it("runs at most once an hour when pages trigger it", async () => {
    await finishedDaysAgo(3, "做完了");

    expect(await tidyTasksIfDue(db, now)).toEqual({ archived: 1, deleted: 0 });
    expect(await tidyTasksIfDue(db, new Date(now.getTime() + HOUR - 1))).toBe(
      null,
    );
    expect(await tidyTasksIfDue(db, new Date(now.getTime() + HOUR))).toEqual({
      archived: 0,
      deleted: 0,
    });
  });
});

describe("other places that read tasks", () => {
  it("keep archived tasks in my calendar's history but not in what to plan", async () => {
    const card = await seedCard(board.todo, "不做了");
    await archive(card);

    expect(
      (await getMyTasks(db, { userId: me.id, now })).map((t) => t.title),
    ).toEqual(["不做了"]);
    const schedule = await getSchedule(db, {
      userId: me.id,
      from: daysAgo(1),
      to: daysLater(6),
      now,
    });
    expect(schedule.openTasks).toEqual([]);

    const refused = await errorOf(
      planTask(
        db,
        me.id,
        {
          cardPublicId: card.publicId,
          startsAt: daysLater(1),
          endsAt: new Date(daysLater(1).getTime() + HOUR),
        },
        now,
      ),
    );
    expect(refused.code).toBe("INVALID_INPUT");
  });

  it("leave archived tasks out of the plain task rows (催一下 reads these)", async () => {
    const card = await seedCard(board.todo, "不做了");
    await seedCard(board.todo, "还要做");
    await archive(card);

    const rows = await listTaskRows(db, [project.id], me.id);
    expect(rows.map((row) => row.title)).toEqual(["还要做"]);
    const all = await listTaskRows(db, [project.id], me.id, { archived: true });
    expect(all.map((row) => row.title).sort()).toEqual(
      ["不做了", "还要做"].sort(),
    );
  });

  it("give Kan's board page the cards to leave out", async () => {
    const card = await seedCard(board.todo, "不做了");
    await seedCard(board.todo, "还要做");
    await archive(card);

    expect(await archivedCardIds(db, project.id)).toEqual([card.id]);
    await restore(card);
    expect(await archivedCardIds(db, project.id)).toEqual([]);
  });
});

describe("the calendar after the clean-up", () => {
  it("keeps time already spent on a task the clean-up deleted", async () => {
    const card = await seedCard(board.todo, "排过时间");
    const startsAt = daysLater(1);
    const endsAt = new Date(startsAt.getTime() + HOUR);
    await planTask(
      db,
      me.id,
      { cardPublicId: card.publicId, startsAt, endsAt },
      now,
    );
    await archive(card, me, daysLater(2));
    await tidyTasks(db, daysLater(9));
    expect((await deletionOf(card))?.deletedAt).toEqual(daysLater(9));

    const schedule = await getSchedule(db, {
      userId: me.id,
      from: now,
      to: daysLater(7),
      now: daysLater(9),
    });
    expect(schedule.blocks.map((b) => [b.kind, b.title])).toEqual([
      ["task", "排过时间"],
    ]);
    expect(schedule.openTasks).toEqual([]);
    expect(
      (
        await errorOf(
          planTask(
            db,
            me.id,
            {
              cardPublicId: card.publicId,
              startsAt: daysLater(10),
              endsAt: new Date(daysLater(10).getTime() + HOUR),
            },
            daysLater(9),
          ),
        )
      ).code,
    ).toBe("INVALID_INPUT");
  });

  it("drops a task someone deleted by hand, as before", async () => {
    const card = await seedCard(board.todo, "手动删了");
    const startsAt = daysLater(1);
    await planTask(
      db,
      me.id,
      {
        cardPublicId: card.publicId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR),
      },
      now,
    );
    await db
      .update(kanSchema.cards)
      .set({ deletedAt: daysLater(2), deletedBy: me.id })
      .where(eq(kanSchema.cards.id, card.id));

    const schedule = await getSchedule(db, {
      userId: me.id,
      from: now,
      to: daysLater(7),
      now: daysLater(3),
    });
    expect(schedule.blocks).toEqual([]);
  });
});

describe("races and leftovers", () => {
  it("keeps a task that was restored after the clean-up listed it", async () => {
    const card = await seedCard(board.todo, "差点被删");
    await archive(card);
    const later = daysLater(7);
    expect(await listExpiredArchivedCards(db, deletionCutoff(later))).toEqual([
      card.id,
    ]);

    await restore(card, me, later);

    expect(await deleteIfStillExpired(db, card.id, later)).toBe(false);
    expect(await deletionOf(card)).toEqual({
      deletedAt: null,
      deletedBy: null,
    });
    expect(await boardTitles(me, later)).toEqual(["差点被删"]);
  });

  it("leaves nothing to restore once the clean-up deleted the task", async () => {
    const card = await seedCard(board.todo, "删了");
    await archive(card);
    const later = daysLater(7);

    expect(await deleteIfStillExpired(db, card.id, later)).toBe(true);
    // The card is gone, so it is as if it never existed.
    expect((await errorOf(restore(card, me, later))).code).toBe("NOT_FOUND");
  });

  it("keeps a task reopened after the clean-up picked it", async () => {
    const card = await finishedDaysAgo(5, "又要改");
    // Reopened between the clean-up's first look and its write.
    await db
      .update(kanSchema.cards)
      .set({ listId: board.todo })
      .where(eq(kanSchema.cards.id, card.id));

    expect(await archiveIfStillDue(db, [card.id], now)).toBe(0);
    expect(await boardTitles()).toEqual(["又要改"]);
  });

  it("keeps a task moved out of 已完成 and back since it was picked", async () => {
    const card = await finishedDaysAgo(5, "刚又做完");
    await db.insert(kanSchema.cardActivities).values({
      publicId: nextId(),
      type: "card.updated.list",
      cardId: card.id,
      toListId: board.done,
      createdBy: me.id,
      createdAt: daysAgo(0.1),
    });

    expect(await archiveIfStillDue(db, [card.id], now)).toBe(0);
    expect(await archiveIfStillDue(db, [card.id], daysLater(3))).toBe(1);
  });

  it("leaves a task someone deleted by hand after it was listed as theirs", async () => {
    const card = await seedCard(board.todo, "刚手动删掉");
    await archive(card);
    const later = daysLater(7);
    expect(await listExpiredArchivedCards(db, deletionCutoff(later))).toEqual([
      card.id,
    ]);
    const byHand = daysLater(7.5);
    await db
      .update(kanSchema.cards)
      .set({ deletedAt: byHand, deletedBy: me.id })
      .where(eq(kanSchema.cards.id, card.id));

    expect(await deleteIfStillExpired(db, card.id, daysLater(8))).toBe(false);
    expect(await deletionOf(card)).toEqual({
      deletedAt: byHand,
      deletedBy: me.id,
    });
    const [row] = await db
      .select({ autoDeletedAt: hubArchivedCards.autoDeletedAt })
      .from(hubArchivedCards);
    expect(row?.autoDeletedAt).toBeNull();
  });

  it("does not delete tasks on a board archived since", async () => {
    const card = await seedCard(board.todo, "看板归档了");
    await archive(card);
    await db
      .update(kanSchema.boards)
      .set({ isArchived: true })
      .where(eq(kanSchema.boards.id, board.id));

    expect((await tidyTasks(db, daysLater(8))).deleted).toBe(0);
    expect(await deletionOf(card)).toEqual({
      deletedAt: null,
      deletedBy: null,
    });
  });
});

describe("the 操作日志", () => {
  it("records every move in and out of 归档, by whom, without the title", async () => {
    const card = await seedCard(board.todo, "秘密任务");
    await archive(card);
    await archive(card); // already there: nothing to record
    await restore(card);
    const done = await finishedDaysAgo(3, "做完了");
    await tidyTasks(db, now);
    await tidyTasks(db, daysLater(7));

    const entries = await auditEntries();
    expect(entries.map((e) => [e.actorEmail, e.action, e.entityId])).toEqual([
      [me.email, "task.archived", card.publicId],
      [me.email, "task.restored", card.publicId],
      ["auto-tidy", "task.auto_archived", done.publicId],
      ["auto-tidy", "task.auto_deleted", done.publicId],
    ]);
    expect(entries.some((e) => e.summary.includes("秘密"))).toBe(false);
  });
});

describe("the table", () => {
  it("drops the row with its card", async () => {
    const card = await seedCard(board.todo, "不做了");
    await archive(card);
    await db.delete(kanSchema.cards).where(eq(kanSchema.cards.id, card.id));

    expect(await db.select().from(hubArchivedCards)).toEqual([]);
  });
});

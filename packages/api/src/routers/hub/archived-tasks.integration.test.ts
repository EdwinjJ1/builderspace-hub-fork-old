import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { dbClient } from "@kan/db/client";
import * as kanSchema from "@kan/db/schema";
import { createHubTestDb, seedProject, seedUser } from "@kan/hub/testing";

import { appRouter } from "../../root";
import {
  callerContext,
  createHubCaller,
  ensureProjectMemberForTests,
} from "./test-helpers";

// Kan's import router reads this when the whole API is loaded.
vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ??= "archived-tasks-integration-test";
});

// Each test boots an in-memory Postgres and applies every migration.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * 归档 through the real API: `hub.tasks.archive` and `restore`, the clean-up
 * the task pages run first, and Kan's own board pages leaving archived cards
 * out (the hub-seam in board.ts / board.repo.ts). The rules themselves are
 * tested in @kan/hub.
 */

interface User {
  id: string;
  email: string;
}

const DAY = 24 * 60 * 60 * 1000;
const WORKSPACE_SLUG = "coursemate";
const BOARD_SLUG = "dev";

let db: dbClient;
let owner: User;
let member: User;
let project: { id: number; publicId: string };
let board: { publicId: string; todo: number; done: number };
let uid = 0;
const nextId = () => `j${(uid += 1).toString().padStart(11, "0")}`;

const asApp = (user: User | null) =>
  appRouter.createCaller(callerContext(db, user));

beforeEach(async () => {
  db = await createHubTestDb();
  owner = await seedUser(db, { email: "owner@example.test" });
  member = await seedUser(db, { email: "member@example.test" });
  project = await seedProject(db, owner, {
    name: "CourseMate",
    slug: WORKSPACE_SLUG,
  });
  await ensureProjectMemberForTests(db, member, project.id, "member");

  const publicId = nextId();
  const [row] = await db
    .insert(kanSchema.boards)
    .values({
      publicId,
      name: "技术",
      slug: BOARD_SLUG,
      workspaceId: project.id,
      createdBy: owner.id,
      visibility: "public",
    })
    .returning({ id: kanSchema.boards.id });
  if (!row) throw new Error("no board");
  const lists: number[] = [];
  for (const [index, name] of ["待办", "已完成"].entries()) {
    const [list] = await db
      .insert(kanSchema.lists)
      .values({ publicId: nextId(), name, index, boardId: row.id })
      .returning({ id: kanSchema.lists.id });
    if (!list) throw new Error("no list");
    lists.push(list.id);
  }
  const [todo = 0, done = 0] = lists;
  board = { publicId, todo, done };
});

async function seedCard(listId: number, title: string, index = 0) {
  const publicId = nextId();
  const [card] = await db
    .insert(kanSchema.cards)
    .values({ publicId, title, index, listId, createdBy: owner.id })
    .returning({ id: kanSchema.cards.id });
  if (!card) throw new Error("no card");
  return { id: card.id, publicId };
}

/** The titles on Kan's own board page, as the given user sees it. */
async function kanBoardTitles(user: User) {
  const result = await asApp(user).board.byId({
    boardPublicId: board.publicId,
  });
  return result.lists.flatMap((list) => list.cards.map((card) => card.title));
}

async function publicBoardTitles() {
  const result = await asApp(null).board.bySlug({
    workspaceSlug: WORKSPACE_SLUG,
    boardSlug: BOARD_SLUG,
  });
  return (result?.lists ?? []).flatMap((list) =>
    list.cards.map((card) => card.title),
  );
}

describe("hub.tasks.archive and restore", () => {
  it("take a card off Kan's board pages and put it back", async () => {
    const card = await seedCard(board.todo, "不做了", 0);
    await seedCard(board.todo, "还要做", 1);
    const hub = createHubCaller(db, member);

    await hub.tasks.archive({ cardPublicId: card.publicId });

    expect(await kanBoardTitles(member)).toEqual(["还要做"]);
    expect(await publicBoardTitles()).toEqual(["还要做"]);
    const archived = await hub.tasks.archived({});
    expect(archived.tasks.map((t) => [t.title, t.canDelete])).toEqual([
      ["不做了", true],
    ]);
    expect(archived.access[project.publicId]).toMatchObject({ canEdit: true });

    await hub.tasks.restore({ cardPublicId: card.publicId });

    expect(await kanBoardTitles(member)).toEqual(["不做了", "还要做"]);
    expect((await hub.tasks.archived({})).tasks).toEqual([]);
  });

  it("refuses people outside the project and guests", async () => {
    const card = await seedCard(board.todo, "任务");
    const stranger = await seedUser(db, { email: "stranger@example.test" });
    const guest = await seedUser(db, { email: "guest@example.test" });
    await ensureProjectMemberForTests(db, guest, project.id, "guest");

    await expect(
      createHubCaller(db, stranger).tasks.archive({
        cardPublicId: card.publicId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      createHubCaller(db, guest).tasks.archive({
        cardPublicId: card.publicId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lets Kan's delete remove a card from 归档", async () => {
    const card = await seedCard(board.todo, "删掉");
    const hub = createHubCaller(db, member);
    await hub.tasks.archive({ cardPublicId: card.publicId });

    await asApp(owner).card.delete({ cardPublicId: card.publicId });

    expect((await hub.tasks.archived({})).tasks).toEqual([]);
  });
});

describe("the clean-up", () => {
  it("runs when the board is loaded, putting old finished work in 归档", async () => {
    const card = await seedCard(board.done, "上周做完的");
    await db.insert(kanSchema.cardActivities).values({
      publicId: nextId(),
      type: "card.updated.list",
      cardId: card.id,
      toListId: board.done,
      createdBy: member.id,
      createdAt: new Date(Date.now() - 4 * DAY),
    });
    await seedCard(board.done, "刚做完的");
    const hub = createHubCaller(db, member);

    const onBoard = await hub.tasks.board({ view: "all" });
    expect(
      onBoard.columns.flatMap((column) => column.tasks.map((t) => t.title)),
    ).toEqual(["刚做完的"]);

    const archived = await hub.tasks.archived({});
    expect(archived.tasks.map((t) => [t.title, t.automatic])).toEqual([
      ["上周做完的", true],
    ]);

    const [row] = await db
      .select({ deletedAt: kanSchema.cards.deletedAt })
      .from(kanSchema.cards)
      .where(eq(kanSchema.cards.id, card.id));
    expect(row?.deletedAt).toBeNull();
  });
});

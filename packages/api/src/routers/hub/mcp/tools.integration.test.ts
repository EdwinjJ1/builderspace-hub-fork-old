import { beforeEach, describe, expect, it, vi } from "vitest";

import type { dbClient } from "@kan/db/client";
import type * as Documents from "@kan/hub/documents";
import * as kanSchema from "@kan/db/schema";
import { mcpTools } from "@kan/hub/mcp";
import {
  createHubTestDb,
  MemoryDocumentStorage,
  seedHubAccount,
  seedProject,
  seedUser,
} from "@kan/hub/testing";

import type { McpToolName } from "./tools";
import { ensureProjectMemberForTests } from "../test-helpers";
import { createMcpCaller, mcpToolImplementations, runMcpTool } from "./tools";

// Each test boots an in-memory Postgres and applies every migration.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Loading the whole router loads Kan's import routes, which need a key at once.
vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ??= "mcp-tools-integration-test";
});

vi.mock("@kan/hub/documents", async (importOriginal) => {
  const actual = await importOriginal<typeof Documents>();
  const storage = new MemoryDocumentStorage();
  return { ...actual, getDocumentStorage: () => storage };
});

/**
 * The MCP tools against a real database, as real people: the permission
 * checks are the procedures' own, so what this checks is that a tool asks
 * the right procedure the right thing and shapes the answer.
 */

interface Person {
  id: string;
  email: string;
}

let db: dbClient;
let owner: Person;
let member: Person;
let club: { id: number; publicId: string; name: string };
let other: { id: number; publicId: string; name: string };
let devBoard: string;
let uid = 0;
const nextId = () => `m${(uid += 1).toString().padStart(11, "0")}`;

const asUser = (person: Person) => ({
  id: person.id,
  email: person.email,
  name: person.email.split("@")[0] ?? "",
  emailVerified: false,
  createdAt: new Date(),
  updatedAt: new Date(),
});

async function call(person: Person, name: McpToolName, args: unknown = {}) {
  return runMcpTool(name, createMcpCaller(db, asUser(person)), args);
}

async function value(person: Person, name: McpToolName, args: unknown = {}) {
  const outcome = await call(person, name, args);
  if (!outcome.ok) throw new Error(`${name} refused: ${outcome.message}`);
  return outcome.value as Record<string, unknown>;
}

/** The message a refused call comes back with. */
async function refusal(person: Person, name: McpToolName, args: unknown = {}) {
  const outcome = await call(person, name, args);
  if (outcome.ok) throw new Error(`${name} was not refused`);
  return outcome.message;
}

async function seedBoard(
  project: { id: number },
  name: string,
  lists: string[],
): Promise<string> {
  const publicId = nextId();
  const [board] = await db
    .insert(kanSchema.boards)
    .values({
      publicId,
      name,
      slug: nextId(),
      workspaceId: project.id,
      createdBy: owner.id,
    })
    .returning({ id: kanSchema.boards.id });
  if (!board) throw new Error("no board");
  for (const [index, listName] of lists.entries()) {
    await db
      .insert(kanSchema.lists)
      .values({ publicId: nextId(), name: listName, index, boardId: board.id });
  }
  return publicId;
}

beforeEach(async () => {
  db = await createHubTestDb();
  owner = await seedUser(db, { email: "owner@example.test" });
  member = await seedUser(db, { email: "member@example.test" });
  await seedHubAccount(db, owner.id, { role: "owner" });
  club = await seedProject(db, owner, { name: "BuilderSpace 社团" });
  other = await seedProject(db, owner, { name: "EchoAgent" });
  await ensureProjectMemberForTests(db, member, club.id, "member");
  devBoard = await seedBoard(club, "技术", ["待办", "进行中", "已完成"]);
});

describe("the tool list", () => {
  it("implements exactly the catalogued tools", () => {
    expect(Object.keys(mcpToolImplementations).sort()).toEqual(
      mcpTools.map((tool) => tool.name).sort(),
    );
  });
});

describe("tasks", () => {
  it("creates, lists, moves, comments on and edits a task as the member", async () => {
    const me = await value(member, "whoami");
    expect(me).toMatchObject({ email: member.email, role: null });
    expect(me.projects).toEqual([{ publicId: club.publicId, name: club.name }]);

    const created = await value(member, "task_create", {
      board: devBoard,
      title: "写周报",
      due_date: "2026-11-02",
      assign_to_me: true,
    });

    const board = await value(member, "task_board", { view: "mine" });
    const todo = (board.columns as { stage: string; tasks: unknown[] }[]).find(
      (column) => column.stage === "todo",
    );
    expect(todo?.tasks).toEqual([
      expect.objectContaining({
        publicId: created.publicId,
        title: "写周报",
        assignedToMe: true,
        dueDate: new Date("2026-11-02T12:00:00Z"),
      }),
    ]);
    expect(board.boards).toEqual([
      expect.objectContaining({
        publicId: devBoard,
        function: "dev",
        stages: ["todo", "doing", "done"],
        canCreate: true,
      }),
    ]);

    await value(member, "task_move", {
      task: created.publicId,
      stage: "doing",
    });
    await value(member, "task_comment", {
      task: created.publicId,
      comment: "开始写了",
    });
    await value(member, "task_update", {
      task: created.publicId,
      title: "写第 8 周周报",
      due_date: null,
    });

    const task = await value(member, "task_get", { task: created.publicId });
    expect(task).toMatchObject({
      title: "写第 8 周周报",
      stage: "doing",
      list: "进行中",
      dueDate: null,
      project: club.publicId,
      assignees: [expect.objectContaining({ email: member.email })],
    });
    expect(task.comments).toEqual([
      expect.objectContaining({ text: "开始写了" }),
    ]);
  });

  it("says so when a board has no list for the column", async () => {
    const created = await value(member, "task_create", {
      board: devBoard,
      title: "x",
    });
    expect(
      await call(member, "task_move", {
        task: created.publicId,
        stage: "review",
      }),
    ).toEqual({ ok: false, message: "看板「技术」没有「待验收」这一列" });
    expect(
      await refusal(member, "task_create", {
        board: devBoard,
        stage: "review",
        title: "x",
      }),
    ).toContain("待验收");
  });

  it("does not reach into a project the member is not in", async () => {
    const hidden = await seedBoard(other, "技术", ["待办"]);
    expect(
      await refusal(member, "task_create", { board: hidden, title: "x" }),
    ).toContain("找不到");

    const theirs = await value(owner, "task_create", {
      board: hidden,
      title: "别人的任务",
    });
    expect(
      await call(member, "task_get", { task: theirs.publicId }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      await call(member, "home_summary", { project: other.publicId }),
    ).toMatchObject({ ok: false });
  });

  it("explains Kan's English refusals in Chinese", async () => {
    expect(await refusal(member, "task_get", { task: "doesnotexist1" })).toBe(
      "找不到：id 不对，或者当前账号看不到它（Card with public ID doesnotexist1 not found）",
    );
  });

  it("refuses arguments that do not fit, with the reason", async () => {
    expect(
      await call(member, "task_create", {
        board: devBoard,
        title: "x",
        due_date: "next friday",
      }),
    ).toEqual({
      ok: false,
      message: "日期要写成 YYYY-MM-DD，或带时区的完整时间",
    });
    expect(await call(member, "task_move", { task: "abc" })).toMatchObject({
      ok: false,
    });
  });
});

describe("documents", () => {
  it("lets an owner write a document only editors see, and refuses a stale save", async () => {
    const created = await value(owner, "doc_create", {
      title: "讲稿",
      content: "# 讲稿\n",
    });

    const listed = await value(member, "doc_list");
    expect(listed.documents).toEqual([]);

    const read = await value(owner, "doc_read", { document: created.publicId });
    expect(read).toMatchObject({
      title: "讲稿",
      filename: "讲稿.md",
      audience: "editors",
      content: "# 讲稿\n",
    });

    expect(
      await call(owner, "doc_update", {
        document: created.publicId,
        content: "新内容",
        expected_updated_at: "2020-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({ ok: false });

    expect(
      await value(owner, "doc_update", {
        document: created.publicId,
        content: "新内容",
        expected_updated_at: read.updatedAt,
        title: "讲稿 v2",
      }),
    ).toEqual({
      publicId: created.publicId,
      contentChanged: true,
      titleChanged: true,
    });
    expect(
      await call(owner, "doc_update", { document: created.publicId }),
    ).toEqual({ ok: false, message: "没有要改的内容" });
  });

  it("lets a reader change the content of a document open to readers, and refuses a title change without writing anything", async () => {
    const created = await value(owner, "doc_create", {
      title: "营销灵感",
      content: "# 素材\n",
      audience: "all",
    });
    await createMcpCaller(db, asUser(owner)).hub.documents.update({
      documentPublicId: created.publicId as string,
      editAccess: "readers",
    });

    const listed = (await value(member, "doc_list")).documents as {
      editAccess: string;
      canEdit: boolean;
      canEditContent: boolean;
    }[];
    expect(listed).toMatchObject([
      { editAccess: "readers", canEdit: false, canEditContent: true },
    ]);
    const read = await value(member, "doc_read", {
      document: created.publicId,
    });
    expect(read).toMatchObject({ editAccess: "readers", canEditText: true });

    expect(
      await refusal(member, "doc_update", {
        document: created.publicId,
        content: "# 素材\n\n- 不该存进去\n",
        title: "别的标题",
      }),
    ).toContain("这次什么都没改");
    expect(
      await value(owner, "doc_read", { document: created.publicId }),
    ).toMatchObject({ title: "营销灵感", content: "# 素材\n" });

    expect(
      await value(member, "doc_update", {
        document: created.publicId,
        content: "# 素材\n\n- 好钩子\n",
        expected_updated_at: read.updatedAt,
      }),
    ).toEqual({
      publicId: created.publicId,
      contentChanged: true,
      titleChanged: false,
    });
  });

  it("shares a document with one department of a project, and only its people read it", async () => {
    const colleague = await seedUser(db, { email: "colleague@example.test" });
    await ensureProjectMemberForTests(db, colleague, club.id, "member");

    const options = (await value(owner, "doc_audience_options")) as {
      departments: { publicId: string; name: string }[];
    };
    const tech = options.departments.find((d) => d.name === "技术");
    if (!tech) throw new Error("no 技术 department");

    await value(owner, "department_set_member", {
      department: tech.publicId,
      project: club.publicId,
      user_id: member.id,
      member: true,
    });
    const created = await value(owner, "doc_create", {
      title: "技术周会",
      content: "议程",
      audience: "selected",
      readers: {
        groups: [{ project: club.publicId, department: tech.publicId }],
      },
    });
    expect(created.audience).toBe("selected");

    const titles = async (person: Person) =>
      ((await value(person, "doc_list")).documents as { title: string }[]).map(
        (d) => d.title,
      );
    expect(await titles(member)).toEqual(["技术周会"]);
    expect(await titles(colleague)).toEqual([]);

    const read = await value(owner, "doc_read", { document: created.publicId });
    expect(read.audience).toBe("selected");
    expect(JSON.stringify(read.readers)).toContain("技术");
  });

  it("lets a document go to everyone, and asks who when it is selected", async () => {
    await value(owner, "doc_create", {
      title: "社团章程",
      content: "x",
      audience: "all",
    });
    expect(
      ((await value(member, "doc_list")).documents as { title: string }[]).map(
        (d) => d.title,
      ),
    ).toEqual(["社团章程"]);
    expect(
      await refusal(owner, "doc_create", {
        title: "x",
        content: "y",
        audience: "selected",
      }),
    ).toContain("readers");
  });

  it("leaves creating documents to owners and admins", async () => {
    expect(
      await refusal(member, "doc_create", { title: "x", content: "y" }),
    ).toContain("新建文档");
  });
});

describe("the back office", () => {
  it("is refused to an ordinary member even if they call it by name", async () => {
    expect(await call(member, "account_list")).toEqual({
      ok: false,
      message: "没有执行这个操作的权限",
    });
    expect(
      await call(member, "account_set_project_role", {
        user_id: member.id,
        project: other.publicId,
        role: "member",
      }),
    ).toMatchObject({ ok: false });
  });

  it("lets an owner put someone in a project, and logs it as them", async () => {
    const projects = await value(owner, "project_list");
    expect(projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ publicId: other.publicId }),
      ]),
    );

    await value(owner, "account_set_project_role", {
      user_id: member.id,
      project: other.publicId,
      role: "guest",
    });
    const account = await value(owner, "account_get", { user_id: member.id });
    expect(JSON.stringify(account)).toContain(other.publicId);

    const audit = await value(owner, "audit_list");
    expect(audit.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "account.project_role_changed",
          actorEmail: owner.email,
        }),
      ]),
    );

    expect(await value(owner, "admin_overview")).toMatchObject({ projects: 2 });
    expect(
      await value(owner, "account_list", { search: "member" }),
    ).toMatchObject({ total: 1 });
    expect(await value(owner, "grant_list")).toMatchObject({ items: [] });
  });

  it("shows departments to back-office members and leaves changes to those who manage accounts", async () => {
    const directory = await value(owner, "department_list");
    expect(
      (directory.departments as { name: string }[]).map((d) => d.name),
    ).toEqual(expect.arrayContaining(["技术", "活动", "运营"]));
    expect(await refusal(member, "department_list")).toBe(
      "没有执行这个操作的权限",
    );
    const first = (directory.departments as { publicId: string }[])[0];
    expect(
      await refusal(member, "department_set_member", {
        department: first?.publicId,
        project: club.publicId,
        user_id: member.id,
        member: true,
      }),
    ).toBe("没有执行这个操作的权限");
  });

  it("answers plainly when the website's database is not connected", async () => {
    await seedHubAccount(db, owner.id, { role: "owner", siteAccess: "manage" });
    expect(await call(owner, "volunteer_list")).toEqual({
      ok: false,
      message: "还没有连接官网数据库",
    });
  });
});

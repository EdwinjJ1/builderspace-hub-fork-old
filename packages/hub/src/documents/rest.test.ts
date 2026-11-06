import { beforeEach, describe, expect, it } from "vitest";

import type { AdminActor } from "../accounts/account.service";
import type { Db } from "../db";
import type { RestRequest } from "./rest";
import { MemoryDocumentStorage } from "../testing/memory-storage";
import { createHubTestDb, seedHubAccount, seedUser } from "../testing/test-db";
import { handleDocumentsRest, statusOfHubError } from "./rest";

let db: Db;
let storage: MemoryDocumentStorage;
let owner: AdminActor;
let member: AdminActor;

const actorOf = (
  user: { id: string; email: string },
  role: AdminActor["role"],
): AdminActor => ({ userId: user.id, email: user.email, role });

beforeEach(async () => {
  db = await createHubTestDb();
  storage = new MemoryDocumentStorage();
  const [o, m] = await Promise.all([
    seedUser(db, { name: "Olivia" }),
    seedUser(db, { name: "Mia" }),
  ]);
  await seedHubAccount(db, o.id, { role: "owner" });
  owner = actorOf(o, "owner");
  member = actorOf(m, null);
});

const call = (
  actor: AdminActor,
  method: string,
  path: string,
  body?: unknown,
  query: Record<string, string> = {},
) =>
  handleDocumentsRest(db, storage, actor, {
    method,
    segments: path.split("/").filter(Boolean),
    query,
    body,
  } satisfies RestRequest);

const create = async (extra: Record<string, unknown> = {}) => {
  const response = await call(owner, "POST", "/", {
    title: "讲稿",
    filename: "讲稿.md",
    content: "# 讲稿",
    ...extra,
  });
  return response.body as { publicId: string; readable: boolean };
};

describe("creating and reading", () => {
  it("creates a text document and returns it as the API describes a document", async () => {
    const response = await call(owner, "POST", "/", {
      title: "讲稿",
      filename: "讲稿.md",
      content: "# 讲稿",
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      title: "讲稿",
      filename: "讲稿.md",
      ext: "md",
      readable: true,
      canEdit: true,
      folderPublicId: null,
    });
    expect(typeof (response.body as { updatedAt: string }).updatedAt).toBe(
      "string",
    );
  });

  it("creates a hidden document that members cannot see or fetch", async () => {
    const doc = await create({ readable: false });
    expect(doc.readable).toBe(false);

    const list = await call(member, "GET", "/");
    expect((list.body as { documents: unknown[] }).documents).toHaveLength(0);
    await expect(call(member, "GET", `/${doc.publicId}`)).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    await expect(
      call(member, "GET", `/${doc.publicId}/content`),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists, searches and reads content", async () => {
    const doc = await create();
    const list = await call(member, "GET", "/", undefined, { search: "讲" });
    expect(
      (list.body as { documents: { publicId: string }[] }).documents[0]
        ?.publicId,
    ).toBe(doc.publicId);

    const content = await call(member, "GET", `/${doc.publicId}/content`);
    expect(content.body).toMatchObject({ content: "# 讲稿" });
  });
});

describe("changing", () => {
  it("replaces content and patches details; only editors may", async () => {
    const doc = await create();
    expect(
      (
        await call(owner, "PUT", `/${doc.publicId}/content`, {
          content: "新内容",
        })
      ).body,
    ).toEqual({
      changed: true,
    });
    const patched = await call(owner, "PATCH", `/${doc.publicId}`, {
      title: "新标题",
      readable: false,
    });
    expect(patched.body).toMatchObject({ title: "新标题", readable: false });

    await expect(
      call(member, "PUT", `/${doc.publicId}/content`, { content: "x" }),
    ).rejects.toBeDefined();
    await expect(
      call(member, "PATCH", `/${doc.publicId}`, { title: "x" }),
    ).rejects.toBeDefined();
  });

  it("opens the content to every reader with editAccess, and only the content", async () => {
    const doc = await create();
    const patched = await call(owner, "PATCH", `/${doc.publicId}`, {
      editAccess: "readers",
    });
    expect(patched.body).toMatchObject({
      editAccess: "readers",
      canEdit: true,
      canEditContent: true,
    });

    expect((await call(member, "GET", `/${doc.publicId}`)).body).toMatchObject({
      editAccess: "readers",
      canEdit: false,
      canEditContent: true,
    });
    expect(
      (
        await call(member, "PUT", `/${doc.publicId}/content`, {
          content: "成员加的",
        })
      ).body,
    ).toEqual({ changed: true });
    await expect(
      call(member, "PATCH", `/${doc.publicId}`, { title: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(owner, "PATCH", `/${doc.publicId}`, { editAccess: "everyone" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses a content save made on a stale copy", async () => {
    const doc = await create();
    const opened = (await call(owner, "GET", `/${doc.publicId}/content`))
      .body as { updatedAt: string };
    await call(owner, "PUT", `/${doc.publicId}/content`, {
      content: "别人先改",
    });
    await expect(
      call(owner, "PUT", `/${doc.publicId}/content`, {
        content: "我后改",
        expectedUpdatedAt: opened.updatedAt,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (
        (await call(owner, "GET", `/${doc.publicId}/content`)).body as {
          content: string;
        }
      ).content,
    ).toBe("别人先改");
  });

  it("only moves a document into a folder that exists", async () => {
    const doc = await create();
    await expect(
      call(owner, "PATCH", `/${doc.publicId}`, {
        folderPublicId: "nope00000000",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const folder = await call(owner, "POST", "/folders", { name: "合同" });
    expect(folder.status).toBe(201);
    // The name comes back as stored, not as typed.
    const spaced = await call(owner, "POST", "/folders", { name: "  A   B  " });
    expect((spaced.body as { name: string }).name).toBe("A B");
    const moved = await call(owner, "PATCH", `/${doc.publicId}`, {
      folderPublicId: (folder.body as { publicId: string }).publicId,
    });
    expect((moved.body as { folderPublicId: string }).folderPublicId).toBe(
      (folder.body as { publicId: string }).publicId,
    );
  });
});

describe("who can read it", () => {
  const titlesFor = async (actor: AdminActor) =>
    (
      (await call(actor, "GET", "/")).body as {
        documents: { title: string }[];
      }
    ).documents.map((doc) => doc.title);

  it("creates a document for 指定的人 that only they and its editors can read", async () => {
    const reader = actorOf(await seedUser(db, { name: "Rita" }), null);
    const doc = await create({
      audience: { kind: "selected", userIds: [reader.userId] },
    });
    expect(doc).toMatchObject({ readable: false, audience: "selected" });

    expect(await titlesFor(reader)).toEqual(["讲稿"]);
    expect(await titlesFor(member)).toEqual([]);
    await expect(
      call(member, "GET", `/${doc.publicId}/content`),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("moves a document between everyone, 指定的人 and editors only; the detail names the readers", async () => {
    const reader = actorOf(await seedUser(db, { name: "Rita" }), null);
    const doc = await create();

    const shared = await call(owner, "PATCH", `/${doc.publicId}`, {
      audience: { kind: "selected", userIds: [reader.userId] },
    });
    expect(shared.body).toMatchObject({
      readable: false,
      audience: "selected",
      readers: { users: [{ userId: reader.userId, name: "Rita" }], groups: [] },
    });
    // The list of 指定的人 is for the people who can change it.
    expect((await call(reader, "GET", `/${doc.publicId}`)).body).toMatchObject({
      audience: "selected",
      readers: null,
    });

    const hidden = await call(owner, "PATCH", `/${doc.publicId}`, {
      audience: { kind: "editors" },
    });
    expect(hidden.body).toMatchObject({ audience: "editors" });
    expect(await titlesFor(reader)).toEqual([]);

    const open = await call(owner, "PATCH", `/${doc.publicId}`, {
      audience: { kind: "all" },
    });
    expect(open.body).toMatchObject({ readable: true, audience: "all" });
    expect(await titlesFor(member)).toEqual(["讲稿"]);
  });

  it("refuses 指定的人 with nobody in it, and people who do not exist", async () => {
    const doc = await create();
    await expect(
      call(owner, "PATCH", `/${doc.publicId}`, {
        audience: { kind: "selected" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      call(owner, "PATCH", `/${doc.publicId}`, {
        audience: {
          kind: "selected",
          userIds: ["00000000-0000-4000-8000-000000000000"],
        },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(member, "PATCH", `/${doc.publicId}`, {
        audience: { kind: "all" },
      }),
    ).rejects.toBeDefined();
  });

  it("lists who 指定的人 can be, only for people who can choose", async () => {
    const options = await call(owner, "GET", "/audience-options");
    expect(options.status).toBe(200);
    const body = options.body as {
      projects: unknown[];
      departments: { name: string }[];
    };
    expect(body.projects).toEqual([]);
    expect(body.departments.map((d) => d.name)).toContain("技术");
    await expect(
      call(member, "GET", "/audience-options"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await call(owner, "POST", "/audience-options")).status).toBe(405);
  });
});

describe("what used to be uploads and downloads", () => {
  it("is gone: there is no upload or download address any more", async () => {
    // "uploads" is now read as a document id, and a document id takes no POST.
    expect(
      (await call(owner, "POST", "/uploads", { filename: "a.md", size: 4 }))
        .status,
    ).toBe(405);
    expect(
      (await call(owner, "POST", "/uploads/abc/complete", {})).status,
    ).toBe(404);
    const doc = await create();
    expect((await call(owner, "GET", `/${doc.publicId}/download`)).status).toBe(
      404,
    );
  });
});

describe("what the API does not offer", () => {
  it("has no delete and no editor management, even for an owner", async () => {
    const doc = await create();
    expect((await call(owner, "DELETE", `/${doc.publicId}`)).status).toBe(405);
    expect((await call(owner, "DELETE", "/folders")).status).toBe(405);
    expect(
      (await call(owner, "POST", `/${doc.publicId}/editors`, { userId: "x" }))
        .status,
    ).toBe(404);
    expect((await call(owner, "GET", `/${doc.publicId}/requests`)).status).toBe(
      404,
    );
  });

  it("answers an unknown path with 404 and a wrong method with 405", async () => {
    expect((await call(owner, "PUT", "/")).status).toBe(405);
    expect((await call(owner, "GET", "/a/b/c/d")).status).toBe(404);
  });
});

describe("bad input", () => {
  it("rejects malformed bodies with a message", async () => {
    await expect(call(owner, "POST", "/", { title: 1 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      call(owner, "POST", "/", {
        title: "t",
        filename: "t.md",
        content: "x",
        readable: "no",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      call(owner, "POST", "/", { title: "t", filename: "t.pdf", content: "x" }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("maps every error code to a status", () => {
    expect(statusOfHubError("INVALID_INPUT")).toBe(400);
    expect(statusOfHubError("FORBIDDEN")).toBe(403);
    expect(statusOfHubError("NOT_FOUND")).toBe(404);
    expect(statusOfHubError("CONFLICT")).toBe(409);
    expect(statusOfHubError("UNAVAILABLE")).toBe(503);
  });
});

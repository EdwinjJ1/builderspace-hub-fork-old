import { beforeEach, describe, expect, it } from "vitest";

import type { AdminActor } from "../accounts/account.service";
import type { Db } from "../db";
import type { AudienceChoice } from "./audience.service";
import { listAudit } from "../audit";
import {
  getDepartmentDirectory,
  setDepartmentMember,
} from "../departments/department.service";
import { ensureProjectMember } from "../kan/members.gateway";
import { MemoryDocumentStorage } from "../testing/memory-storage";
import {
  createHubTestDb,
  seedHubAccount,
  seedProject,
  seedUser,
} from "../testing/test-db";
import { grantEditor, requestEdit } from "./access.service";
import { deleteDocument, updateDocument } from "./document.service";
import { getDocumentDetail, getLibrary } from "./library.service";
import {
  createTextDocument,
  readTextContent,
  replaceTextContent,
} from "./text.service";

let db: Db;
let storage: MemoryDocumentStorage;
let owner: AdminActor;
let admin: AdminActor;
/** In CourseMate, and in its 技术 department. */
let dev: AdminActor;
/** In CourseMate, in no department. */
let plain: AdminActor;
let courseMate: { id: number; publicId: string };
let techPublicId: string;

const actorOf = (
  user: { id: string; email: string },
  role: AdminActor["role"],
): AdminActor => ({ userId: user.id, email: user.email, role });

beforeEach(async () => {
  db = await createHubTestDb();
  storage = new MemoryDocumentStorage();
  const [o, a, d, p] = await Promise.all([
    seedUser(db, { name: "Olivia" }),
    seedUser(db, { name: "Adam" }),
    seedUser(db, { name: "Dev" }),
    seedUser(db, { name: "Pat" }),
  ]);
  await seedHubAccount(db, o.id, { role: "owner" });
  await seedHubAccount(db, a.id, { role: "admin" });
  owner = actorOf(o, "owner");
  admin = actorOf(a, "admin");
  dev = actorOf(d, null);
  plain = actorOf(p, null);

  courseMate = await seedProject(db, a, { name: "CourseMate" });
  for (const person of [dev, plain]) {
    await ensureProjectMember(db, {
      workspaceId: courseMate.id,
      userId: person.userId,
      email: person.email,
      role: "member",
      addedBy: admin.userId,
    });
  }
  const directory = await getDepartmentDirectory(db, admin);
  const tech = directory.departments.find((d) => d.name === "技术");
  if (!tech) throw new Error("no 技术 department");
  techPublicId = tech.publicId;
  await setDepartmentMember(db, admin, {
    departmentPublicId: techPublicId,
    projectPublicId: courseMate.publicId,
    userId: dev.userId,
    member: true,
  });
});

/** A document the admin wrote (so they are its editor), read by every member. */
const make = async (audience?: AudienceChoice) =>
  (
    await createTextDocument(db, storage, admin, {
      title: "营销灵感",
      filename: "营销灵感.md",
      content: "# 素材",
      audience,
    })
  ).publicId;

const write = (actor: AdminActor, publicId: string, content: string) =>
  replaceTextContent(db, storage, actor, {
    documentPublicId: publicId,
    content,
  });

const detailOf = (actor: AdminActor, publicId: string) =>
  getDocumentDetail(db, storage, actor, publicId);

describe("谁能改", () => {
  it("is only the assigned people at first: a member asks", async () => {
    const doc = await make();

    expect(await detailOf(plain, doc)).toMatchObject({
      editAccess: "assigned",
      canEdit: false,
      canEditContent: false,
      canEditText: false,
      canRequestEdit: true,
    });
    await expect(write(plain, doc, "改")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("opened to readers, lets every member change the content and nothing else", async () => {
    const doc = await make();
    await updateDocument(db, admin, {
      documentPublicId: doc,
      editAccess: "readers",
    });

    expect(await detailOf(plain, doc)).toMatchObject({
      editAccess: "readers",
      canEdit: false,
      canEditContent: true,
      canEditText: true,
      canRequestEdit: false,
      myRequest: null,
      readers: null,
      folderOptions: [],
    });
    expect(await write(plain, doc, "# 素材\n\n- 好钩子")).toEqual({
      changed: true,
    });
    expect((await readTextContent(db, storage, owner, doc)).content).toBe(
      "# 素材\n\n- 好钩子",
    );
    expect(
      (await getLibrary(db, storage, plain, {})).documents[0],
    ).toMatchObject({
      editAccess: "readers",
      canEdit: false,
      canEditContent: true,
    });

    // The details, who reads and edits it, deleting it and edit rights stay
    // with its editors.
    for (const change of [
      { title: "别的" },
      { audience: { kind: "editors" } as const },
      { editAccess: "assigned" } as const,
    ]) {
      await expect(
        updateDocument(db, plain, { documentPublicId: doc, ...change }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(deleteDocument(db, storage, plain, doc)).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    await expect(
      grantEditor(db, plain, { documentPublicId: doc, userId: dev.userId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Nothing left to ask for.
    await expect(
      requestEdit(db, plain, { documentPublicId: doc }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const actions = (await listAudit(db, { limit: 10, offset: 0 })).map(
      (entry) => [entry.action, entry.summary],
    );
    expect(actions).toContainEqual([
      "document.edit_access_changed",
      "「营销灵感」设为能看的人都能改内容",
    ]);
    expect(actions).toContainEqual([
      "document.file_replaced",
      "修改了「营销灵感」的内容",
    ]);
  });

  it("still refuses a save made on a stale copy, now that many can write", async () => {
    const doc = await make();
    await updateDocument(db, admin, {
      documentPublicId: doc,
      editAccess: "readers",
    });
    const { updatedAt } = await readTextContent(db, storage, plain, doc);
    await write(dev, doc, "Dev 先存");

    await expect(
      replaceTextContent(db, storage, plain, {
        documentPublicId: doc,
        content: "Pat 后存",
        expectedUpdatedAt: updatedAt.toISOString(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("follows 指定的人: only the people listed can change it, while they are listed", async () => {
    const doc = await make({
      kind: "selected",
      userIds: [],
      groups: [
        {
          projectPublicId: courseMate.publicId,
          departmentPublicId: techPublicId,
        },
      ],
    });
    await updateDocument(db, admin, {
      documentPublicId: doc,
      editAccess: "readers",
    });

    expect(await write(dev, doc, "技术部加的")).toEqual({ changed: true });
    // Pat is in the project but not in 技术: cannot even see it.
    await expect(write(plain, doc, "x")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await setDepartmentMember(db, admin, {
      departmentPublicId: techPublicId,
      projectPublicId: courseMate.publicId,
      userId: dev.userId,
      member: false,
    });
    await expect(write(dev, doc, "x")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("goes back to the assigned people when switched back", async () => {
    const doc = await make();
    await updateDocument(db, admin, {
      documentPublicId: doc,
      editAccess: "readers",
    });
    await updateDocument(db, admin, {
      documentPublicId: doc,
      editAccess: "assigned",
    });

    await expect(write(plain, doc, "x")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await detailOf(plain, doc)).canRequestEdit).toBe(true);
    const [latest] = await listAudit(db, { limit: 1, offset: 0 });
    expect(latest).toMatchObject({
      action: "document.edit_access_changed",
      summary: "「营销灵感」设为只有所有者和被指派的人能改",
    });
  });

  it("closes with 谁能看: a document only its editors read is never open", async () => {
    const doc = await make();
    await updateDocument(db, admin, {
      documentPublicId: doc,
      editAccess: "readers",
    });

    // The command line's form: readable false is editors only.
    await updateDocument(db, admin, { documentPublicId: doc, readable: false });
    expect((await detailOf(admin, doc)).editAccess).toBe("assigned");
    // Opened to every member again, it does not come back open.
    await updateDocument(db, admin, {
      documentPublicId: doc,
      audience: { kind: "all" },
    });
    expect((await detailOf(plain, doc)).editAccess).toBe("assigned");
    await expect(write(plain, doc, "x")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("cannot be opened while only its editors can read it", async () => {
    const doc = await make({ kind: "editors" });
    await expect(
      updateDocument(db, admin, {
        documentPublicId: doc,
        editAccess: "readers",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      updateDocument(db, admin, {
        documentPublicId: doc,
        audience: { kind: "all" },
        editAccess: "readers",
      }),
    ).resolves.toBeUndefined();
    expect((await detailOf(plain, doc)).canEditContent).toBe(true);
  });

  it("is changed by any of its editors, and only they", async () => {
    const doc = await make();
    await expect(
      updateDocument(db, owner, {
        documentPublicId: doc,
        editAccess: "readers",
      }),
    ).resolves.toBeUndefined();

    // A member assigned to it may change it too.
    await updateDocument(db, owner, {
      documentPublicId: doc,
      editAccess: "assigned",
    });
    await grantEditor(db, owner, { documentPublicId: doc, userId: dev.userId });
    await updateDocument(db, dev, {
      documentPublicId: doc,
      editAccess: "readers",
    });
    expect((await detailOf(plain, doc)).canEditContent).toBe(true);
  });
});

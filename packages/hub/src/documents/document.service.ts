import { z } from "zod";

import { createLogger } from "@kan/logger";

import type { AdminActor } from "../accounts/account.service";
import type { Db } from "../db";
import type { AudienceChoice } from "./audience.service";
import type { ReaderTarget } from "./document.policy";
import type { DocumentSource, DocumentStorage } from "./storage";
import { recordAudit, withAudit } from "../audit";
import { HubError } from "../shared/errors";
import { audienceSchema, resolveAudience } from "./audience.service";
import { loadReadable, requireEdit } from "./document.guard";
import {
  audienceOf,
  contentDisposition,
  DESCRIPTION_MAX_LENGTH,
  normaliseName,
  readerTargetKey,
  TITLE_MAX_LENGTH,
  viewContentType,
} from "./document.policy";
import {
  deleteDocument as deleteDocumentRow,
  findFolder,
  listReaders,
  replaceReaders,
  updateDocument as updateDocumentRow,
} from "./document.repo";

const log = createLogger("hub-documents");

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HubError(
      "INVALID_INPUT",
      result.error.issues[0]?.message ?? "输入不对",
    );
  }
  return result.data;
}

export function requireStorage(
  storage: DocumentStorage | null,
): DocumentStorage {
  if (!storage) {
    throw new HubError("UNAVAILABLE", "文档存储不可用");
  }
  return storage;
}

/** Deleting a file nobody points at any more must never fail the request. */
export async function discardObject(
  storage: DocumentStorage | null,
  key: string,
): Promise<void> {
  if (!storage) return;
  await storage.delete(key).catch((error: unknown) => {
    log.warn({ err: error, key }, "Could not delete a stored document file");
  });
}

const titleSchema = z
  .string()
  .transform((value) => normaliseName(value, TITLE_MAX_LENGTH))
  .refine((value): value is string => value !== null, {
    message: `标题要填写，最多 ${TITLE_MAX_LENGTH} 个字`,
  });

const descriptionSchema = z
  .string()
  .max(DESCRIPTION_MAX_LENGTH, `说明最多 ${DESCRIPTION_MAX_LENGTH} 个字`)
  .transform((value) => value.trim() || null);

const idSchema = z.string().min(1).max(32);

/* ── changing ────────────────────────────────────────────────────────── */

const updateSchema = z.object({
  documentPublicId: idSchema,
  title: titleSchema.optional(),
  description: descriptionSchema.nullish(),
  /** `null` moves it to the top level. */
  folderPublicId: idSchema.nullish(),
  /** Who can read it. */
  audience: audienceSchema.optional(),
  /**
   * The older on/off form of `audience`, still sent by the command line:
   * true is every member, false only the editors. Ignored when `audience` is
   * given, and when it matches the switch already (so a document shared with
   * 指定的人 stays that way).
   */
  readable: z.boolean().optional(),
  /** Who can change the content: the assigned editors, or every reader too. */
  editAccess: z.enum(["assigned", "readers"]).optional(),
});

export async function updateDocument(
  db: Db,
  actor: AdminActor,
  rawInput: z.input<typeof updateSchema>,
  now: Date = new Date(),
): Promise<void> {
  const input = parse(updateSchema, rawInput);
  const access = await loadReadable(db, actor, input.documentPublicId);
  requireEdit(access);
  const { row } = access;

  const patch: Parameters<typeof updateDocumentRow>[2] = {};
  const changes: string[] = [];

  if (input.title !== undefined && input.title !== row.title) {
    patch.title = input.title;
    changes.push(`标题改为「${input.title}」`);
  }
  if (input.description !== undefined) {
    const next = input.description ?? null;
    if (next !== row.description) {
      patch.description = next;
      changes.push("修改了说明");
    }
  }
  if (input.folderPublicId !== undefined) {
    const folder = input.folderPublicId
      ? await findFolder(db, input.folderPublicId)
      : null;
    if (input.folderPublicId && !folder) {
      throw new HubError("NOT_FOUND", "找不到这个文件夹");
    }
    if ((folder?.id ?? null) !== row.folderId) {
      patch.folderId = folder?.id ?? null;
      changes.push(folder ? `移到文件夹「${folder.name}」` : "移到最上层");
    }
  }
  let choice: AudienceChoice | undefined = input.audience;
  if (
    !choice &&
    input.readable !== undefined &&
    input.readable !== row.readable
  ) {
    choice = { kind: input.readable ? "all" : "editors" };
  }
  const audience = choice ? await resolveAudience(db, choice) : null;
  const before = await listReaders(db, [row.id]);
  const sameTargets = (targets: readonly ReaderTarget[]) =>
    targets.length === before.length &&
    new Set([...targets, ...before].map(readerTargetKey)).size ===
      before.length;
  const audienceChanged =
    audience !== null &&
    (audience.readable !== row.readable || !sameTargets(audience.targets));
  if (audienceChanged) patch.readable = audience.readable;

  // Opening the content to its readers needs readers besides the editors, so
  // it is switched off with them (能看的人都能改 never outlives 谁能看).
  const audienceAfter = audienceChanged
    ? audienceOf({
        readable: audience.readable,
        hasReaders: audience.targets.length > 0,
      })
    : audienceOf({ readable: row.readable, hasReaders: before.length > 0 });
  if (input.editAccess === "readers" && audienceAfter === "editors") {
    throw new HubError(
      "INVALID_INPUT",
      "只有能修改的人能看时，没有别人可以放开修改；先把「谁能看」改成所有成员或指定的人",
    );
  }
  const readersCanEdit =
    (input.editAccess === undefined
      ? row.readersCanEdit
      : input.editAccess === "readers") && audienceAfter !== "editors";
  const editAccessChanged = readersCanEdit !== row.readersCanEdit;
  if (editAccessChanged) patch.readersCanEdit = readersCanEdit;

  if (changes.length === 0 && !audienceChanged && !editAccessChanged) return;

  await db.transaction(async (tx) => {
    await updateDocumentRow(tx, row.id, patch, now);
    if (changes.length > 0) {
      await recordAudit(tx, {
        actor,
        action: "document.updated",
        entityType: "document",
        entityId: row.publicId,
        summary: `「${row.title}」：${changes.join("，")}`,
      });
    }
    if (audienceChanged) {
      await replaceReaders(tx, row.id, audience.targets);
      await recordAudit(tx, {
        actor,
        action: "document.readable_changed",
        entityType: "document",
        entityId: row.publicId,
        summary: `「${row.title}」${audience.summary}`,
        detail: audience.chosen,
      });
    }
    if (editAccessChanged) {
      await recordAudit(tx, {
        actor,
        action: "document.edit_access_changed",
        entityType: "document",
        entityId: row.publicId,
        summary: readersCanEdit
          ? `「${row.title}」设为能看的人都能改内容`
          : `「${row.title}」设为只有所有者和被指派的人能改`,
      });
    }
  });
}

export async function deleteDocument(
  db: Db,
  storage: DocumentStorage | null,
  actor: AdminActor,
  documentPublicId: string,
): Promise<void> {
  const access = await loadReadable(db, actor, documentPublicId);
  requireEdit(access);
  const { row } = access;

  await withAudit(
    db,
    (tx) => deleteDocumentRow(tx, row.id),
    () => ({
      actor,
      action: "document.deleted",
      entityType: "document",
      entityId: row.publicId,
      summary: `删除了「${row.title}」（${row.filename}）`,
    }),
  );
  await discardObject(storage, row.storageKey);
}

/* ── viewing and downloading ─────────────────────────────────────────── */

export type OpenMode = "view" | "download";

export interface OpenedDocument {
  source: DocumentSource;
  /** What the browser is told the bytes are. */
  contentType: string;
  disposition: string;
  /** How it will be shown, so the route can add the right protections. */
  mode: OpenMode;
  ext: string;
}

/**
 * Hands a signed-in reader the document's bytes to stream. Viewing is only for formats we know how to show safely; those are
 * served as the type we decide, never the one the author claimed.
 */
export async function openDocument(
  db: Db,
  storage: DocumentStorage | null,
  actor: AdminActor,
  input: { documentPublicId: string; mode: OpenMode },
): Promise<OpenedDocument> {
  const store = requireStorage(storage);
  const { row } = await loadReadable(db, actor, input.documentPublicId);

  let contentType = row.contentType;
  if (input.mode === "view") {
    const viewType = viewContentType(row.ext);
    if (!viewType) {
      throw new HubError("INVALID_INPUT", "这种格式不能在线预览");
    }
    contentType = viewType;
  }
  const disposition = contentDisposition(
    input.mode === "view" ? "inline" : "attachment",
    row.filename,
  );

  const source = await store.open({ key: row.storageKey });
  return { source, contentType, disposition, mode: input.mode, ext: row.ext };
}

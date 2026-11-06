import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { generateUID } from "@kan/shared/utils";

import type { AdminActor } from "../accounts/account.service";
import type { Db } from "../db";
import type { DocumentStorage } from "./storage";
import { withAudit } from "../audit";
import { HubError } from "../shared/errors";
import { audienceSchema, resolveAudience } from "./audience.service";
import {
  loadReadable,
  requireEditContent,
  requireUserId,
} from "./document.guard";
import {
  canCreateDocument,
  DESCRIPTION_MAX_LENGTH,
  inspectFile,
  MAX_TEXT_BYTES,
  normaliseName,
  previewKindOf,
  storageKeyFor,
  TITLE_MAX_LENGTH,
} from "./document.policy";
import {
  addEditor,
  findFolder,
  insertDocument,
  replaceReaders,
  updateDocumentIfUnchanged,
  updateDocument as updateDocumentRow,
} from "./document.repo";
import { discardObject, requireStorage } from "./document.service";

/**
 * Documents (Markdown and HTML) written and changed in the page's editor, or
 * sent from the command line. They go through the same
 * rules as every other document: who may create, who may change, the format
 * allowlist, the audit log.
 */

const idSchema = z.string().min(1).max(32);

const createSchema = z.object({
  title: z
    .string()
    .transform((value) => normaliseName(value, TITLE_MAX_LENGTH))
    .refine((value): value is string => value !== null, {
      message: `标题要填写，最多 ${TITLE_MAX_LENGTH} 个字`,
    }),
  filename: z.string().min(1, "文件名要填写").max(300),
  content: z.string(),
  description: z
    .string()
    .max(DESCRIPTION_MAX_LENGTH, `说明最多 ${DESCRIPTION_MAX_LENGTH} 个字`)
    .transform((value) => value.trim() || null)
    .nullish(),
  folderPublicId: idSchema.nullish(),
  /** Who can read it; every member when left out. */
  audience: audienceSchema.optional(),
  /** The command line's on/off form of `audience`; ignored when that is given. */
  readable: z.boolean().optional(),
});

const replaceSchema = z.object({
  documentPublicId: idSchema,
  content: z.string(),
  /**
   * The `updatedAt` the editor was opened with. When given, the save is
   * refused if someone changed the document since, instead of silently
   * overwriting their change.
   */
  expectedUpdatedAt: z
    .string()
    .datetime({ message: "修改时间的格式不对" })
    .transform((value) => new Date(value))
    .optional(),
});

const STALE = "这份文档在你打开之后被别人改过了，请刷新后再改";

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

/** The bytes of some text, or a refusal when it is empty or too large. */
function textBytes(content: string): Buffer {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length === 0) throw new HubError("INVALID_INPUT", "内容是空的");
  if (bytes.length > MAX_TEXT_BYTES) {
    throw new HubError(
      "INVALID_INPUT",
      `文本文档最大 ${MAX_TEXT_BYTES / 1024} KB，这份太大了`,
    );
  }
  return bytes;
}

/** Creates a text document from its content. Returns its public id. */
export async function createTextDocument(
  db: Db,
  storage: DocumentStorage | null,
  actor: AdminActor,
  rawInput: z.input<typeof createSchema>,
  now: Date = new Date(),
): Promise<{ publicId: string }> {
  const store = requireStorage(storage);
  const userId = requireUserId(actor);
  if (!canCreateDocument(actor.role)) {
    throw new HubError("FORBIDDEN", "只有所有者和管理员能新建文档");
  }
  const input = parse(createSchema, rawInput);

  const bytes = textBytes(input.content);
  const file = inspectFile({ filename: input.filename, size: bytes.length });
  if (!file.ok) throw new HubError("INVALID_INPUT", file.reason);

  const folder = input.folderPublicId
    ? await findFolder(db, input.folderPublicId)
    : null;
  if (input.folderPublicId && !folder) {
    throw new HubError("NOT_FOUND", "找不到这个文件夹");
  }
  const audience = input.audience
    ? await resolveAudience(db, input.audience)
    : null;

  const key = storageKeyFor(file.ext, randomUUID());
  await store.put({ key, body: bytes, contentType: file.contentType });

  try {
    return await withAudit(
      db,
      async (tx) => {
        const created = await insertDocument(tx, {
          publicId: generateUID(),
          folderId: folder?.id ?? null,
          title: input.title,
          description: input.description ?? null,
          filename: file.displayName,
          ext: file.ext,
          contentType: file.contentType,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          storageKey: key,
          readable: audience?.readable ?? input.readable ?? true,
          readersCanEdit: false,
          uploadedBy: userId,
          now,
        });
        await addEditor(tx, {
          documentId: created.id,
          userId,
          grantedBy: userId,
        });
        if (audience) await replaceReaders(tx, created.id, audience.targets);
        return { publicId: created.publicId };
      },
      (result) => ({
        actor,
        action: "document.created",
        entityType: "document",
        entityId: result.publicId,
        summary:
          audience && !audience.readable
            ? `新建了「${input.title}」（${file.displayName}），${audience.summary}`
            : `新建了「${input.title}」（${file.displayName}）`,
        ...(audience ? { detail: audience.chosen } : {}),
      }),
    );
  } catch (error) {
    await discardObject(store, key);
    throw error;
  }
}

/** The text of a text document, for someone who may read it. */
export async function readTextContent(
  db: Db,
  storage: DocumentStorage | null,
  actor: AdminActor,
  documentPublicId: string,
): Promise<{ content: string; updatedAt: Date }> {
  const store = requireStorage(storage);
  const { row } = await loadReadable(db, actor, documentPublicId);
  if (row.size > MAX_TEXT_BYTES) {
    throw new HubError("INVALID_INPUT", "这份文档太大，不能在这里读取，请下载");
  }
  const bytes = await store.read(row.storageKey);
  let content: string;
  try {
    // Strict: a file in another encoding (GBK, UTF-16) must not be shown with
    // replacement characters, because saving it again would write them back.
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HubError(
      "INVALID_INPUT",
      "这份文档不是 UTF-8 编码的文本，不能在线读取或修改，请下载后用本机软件修改",
    );
  }
  return { content, updatedAt: row.updatedAt };
}

/**
 * Replaces the content of a text document. Needs the right to change its
 * content: an editor's, or a reader's when it is open to them. The
 * old object is removed once the new one is in place, so a failure never
 * leaves the document pointing at nothing.
 */
export async function replaceTextContent(
  db: Db,
  storage: DocumentStorage | null,
  actor: AdminActor,
  rawInput: z.input<typeof replaceSchema>,
  now: Date = new Date(),
): Promise<{ changed: boolean }> {
  const store = requireStorage(storage);
  const input = parse(replaceSchema, rawInput);
  const access = await loadReadable(db, actor, input.documentPublicId);
  requireEditContent(access);
  const { row } = access;
  if (!previewKindOf(row.ext)) {
    // A document from before the library held Markdown and HTML only (a
    // .txt, .csv or .json written earlier). Writing text into it would keep
    // its old name and type, so it is left as it is.
    throw new HubError(
      "INVALID_INPUT",
      "这份文档的格式已经不支持在线修改，只有 Markdown 和 HTML 可以",
    );
  }

  const bytes = textBytes(input.content);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    input.expectedUpdatedAt &&
    input.expectedUpdatedAt.getTime() !== row.updatedAt.getTime()
  ) {
    throw new HubError("CONFLICT", STALE);
  }
  if (row.sha256 === sha256) return { changed: false };

  const key = storageKeyFor(row.ext, randomUUID());
  await store.put({ key, body: bytes, contentType: row.contentType });
  const oldKey = row.storageKey;

  try {
    await withAudit(
      db,
      async (tx) => {
        const patch = { size: bytes.length, sha256, storageKey: key };
        if (input.expectedUpdatedAt) {
          // Checked again as part of the write: a save that raced ours loses.
          const written = await updateDocumentIfUnchanged(
            tx,
            row.id,
            patch,
            now,
            input.expectedUpdatedAt,
          );
          if (!written) throw new HubError("CONFLICT", STALE);
        } else {
          await updateDocumentRow(tx, row.id, patch, now);
        }
      },
      () => ({
        actor,
        action: "document.file_replaced",
        entityType: "document",
        entityId: row.publicId,
        summary: `修改了「${row.title}」的内容`,
      }),
    );
  } catch (error) {
    await discardObject(store, key);
    throw error;
  }
  await discardObject(store, oldKey);
  return { changed: true };
}

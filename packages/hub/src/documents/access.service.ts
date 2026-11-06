import { z } from "zod";

import { generateUID } from "@kan/shared/utils";

import type { AdminActor } from "../accounts/account.service";
import type { Db } from "../db";
import type { CandidateRow } from "./document.repo";
import type { EditRequestSummary } from "./library.service";
import { withAudit } from "../audit";
import { isUniqueViolation } from "../shared/db-errors";
import { HubError } from "../shared/errors";
import { loadReadable, requireManage, requireUserId } from "./document.guard";
import { canRequestEdit, REQUEST_NOTE_MAX_LENGTH } from "./document.policy";
import {
  addEditor,
  approvePendingRequest,
  decideRequest,
  findActiveUser,
  findDocumentById,
  findPendingRequest,
  findRequest,
  insertRequest,
  listEditedDocumentIds,
  listPendingRequests,
  removeEditor,
  searchEditorCandidates,
} from "./document.repo";
import { toRequestSummary } from "./library.service";

/**
 * Who may change which document. Edit rights are assigned per document: by the
 * owner, or by an admin who is an editor of that document. Anyone who can read
 * a document and cannot change it may ask for the right (unless it is open to
 * its readers, when they can change its content already); the people who can
 * hand it out then approve or deny.
 */

const idSchema = z.string().min(1).max(32);

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

const grantSchema = z.object({
  documentPublicId: idSchema,
  userId: z.string().uuid(),
});

export async function grantEditor(
  db: Db,
  actor: AdminActor,
  rawInput: z.input<typeof grantSchema>,
  now: Date = new Date(),
): Promise<void> {
  const input = parse(grantSchema, rawInput);
  const access = await loadReadable(db, actor, input.documentPublicId);
  requireManage(access);

  const person = await findActiveUser(db, input.userId);
  if (!person) throw new HubError("NOT_FOUND", "找不到这个账号，或账号已停用");

  const { row } = access;
  await withAudit(
    db,
    async (tx) => {
      const added = await addEditor(tx, {
        documentId: row.id,
        userId: person.id,
        grantedBy: access.userId,
      });
      // Granting settles any request the person had open.
      await approvePendingRequest(tx, row.id, person.id, access.userId, now);
      return added;
    },
    () => ({
      actor,
      action: "document.editor_granted",
      entityType: "document",
      entityId: row.publicId,
      summary: `让 ${person.name} 可以修改「${row.title}」`,
      detail: { userId: person.id },
    }),
  );
}

export async function revokeEditor(
  db: Db,
  actor: AdminActor,
  rawInput: z.input<typeof grantSchema>,
): Promise<void> {
  const input = parse(grantSchema, rawInput);
  const access = await loadReadable(db, actor, input.documentPublicId);
  requireManage(access);

  const { row } = access;
  await withAudit(
    db,
    async (tx) => {
      if (!(await removeEditor(tx, row.id, input.userId))) {
        throw new HubError("NOT_FOUND", "这个人本来就不是这份文档的编辑者");
      }
    },
    () => ({
      actor,
      action: "document.editor_revoked",
      entityType: "document",
      entityId: row.publicId,
      summary: `收回了「${row.title}」的修改权限`,
      detail: { userId: input.userId },
    }),
  );
}

const candidatesSchema = z.object({
  documentPublicId: idSchema,
  search: z.string().trim().min(1).max(100),
});

/** Accounts a manager can pick to hand edit rights to. */
export async function findEditorCandidates(
  db: Db,
  actor: AdminActor,
  rawInput: z.input<typeof candidatesSchema>,
): Promise<CandidateRow[]> {
  const input = parse(candidatesSchema, rawInput);
  const access = await loadReadable(db, actor, input.documentPublicId);
  requireManage(access);
  return searchEditorCandidates(db, {
    documentId: access.row.id,
    search: input.search,
    limit: 8,
  });
}

const requestSchema = z.object({
  documentPublicId: idSchema,
  note: z
    .string()
    .max(REQUEST_NOTE_MAX_LENGTH, `留言最多 ${REQUEST_NOTE_MAX_LENGTH} 个字`)
    .transform((value) => value.trim() || null)
    .nullish(),
});

export async function requestEdit(
  db: Db,
  actor: AdminActor,
  rawInput: z.input<typeof requestSchema>,
): Promise<{ publicId: string }> {
  const input = parse(requestSchema, rawInput);
  const access = await loadReadable(db, actor, input.documentPublicId);
  const { row } = access;

  if (access.canEditContent) {
    throw new HubError("CONFLICT", "你已经可以修改这份文档了");
  }
  const hasPendingRequest =
    (await findPendingRequest(db, row.id, access.userId)) !== null;
  if (
    !canRequestEdit({ canRead: true, canEditContent: false, hasPendingRequest })
  ) {
    throw new HubError("CONFLICT", "你已经申请过了，请等待管理员处理");
  }

  return withAudit(
    db,
    async (tx) => {
      try {
        const created = await insertRequest(tx, {
          publicId: generateUID(),
          documentId: row.id,
          requesterId: access.userId,
          note: input.note ?? null,
        });
        return { publicId: created.publicId };
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new HubError("CONFLICT", "你已经申请过了，请等待管理员处理");
        }
        throw error;
      }
    },
    (result) => ({
      actor,
      action: "document.edit_requested",
      entityType: "document",
      entityId: row.publicId,
      summary: `${actor.email} 申请修改「${row.title}」`,
      detail: { request: result.publicId },
    }),
  );
}

/**
 * Pending requests the person may decide: all of them for an owner, and for an
 * admin those on documents they are an editor of. Everyone else has none.
 */
export async function listDecidableRequests(
  db: Db,
  actor: AdminActor,
): Promise<EditRequestSummary[]> {
  const userId = requireUserId(actor);
  if (actor.role === "owner") {
    return (await listPendingRequests(db)).map(toRequestSummary);
  }
  if (actor.role !== "admin") return [];
  const edited = await listEditedDocumentIds(db, userId);
  return (await listPendingRequests(db, [...edited])).map(toRequestSummary);
}

const decideSchema = z.object({
  requestPublicId: idSchema,
  approve: z.boolean(),
});

export async function decideEditRequest(
  db: Db,
  actor: AdminActor,
  rawInput: z.input<typeof decideSchema>,
  now: Date = new Date(),
): Promise<void> {
  const input = parse(decideSchema, rawInput);
  const request = await findRequest(db, input.requestPublicId);
  if (!request) throw new HubError("NOT_FOUND", "找不到这条申请");

  const document = await findDocumentById(db, request.documentId);
  if (!document) throw new HubError("NOT_FOUND", "找不到这条申请");
  const access = await loadReadable(db, actor, document.publicId);
  requireManage(access);

  if (request.status !== "pending") {
    throw new HubError("CONFLICT", "这条申请已经处理过了");
  }

  await withAudit(
    db,
    async (tx) => {
      const decided = await decideRequest(tx, request.id, {
        status: input.approve ? "approved" : "denied",
        by: access.userId,
        at: now,
      });
      if (!decided) {
        // Someone decided it between our read above and this write.
        throw new HubError("CONFLICT", "这条申请已经处理过了");
      }
      if (input.approve) {
        await addEditor(tx, {
          documentId: document.id,
          userId: request.requesterId,
          grantedBy: access.userId,
        });
      }
    },
    () => ({
      actor,
      action: input.approve
        ? "document.edit_request_approved"
        : "document.edit_request_denied",
      entityType: "document",
      entityId: document.publicId,
      summary: input.approve
        ? `同意了对「${document.title}」的修改申请`
        : `拒绝了对「${document.title}」的修改申请`,
      detail: { request: request.publicId, userId: request.requesterId },
    }),
  );
}

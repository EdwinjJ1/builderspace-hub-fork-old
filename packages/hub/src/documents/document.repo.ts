import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { users } from "@kan/db/schema";

import type { DbOrTx } from "../db";
import type { EditRequestStatus, HubRole } from "../schema";
import type { ReaderTarget } from "./document.policy";
import {
  hubAccounts,
  hubDocumentEditors,
  hubDocumentEditRequests,
  hubDocumentFolders,
  hubDocumentReaders,
  hubDocuments,
} from "../schema";

/** A person's name for display; their e-mail when they never set one. */
const userName = sql<string>`coalesce(${users.name}, ${users.email})`;

export type FolderRow = typeof hubDocumentFolders.$inferSelect;
export type DocumentRow = typeof hubDocuments.$inferSelect;

/* ── folders ─────────────────────────────────────────────────────────── */

export async function listFolders(db: DbOrTx): Promise<FolderRow[]> {
  return db
    .select()
    .from(hubDocumentFolders)
    .orderBy(asc(hubDocumentFolders.name));
}

export async function findFolder(
  db: DbOrTx,
  publicId: string,
): Promise<FolderRow | null> {
  const [row] = await db
    .select()
    .from(hubDocumentFolders)
    .where(eq(hubDocumentFolders.publicId, publicId))
    .limit(1);
  return row ?? null;
}

export async function insertFolder(
  db: DbOrTx,
  row: {
    publicId: string;
    name: string;
    parentId: number | null;
    createdBy: string | null;
  },
): Promise<FolderRow> {
  const [created] = await db.insert(hubDocumentFolders).values(row).returning();
  if (!created) throw new Error("insertFolder: no row returned");
  return created;
}

export async function renameFolder(
  db: DbOrTx,
  id: number,
  name: string,
): Promise<void> {
  await db
    .update(hubDocumentFolders)
    .set({ name })
    .where(eq(hubDocumentFolders.id, id));
}

export async function deleteFolder(db: DbOrTx, id: number): Promise<void> {
  await db.delete(hubDocumentFolders).where(eq(hubDocumentFolders.id, id));
}

export async function countFolderChildren(
  db: DbOrTx,
  folderId: number,
): Promise<{ folders: number; documents: number }> {
  const [folders] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(hubDocumentFolders)
    .where(eq(hubDocumentFolders.parentId, folderId));
  const [documents] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(hubDocuments)
    .where(eq(hubDocuments.folderId, folderId));
  return { folders: folders?.n ?? 0, documents: documents?.n ?? 0 };
}

/* ── documents ───────────────────────────────────────────────────────── */

export async function listDocuments(db: DbOrTx): Promise<DocumentRow[]> {
  return db
    .select()
    .from(hubDocuments)
    .orderBy(desc(hubDocuments.updatedAt), desc(hubDocuments.id));
}

export async function findDocument(
  db: DbOrTx,
  publicId: string,
): Promise<DocumentRow | null> {
  const [row] = await db
    .select()
    .from(hubDocuments)
    .where(eq(hubDocuments.publicId, publicId))
    .limit(1);
  return row ?? null;
}

export async function findDocumentById(
  db: DbOrTx,
  id: number,
): Promise<DocumentRow | null> {
  const [row] = await db
    .select()
    .from(hubDocuments)
    .where(eq(hubDocuments.id, id))
    .limit(1);
  return row ?? null;
}

export type NewDocument = Omit<DocumentRow, "id" | "createdAt" | "updatedAt">;

export async function insertDocument(
  db: DbOrTx,
  row: NewDocument & { now: Date },
): Promise<DocumentRow> {
  const { now, ...values } = row;
  const [created] = await db
    .insert(hubDocuments)
    .values({ ...values, createdAt: now, updatedAt: now })
    .returning();
  if (!created) throw new Error("insertDocument: no row returned");
  return created;
}

export type DocumentPatch = Partial<
  Pick<
    DocumentRow,
    | "title"
    | "description"
    | "folderId"
    | "readable"
    | "readersCanEdit"
    | "filename"
    | "ext"
    | "contentType"
    | "size"
    | "sha256"
    | "storageKey"
  >
>;

export async function updateDocument(
  db: DbOrTx,
  id: number,
  patch: DocumentPatch,
  now: Date,
): Promise<void> {
  await db
    .update(hubDocuments)
    .set({ ...patch, updatedAt: now })
    .where(eq(hubDocuments.id, id));
}

/**
 * Like `updateDocument`, but only if nobody changed the document since
 * `ifUpdatedAt`. The check is part of the write, so two people saving at the
 * same moment cannot both win. Returns whether the document was changed.
 */
export async function updateDocumentIfUnchanged(
  db: DbOrTx,
  id: number,
  patch: DocumentPatch,
  now: Date,
  ifUpdatedAt: Date,
): Promise<boolean> {
  const rows = await db
    .update(hubDocuments)
    .set({ ...patch, updatedAt: now })
    .where(
      and(eq(hubDocuments.id, id), eq(hubDocuments.updatedAt, ifUpdatedAt)),
    )
    .returning({ id: hubDocuments.id });
  return rows.length > 0;
}

export async function deleteDocument(db: DbOrTx, id: number): Promise<void> {
  await db.delete(hubDocuments).where(eq(hubDocuments.id, id));
}

/* ── editors ─────────────────────────────────────────────────────────── */

/** Ids of the documents `userId` was assigned to. */
export async function listEditedDocumentIds(
  db: DbOrTx,
  userId: string,
): Promise<Set<number>> {
  const rows = await db
    .select({ documentId: hubDocumentEditors.documentId })
    .from(hubDocumentEditors)
    .where(eq(hubDocumentEditors.userId, userId));
  return new Set(rows.map((row) => row.documentId));
}

export async function isEditor(
  db: DbOrTx,
  documentId: number,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ userId: hubDocumentEditors.userId })
    .from(hubDocumentEditors)
    .where(
      and(
        eq(hubDocumentEditors.documentId, documentId),
        eq(hubDocumentEditors.userId, userId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export interface EditorRow {
  userId: string;
  name: string;
  email: string;
  hubRole: HubRole | null;
  grantedAt: Date;
}

export async function listEditors(
  db: DbOrTx,
  documentId: number,
): Promise<EditorRow[]> {
  return db
    .select({
      userId: users.id,
      name: userName,
      email: users.email,
      hubRole: hubAccounts.role,
      grantedAt: hubDocumentEditors.grantedAt,
    })
    .from(hubDocumentEditors)
    .innerJoin(users, eq(users.id, hubDocumentEditors.userId))
    .leftJoin(hubAccounts, eq(hubAccounts.userId, users.id))
    .where(eq(hubDocumentEditors.documentId, documentId))
    .orderBy(asc(hubDocumentEditors.grantedAt));
}

/** Returns false when the person already was an editor. */
export async function addEditor(
  db: DbOrTx,
  input: { documentId: number; userId: string; grantedBy: string | null },
): Promise<boolean> {
  const inserted = await db
    .insert(hubDocumentEditors)
    .values(input)
    .onConflictDoNothing()
    .returning({ userId: hubDocumentEditors.userId });
  return inserted.length > 0;
}

/** Returns false when the person was not an editor. */
export async function removeEditor(
  db: DbOrTx,
  documentId: number,
  userId: string,
): Promise<boolean> {
  const removed = await db
    .delete(hubDocumentEditors)
    .where(
      and(
        eq(hubDocumentEditors.documentId, documentId),
        eq(hubDocumentEditors.userId, userId),
      ),
    )
    .returning({ userId: hubDocumentEditors.userId });
  return removed.length > 0;
}

export interface CandidateRow {
  userId: string;
  name: string;
  email: string;
  hubRole: HubRole | null;
}

/** Active accounts matching `search` that are not yet editors of the document. */
export async function searchEditorCandidates(
  db: DbOrTx,
  input: { documentId: number; search: string; limit: number },
): Promise<CandidateRow[]> {
  const pattern = `%${input.search.replace(/[\\%_]/g, "\\$&")}%`;
  return db
    .select({
      userId: users.id,
      name: userName,
      email: users.email,
      hubRole: hubAccounts.role,
    })
    .from(users)
    .leftJoin(hubAccounts, eq(hubAccounts.userId, users.id))
    .where(
      and(
        or(isNull(hubAccounts.status), eq(hubAccounts.status, "active")),
        or(ilike(users.name, pattern), ilike(users.email, pattern)),
        sql`NOT EXISTS (
          SELECT 1 FROM ${hubDocumentEditors}
          WHERE ${hubDocumentEditors.documentId} = ${input.documentId}
            AND ${hubDocumentEditors.userId} = ${users.id}
        )`,
      ),
    )
    .orderBy(asc(users.name))
    .limit(input.limit);
}

/* ── readers (指定的人) ────────────────────────────────────────────────── */

export interface ReaderRow extends ReaderTarget {
  documentId: number;
}

/** The 指定的人 of the given documents, or of every document. */
export async function listReaders(
  db: DbOrTx,
  documentIds?: number[],
): Promise<ReaderRow[]> {
  if (documentIds && documentIds.length === 0) return [];
  return db
    .select({
      documentId: hubDocumentReaders.documentId,
      userId: hubDocumentReaders.userId,
      workspaceId: hubDocumentReaders.workspaceId,
      departmentId: hubDocumentReaders.departmentId,
    })
    .from(hubDocumentReaders)
    .where(
      documentIds
        ? inArray(hubDocumentReaders.documentId, documentIds)
        : undefined,
    )
    .orderBy(asc(hubDocumentReaders.id));
}

/** Replaces a document's 指定的人 with `targets` (none clears them). */
export async function replaceReaders(
  db: DbOrTx,
  documentId: number,
  targets: readonly ReaderTarget[],
): Promise<void> {
  await db
    .delete(hubDocumentReaders)
    .where(eq(hubDocumentReaders.documentId, documentId));
  if (targets.length === 0) return;
  await db
    .insert(hubDocumentReaders)
    .values(targets.map((target) => ({ ...target, documentId })));
}

/* ── edit requests ───────────────────────────────────────────────────── */

export type RequestRow = typeof hubDocumentEditRequests.$inferSelect;

export async function insertRequest(
  db: DbOrTx,
  row: {
    publicId: string;
    documentId: number;
    requesterId: string;
    note: string | null;
  },
): Promise<RequestRow> {
  const [created] = await db
    .insert(hubDocumentEditRequests)
    .values(row)
    .returning();
  if (!created) throw new Error("insertRequest: no row returned");
  return created;
}

export async function findPendingRequest(
  db: DbOrTx,
  documentId: number,
  requesterId: string,
): Promise<RequestRow | null> {
  const [row] = await db
    .select()
    .from(hubDocumentEditRequests)
    .where(
      and(
        eq(hubDocumentEditRequests.documentId, documentId),
        eq(hubDocumentEditRequests.requesterId, requesterId),
        eq(hubDocumentEditRequests.status, "pending"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The person's most recent request for the document, whatever its status. */
export async function findLatestRequest(
  db: DbOrTx,
  documentId: number,
  requesterId: string,
): Promise<RequestRow | null> {
  const [row] = await db
    .select()
    .from(hubDocumentEditRequests)
    .where(
      and(
        eq(hubDocumentEditRequests.documentId, documentId),
        eq(hubDocumentEditRequests.requesterId, requesterId),
      ),
    )
    .orderBy(desc(hubDocumentEditRequests.id))
    .limit(1);
  return row ?? null;
}

export async function findRequest(
  db: DbOrTx,
  publicId: string,
): Promise<RequestRow | null> {
  const [row] = await db
    .select()
    .from(hubDocumentEditRequests)
    .where(eq(hubDocumentEditRequests.publicId, publicId))
    .limit(1);
  return row ?? null;
}

export interface PendingRequestRow {
  publicId: string;
  note: string | null;
  createdAt: Date;
  documentId: number;
  documentPublicId: string;
  documentTitle: string;
  requesterId: string;
  requesterName: string;
  requesterEmail: string;
}

export async function listPendingRequests(
  db: DbOrTx,
  documentIds?: number[],
): Promise<PendingRequestRow[]> {
  if (documentIds && documentIds.length === 0) return [];
  return db
    .select({
      publicId: hubDocumentEditRequests.publicId,
      note: hubDocumentEditRequests.note,
      createdAt: hubDocumentEditRequests.createdAt,
      documentId: hubDocuments.id,
      documentPublicId: hubDocuments.publicId,
      documentTitle: hubDocuments.title,
      requesterId: users.id,
      requesterName: userName,
      requesterEmail: users.email,
    })
    .from(hubDocumentEditRequests)
    .innerJoin(
      hubDocuments,
      eq(hubDocuments.id, hubDocumentEditRequests.documentId),
    )
    .innerJoin(users, eq(users.id, hubDocumentEditRequests.requesterId))
    .where(
      and(
        eq(hubDocumentEditRequests.status, "pending"),
        documentIds
          ? inArray(hubDocumentEditRequests.documentId, documentIds)
          : undefined,
      ),
    )
    .orderBy(asc(hubDocumentEditRequests.createdAt));
}

/**
 * Records a decision on a pending request. Returns false when the request was
 * no longer pending, i.e. someone else decided it first, so two managers
 * deciding at once cannot both succeed.
 */
export async function decideRequest(
  db: DbOrTx,
  id: number,
  decision: {
    status: Exclude<EditRequestStatus, "pending">;
    by: string | null;
    at: Date;
  },
): Promise<boolean> {
  const rows = await db
    .update(hubDocumentEditRequests)
    .set({
      status: decision.status,
      decidedBy: decision.by,
      decidedAt: decision.at,
    })
    .where(
      and(
        eq(hubDocumentEditRequests.id, id),
        eq(hubDocumentEditRequests.status, "pending"),
      ),
    )
    .returning({ id: hubDocumentEditRequests.id });
  return rows.length > 0;
}

/** Closes the person's pending request for the document as approved. */
export async function approvePendingRequest(
  db: DbOrTx,
  documentId: number,
  requesterId: string,
  by: string | null,
  at: Date,
): Promise<void> {
  await db
    .update(hubDocumentEditRequests)
    .set({ status: "approved", decidedBy: by, decidedAt: at })
    .where(
      and(
        eq(hubDocumentEditRequests.documentId, documentId),
        eq(hubDocumentEditRequests.requesterId, requesterId),
        eq(hubDocumentEditRequests.status, "pending"),
      ),
    );
}

/* ── users ───────────────────────────────────────────────────────────── */

export async function findActiveUser(
  db: DbOrTx,
  userId: string,
): Promise<{ id: string; name: string; email: string } | null> {
  const [row] = await db
    .select({ id: users.id, name: userName, email: users.email })
    .from(users)
    .leftJoin(hubAccounts, eq(hubAccounts.userId, users.id))
    .where(
      and(
        eq(users.id, userId),
        or(isNull(hubAccounts.status), eq(hubAccounts.status, "active")),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The given accounts that exist and are not suspended. */
export async function findActiveUsers(
  db: DbOrTx,
  userIds: string[],
): Promise<{ id: string; name: string }[]> {
  if (userIds.length === 0) return [];
  return db
    .select({ id: users.id, name: userName })
    .from(users)
    .leftJoin(hubAccounts, eq(hubAccounts.userId, users.id))
    .where(
      and(
        inArray(users.id, userIds),
        or(isNull(hubAccounts.status), eq(hubAccounts.status, "active")),
      ),
    );
}

export async function namesOf(
  db: DbOrTx,
  userIds: string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: userName })
    .from(users)
    .where(inArray(users.id, userIds));
  return new Map(rows.map((row) => [row.id, row.name]));
}

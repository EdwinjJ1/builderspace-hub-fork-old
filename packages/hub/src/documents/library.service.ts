import { z } from "zod";

import { generateUID } from "@kan/shared/utils";

import type { AdminActor } from "../accounts/account.service";
import type { Db } from "../db";
import type { ReaderList } from "./audience.service";
import type { Audience, EditAccess, PreviewKind } from "./document.policy";
import type { DocumentRow, FolderRow, ReaderRow } from "./document.repo";
import type { DocumentStorage } from "./storage";
import { withAudit } from "../audit";
import { isUniqueViolation } from "../shared/db-errors";
import { HubError } from "../shared/errors";
import { describeReaders } from "./audience.service";
import { loadReadable, loadReader, requireUserId } from "./document.guard";
import {
  audienceOf,
  canCreateDocument,
  canEditContent,
  canEditDocument,
  canReadDocument,
  canRequestEdit,
  editAccessOf,
  fileLabel,
  FOLDER_MAX_DEPTH,
  FOLDER_NAME_MAX_LENGTH,
  isListedReader,
  MAX_TEXT_BYTES,
  normaliseName,
  previewKindOf,
} from "./document.policy";
import {
  countFolderChildren,
  deleteFolder as deleteFolderRow,
  findFolder,
  findLatestRequest,
  insertFolder,
  listDocuments,
  listEditedDocumentIds,
  listEditors,
  listFolders,
  listPendingRequests,
  listReaders,
  namesOf,
  renameFolder as renameFolderRow,
} from "./document.repo";

/**
 * The document library: what a signed-in person sees, and the folders around
 * the documents. Documents are listed from memory after one query each for
 * folders, documents and the person's edit rights; the library is a few
 * hundred rows at most, so this is simpler and cheaper than a query per view.
 */

export interface DocumentSummary {
  publicId: string;
  title: string;
  description: string | null;
  filename: string;
  ext: string;
  /** Short format name for the list: "PDF", "PPT", ... */
  label: string;
  size: number;
  preview: PreviewKind | null;
  folderPublicId: string | null;
  /** The folders it sits in, joined: "合同 / 2026". */
  folderPath: string;
  /** Every member can read it (the `all` audience). */
  readable: boolean;
  /** Who can read it besides its editors. */
  audience: Audience;
  /** Who can change its content: the assigned editors, or every reader too. */
  editAccess: EditAccess;
  /** Whether the viewer may change it: details, 谁能看, 谁能改, deleting. */
  canEdit: boolean;
  /** Whether the viewer may rewrite its content. */
  canEditContent: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface FolderSummary {
  publicId: string;
  name: string;
  parentPublicId: string | null;
  /** Documents the viewer can see in this folder and everything below it. */
  documentCount: number;
  folderCount: number;
}

export interface Library {
  folder: FolderSummary | null;
  breadcrumbs: { publicId: string; name: string }[];
  /** Sub-folders of `folder` (or the top level). Empty while searching. */
  folders: FolderSummary[];
  documents: DocumentSummary[];
  search: string | null;
  canCreate: boolean;
}

const libraryInput = z.object({
  folderPublicId: z.string().min(1).max(32).nullish(),
  search: z.string().max(100).nullish(),
});

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

/** Folder names from the top down to (and including) `folder`. */
function pathOf(
  folder: FolderRow | undefined,
  byId: Map<number, FolderRow>,
): FolderRow[] {
  const path: FolderRow[] = [];
  let current = folder;
  while (current) {
    path.unshift(current);
    current =
      current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return path;
}

function summarise(
  row: DocumentRow,
  canEdit: boolean,
  byId: Map<number, FolderRow>,
  hasReaders: boolean,
): DocumentSummary {
  const folder = row.folderId === null ? undefined : byId.get(row.folderId);
  const audience = audienceOf({ readable: row.readable, hasReaders });
  return {
    publicId: row.publicId,
    title: row.title,
    description: row.description,
    filename: row.filename,
    ext: row.ext,
    label: fileLabel(row.filename),
    size: row.size,
    preview: previewKindOf(row.ext),
    folderPublicId: folder?.publicId ?? null,
    folderPath: pathOf(folder, byId)
      .map((f) => f.name)
      .join(" / "),
    readable: row.readable,
    audience,
    editAccess: editAccessOf({ audience, readersCanEdit: row.readersCanEdit }),
    canEdit,
    // Only documents the viewer can read are summarised.
    canEditContent: canEditContent({
      canEdit,
      canRead: true,
      readersCanEdit: row.readersCanEdit,
    }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getLibrary(
  db: Db,
  storage: DocumentStorage | null,
  actor: AdminActor,
  rawInput: z.input<typeof libraryInput>,
): Promise<Library> {
  const input = parse(libraryInput, rawInput);
  const userId = requireUserId(actor);

  const [folderRows, documentRows, edited, readerRows, reader] =
    await Promise.all([
      listFolders(db),
      listDocuments(db),
      listEditedDocumentIds(db, userId),
      listReaders(db),
      loadReader(db, userId),
    ]);
  const byId = new Map(folderRows.map((f) => [f.id, f]));
  const readersOf = groupReaders(readerRows);

  const visible = documentRows.flatMap((row) => {
    const canEdit = canEditDocument({
      role: actor.role,
      isEditor: edited.has(row.id),
    });
    const readers = readersOf.get(row.id) ?? [];
    const isListed = !row.readable && isListedReader(readers, reader);
    return canReadDocument({ readable: row.readable, canEdit, isListed })
      ? [{ row, canEdit, hasReaders: readers.length > 0 }]
      : [];
  });

  const current = input.folderPublicId
    ? folderRows.find((f) => f.publicId === input.folderPublicId)
    : undefined;
  if (input.folderPublicId && !current) {
    throw new HubError("NOT_FOUND", "找不到这个文件夹");
  }

  // Documents per folder, counting everything underneath it.
  const docsIn = new Map<number | null, number>();
  for (const { row } of visible) {
    docsIn.set(row.folderId, (docsIn.get(row.folderId) ?? 0) + 1);
  }
  const childrenOf = new Map<number | null, FolderRow[]>();
  for (const folder of folderRows) {
    const siblings = childrenOf.get(folder.parentId) ?? [];
    siblings.push(folder);
    childrenOf.set(folder.parentId, siblings);
  }
  const countBelow = (folderId: number): number =>
    (docsIn.get(folderId) ?? 0) +
    (childrenOf.get(folderId) ?? []).reduce(
      (sum, child) => sum + countBelow(child.id),
      0,
    );
  const summariseFolder = (folder: FolderRow): FolderSummary => ({
    publicId: folder.publicId,
    name: folder.name,
    parentPublicId:
      folder.parentId === null
        ? null
        : (byId.get(folder.parentId)?.publicId ?? null),
    documentCount: countBelow(folder.id),
    folderCount: (childrenOf.get(folder.id) ?? []).length,
  });

  const typed = input.search?.trim().toLowerCase();
  const search = typed === undefined || typed === "" ? null : typed;
  const inScope = search
    ? visible.filter(({ row }) =>
        [row.title, row.filename, row.description ?? ""].some((text) =>
          text.toLowerCase().includes(search),
        ),
      )
    : visible.filter(({ row }) => row.folderId === (current?.id ?? null));

  return {
    folder: current ? summariseFolder(current) : null,
    breadcrumbs: search
      ? []
      : pathOf(current, byId).map((f) => ({
          publicId: f.publicId,
          name: f.name,
        })),
    folders: search
      ? []
      : (childrenOf.get(current?.id ?? null) ?? []).map(summariseFolder),
    documents: inScope.map(({ row, canEdit, hasReaders }) =>
      summarise(row, canEdit, byId, hasReaders),
    ),
    search,
    canCreate: canCreateDocument(actor.role),
  };
}

function groupReaders(rows: ReaderRow[]): Map<number, ReaderRow[]> {
  const byDocument = new Map<number, ReaderRow[]>();
  for (const row of rows) {
    byDocument.set(row.documentId, [
      ...(byDocument.get(row.documentId) ?? []),
      row,
    ]);
  }
  return byDocument;
}

export interface EditRequestSummary {
  publicId: string;
  note: string | null;
  createdAt: Date;
  requester: { userId: string; name: string; email: string };
  document: { publicId: string; title: string };
}

export interface DocumentDetail extends DocumentSummary {
  breadcrumbs: { publicId: string; name: string }[];
  uploadedByName: string | null;
  /** May hand out edit rights and decide requests. */
  canManageEditors: boolean;
  canRequestEdit: boolean;
  /** May rewrite the content in the page's editor. */
  canEditText: boolean;
  /** The viewer's latest request for this document, if any. */
  myRequest: {
    status: "pending" | "approved" | "denied";
    note: string | null;
    createdAt: Date;
  } | null;
  /** Everyone it was assigned to. Emails are only shown to managers. */
  editors: { userId: string; name: string; email: string | null }[];
  /** Pending requests, for managers only. */
  pendingRequests: EditRequestSummary[];
  /** Every folder with its path, to move the document to; editors only. */
  folderOptions: { publicId: string; path: string }[];
  /** Its 指定的人, for the people who can change them; null for others. */
  readers: ReaderList | null;
}

export async function getDocumentDetail(
  db: Db,
  storage: DocumentStorage | null,
  actor: AdminActor,
  publicId: string,
): Promise<DocumentDetail> {
  const access = await loadReadable(db, actor, publicId);
  const { row } = access;

  const [folderRows, editors, latest, uploaders, readerRows] =
    await Promise.all([
      listFolders(db),
      listEditors(db, row.id),
      findLatestRequest(db, row.id, access.userId),
      row.uploadedBy
        ? namesOf(db, [row.uploadedBy])
        : Promise.resolve(new Map<string, string>()),
      listReaders(db, [row.id]),
    ]);
  const byId = new Map(folderRows.map((f) => [f.id, f]));
  const folder = row.folderId === null ? undefined : byId.get(row.folderId);

  const pending = access.canManage
    ? await listPendingRequests(db, [row.id])
    : [];
  const hasPending = latest?.status === "pending";

  return {
    ...summarise(row, access.canEdit, byId, readerRows.length > 0),
    breadcrumbs: pathOf(folder, byId).map((f) => ({
      publicId: f.publicId,
      name: f.name,
    })),
    uploadedByName: row.uploadedBy
      ? (uploaders.get(row.uploadedBy) ?? null)
      : null,
    canManageEditors: access.canManage,
    canRequestEdit: canRequestEdit({
      canRead: true,
      canEditContent: access.canEditContent,
      hasPendingRequest: hasPending,
    }),
    canEditText:
      access.canEditContent &&
      storage !== null &&
      previewKindOf(row.ext) !== null &&
      row.size <= MAX_TEXT_BYTES,
    myRequest:
      latest && !access.canEditContent
        ? {
            status: latest.status,
            note: latest.note,
            createdAt: latest.createdAt,
          }
        : null,
    editors: editors.map((editor) => ({
      userId: editor.userId,
      name: editor.name,
      email: access.canManage ? editor.email : null,
    })),
    pendingRequests: pending.map(toRequestSummary),
    folderOptions: access.canEdit
      ? folderRows
          .map((f) => ({
            publicId: f.publicId,
            path: pathOf(f, byId)
              .map((p) => p.name)
              .join(" / "),
          }))
          .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"))
      : [],
    readers: access.canEdit ? await describeReaders(db, readerRows) : null,
  };
}

export function toRequestSummary(row: {
  publicId: string;
  note: string | null;
  createdAt: Date;
  requesterId: string;
  requesterName: string;
  requesterEmail: string;
  documentPublicId: string;
  documentTitle: string;
}): EditRequestSummary {
  return {
    publicId: row.publicId,
    note: row.note,
    createdAt: row.createdAt,
    requester: {
      userId: row.requesterId,
      name: row.requesterName,
      email: row.requesterEmail,
    },
    document: { publicId: row.documentPublicId, title: row.documentTitle },
  };
}

/* ── folders ─────────────────────────────────────────────────────────── */

const folderNameSchema = z
  .string()
  .transform((value) => normaliseName(value, FOLDER_NAME_MAX_LENGTH))
  .refine((value): value is string => value !== null, {
    message: `文件夹名要填写，最多 ${FOLDER_NAME_MAX_LENGTH} 个字`,
  });

const createFolderSchema = z.object({
  name: folderNameSchema,
  parentPublicId: z.string().min(1).max(32).nullish(),
});

const renameFolderSchema = z.object({
  folderPublicId: z.string().min(1).max(32),
  name: folderNameSchema,
});

function requireCreate(actor: AdminActor): void {
  if (!canCreateDocument(actor.role)) {
    throw new HubError("FORBIDDEN", "只有所有者和管理员能管理文件夹");
  }
}

async function depthOf(db: Db, folder: FolderRow | null): Promise<number> {
  const byId = new Map((await listFolders(db)).map((f) => [f.id, f]));
  return pathOf(folder ?? undefined, byId).length;
}

async function insertFolderOrConflict(
  db: Parameters<typeof insertFolder>[0],
  row: Parameters<typeof insertFolder>[1],
): Promise<FolderRow> {
  try {
    return await insertFolder(db, row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HubError("CONFLICT", "这里已经有同名的文件夹了");
    }
    throw error;
  }
}

export async function createFolder(
  db: Db,
  actor: AdminActor,
  rawInput: z.input<typeof createFolderSchema>,
): Promise<{ publicId: string; name: string }> {
  requireCreate(actor);
  const input = parse(createFolderSchema, rawInput);

  const parent = input.parentPublicId
    ? await findFolder(db, input.parentPublicId)
    : null;
  if (input.parentPublicId && !parent) {
    throw new HubError("NOT_FOUND", "找不到上一级文件夹");
  }
  if ((await depthOf(db, parent)) >= FOLDER_MAX_DEPTH) {
    throw new HubError(
      "INVALID_INPUT",
      `文件夹最多嵌套 ${FOLDER_MAX_DEPTH} 层`,
    );
  }

  return withAudit(
    db,
    async (tx) => {
      const created = await insertFolderOrConflict(tx, {
        publicId: generateUID(),
        name: input.name,
        parentId: parent?.id ?? null,
        createdBy: actor.userId,
      });
      return { publicId: created.publicId, name: created.name };
    },
    (result) => ({
      actor,
      action: "document_folder.created",
      entityType: "document_folder",
      entityId: result.publicId,
      summary: `新建文件夹「${input.name}」`,
    }),
  );
}

export async function renameFolder(
  db: Db,
  actor: AdminActor,
  rawInput: z.input<typeof renameFolderSchema>,
): Promise<void> {
  requireCreate(actor);
  const input = parse(renameFolderSchema, rawInput);
  const folder = await findFolder(db, input.folderPublicId);
  if (!folder) throw new HubError("NOT_FOUND", "找不到这个文件夹");

  await withAudit(
    db,
    async (tx) => {
      try {
        await renameFolderRow(tx, folder.id, input.name);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new HubError("CONFLICT", "这里已经有同名的文件夹了");
        }
        throw error;
      }
    },
    () => ({
      actor,
      action: "document_folder.renamed",
      entityType: "document_folder",
      entityId: folder.publicId,
      summary: `文件夹「${folder.name}」改名为「${input.name}」`,
    }),
  );
}

export async function deleteFolder(
  db: Db,
  actor: AdminActor,
  folderPublicId: string,
): Promise<void> {
  requireCreate(actor);
  const folder = await findFolder(db, folderPublicId);
  if (!folder) throw new HubError("NOT_FOUND", "找不到这个文件夹");

  await withAudit(
    db,
    async (tx) => {
      const inside = await countFolderChildren(tx, folder.id);
      if (inside.folders + inside.documents > 0) {
        throw new HubError("CONFLICT", "文件夹不是空的，先把里面的内容移走");
      }
      await deleteFolderRow(tx, folder.id);
    },
    () => ({
      actor,
      action: "document_folder.deleted",
      entityType: "document_folder",
      entityId: folder.publicId,
      summary: `删除文件夹「${folder.name}」`,
    }),
  );
}

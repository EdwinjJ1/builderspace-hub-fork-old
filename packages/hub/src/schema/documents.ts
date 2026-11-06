import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users, workspaces } from "@kan/db/schema";

import { hubDepartments } from "./departments";

export const editRequestStatuses = ["pending", "approved", "denied"] as const;
export type EditRequestStatus = (typeof editRequestStatuses)[number];

/**
 * A folder in the document library. Folders nest (the depth is limited by the
 * documents policy) and are removed only when empty, hence `restrict`.
 * Two folders with the same name cannot sit side by side.
 */
export const hubDocumentFolders = pgTable(
  "hub_document_folder",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publicId: varchar("publicId", { length: 12 }).notNull().unique(),
    name: varchar("name", { length: 80 }).notNull(),
    parentId: bigint("parentId", { mode: "number" }).references(
      (): AnyPgColumn => hubDocumentFolders.id,
      { onDelete: "restrict" },
    ),
    createdBy: uuid("createdBy").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("hub_document_folder_name_idx").on(
      sql`coalesce(${table.parentId}, 0)`,
      sql`lower(${table.name})`,
    ),
  ],
).enableRLS();

/**
 * A stored file with its details. The bytes live in object storage under
 * `storageKey`; the database holds only the metadata and who may do what.
 *
 * `readable` is the per-document read switch: on, every member can read it.
 * Off, only the people who can edit it can, plus whoever is listed in
 * `hub_document_reader` (指定的人). With nobody listed it is 仅编辑者可见.
 * `readersCanEdit` lets everyone who can read it change its content too
 * (能看的人都能改); it is only ever on while someone besides the editors can
 * read it.
 * `sha256` is set when the server saw the bytes (the import command) and is
 * what makes importing the same file twice a no-op.
 */
export const hubDocuments = pgTable(
  "hub_document",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publicId: varchar("publicId", { length: 12 }).notNull().unique(),
    folderId: bigint("folderId", { mode: "number" }).references(
      () => hubDocumentFolders.id,
      { onDelete: "restrict" },
    ),
    title: varchar("title", { length: 120 }).notNull(),
    description: varchar("description", { length: 500 }),
    filename: varchar("filename", { length: 200 }).notNull(),
    ext: varchar("ext", { length: 8 }).notNull(),
    contentType: varchar("contentType", { length: 120 }).notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: varchar("sha256", { length: 64 }),
    storageKey: varchar("storageKey", { length: 200 }).notNull().unique(),
    readable: boolean("readable").notNull().default(true),
    readersCanEdit: boolean("readersCanEdit").notNull().default(false),
    uploadedBy: uuid("uploadedBy").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [
    index("hub_document_folder_idx").on(table.folderId),
    check("hub_document_size_check", sql`${table.size} > 0`),
  ],
).enableRLS();

/** Someone a document was assigned to: they may change it. */
export const hubDocumentEditors = pgTable(
  "hub_document_editor",
  {
    documentId: bigint("documentId", { mode: "number" })
      .notNull()
      .references(() => hubDocuments.id, { onDelete: "cascade" }),
    userId: uuid("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedBy: uuid("grantedBy").references(() => users.id, {
      onDelete: "set null",
    }),
    grantedAt: timestamp("grantedAt").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.documentId, table.userId] })],
).enableRLS();

/**
 * 指定的人: who may read a document whose `readable` switch is off, besides
 * the people who can edit it. Each row is one person (`userId`), a whole
 * project (`workspaceId`), or one department of a project (`workspaceId` and
 * `departmentId`).
 *
 * Rows are only kept while `readable` is off: switching it on clears them, so
 * "readable, with a list" never exists. Deleting the last listed person or
 * project leaves the document to its editors, never open to everyone.
 */
export const hubDocumentReaders = pgTable(
  "hub_document_reader",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentId: bigint("documentId", { mode: "number" })
      .notNull()
      .references(() => hubDocuments.id, { onDelete: "cascade" }),
    userId: uuid("userId").references(() => users.id, { onDelete: "cascade" }),
    workspaceId: bigint("workspaceId", { mode: "number" }).references(
      () => workspaces.id,
      { onDelete: "cascade" },
    ),
    departmentId: bigint("departmentId", { mode: "number" }).references(
      () => hubDepartments.id,
      { onDelete: "restrict" },
    ),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    index("hub_document_reader_document_idx").on(table.documentId),
    uniqueIndex("hub_document_reader_user_idx")
      .on(table.documentId, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    uniqueIndex("hub_document_reader_group_idx")
      .on(
        table.documentId,
        table.workspaceId,
        sql`coalesce(${table.departmentId}, 0)`,
      )
      .where(sql`${table.workspaceId} IS NOT NULL`),
    check(
      "hub_document_reader_target_check",
      sql`(${table.userId} IS NULL) <> (${table.workspaceId} IS NULL)
        AND (${table.departmentId} IS NULL OR ${table.workspaceId} IS NOT NULL)`,
    ),
  ],
).enableRLS();

/**
 * An ordinary member asking for the right to change a document. At most one
 * request per person and document is pending at a time.
 */
export const hubDocumentEditRequests = pgTable(
  "hub_document_edit_request",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publicId: varchar("publicId", { length: 12 }).notNull().unique(),
    documentId: bigint("documentId", { mode: "number" })
      .notNull()
      .references(() => hubDocuments.id, { onDelete: "cascade" }),
    requesterId: uuid("requesterId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    note: varchar("note", { length: 280 }),
    status: varchar("status", { length: 16 })
      .$type<EditRequestStatus>()
      .notNull()
      .default("pending"),
    decidedBy: uuid("decidedBy").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decidedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    index("hub_document_edit_request_document_idx").on(table.documentId),
    uniqueIndex("hub_document_edit_request_pending_idx")
      .on(table.documentId, table.requesterId)
      .where(sql`${table.status} = 'pending'`),
    check(
      "hub_document_edit_request_status_check",
      sql`${table.status} IN ('pending', 'approved', 'denied')`,
    ),
  ],
).enableRLS();

/**
 * Unused since documents became Markdown and HTML written in the page: there
 * is no file upload any more. The table (and its migration) stays so the
 * production database and the migration history are not rewritten; it is
 * empty and nothing reads or writes it.
 *
 * It was: an upload the server handed out a place for. The browser sends the bytes
 * straight to storage, then asks us to register them; only a key listed here,
 * for the same person and not yet used, can become a document. That is what
 * stops anyone from registering someone else's file by guessing its key.
 */
export const hubDocumentUploads = pgTable(
  "hub_document_upload",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publicId: varchar("publicId", { length: 12 }).notNull().unique(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Set when the upload replaces the file of an existing document. */
    documentId: bigint("documentId", { mode: "number" }).references(
      () => hubDocuments.id,
      { onDelete: "cascade" },
    ),
    storageKey: varchar("storageKey", { length: 200 }).notNull().unique(),
    filename: varchar("filename", { length: 200 }).notNull(),
    ext: varchar("ext", { length: 8 }).notNull(),
    contentType: varchar("contentType", { length: 120 }).notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [index("hub_document_upload_user_idx").on(table.userId)],
).enableRLS();

/** Postgres `bytea` as a Node Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * Small files kept in the database itself, for when no object-storage bucket
 * is configured: text documents only, a megabyte at most. Keyed by the same
 * `storageKey` a document row points at, so a document does not care where its
 * bytes live. Once a bucket exists, new files go there and these stay readable.
 */
export const hubDocumentBlobs = pgTable("hub_document_blob", {
  storageKey: varchar("storageKey", { length: 200 }).primaryKey(),
  body: bytea("body").notNull(),
  contentType: varchar("contentType", { length: 120 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}).enableRLS();

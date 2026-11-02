import { count, desc } from "drizzle-orm";

import { generateUID } from "@kan/shared/utils";

import type { Db, DbOrTx, Tx } from "../db";
import { hubAuditLog } from "../schema";

/**
 * Every kind of change the log can hold. Add a member here when a feature gains
 * a new mutation; the name is `<entity>.<past-tense verb>`.
 */
export type AuditAction =
  | "grant.issued"
  | "grant.revoked"
  | "grant.role_changed"
  | "grant.consumed"
  | "grant.mailed"
  | "grant.restored"
  | "grant.mail_unconfirmed"
  | "project.created"
  | "board.created"
  | "board.privacy_changed"
  | "account.created"
  | "account.renamed"
  | "account.password_reset"
  | "account.role_changed"
  | "account.suspended"
  | "account.restored"
  | "account.project_role_changed"
  | "account.project_removed"
  | "account.site_access_changed"
  | "account.mail_access_changed"
  | "department.created"
  | "department.renamed"
  | "department.reordered"
  | "department.member_added"
  | "department.member_removed"
  | "project.permission_changed"
  | "project.repo_linked"
  | "project.repo_unlinked"
  | "github.connected"
  | "github.disconnected"
  | "settings.function_colors_changed"
  | "nudge_mail.turned_on"
  | "nudge_mail.turned_off"
  | "site.project_reviewed"
  | "site.update_reviewed"
  | "site.volunteer_updated"
  | "site.list_exported"
  | "document.created"
  | "document.updated"
  | "document.file_replaced"
  | "document.readable_changed"
  | "document.deleted"
  | "document.editor_granted"
  | "document.editor_revoked"
  | "document.edit_requested"
  | "document.edit_request_approved"
  | "document.edit_request_denied"
  | "document_folder.created"
  | "document_folder.renamed"
  | "document_folder.deleted"
  | "form.created"
  | "form.updated"
  | "form.opened"
  | "form.closed"
  | "form.duplicated"
  | "form.deleted"
  | "form.manager_added"
  | "form.manager_removed"
  | "form_response.deleted"
  | "mcp.connected"
  | "mcp.disconnected";

export interface AuditActor {
  userId: string | null;
  email: string;
}

/** The actor for changes made from the operations command line. */
export const CLI_ACTOR: AuditActor = { userId: null, email: "cli" };

export interface AuditEntry {
  actor: AuditActor;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  /** One sentence a person can read in the log, in Chinese. */
  summary: string;
  detail?: Record<string, unknown>;
}

export type AuditLogRow = typeof hubAuditLog.$inferSelect;

export async function recordAudit(
  db: DbOrTx,
  entry: AuditEntry,
): Promise<void> {
  await db.insert(hubAuditLog).values({
    publicId: generateUID(),
    actorUserId: entry.actor.userId,
    actorEmail: entry.actor.email,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    summary: entry.summary,
    detail: entry.detail ?? null,
  });
}

/**
 * Runs a change and its audit entry in one transaction, so the log can never
 * disagree with the data: either both are written or neither is.
 *
 * @param work     the change itself; use `tx` for every query
 * @param describe builds the entry from the work's result
 */
export async function withAudit<T>(
  db: Db,
  work: (tx: Tx) => Promise<T>,
  describe: (result: T) => AuditEntry,
): Promise<T> {
  return db.transaction(async (tx) => {
    const result = await work(tx);
    await recordAudit(tx, describe(result));
    return result;
  });
}

export async function listAudit(
  db: DbOrTx,
  page: { limit: number; offset: number },
): Promise<AuditLogRow[]> {
  return db
    .select()
    .from(hubAuditLog)
    .orderBy(desc(hubAuditLog.at), desc(hubAuditLog.id))
    .limit(page.limit)
    .offset(page.offset);
}

export async function countAudit(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ total: count() }).from(hubAuditLog);
  return row?.total ?? 0;
}

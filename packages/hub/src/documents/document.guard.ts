import type { AdminActor } from "../accounts/account.service";
import type { Db, DbOrTx } from "../db";
import type { Reader } from "./document.policy";
import type { DocumentRow } from "./document.repo";
import { effectiveDepartments } from "../departments/department.policy";
import { departmentsOfUser } from "../departments/department.repo";
import { listMemberships } from "../kan/accounts.gateway";
import { HubError } from "../shared/errors";
import {
  canEditContent,
  canEditDocument,
  canManageEditors,
  canReadDocument,
  isListedReader,
} from "./document.policy";
import { findDocument, isEditor, listReaders } from "./document.repo";

/** Everything the rules need to know about one person and one document. */
export interface DocumentAccess {
  row: DocumentRow;
  userId: string;
  isEditor: boolean;
  /** May change its details, who reads and edits it, and delete it. */
  canEdit: boolean;
  /**
   * May rewrite its content: `canEdit`, or anyone when it is open to its
   * readers (everyone with an access has passed the read check).
   */
  canEditContent: boolean;
  canManage: boolean;
}

/** Documents are for signed-in people; a missing id means a bug in the caller. */
export function requireUserId(actor: AdminActor): string {
  if (!actor.userId) throw new HubError("FORBIDDEN", "请先登录");
  return actor.userId;
}

export function accessFor(
  row: DocumentRow,
  actor: AdminActor,
  userId: string,
  editor: boolean,
): DocumentAccess {
  const canEdit = canEditDocument({ role: actor.role, isEditor: editor });
  return {
    row,
    userId,
    isEditor: editor,
    canEdit,
    canEditContent: canEditContent({
      canEdit,
      canRead: true,
      readersCanEdit: row.readersCanEdit,
    }),
    canManage: canManageEditors({ role: actor.role, isEditor: editor }),
  };
}

/** The projects and departments that decide whether someone is among 指定的人. */
export async function loadReader(db: DbOrTx, userId: string): Promise<Reader> {
  const [memberships, placements] = await Promise.all([
    listMemberships(db, [userId]),
    departmentsOfUser(db, userId),
  ]);
  const projectIds = new Set(
    (memberships.get(userId) ?? []).map((m) => m.workspaceId),
  );
  return {
    userId,
    projectIds,
    departments: effectiveDepartments({
      rows: placements,
      activeProjectIds: projectIds,
    }),
  };
}

/**
 * Loads a document for someone who must be able to read it. A document that
 * does not exist and one they may not read get the same answer, so the
 * response never confirms that a hidden document is there.
 */
export async function loadReadable(
  db: Db | DbOrTx,
  actor: AdminActor,
  publicId: string,
): Promise<DocumentAccess> {
  const userId = requireUserId(actor);
  const row = await findDocument(db, publicId);
  if (!row) throw new HubError("NOT_FOUND", "找不到这份文档");
  const access = accessFor(
    row,
    actor,
    userId,
    await isEditor(db, row.id, userId),
  );
  // Only a document closed to the viewer needs its list of 指定的人.
  const isListed =
    !row.readable &&
    !access.canEdit &&
    isListedReader(
      await listReaders(db, [row.id]),
      await loadReader(db, userId),
    );
  if (
    !canReadDocument({
      readable: row.readable,
      canEdit: access.canEdit,
      isListed,
    })
  ) {
    throw new HubError("NOT_FOUND", "找不到这份文档");
  }
  return access;
}

export function requireEdit(access: DocumentAccess): void {
  if (!access.canEdit) {
    throw new HubError("FORBIDDEN", "你没有修改这份文档的权限，可以先申请");
  }
}

export function requireEditContent(access: DocumentAccess): void {
  if (!access.canEditContent) {
    throw new HubError("FORBIDDEN", "你没有修改这份文档的权限，可以先申请");
  }
}

export function requireManage(access: DocumentAccess): void {
  if (!access.canManage) {
    throw new HubError(
      "FORBIDDEN",
      "只有所有者和这份文档的管理编辑者能分配修改权限",
    );
  }
}

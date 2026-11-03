import { and, asc, eq, inArray, isNotNull, isNull, max, or } from "drizzle-orm";

import * as permissionRepo from "@kan/db/repository/permission.repo";
import {
  boards,
  cardActivities,
  cards,
  cardsToLabels,
  cardToWorkspaceMembers,
  labels,
  lists,
  users,
  workspaceMembers,
  workspaces,
} from "@kan/db/schema";

import type { Db } from "../db";
import { hubArchivedCards } from "../schema";
import { boardVisibleTo } from "./private-boards.gateway";

export interface ViewableProject {
  id: number;
  publicId: string;
  name: string;
  slug: string;
  /** This person's membership, for assigning a new task to them. */
  memberPublicId: string;
  canCreateTasks: boolean;
  canEditTasks: boolean;
  canDeleteTasks: boolean;
  /** May add a list to a board, for a column the board has none for. */
  canCreateLists: boolean;
}

/**
 * The projects whose tasks this person may see: they are an active member
 * and their effective permissions (role plus per-member overrides, resolved by
 * Kan) include viewing boards and cards. This is the only gate for the home
 * page and the task board, so it reuses Kan's own rules instead of guessing.
 */
export async function listViewableProjects(
  db: Db,
  userId: string,
): Promise<ViewableProject[]> {
  const memberships = await db
    .select({
      memberId: workspaceMembers.id,
      memberPublicId: workspaceMembers.publicId,
      role: workspaceMembers.role,
      roleId: workspaceMembers.roleId,
      id: workspaces.id,
      publicId: workspaces.publicId,
      name: workspaces.name,
      slug: workspaces.slug,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.status, "active"),
        isNull(workspaceMembers.deletedAt),
        isNull(workspaces.deletedAt),
      ),
    );

  const viewable: ViewableProject[] = [];
  for (const membership of memberships) {
    const permissions = await permissionRepo.getMemberEffectivePermissions(
      db,
      membership.memberId,
      membership.roleId,
      membership.role,
    );
    if (
      permissions.includes("board:view") &&
      permissions.includes("card:view")
    ) {
      viewable.push({
        id: membership.id,
        publicId: membership.publicId,
        name: membership.name,
        slug: membership.slug,
        memberPublicId: membership.memberPublicId,
        canCreateTasks: permissions.includes("card:create"),
        canEditTasks: permissions.includes("card:edit"),
        canDeleteTasks: permissions.includes("card:delete"),
        canCreateLists: permissions.includes("list:create"),
      });
    }
  }
  return viewable;
}

export interface TaskRow {
  publicId: string;
  title: string;
  dueDate: Date | null;
  createdAt: Date;
  updatedAt: Date | null;
  /** Who created the card; null when that account is gone. */
  createdBy: string | null;
  listName: string;
  boardPublicId: string;
  boardName: string;
  projectId: number;
  assignees: { userId: string | null; name: string }[];
  labels: { name: string; colourCode: string | null }[];
  /** In 归档 since `at`; null while it is on its board. */
  archive: { at: Date; automatic: boolean } | null;
  /** Deleted by the clean-up after its time in 归档. */
  autoDeleted: boolean;
}

/** Which cards `listTaskRows` returns besides the ones on the boards. */
export interface TaskRowsIncluding {
  /** Cards in 归档. */
  archived?: boolean;
  /** Cards the clean-up deleted after their time in 归档. */
  autoDeleted?: boolean;
}

/**
 * Every live card on the ordinary boards of the given projects that the viewer
 * may see. Templates, archived boards, other people's 仅自己可见 boards and
 * anything soft-deleted are left out, and so are cards in 归档 and cards the
 * clean-up deleted unless `including` asks for them.
 *
 * Loads everything in three queries and lets the caller filter in memory.
 * That is plenty for a team's worth of cards; if it ever is not, push the
 * filters from `task.policy.ts` down into SQL here.
 */
export async function listTaskRows(
  db: Db,
  projectIds: readonly number[],
  viewerId: string,
  including: TaskRowsIncluding = {},
): Promise<TaskRow[]> {
  if (projectIds.length === 0) return [];

  const rows = await db
    .select({
      id: cards.id,
      publicId: cards.publicId,
      title: cards.title,
      dueDate: cards.dueDate,
      createdAt: cards.createdAt,
      updatedAt: cards.updatedAt,
      createdBy: cards.createdBy,
      deletedAt: cards.deletedAt,
      listName: lists.name,
      boardPublicId: boards.publicId,
      boardName: boards.name,
      projectId: boards.workspaceId,
      archivedAt: hubArchivedCards.archivedAt,
      archivedAutomatically: hubArchivedCards.automatic,
      autoDeletedAt: hubArchivedCards.autoDeletedAt,
    })
    .from(cards)
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .leftJoin(hubArchivedCards, eq(hubArchivedCards.cardId, cards.id))
    .where(
      and(
        inArray(boards.workspaceId, [...projectIds]),
        eq(boards.type, "regular"),
        eq(boards.isArchived, false),
        isNull(boards.deletedAt),
        isNull(lists.deletedAt),
        including.autoDeleted
          ? or(
              isNull(cards.deletedAt),
              isNotNull(hubArchivedCards.autoDeletedAt),
            )
          : isNull(cards.deletedAt),
        // A card the clean-up deleted is still marked as archived; the
        // condition above alone decides about those.
        including.archived
          ? undefined
          : or(
              isNull(hubArchivedCards.archivedAt),
              isNotNull(hubArchivedCards.autoDeletedAt),
            ),
        boardVisibleTo(db, viewerId),
      ),
    );
  if (rows.length === 0) return [];

  const cardIds = rows.map((row) => row.id);
  const [assignees, cardLabels] = await Promise.all([
    db
      .select({
        cardId: cardToWorkspaceMembers.cardId,
        userId: workspaceMembers.userId,
        name: users.name,
        email: workspaceMembers.email,
      })
      .from(cardToWorkspaceMembers)
      .innerJoin(
        workspaceMembers,
        eq(workspaceMembers.id, cardToWorkspaceMembers.workspaceMemberId),
      )
      .leftJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          inArray(cardToWorkspaceMembers.cardId, cardIds),
          isNull(workspaceMembers.deletedAt),
        ),
      ),
    db
      .select({
        cardId: cardsToLabels.cardId,
        name: labels.name,
        colourCode: labels.colourCode,
      })
      .from(cardsToLabels)
      .innerJoin(labels, eq(labels.id, cardsToLabels.labelId))
      .where(
        and(inArray(cardsToLabels.cardId, cardIds), isNull(labels.deletedAt)),
      ),
  ]);

  const assigneesByCard = groupBy(assignees, (row) => row.cardId);
  const labelsByCard = groupBy(cardLabels, (row) => row.cardId);

  return rows.map(
    ({
      id,
      deletedAt,
      archivedAt,
      archivedAutomatically,
      autoDeletedAt,
      ...row
    }) => ({
      ...row,
      archive: archivedAt
        ? { at: archivedAt, automatic: archivedAutomatically ?? false }
        : null,
      autoDeleted: deletedAt !== null && autoDeletedAt !== null,
      assignees: (assigneesByCard.get(id) ?? []).map((a) => ({
        userId: a.userId,
        // Someone invited but not registered yet has no name: show the address.
        name: a.name?.trim() ? a.name : a.email,
      })),
      labels: (labelsByCard.get(id) ?? []).map(({ name, colourCode }) => ({
        name,
        colourCode,
      })),
    }),
  );
}

/**
 * When each card last had any activity: a move, an edit, a comment. Kan
 * records one for every change, which `cards.updatedAt` does not catch (a
 * move between lists leaves it alone). Cards with no activity are left out.
 */
export async function lastActivityByCard(
  db: Db,
  cardPublicIds: readonly string[],
): Promise<Map<string, Date>> {
  if (cardPublicIds.length === 0) return new Map();
  const rows = await db
    .select({ publicId: cards.publicId, at: max(cardActivities.createdAt) })
    .from(cardActivities)
    .innerJoin(cards, eq(cards.id, cardActivities.cardId))
    .where(inArray(cards.publicId, [...cardPublicIds]))
    .groupBy(cards.publicId);
  return new Map(
    rows.flatMap((row) => (row.at ? [[row.publicId, row.at] as const] : [])),
  );
}

export interface BoardWithLists {
  publicId: string;
  name: string;
  projectId: number;
  /** Live lists, left to right, with Kan's index for each. */
  lists: { publicId: string; name: string; index: number }[];
}

/**
 * The ordinary boards of the given projects that the viewer may see, with
 * their lists, including empty ones: the task board needs them to move a card
 * into a column that has no cards yet, and to offer a place for a new task.
 */
export async function listBoardsWithLists(
  db: Db,
  projectIds: readonly number[],
  viewerId: string,
): Promise<BoardWithLists[]> {
  if (projectIds.length === 0) return [];

  const rows = await db
    .select({
      boardId: boards.id,
      boardPublicId: boards.publicId,
      boardName: boards.name,
      projectId: boards.workspaceId,
      listPublicId: lists.publicId,
      listName: lists.name,
      listIndex: lists.index,
    })
    .from(boards)
    .leftJoin(lists, and(eq(lists.boardId, boards.id), isNull(lists.deletedAt)))
    .where(
      and(
        inArray(boards.workspaceId, [...projectIds]),
        eq(boards.type, "regular"),
        eq(boards.isArchived, false),
        isNull(boards.deletedAt),
        boardVisibleTo(db, viewerId),
      ),
    )
    .orderBy(asc(boards.id), asc(lists.index));

  const byBoard = new Map<number, BoardWithLists>();
  for (const row of rows) {
    const board = byBoard.get(row.boardId) ?? {
      publicId: row.boardPublicId,
      name: row.boardName,
      projectId: row.projectId,
      lists: [],
    };
    if (row.listPublicId && row.listName !== null && row.listIndex !== null) {
      board.lists.push({
        publicId: row.listPublicId,
        name: row.listName,
        index: row.listIndex,
      });
    }
    byBoard.set(row.boardId, board);
  }
  return [...byBoard.values()];
}

function groupBy<T, K>(
  items: readonly T[],
  keyOf: (item: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

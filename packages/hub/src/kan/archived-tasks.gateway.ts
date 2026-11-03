import type { SQL } from "drizzle-orm";
import { and, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";

import * as cardRepo from "@kan/db/repository/card.repo";
import { boards, cards, lists } from "@kan/db/schema";

import type { Db, DbOrTx, Tx } from "../db";
import { hubArchivedCards } from "../schema";
import { boardVisibleTo } from "./private-boards.gateway";

/**
 * The card sits in a live list on a live ordinary board: not a template, not
 * an archived or deleted board. Everything 归档 does is limited to these.
 */
function onLiveOrdinaryBoard(): SQL | undefined {
  return and(
    eq(boards.type, "regular"),
    eq(boards.isArchived, false),
    isNull(boards.deletedAt),
    isNull(lists.deletedAt),
  );
}

/** Where a card lives, for checking who may put it away or bring it back. */
export interface CardPlace {
  id: number;
  projectId: number;
}

/**
 * A live card on a live ordinary board that the viewer may see, or undefined:
 * the same answer for a card that does not exist and one they cannot see.
 */
export async function findVisibleCard(
  db: DbOrTx,
  cardPublicId: string,
  viewerId: string,
): Promise<CardPlace | undefined> {
  const [row] = await db
    .select({ id: cards.id, projectId: boards.workspaceId })
    .from(cards)
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .where(
      and(
        eq(cards.publicId, cardPublicId),
        onLiveOrdinaryBoard(),
        isNull(cards.deletedAt),
        boardVisibleTo(db, viewerId),
      ),
    )
    .limit(1);
  return row;
}

export interface CardOnBoard {
  id: number;
  publicId: string;
  listName: string;
  /** When someone last brought it back from 归档; null if never. */
  restoredAt: Date | null;
}

function selectCardsOnBoards(db: DbOrTx, only?: SQL) {
  return db
    .select({
      id: cards.id,
      publicId: cards.publicId,
      listName: lists.name,
      restoredAt: hubArchivedCards.restoredAt,
    })
    .from(cards)
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .leftJoin(hubArchivedCards, eq(hubArchivedCards.cardId, cards.id))
    .where(
      and(
        only,
        onLiveOrdinaryBoard(),
        isNull(cards.deletedAt),
        isNull(hubArchivedCards.archivedAt),
      ),
    );
}

/**
 * Every live card on a live ordinary board, in any project, that is not in
 * 归档: what the clean-up looks through for finished work. Templates and
 * archived boards are left alone. Read-only.
 */
export async function listCardsOnBoards(db: DbOrTx): Promise<CardOnBoard[]> {
  return selectCardsOnBoards(db);
}

/**
 * The same, for just these cards, as they are now, locked for the rest of the
 * transaction: a move to another column waits until it ends. Cards that left
 * a live board, were deleted or went to 归档 since are not returned.
 */
export async function lockCardsOnBoards(
  tx: Tx,
  cardIds: readonly number[],
): Promise<CardOnBoard[]> {
  if (cardIds.length === 0) return [];
  return selectCardsOnBoards(tx, inArray(cards.id, [...cardIds])).for(
    "update",
    { of: cards },
  );
}

/**
 * Cards in 归档 since `cutoff` or earlier that are still there to delete, on a
 * live ordinary board: a card whose board was archived since is left alone,
 * like the rest of that board.
 */
function expiredArchivedCards(cutoff: Date): SQL | undefined {
  return and(
    isNotNull(hubArchivedCards.archivedAt),
    lte(hubArchivedCards.archivedAt, cutoff),
    isNull(hubArchivedCards.autoDeletedAt),
    isNull(cards.deletedAt),
    onLiveOrdinaryBoard(),
  );
}

/** The cards due for deletion as of `cutoff`. Read-only. */
export async function listExpiredArchivedCards(
  db: DbOrTx,
  cutoff: Date,
): Promise<number[]> {
  const rows = await db
    .select({ id: cards.id })
    .from(hubArchivedCards)
    .innerJoin(cards, eq(cards.id, hubArchivedCards.cardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .where(expiredArchivedCards(cutoff));
  return rows.map((row) => row.id);
}

/**
 * Locks one card and its 归档 row for the rest of the transaction if the card
 * is still due for deletion, and returns its public id; undefined if someone
 * restored or deleted it since it was listed. Both rows are locked: a restore
 * writes the 归档 row and Kan's own delete writes the card, and either one
 * that arrives first wins (the check is made against what it committed),
 * while one that arrives later waits and then finds nothing to do.
 */
export async function lockExpiredArchivedCard(
  tx: Tx,
  cardId: number,
  cutoff: Date,
): Promise<{ publicId: string } | undefined> {
  const [row] = await tx
    .select({ publicId: cards.publicId })
    .from(hubArchivedCards)
    .innerJoin(cards, eq(cards.id, hubArchivedCards.cardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .where(
      and(eq(hubArchivedCards.cardId, cardId), expiredArchivedCards(cutoff)),
    )
    .for("update", { of: [hubArchivedCards, cards] })
    .limit(1);
  return row;
}

/**
 * Deletes a card through Kan's own delete (soft, closing the gap in its list),
 * as the clean-up rather than a person. Kan's signature asks for whoever
 * deleted it; the column is nullable and nobody is the truth here. No activity
 * is logged and no webhook fires: Kan does both in its router, not here.
 *
 * Runs inside the caller's transaction so the deletion stands or falls with
 * the 归档 row's lock and its mark. Kan's repositories are typed for the plain
 * client, but take a transaction just the same (their own transaction nests as
 * a savepoint).
 */
export async function deleteCardUnattended(
  tx: Tx,
  cardId: number,
  at: Date,
): Promise<void> {
  await cardRepo.softDelete(tx as unknown as Db, {
    cardId,
    deletedAt: at,
    deletedBy: null as unknown as string,
  });
}

/**
 * The ids of a project's cards that are in 归档, for Kan's board page to leave
 * out. Internal ids: they never leave the server. Read-only.
 */
export async function archivedCardIdsInProject(
  db: DbOrTx,
  projectId: number,
): Promise<number[]> {
  const rows = await db
    .select({ id: cards.id })
    .from(hubArchivedCards)
    .innerJoin(cards, eq(cards.id, hubArchivedCards.cardId))
    .innerJoin(lists, eq(lists.id, cards.listId))
    .innerJoin(boards, eq(boards.id, lists.boardId))
    .where(
      and(
        eq(boards.workspaceId, projectId),
        isNotNull(hubArchivedCards.archivedAt),
        isNull(cards.deletedAt),
      ),
    );
  return rows.map((row) => row.id);
}

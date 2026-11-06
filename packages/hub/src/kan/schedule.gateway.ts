import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";

import { cards } from "@kan/db/schema";

import type { DbOrTx } from "../db";
import { hubArchivedCards } from "../schema";

/**
 * Public ids of cards, keyed by their row ids. Soft-deleted cards are skipped,
 * except those the 归档 clean-up deleted: time already spent on them stays on
 * the calendar.
 */
export async function publicIdsOfCards(
  db: DbOrTx,
  cardIds: readonly number[],
): Promise<Map<number, string>> {
  if (cardIds.length === 0) return new Map();
  const rows = await db
    .select({ id: cards.id, publicId: cards.publicId })
    .from(cards)
    .leftJoin(hubArchivedCards, eq(hubArchivedCards.cardId, cards.id))
    .where(
      and(
        inArray(cards.id, [...cardIds]),
        or(isNull(cards.deletedAt), isNotNull(hubArchivedCards.autoDeletedAt)),
      ),
    );
  return new Map(rows.map((row) => [row.id, row.publicId]));
}

/** The row id of one live card, or undefined. */
export async function cardIdOf(
  db: DbOrTx,
  cardPublicId: string,
): Promise<number | undefined> {
  const [row] = await db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.publicId, cardPublicId), isNull(cards.deletedAt)))
    .limit(1);
  return row?.id;
}

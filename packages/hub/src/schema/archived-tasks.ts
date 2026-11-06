import { bigint, boolean, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

import { cards, users } from "@kan/db/schema";

/**
 * 归档: tasks put away off the boards. Kan has no archive for cards, so the
 * Hub keeps one. A card without a row here is on its board as usual.
 *
 * - `archivedAt` set: in 归档, hidden from every board, the Hub's and Kan's.
 *   `automatic` when it went there on its own, `ARCHIVE_AFTER_DAYS` after it
 *   was finished; otherwise `archivedBy` pressed 归档.
 * - `archivedAt` null: back on its board since `restoredAt`. A finished task
 *   then waits the full `ARCHIVE_AFTER_DAYS` again before it goes back.
 * - `autoDeletedAt` set: the clean-up deleted the card (Kan's soft delete)
 *   after `DELETE_AFTER_DAYS` in 归档. The row stays so 我完成的 still counts
 *   it; a card someone deleted by hand has no such mark and stops counting.
 */
export const hubArchivedCards = pgTable("hub_archived_card", {
  cardId: bigint("cardId", { mode: "number" })
    .primaryKey()
    .references(() => cards.id, { onDelete: "cascade" }),
  archivedAt: timestamp("archivedAt"),
  archivedBy: uuid("archivedBy").references(() => users.id, {
    onDelete: "set null",
  }),
  automatic: boolean("automatic").default(false).notNull(),
  restoredAt: timestamp("restoredAt"),
  autoDeletedAt: timestamp("autoDeletedAt"),
}).enableRLS();

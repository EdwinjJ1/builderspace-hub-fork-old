import type { dbClient } from "@kan/db/client";
import { archivedCardIds as archivedCardIdsInProject } from "@kan/hub/archived-tasks";

// Where Kan's own board pages meet 归档. Called from one-line hub-seams in
// routers/board.ts (docs/hub/UPSTREAM_SEAMS.md); the rules live in
// @kan/hub/archived-tasks.

/**
 * `board.byId` and `board.bySlug`: the cards of the board's project that are
 * in 归档, for the board query to leave out.
 */
export function archivedCardIds(
  db: dbClient,
  projectId: number,
): Promise<number[]> {
  return archivedCardIdsInProject(db, projectId);
}

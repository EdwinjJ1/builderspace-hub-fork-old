/**
 * A steady colour for a board that is not one of the three functions (核心三人,
 * a person's private board, ...), so its cards stop all being the same grey.
 * Picked from the same soft palette the functions use, by the board's id, so a
 * board keeps its colour from one visit to the next.
 */
const BOARD_COLOURS = [
  "#9A86D1",
  "#C77F95",
  "#C9A646",
  "#D7776B",
  "#8AA35A",
  "#4FA3A5",
] as const;

export function boardColour(boardPublicId: string): string {
  let hash = 0;
  for (const char of boardPublicId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return BOARD_COLOURS[hash % BOARD_COLOURS.length] ?? BOARD_COLOURS[0];
}

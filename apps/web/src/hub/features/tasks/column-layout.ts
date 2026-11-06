import type { Stage } from "@kan/hub/public";

/**
 * How wide a column of the overall board is drawn.
 * - full: has tasks, takes its share of the width.
 * - slim: empty, but still a comfortable place to drop a task.
 * - strip: 其他 while closed. Tasks cannot be dropped there, so it is a thin
 *   bar until someone opens it.
 */
export type ColumnMode = "full" | "slim" | "strip";

export function columnMode(
  stage: Stage,
  total: number,
  otherOpen: boolean,
): ColumnMode {
  if (stage === "other") return otherOpen && total > 0 ? "full" : "strip";
  return total === 0 ? "slim" : "full";
}

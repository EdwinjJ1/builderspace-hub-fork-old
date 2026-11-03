import { hubStructure } from "@kan/builderspace/structure";

/**
 * Pure rules for the home page and the cross-project task board. No IO.
 *
 * Tasks are Kan cards. Which column a card belongs in is read from its list's
 * name and which function it belongs to from its board's name, using the
 * standard names in `@kan/builderspace` (待办 / 进行中 / 待验收 / 已完成 and
 * 技术 / 活动 / 运营, or a function's former name). A list or board someone
 * renamed is never dropped: its cards land in "other".
 */

/** The columns of the task board, left to right. */
export const stages = ["todo", "doing", "review", "done", "other"] as const;
export type Stage = (typeof stages)[number];

/** The standard functions. Must match `hubStructure.functions` (tested). */
export const functionKeys = ["dev", "ops", "marketing"] as const;
export type FunctionKey = (typeof functionKeys)[number];

/** Every way the task board can be filtered, as it appears in the URL. */
export const taskViews = [
  "mine",
  "due-soon",
  "overdue",
  "all",
  ...functionKeys,
] as const;
export type TaskView = (typeof taskViews)[number];

/** A task counts as "due soon" when it is due within this many days. */
export const DUE_SOON_DAYS = 7;

/** How many finished tasks a column shows; older ones stay on the boards. */
export const DONE_COLUMN_LIMIT = 50;

const canonicalStages = ["todo", "doing", "review", "done"] as const;

const normalise = (name: string) => name.trim().toLowerCase();

const STAGE_BY_LIST_NAME = new Map<string, Stage>([
  ...hubStructure.lists.map(
    (name, index) =>
      [normalise(name), canonicalStages[index] ?? "other"] as const,
  ),
  // The short form people write for 已完成 on boards they set up themselves.
  ["完成", "done"],
  // Kan's own templates, so boards made from them still sort sensibly.
  ["to do", "todo"],
  ["todo", "todo"],
  ["backlog", "todo"],
  ["in progress", "doing"],
  ["doing", "doing"],
  ["code review", "review"],
  ["review", "review"],
  ["done", "done"],
]);

/** The column a card belongs in, from the name of its list. */
export function stageOf(listName: string): Stage {
  return STAGE_BY_LIST_NAME.get(normalise(listName)) ?? "other";
}

/**
 * Where a list for `stage` goes when its board has none: Kan's index of the
 * first list of a later column, so 待验收 lands between 进行中 and 已完成
 * whatever else the board keeps around them. Undefined when no later column
 * has a list: the end, where Kan puts a new list anyway.
 */
export function missingListIndex(
  lists: readonly { name: string; index: number }[],
  stage: Exclude<Stage, "other">,
): number | undefined {
  const rank = (s: Stage) => (canonicalStages as readonly Stage[]).indexOf(s);
  const later = [...lists]
    .sort((a, b) => a.index - b.index)
    .find((list) => rank(stageOf(list.name)) > rank(stage));
  return later?.index;
}

const FUNCTION_BY_BOARD_NAME = new Map<string, FunctionKey>(
  hubStructure.functions.flatMap(({ key, name, formerNames = [] }) =>
    isFunctionKey(key)
      ? [name, key, ...formerNames].map((n) => [normalise(n), key] as const)
      : [],
  ),
);

function isFunctionKey(value: string): value is FunctionKey {
  return (functionKeys as readonly string[]).includes(value);
}

/** The function a board stands for, or null for any other board. */
export function functionKeyOf(boardName: string): FunctionKey | null {
  return FUNCTION_BY_BOARD_NAME.get(normalise(boardName)) ?? null;
}

/**
 * Display names, straight from the shared structure so a column on the task
 * board reads exactly like the list it came from. "other" has no list; pages
 * name it themselves.
 */
export const stageNames = Object.fromEntries(
  canonicalStages.map((stage, index) => [
    stage,
    hubStructure.lists[index] ?? stage,
  ]),
) as Record<Exclude<Stage, "other">, string>;

export const functionNames = Object.fromEntries(
  functionKeys.map((key) => [
    key,
    hubStructure.functions.find((f) => f.key === key)?.name ?? key,
  ]),
) as Record<FunctionKey, string>;

export function isOpen(stage: Stage): boolean {
  return stage !== "done";
}

export type DueState = "none" | "overdue" | "soon" | "later";

export function dueStateOf(dueDate: Date | null, now: Date): DueState {
  if (!dueDate) return "none";
  const msLeft = dueDate.getTime() - now.getTime();
  if (msLeft < 0) return "overdue";
  if (msLeft <= DUE_SOON_DAYS * 24 * 60 * 60 * 1000) return "soon";
  return "later";
}

/** What the view rules need to know about one task. */
export interface TaskFacts {
  stage: Stage;
  functionKey: FunctionKey | null;
  dueState: DueState;
  assignedToMe: boolean;
}

export function inView(task: TaskFacts, view: TaskView): boolean {
  switch (view) {
    case "mine":
      return task.assignedToMe;
    case "due-soon":
      return isOpen(task.stage) && task.dueState === "soon";
    case "overdue":
      return isOpen(task.stage) && task.dueState === "overdue";
    case "all":
      return true;
    default:
      return task.functionKey === view;
  }
}

/**
 * Whether a task is on a board: in its view and, with 只看我的 on, assigned to
 * me. The board narrows before it counts and before it cuts the done column,
 * so totals and the limit are those of the tasks shown.
 */
export function onBoard(
  task: TaskFacts,
  view: TaskView,
  onlyMine: boolean,
): boolean {
  return inView(task, view) && (!onlyMine || task.assignedToMe);
}

/**
 * The columns a view shows. Finished work is never due or overdue, so those
 * views leave the "done" column out. "other" is kept here; the board hides it
 * when it is empty.
 */
export function columnsOf(view: TaskView): Stage[] {
  if (view === "due-soon" || view === "overdue") {
    return stages.filter((stage) => stage !== "done");
  }
  return [...stages];
}

/** The counts on the home page's category tiles. Only open tasks count. */
export interface TileCounts {
  mine: number;
  dueSoon: number;
  overdue: number;
  open: number;
}

export function countTiles(tasks: readonly TaskFacts[]): TileCounts {
  const counts: TileCounts = { mine: 0, dueSoon: 0, overdue: 0, open: 0 };
  for (const task of tasks) {
    if (!isOpen(task.stage)) continue;
    counts.open += 1;
    if (task.assignedToMe) counts.mine += 1;
    if (task.dueState === "soon") counts.dueSoon += 1;
    if (task.dueState === "overdue") counts.overdue += 1;
  }
  return counts;
}

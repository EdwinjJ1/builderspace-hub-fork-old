import type { RouterOutputs } from "~/utils/api";

type Board = RouterOutputs["hub"]["tasks"]["board"];
type Stage = Board["columns"][number]["stage"];

/**
 * The board as it will look once a task has moved to another column, for
 * showing the move straight away while the server catches up. Pure.
 */
export function withTaskMoved(
  board: Board,
  taskPublicId: string,
  to: Stage,
  listName: string,
): Board {
  const task = board.columns
    .flatMap((column) => column.tasks)
    .find((candidate) => candidate.publicId === taskPublicId);
  if (!task || task.stage === to) return board;
  if (!board.columns.some((column) => column.stage === to)) return board;

  const moved = { ...task, stage: to, listName };
  return {
    ...board,
    columns: board.columns.map((column) => {
      if (column.stage === task.stage) {
        return {
          ...column,
          tasks: column.tasks.filter((t) => t.publicId !== taskPublicId),
          total: column.total - 1,
        };
      }
      if (column.stage === to) {
        return {
          ...column,
          tasks: [moved, ...column.tasks],
          total: column.total + 1,
        };
      }
      return column;
    }),
  };
}

/**
 * For a board query's `placeholderData`: keeps the board on screen while
 * 只看我的 is switched, so the switch does not vanish under the pointer. A
 * different view or scope still starts from the skeleton. Pure.
 */
export function keepWhileSwitchingMine(query: {
  view: Board["view"];
  project?: string;
}) {
  return (previous: Board | undefined): Board | undefined =>
    previous?.view === query.view &&
    (previous.scope.current?.publicId ?? undefined) === query.project
      ? previous
      : undefined;
}

/** The board with one task's due date changed. Pure. */
export function withTaskDue(
  board: Board,
  taskPublicId: string,
  dueDate: Date | null,
): Board {
  return {
    ...board,
    columns: board.columns.map((column) => ({
      ...column,
      tasks: column.tasks.map((task) =>
        task.publicId === taskPublicId ? { ...task, dueDate } : task,
      ),
    })),
  };
}

/** The board without one task, once it went to 归档 or was deleted. Pure. */
export function withTaskRemoved(board: Board, taskPublicId: string): Board {
  return {
    ...board,
    columns: board.columns.map((column) =>
      column.tasks.some((task) => task.publicId === taskPublicId)
        ? {
            ...column,
            tasks: column.tasks.filter(
              (task) => task.publicId !== taskPublicId,
            ),
            total: column.total - 1,
          }
        : column,
    ),
  };
}

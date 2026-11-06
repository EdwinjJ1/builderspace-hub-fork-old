import { describe, expect, it } from "vitest";

import type { RouterOutputs } from "~/utils/api";
import {
  keepWhileSwitchingMine,
  withTaskDue,
  withTaskMoved,
  withTaskRemoved,
} from "./board-cache";

type Board = RouterOutputs["hub"]["tasks"]["board"];

const task = (publicId: string, stage: string) =>
  ({ publicId, stage, listName: "待办", dueDate: null }) as never;

const board = {
  columns: [
    { stage: "todo", tasks: [task("a", "todo"), task("b", "todo")], total: 2 },
    { stage: "doing", tasks: [], total: 0 },
  ],
} as unknown as Board;

describe("withTaskMoved", () => {
  it("moves a task to the top of another column and fixes the totals", () => {
    const after = withTaskMoved(board, "b", "doing", "进行中");

    expect(after.columns[0]?.tasks.map((t) => t.publicId)).toEqual(["a"]);
    expect(after.columns[0]?.total).toBe(1);
    expect(after.columns[1]?.tasks[0]).toMatchObject({
      publicId: "b",
      stage: "doing",
      listName: "进行中",
    });
    expect(after.columns[1]?.total).toBe(1);
  });

  it("leaves the board alone for an unknown task, the same column or a hidden column", () => {
    expect(withTaskMoved(board, "zz", "doing", "进行中")).toBe(board);
    expect(withTaskMoved(board, "a", "todo", "待办")).toBe(board);
    expect(withTaskMoved(board, "a", "done", "已完成")).toBe(board);
  });
});

describe("keepWhileSwitchingMine", () => {
  const shown = (view: string, project: string | null) =>
    ({
      view,
      onlyMine: false,
      scope: { current: project ? { publicId: project } : null },
    }) as unknown as Board;

  it("keeps the board when only 只看我的 changes", () => {
    const all = shown("all", null);
    const scoped = shown("all", "p1");

    expect(keepWhileSwitchingMine({ view: "all" })(all)).toBe(all);
    expect(keepWhileSwitchingMine({ view: "all", project: "p1" })(scoped)).toBe(
      scoped,
    );
  });

  it("drops it for another view or another scope", () => {
    expect(
      keepWhileSwitchingMine({ view: "dev" })(shown("all", null)),
    ).toBeUndefined();
    expect(
      keepWhileSwitchingMine({ view: "all", project: "p2" })(
        shown("all", "p1"),
      ),
    ).toBeUndefined();
    expect(
      keepWhileSwitchingMine({ view: "all" })(shown("all", "p1")),
    ).toBeUndefined();
    expect(keepWhileSwitchingMine({ view: "all" })(undefined)).toBeUndefined();
  });
});

describe("withTaskDue", () => {
  it("changes only that task's due date", () => {
    const due = new Date("2026-10-20T12:00:00Z");
    const after = withTaskDue(board, "a", due);

    expect(after.columns[0]?.tasks[0]?.dueDate).toBe(due);
    expect(after.columns[0]?.tasks[1]?.dueDate).toBeNull();
  });
});

describe("withTaskRemoved", () => {
  it("takes the task out of its column and fixes the total", () => {
    const after = withTaskRemoved(board, "a");

    expect(after.columns[0]?.tasks.map((t) => t.publicId)).toEqual(["b"]);
    expect(after.columns[0]?.total).toBe(1);
    expect(after.columns[1]).toBe(board.columns[1]);
  });

  it("changes no totals for an unknown task", () => {
    const after = withTaskRemoved(board, "zz");
    expect(after.columns.map((c) => c.total)).toEqual([2, 0]);
  });
});

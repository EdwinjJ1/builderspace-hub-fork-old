import { describe, expect, it } from "vitest";

import { hubStructure } from "@kan/builderspace/structure";

import type { TaskFacts, TaskView } from "./task.policy";
import {
  columnsOf,
  countTiles,
  DUE_SOON_DAYS,
  dueStateOf,
  functionKeyOf,
  functionKeys,
  functionNames,
  inView,
  missingListIndex,
  onBoard,
  stageNames,
  stageOf,
  taskViews,
} from "./task.policy";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-14T00:00:00Z");

const task = (overrides: Partial<TaskFacts> = {}): TaskFacts => ({
  stage: "todo",
  functionKey: "dev",
  dueState: "none",
  assignedToMe: false,
  ...overrides,
});

describe("stageOf", () => {
  it("reads the standard list names", () => {
    expect(hubStructure.lists.map(stageOf)).toEqual([
      "todo",
      "doing",
      "review",
      "done",
    ]);
  });

  it("understands the lists of Kan's own templates, in any case", () => {
    expect(stageOf("To Do")).toBe("todo");
    expect(stageOf(" in progress ")).toBe("doing");
    expect(stageOf("Code Review")).toBe("review");
    expect(stageOf("DONE")).toBe("done");
  });

  it("reads 完成, the short form of 已完成, as done", () => {
    expect(stageOf("完成")).toBe("done");
    expect(stageOf(" 完成 ")).toBe("done");
  });

  it("puts a renamed list in other instead of losing its cards", () => {
    expect(stageOf("灵感池")).toBe("other");
    expect(stageOf("")).toBe("other");
  });
});

describe("missingListIndex", () => {
  const lists = (...names: string[]) =>
    names.map((name, index) => ({ name, index: index * 2 }));

  it("puts a missing column in front of the first later one, by Kan's index", () => {
    // Indexes 0, 2, 4: Kan's, not positions.
    expect(missingListIndex(lists("待办", "进行中", "已完成"), "review")).toBe(
      4,
    );
    expect(missingListIndex(lists("待办", "已完成"), "doing")).toBe(2);
    expect(missingListIndex(lists("进行中", "已完成"), "todo")).toBe(0);
  });

  it("skips lists that are no column, wherever they are", () => {
    expect(
      missingListIndex(
        lists("待办", "进行中", "卡住（暂停）", "完成", "每日日报"),
        "review",
      ),
    ).toBe(6);
  });

  it("follows Kan's order, not the order the lists were given in", () => {
    expect(
      missingListIndex(
        [
          { name: "已完成", index: 5 },
          { name: "待验收", index: 3 },
        ],
        "doing",
      ),
    ).toBe(3);
  });

  it("leaves it to the end when no later column has a list", () => {
    expect(missingListIndex(lists("待办", "进行中"), "done")).toBeUndefined();
    expect(missingListIndex(lists("灵感池"), "todo")).toBeUndefined();
    expect(missingListIndex([], "review")).toBeUndefined();
  });
});

describe("functionKeyOf", () => {
  it("matches every standard function by name and by key", () => {
    for (const { key, name } of hubStructure.functions) {
      expect(functionKeyOf(name)).toBe(key);
      expect(functionKeyOf(key.toUpperCase())).toBe(key);
    }
  });

  it("still recognises a board under its function's former name", () => {
    for (const { key, formerNames = [] } of hubStructure.functions) {
      for (const name of formerNames) expect(functionKeyOf(name)).toBe(key);
    }
    expect(functionKeyOf("开发")).toBe("dev");
  });

  it("reads 运营 as marketing now that the ops board is called 活动", () => {
    expect(functionKeyOf("运营")).toBe("marketing");
    expect(functionKeyOf("营销")).toBe("marketing");
    expect(functionKeyOf("活动")).toBe("ops");
  });

  it("returns null for any other board", () => {
    expect(functionKeyOf("Roadmap")).toBeNull();
  });

  it("lists the same functions as the shared structure", () => {
    expect([...functionKeys]).toEqual(hubStructure.functions.map((f) => f.key));
  });
});

describe("dueStateOf", () => {
  it("has no state without a due date", () => {
    expect(dueStateOf(null, now)).toBe("none");
  });

  it("is overdue once the due time has passed", () => {
    expect(dueStateOf(new Date(now.getTime() - 1), now)).toBe("overdue");
  });

  it("is due soon up to and including the window, later after it", () => {
    expect(dueStateOf(now, now)).toBe("soon");
    expect(dueStateOf(new Date(now.getTime() + DUE_SOON_DAYS * DAY), now)).toBe(
      "soon",
    );
    expect(
      dueStateOf(new Date(now.getTime() + DUE_SOON_DAYS * DAY + 1), now),
    ).toBe("later");
  });
});

describe("inView", () => {
  const cases: [TaskView, TaskFacts, boolean][] = [
    ["mine", task({ assignedToMe: true }), true],
    ["mine", task({ assignedToMe: true, stage: "done" }), true],
    ["mine", task(), false],
    ["due-soon", task({ dueState: "soon" }), true],
    ["due-soon", task({ dueState: "soon", stage: "done" }), false],
    ["due-soon", task({ dueState: "later" }), false],
    ["overdue", task({ dueState: "overdue" }), true],
    ["overdue", task({ dueState: "overdue", stage: "done" }), false],
    ["all", task({ stage: "done", functionKey: null }), true],
    ["dev", task({ functionKey: "dev" }), true],
    ["ops", task({ functionKey: "dev" }), false],
    ["marketing", task({ functionKey: null }), false],
  ];

  it.each(cases)("%s with %j → %s", (view, facts, expected) => {
    expect(inView(facts, view)).toBe(expected);
  });

  it("covers every view", () => {
    expect(new Set(cases.map(([view]) => view))).toEqual(new Set(taskViews));
  });
});

describe("onBoard", () => {
  const cases: [TaskView, TaskFacts, boolean, boolean][] = [
    ["all", task(), false, true],
    ["all", task(), true, false],
    ["all", task({ assignedToMe: true, stage: "done" }), true, true],
    ["dev", task({ assignedToMe: true, functionKey: "ops" }), true, false],
    ["overdue", task({ assignedToMe: true, dueState: "overdue" }), true, true],
    ["overdue", task({ assignedToMe: true }), true, false],
    ["mine", task({ assignedToMe: true }), true, true],
    ["mine", task(), false, false],
  ];

  it.each(cases)(
    "%s with %j, only mine %s → %s",
    (view, facts, onlyMine, expected) => {
      expect(onBoard(facts, view, onlyMine)).toBe(expected);
    },
  );

  it("is the view itself without 只看我的", () => {
    for (const view of taskViews) {
      for (const facts of [
        task(),
        task({ assignedToMe: true, stage: "done" }),
        task({ dueState: "soon", functionKey: "ops" }),
      ]) {
        expect(onBoard(facts, view, false)).toBe(inView(facts, view));
      }
    }
  });
});

describe("columnsOf", () => {
  it("shows every column for most views", () => {
    expect(columnsOf("all")).toEqual([
      "todo",
      "doing",
      "review",
      "done",
      "other",
    ]);
    expect(columnsOf("mine")).toContain("done");
  });

  it("leaves finished work out of the due views", () => {
    expect(columnsOf("due-soon")).not.toContain("done");
    expect(columnsOf("overdue")).toEqual(["todo", "doing", "review", "other"]);
  });
});

describe("countTiles", () => {
  it("counts open tasks only", () => {
    expect(
      countTiles([
        task({ assignedToMe: true, dueState: "overdue" }),
        task({ dueState: "soon" }),
        task({ stage: "other" }),
        task({ stage: "done", assignedToMe: true, dueState: "overdue" }),
      ]),
    ).toEqual({ mine: 1, dueSoon: 1, overdue: 1, open: 3 });
  });

  it("is all zeros for no tasks", () => {
    expect(countTiles([])).toEqual({
      mine: 0,
      dueSoon: 0,
      overdue: 0,
      open: 0,
    });
  });
});

describe("display names", () => {
  it("names columns and functions exactly like the shared structure", () => {
    expect(Object.values(stageNames)).toEqual(hubStructure.lists);
    expect(Object.values(functionNames)).toEqual(
      hubStructure.functions.map((f) => f.name),
    );
  });
});

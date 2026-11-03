import type { ClientRect, Collision, DroppableContainer } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";

import { columnUnderPointer } from "./column-collision";

type Args = Parameters<typeof columnUnderPointer>[0];

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

/** Two columns side by side with a 12px gap: todo 0-200, doing 212-412. */
function argsWith(
  pointer: { x: number; y: number } | null,
  card = rect(150, 100, 200, 80),
): Args {
  const columns: Record<string, ClientRect> = {
    todo: rect(0, 0, 200, 600),
    doing: rect(212, 0, 200, 600),
  };
  return {
    active: {
      id: "card",
      data: { current: undefined },
      rect: { current: { initial: null, translated: null } },
    },
    collisionRect: card,
    droppableRects: new Map(Object.entries(columns)),
    droppableContainers: Object.keys(columns).map(
      (id) => ({ id, disabled: false }) as unknown as DroppableContainer,
    ),
    pointerCoordinates: pointer,
  } as unknown as Args;
}

const ids = (collisions: Collision[]) => collisions.map((c) => c.id);

describe("columnUnderPointer", () => {
  it("picks the column the pointer is in", () => {
    expect(ids(columnUnderPointer(argsWith({ x: 50, y: 300 })))).toEqual([
      "todo",
    ]);
    expect(ids(columnUnderPointer(argsWith({ x: 300, y: 300 })))).toEqual([
      "doing",
    ]);
  });

  it("drops nowhere when the pointer is in the gap, even if the card overlaps a column", () => {
    // The card (150-350) overlaps both columns; the pointer is in the gap.
    expect(columnUnderPointer(argsWith({ x: 206, y: 300 }))).toEqual([]);
  });

  it("drops nowhere when the pointer is off every column", () => {
    expect(columnUnderPointer(argsWith({ x: 700, y: 300 }))).toEqual([]);
  });

  it("falls back to the card's box when there is no pointer (keyboard)", () => {
    expect(
      ids(columnUnderPointer(argsWith(null, rect(20, 100, 120, 80)))),
    ).toEqual(["todo"]);
  });
});

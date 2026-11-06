import { describe, expect, it } from "vitest";

import { boardColour } from "./board-colour";

describe("boardColour", () => {
  it("gives a board the same colour every time", () => {
    expect(boardColour("f2stqko7qova")).toBe(boardColour("f2stqko7qova"));
  });

  it("returns a #RRGGBB colour, whatever the id", () => {
    for (const id of ["", "a", "4hy5u75w9om0", "核心三人"]) {
      expect(boardColour(id)).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it("does not paint every board alike", () => {
    const ids = [
      "4hy5u75w9om0",
      "f2stqko7qova",
      "5yvfsfz4n0x7",
      "zsshs7zaj3at",
    ];
    expect(new Set(ids.map(boardColour)).size).toBeGreaterThan(1);
  });
});

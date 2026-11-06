import { describe, expect, it } from "vitest";

import { columnMode } from "./column-layout";

describe("columnMode", () => {
  it("gives a column with tasks its full share", () => {
    expect(columnMode("todo", 60, false)).toBe("full");
    expect(columnMode("done", 1, false)).toBe("full");
  });

  it("slims an empty column but keeps it a place to drop", () => {
    expect(columnMode("review", 0, false)).toBe("slim");
  });

  it("closes 其他 to a strip until it is opened", () => {
    expect(columnMode("other", 5, false)).toBe("strip");
    expect(columnMode("other", 5, true)).toBe("full");
  });

  it("keeps an empty 其他 a strip even when opened", () => {
    expect(columnMode("other", 0, true)).toBe("strip");
  });
});

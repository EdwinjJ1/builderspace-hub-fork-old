import { describe, expect, it } from "vitest";

import {
  ARCHIVE_AFTER_DAYS,
  DELETE_AFTER_DAYS,
  deletesAt,
  deletionCutoff,
  isDueForArchive,
  isDueForDeletion,
} from "./archived-task.policy";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-26T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

describe("isDueForArchive", () => {
  it("waits ARCHIVE_AFTER_DAYS from when the task was finished", () => {
    expect(ARCHIVE_AFTER_DAYS).toBe(3);
    expect(
      isDueForArchive({ finishedAt: daysAgo(2.9), restoredAt: null }, now),
    ).toBe(false);
    expect(
      isDueForArchive({ finishedAt: daysAgo(3), restoredAt: null }, now),
    ).toBe(true);
  });

  it("starts the wait again when the task was restored", () => {
    expect(
      isDueForArchive({ finishedAt: daysAgo(10), restoredAt: daysAgo(1) }, now),
    ).toBe(false);
    expect(
      isDueForArchive({ finishedAt: daysAgo(10), restoredAt: daysAgo(3) }, now),
    ).toBe(true);
  });

  it("counts from the finish when it came after the restore", () => {
    expect(
      isDueForArchive({ finishedAt: daysAgo(1), restoredAt: daysAgo(5) }, now),
    ).toBe(false);
  });
});

describe("deletion", () => {
  it("comes DELETE_AFTER_DAYS after the task went to 归档", () => {
    expect(DELETE_AFTER_DAYS).toBe(7);
    expect(deletesAt(daysAgo(2))).toEqual(new Date(now.getTime() + 5 * DAY));
    expect(isDueForDeletion(daysAgo(6.9), now)).toBe(false);
    expect(isDueForDeletion(daysAgo(7), now)).toBe(true);
  });

  it("has a cutoff that agrees with isDueForDeletion", () => {
    const cutoff = deletionCutoff(now);
    expect(isDueForDeletion(cutoff, now)).toBe(true);
    expect(isDueForDeletion(new Date(cutoff.getTime() + 1), now)).toBe(false);
  });
});

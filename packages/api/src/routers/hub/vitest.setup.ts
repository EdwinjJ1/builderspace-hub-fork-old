import { vi } from "vitest";

import type * as ArchivedTasks from "./archived-tasks";
import type * as PrivateBoards from "./private-boards";

// Kan's integration tests boot an in-memory Postgres in each `beforeEach`
// under vitest's 10-second default. The Hub's integration tests here boot one
// per test too, and `pnpm test` runs every package at once, so on a busy CI
// runner Kan's hooks ran out of time. Every file gets the Hub's allowance;
// files that set their own keep it.
vi.setConfig({ hookTimeout: 60_000 });

/**
 * Kan's own router tests hand the procedures a stand-in database (no
 * `select`), and some mock modules such as `@kan/shared/utils` that the Hub's
 * private-board code needs just to load. For those tests the 仅自己可见 guard
 * and filters step aside, and the real code is never loaded. Every test with a
 * real database (the Hub's integration tests) gets the real ones.
 */
vi.mock("./private-boards", () => {
  let real: typeof PrivateBoards | undefined;
  const isRealDb = (db: unknown) =>
    typeof (db as { select?: unknown } | null)?.select === "function";
  const load = async () =>
    (real ??= await vi.importActual<typeof PrivateBoards>("./private-boards"));

  return {
    guardPrivateBoards: async (
      ...args: Parameters<typeof PrivateBoards.guardPrivateBoards>
    ) => {
      if (isRealDb(args[0])) await (await load()).guardPrivateBoards(...args);
    },
    visibleBoardsOnly: async (
      ...args: Parameters<typeof PrivateBoards.visibleBoardsOnly>
    ) =>
      isRealDb(args[0])
        ? (await load()).visibleBoardsOnly(...args)
        : [...args[2]],
    // Synchronous, so it uses the copy the guard loaded: the guard runs before
    // every procedure, so with a real database it is always there by now.
    boardsVisibleTo: (
      ...args: Parameters<typeof PrivateBoards.boardsVisibleTo>
    ) => {
      if (!isRealDb(args[0])) return undefined;
      if (!real)
        throw new Error("vitest.setup: the private-board guard has not run");
      return real.boardsVisibleTo(...args);
    },
  };
});

/** The same for 归档: on a stand-in database no card is archived. */
vi.mock("./archived-tasks", () => {
  const isRealDb = (db: unknown) =>
    typeof (db as { select?: unknown } | null)?.select === "function";

  return {
    archivedCardIds: async (
      ...args: Parameters<typeof ArchivedTasks.archivedCardIds>
    ) =>
      isRealDb(args[0])
        ? (
            await vi.importActual<typeof ArchivedTasks>("./archived-tasks")
          ).archivedCardIds(...args)
        : [],
  };
});

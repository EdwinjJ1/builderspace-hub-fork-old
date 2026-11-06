import { z } from "zod";

import type { Db } from "../db";
import type { TimeBlockKind } from "../schema";
import type { Task } from "../tasks";
import type { TimeBlockRow } from "./schedule.repo";
import { cardIdOf, publicIdsOfCards } from "../kan/schedule.gateway";
import { HubError } from "../shared/errors";
import { getMyTasks } from "../tasks";
import {
  isManualKind,
  manualKinds,
  normaliseTitle,
  rangeProblem,
  TITLE_MAX_LENGTH,
  windowProblem,
} from "./schedule.policy";
import {
  deleteBlock,
  findOwnBlock,
  insertBlock,
  listBlocksInWindow,
  listPlannedCardIds,
  updateBlock,
} from "./schedule.repo";

/**
 * The personal calendar: time the person marked free, busy or spent in a
 * meeting, and time set aside for tasks assigned to them.
 *
 * Everything here is scoped to one `userId` and never audited: the audit log is
 * visible to back-office admins, and a person's calendar is not theirs to read.
 */

export interface ScheduleBlock {
  publicId: string;
  kind: TimeBlockKind;
  /** For a task block, the card's current title. */
  title: string | null;
  startsAt: Date;
  endsAt: Date;
  /** Set on task blocks: the live state of the card the block is for. */
  task: Task | null;
}

export interface PlanTask {
  task: Task;
  /** Whether any time is set aside for it from now on. */
  planned: boolean;
}

export interface Schedule {
  blocks: ScheduleBlock[];
  /** My unfinished tasks, for the due-date markers and the "to plan" list. */
  openTasks: PlanTask[];
}

const titleSchema = z
  .string()
  .max(TITLE_MAX_LENGTH, `标题最多 ${TITLE_MAX_LENGTH} 个字`)
  .nullish();

const manualBlockSchema = z.object({
  kind: z.enum(manualKinds),
  title: titleSchema,
  startsAt: z.date(),
  endsAt: z.date(),
});

const taskBlockSchema = z.object({
  cardPublicId: z.string().min(1).max(32),
  startsAt: z.date(),
  endsAt: z.date(),
});

const editSchema = z.object({
  blockPublicId: z.string().min(1).max(32),
  kind: z.enum(manualKinds).optional(),
  title: titleSchema,
  startsAt: z.date().optional(),
  endsAt: z.date().optional(),
});

/** The inputs as zod schemas, so the API layer validates with the same rules. */
export const blockInputs = {
  manual: manualBlockSchema,
  task: taskBlockSchema,
  edit: editSchema,
};

export type NewManualBlock = z.input<typeof manualBlockSchema>;
export type NewTaskBlock = z.input<typeof taskBlockSchema>;
export type BlockEdit = z.input<typeof editSchema>;

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HubError(
      "INVALID_INPUT",
      result.error.issues[0]?.message ?? "输入不对",
    );
  }
  return result.data;
}

function requireValidRange(startsAt: Date, endsAt: Date): void {
  const problem = rangeProblem(startsAt, endsAt);
  if (problem) throw new HubError("INVALID_INPUT", problem);
}

/** What the calendar shows for `[from, to)`: my blocks and my unfinished tasks. */
export async function getSchedule(
  db: Db,
  input: { userId: string; from: Date; to: Date; now: Date },
): Promise<Schedule> {
  const problem = windowProblem(input.from, input.to);
  if (problem) throw new HubError("INVALID_INPUT", problem);

  const [rows, myTasks, plannedIds] = await Promise.all([
    listBlocksInWindow(db, input.userId, input.from, input.to),
    getMyTasks(db, { userId: input.userId, now: input.now }),
    listPlannedCardIds(db, input.userId, input.now),
  ]);

  const tasksByPublicId = new Map(myTasks.map((task) => [task.publicId, task]));
  const cardPublicIds = await publicIdsOfCards(
    db,
    rows.flatMap((row) => (row.cardId === null ? [] : [row.cardId])),
  );
  const plannedPublicIds = new Set([
    ...(await publicIdsOfCards(db, plannedIds)).values(),
  ]);

  return {
    blocks: rows.flatMap((row) => {
      const block = toBlock(row, cardPublicIds, tasksByPublicId);
      return block ? [block] : [];
    }),
    openTasks: myTasks
      // A task the clean-up deleted is still marked as archived.
      .filter((task) => task.stage !== "done" && task.archivedAt === null)
      .map((task) => ({ task, planned: plannedPublicIds.has(task.publicId) })),
  };
}

/**
 * A task block whose card is gone, or is no longer one of my visible tasks, is
 * left out rather than deleted: it comes back if the card is given to me again.
 */
function toBlock(
  row: TimeBlockRow,
  cardPublicIds: Map<number, string>,
  tasks: Map<string, Task>,
): ScheduleBlock | null {
  const base = {
    publicId: row.publicId,
    kind: row.kind,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
  };
  if (row.kind !== "task") return { ...base, title: row.title, task: null };

  const cardPublicId =
    row.cardId === null ? undefined : cardPublicIds.get(row.cardId);
  const task = cardPublicId ? tasks.get(cardPublicId) : undefined;
  return task ? { ...base, title: task.title, task } : null;
}

export async function createBlock(
  db: Db,
  userId: string,
  input: NewManualBlock,
): Promise<{ publicId: string }> {
  const data = parse(manualBlockSchema, input);
  requireValidRange(data.startsAt, data.endsAt);

  const row = await insertBlock(db, {
    userId,
    kind: data.kind,
    title: normaliseTitle(data.title),
    startsAt: data.startsAt,
    endsAt: data.endsAt,
    cardId: null,
  });
  return { publicId: row.publicId };
}

/** Sets time aside for a task assigned to me that is not finished yet. */
export async function planTask(
  db: Db,
  userId: string,
  input: NewTaskBlock,
  now: Date,
): Promise<{ publicId: string }> {
  const data = parse(taskBlockSchema, input);
  requireValidRange(data.startsAt, data.endsAt);

  const myTasks = await getMyTasks(db, { userId, now });
  const task = myTasks.find((t) => t.publicId === data.cardPublicId);
  // The same answer for a card that does not exist and one that is not mine.
  if (!task) {
    throw new HubError("NOT_FOUND", "没有这个任务，或者它没有指派给你。");
  }
  if (task.stage === "done") {
    throw new HubError("INVALID_INPUT", "这个任务已经完成，不用再排时间了。");
  }
  if (task.archivedAt) {
    throw new HubError("INVALID_INPUT", "这个任务在归档里，先恢复再排时间。");
  }

  const cardId = await cardIdOf(db, data.cardPublicId);
  if (cardId === undefined) {
    throw new HubError("NOT_FOUND", "没有这个任务，或者它没有指派给你。");
  }
  const row = await insertBlock(db, {
    userId,
    kind: "task",
    title: null,
    startsAt: data.startsAt,
    endsAt: data.endsAt,
    cardId,
  });
  return { publicId: row.publicId };
}

/**
 * Moves, resizes or relabels one of my blocks. A task block can only move: its
 * title and meaning belong to the card.
 */
export async function editBlock(
  db: Db,
  userId: string,
  input: BlockEdit,
): Promise<{ publicId: string }> {
  const data = parse(editSchema, input);
  const block = await findOwnBlock(db, userId, data.blockPublicId);
  if (!block) throw new HubError("NOT_FOUND", "没有找到这个时间段。");

  if (
    !isManualKind(block.kind) &&
    (data.kind !== undefined || data.title !== undefined)
  ) {
    throw new HubError(
      "INVALID_INPUT",
      "任务的时间段只能改时间，标题跟着任务走。",
    );
  }

  const startsAt = data.startsAt ?? block.startsAt;
  const endsAt = data.endsAt ?? block.endsAt;
  requireValidRange(startsAt, endsAt);

  const row = await updateBlock(db, block.id, {
    startsAt,
    endsAt,
    ...(data.kind === undefined ? {} : { kind: data.kind }),
    ...(data.title === undefined ? {} : { title: normaliseTitle(data.title) }),
  });
  return { publicId: row.publicId };
}

export async function removeBlock(
  db: Db,
  userId: string,
  blockPublicId: string,
): Promise<void> {
  const block = await findOwnBlock(db, userId, blockPublicId);
  if (!block) throw new HubError("NOT_FOUND", "没有找到这个时间段。");
  await deleteBlock(db, block.id);
}

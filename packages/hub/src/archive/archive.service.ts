import type { Db, DbOrTx } from "../db";
import type { FunctionKey } from "../tasks/task.policy";
import type { ProjectChip, Task } from "../tasks/task.service";
import type { CardEvent, Completion } from "./archive.policy";
import { cardCreationTimes, listFinishHistory } from "../kan/archive.gateway";
import { HubError } from "../shared/errors";
import { getVisibleTasks } from "../tasks";
import { stageOf } from "../tasks/task.policy";
import {
  ARCHIVE_LIST_LIMIT,
  ARCHIVE_MONTHS,
  completionOf,
  countsForMe,
  isTimeZone,
  monthKey,
  monthsEndingAt,
} from "./archive.policy";

/**
 * "我完成的": the tasks a person finished, found in the cards' own activity
 * logs, so nothing has to be recorded separately and nothing can drift. A task
 * reopened on the board simply stops counting.
 */

export interface FinishedTask {
  task: Task;
  finishedAt: Date;
}

export interface MonthCount {
  /** "2026-10", in the viewer's time zone. */
  month: string;
  count: number;
}

export interface Archive {
  total: number;
  thisMonth: number;
  /** The last ARCHIVE_MONTHS months, oldest first, empty months included. */
  months: MonthCount[];
  /** Projects with at least one finished task, most first. */
  byProject: { project: ProjectChip; count: number }[];
  /** Per standard function; "other" is every board that is not one. */
  byFunction: Record<FunctionKey | "other", number>;
  /** Newest first, at most ARCHIVE_LIST_LIMIT. */
  recent: FinishedTask[];
}

export async function getArchive(
  db: Db,
  input: { userId: string; timeZone: string; now: Date },
): Promise<Archive> {
  if (!isTimeZone(input.timeZone)) {
    throw new HubError("INVALID_INPUT", "时区不对，请刷新页面再试。");
  }

  const done = (
    await getVisibleTasks(db, { userId: input.userId, now: input.now })
  ).filter((task) => task.stage === "done");
  const finished = await whenFinished(db, done, input.userId);
  finished.sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime());

  const currentMonth = monthKey(input.now, input.timeZone);
  const perMonth = new Map<string, number>();
  for (const item of finished) {
    const month = monthKey(item.finishedAt, input.timeZone);
    perMonth.set(month, (perMonth.get(month) ?? 0) + 1);
  }

  return {
    total: finished.length,
    thisMonth: perMonth.get(currentMonth) ?? 0,
    months: monthsEndingAt(currentMonth, ARCHIVE_MONTHS).map((month) => ({
      month,
      count: perMonth.get(month) ?? 0,
    })),
    byProject: countByProject(finished),
    byFunction: countByFunction(finished),
    recent: finished.slice(0, ARCHIVE_LIST_LIMIT),
  };
}

/** The finished tasks that count for this person, each with when it was finished. */
async function whenFinished(
  db: Db,
  done: Task[],
  userId: string,
): Promise<FinishedTask[]> {
  const completions = await completionsOf(
    db,
    done.map((task) => task.publicId),
  );

  return done.flatMap((task) => {
    const completion = completions.get(task.publicId);
    if (!completion) return [];

    const mine = countsForMe({
      assignedToMe: task.assignedToMe,
      hasAssignees: task.assignees.length > 0,
      finishedBy: completion.by,
      userId,
    });
    return mine ? [{ task, finishedAt: completion.at }] : [];
  });
}

/**
 * When and by whom each of these cards, all sitting in a finished column, was
 * finished, read from their activity logs. Cards it cannot tell are left out.
 */
export async function completionsOf(
  db: DbOrTx,
  cardPublicIds: readonly string[],
): Promise<Map<string, Completion>> {
  const [history, createdAt] = await Promise.all([
    listFinishHistory(db, cardPublicIds),
    cardCreationTimes(db, cardPublicIds),
  ]);

  const eventsByCard = new Map<string, CardEvent[]>();
  for (const row of history) {
    const events = eventsByCard.get(row.cardPublicId) ?? [];
    events.push({
      kind: row.kind,
      toStage: row.toListName === null ? null : stageOf(row.toListName),
      by: row.by,
      at: row.at,
    });
    eventsByCard.set(row.cardPublicId, events);
  }

  return new Map(
    cardPublicIds.flatMap((publicId) => {
      const created = createdAt.get(publicId);
      // A card with no usable history (imported, say) counts from its creation,
      // but only for its assignees: nobody is known to have finished it.
      const completion =
        completionOf(eventsByCard.get(publicId) ?? []) ??
        (created ? { at: created, by: null } : null);
      return completion ? [[publicId, completion] as const] : [];
    }),
  );
}

function countByProject(
  finished: readonly FinishedTask[],
): Archive["byProject"] {
  const counts = new Map<string, { project: ProjectChip; count: number }>();
  for (const { task } of finished) {
    const entry = counts.get(task.project.publicId) ?? {
      project: task.project,
      count: 0,
    };
    entry.count += 1;
    counts.set(task.project.publicId, entry);
  }
  return [...counts.values()].sort(
    (a, b) =>
      b.count - a.count ||
      a.project.name.localeCompare(b.project.name, "zh-CN"),
  );
}

function countByFunction(
  finished: readonly FinishedTask[],
): Archive["byFunction"] {
  const counts: Archive["byFunction"] = {
    dev: 0,
    ops: 0,
    marketing: 0,
    other: 0,
  };
  for (const { task } of finished) counts[task.functionKey ?? "other"] += 1;
  return counts;
}

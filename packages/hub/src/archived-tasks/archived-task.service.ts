import { createLogger } from "@kan/logger";

import type { AuditActor } from "../audit";
import type { Db, DbOrTx } from "../db";
import type { CardOnBoard } from "../kan/archived-tasks.gateway";
import { completionsOf } from "../archive/archive.service";
import { recordAudit, TIDY_ACTOR } from "../audit";
import {
  archivedCardIdsInProject,
  deleteCardUnattended,
  findVisibleCard,
  listCardsOnBoards,
  listExpiredArchivedCards,
  lockCardsOnBoards,
  lockExpiredArchivedCard,
} from "../kan/archived-tasks.gateway";
import { listViewableProjects } from "../kan/tasks.gateway";
import { consumeRateLimit } from "../rate-limit";
import { HubError } from "../shared/errors";
import { stageOf } from "../tasks/task.policy";
import {
  ARCHIVE_AFTER_DAYS,
  DELETE_AFTER_DAYS,
  deletionCutoff,
  isDueForArchive,
  TIDY_EVERY_SECONDS,
} from "./archived-task.policy";
import { bringBack, markAutoDeleted, putAway } from "./archived-task.repo";

const log = createLogger("hub-archived-tasks");

/**
 * 归档: putting tasks away by hand, bringing them back, and the clean-up that
 * puts finished tasks away on its own and later deletes them. Reading what is
 * in 归档 is in the task service, next to the boards it is hidden from.
 *
 * Every change is written to the 操作日志 in the same transaction, the
 * clean-up's as `TIDY_ACTOR`. Not to Kan's card activity: its types are a
 * Postgres enum with no "back from 归档", and Kan's own `card.archived` means
 * deleted. Entries name the task only by its card's public id, never its
 * title: back-office admins read the log, and the task may sit on a board
 * they cannot see.
 */

/** Puts a task in 归档, finished or not. Doing it twice changes nothing. */
export async function archiveTask(
  db: Db,
  actor: AuditActor & { userId: string },
  input: { cardPublicId: string },
  now: Date,
): Promise<void> {
  const card = await editableCard(db, actor.userId, input.cardPublicId);
  await db.transaction(async (tx) => {
    const moved = await putAway(tx, {
      cardIds: [card.id],
      at: now,
      by: actor.userId,
      automatic: false,
    });
    if (moved.length === 0) return;
    await recordAudit(tx, {
      actor,
      action: "task.archived",
      entityType: "task",
      entityId: input.cardPublicId,
      summary: "把一个任务移到归档",
      detail: { project: card.projectPublicId },
    });
  });
}

/**
 * Brings a task back from 归档 to the column it was in. A finished one gets
 * its full wait in 已完成 again before the clean-up puts it back.
 */
export async function restoreTask(
  db: Db,
  actor: AuditActor & { userId: string },
  input: { cardPublicId: string },
  now: Date,
): Promise<void> {
  const card = await editableCard(db, actor.userId, input.cardPublicId);
  await db.transaction(async (tx) => {
    // Waits for the clean-up if it is deleting this very card right now.
    if (!(await bringBack(tx, card.id, now))) {
      throw new HubError("CONFLICT", "这个任务已经不在归档里了，刷新看看。");
    }
    await recordAudit(tx, {
      actor,
      action: "task.restored",
      entityType: "task",
      entityId: input.cardPublicId,
      summary: "把一个任务从归档恢复",
      detail: { project: card.projectPublicId },
    });
  });
}

/** The card, if this person may see it and edit tasks in its project. */
async function editableCard(
  db: Db,
  userId: string,
  cardPublicId: string,
): Promise<{ id: number; projectPublicId: string }> {
  const card = await findVisibleCard(db, cardPublicId, userId);
  const project = card
    ? (await listViewableProjects(db, userId)).find(
        (candidate) => candidate.id === card.projectId,
      )
    : undefined;
  // The same answer whether the task does not exist or is not theirs to see.
  if (!card || !project) {
    throw new HubError("NOT_FOUND", "没有这个任务，或者你看不到它。");
  }
  if (!project.canEditTasks) {
    throw new HubError("FORBIDDEN", "你没有修改这个项目里任务的权限。");
  }
  return { id: card.id, projectPublicId: project.publicId };
}

export interface TidyResult {
  /** Finished tasks that went to 归档 on their own. */
  archived: number;
  /** Tasks deleted after their time in 归档. */
  deleted: number;
}

/**
 * The clean-up, across every project: finished tasks that have waited long
 * enough go to 归档, and tasks that have been in 归档 long enough are
 * deleted. Safe to run at any time and as often as you like.
 */
export async function tidyTasks(db: Db, now: Date): Promise<TidyResult> {
  const due = await dueForArchive(db, await listCardsOnBoards(db), now);
  const archived = await archiveIfStillDue(
    db,
    due.map((card) => card.id),
    now,
  );

  let deleted = 0;
  for (const cardId of await listExpiredArchivedCards(
    db,
    deletionCutoff(now),
  )) {
    if (await deleteIfStillExpired(db, cardId, now)) deleted += 1;
  }

  return { archived, deleted };
}

/** Which of these cards sit in 已完成 and have waited long enough there. */
async function dueForArchive(
  db: DbOrTx,
  candidates: readonly CardOnBoard[],
  now: Date,
): Promise<CardOnBoard[]> {
  const finished = candidates.filter(
    (card) => stageOf(card.listName) === "done",
  );
  const completions = await completionsOf(
    db,
    finished.map((card) => card.publicId),
  );
  return finished.filter((card) => {
    const completion = completions.get(card.publicId);
    return (
      completion !== undefined &&
      isDueForArchive(
        { finishedAt: completion.at, restoredAt: card.restoredAt },
        now,
      )
    );
  });
}

/**
 * Puts in 归档 those of the cards the clean-up picked that are still due. The
 * first look was without locks, so in one transaction this locks the cards,
 * reads them and their history again and decides again: a task reopened, or
 * moved out and back into 已完成, since then keeps its place. A move that
 * comes later waits for the transaction and then applies to the archived card.
 * Returns how many went.
 */
export async function archiveIfStillDue(
  db: Db,
  cardIds: readonly number[],
  now: Date,
): Promise<number> {
  if (cardIds.length === 0) return 0;
  return db.transaction(async (tx) => {
    const due = await dueForArchive(
      tx,
      await lockCardsOnBoards(tx, cardIds),
      now,
    );
    const publicIds = new Map(due.map((card) => [card.id, card.publicId]));
    const moved = await putAway(tx, {
      cardIds: due.map((card) => card.id),
      at: now,
      by: null,
      automatic: true,
    });
    for (const cardId of moved) {
      await recordAudit(tx, {
        actor: TIDY_ACTOR,
        action: "task.auto_archived",
        entityType: "task",
        entityId: publicIds.get(cardId) ?? null,
        summary: `自动归档了一个完成满 ${ARCHIVE_AFTER_DAYS} 天的任务`,
      });
    }
    return moved.length;
  });
}

/**
 * Deletes one card the clean-up listed, unless it was restored or deleted
 * since: the check, the deletion, the mark that keeps it in 我完成的 and the
 * log entry run in one transaction holding the 归档 row's lock, so a restore
 * either lands first (and the card stays) or finds nothing to restore.
 */
export async function deleteIfStillExpired(
  db: Db,
  cardId: number,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const card = await lockExpiredArchivedCard(tx, cardId, deletionCutoff(now));
    if (!card) return false;
    await deleteCardUnattended(tx, cardId, now);
    await markAutoDeleted(tx, cardId, now);
    await recordAudit(tx, {
      actor: TIDY_ACTOR,
      action: "task.auto_deleted",
      entityType: "task",
      entityId: card.publicId,
      summary: `自动删除了一个在归档里满 ${DELETE_AFTER_DAYS} 天的任务`,
    });
    return true;
  });
}

const TIDY_KEY = "hub:tidy-tasks";

/**
 * Runs the clean-up if nobody has in the last `TIDY_EVERY_SECONDS`. There is
 * no scheduler: the pages that show tasks call this first, so the boards are
 * at most that much behind. Null when it was not this call's turn.
 */
export async function tidyTasksIfDue(
  db: Db,
  now: Date,
): Promise<TidyResult | null> {
  const turn = await consumeRateLimit(
    db,
    TIDY_KEY,
    { window: TIDY_EVERY_SECONDS, max: 1 },
    now.getTime(),
  );
  return turn.allowed ? tidyTasks(db, now) : null;
}

/**
 * For a page about to show tasks: `tidyTasksIfDue`, but a failed clean-up is
 * logged rather than thrown, so nobody loses their page over it.
 */
export async function tidyBeforeShowingTasks(db: Db, now: Date): Promise<void> {
  try {
    await tidyTasksIfDue(db, now);
  } catch (error) {
    log.error({ err: error }, "The 归档 clean-up failed");
  }
}

/** The cards in 归档 in one project, for Kan's board page to leave out. */
export function archivedCardIds(db: Db, projectId: number): Promise<number[]> {
  return archivedCardIdsInProject(db, projectId);
}

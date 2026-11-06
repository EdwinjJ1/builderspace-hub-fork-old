/**
 * Pure rules for 归档 (archived tasks). No IO.
 *
 * A finished task goes to 归档 on its own `ARCHIVE_AFTER_DAYS` after it was
 * finished, so 已完成 only holds recent work; anyone who may edit a task can
 * also put it there by hand, finished or not. A task in 归档 is deleted
 * `DELETE_AFTER_DAYS` after it went there, unless someone restores it first.
 *
 * Not to be confused with 我完成的 (`../archive`), which is a person's record
 * of finished work and keeps counting tasks after they leave 归档.
 */

/** How long a finished task stays in 已完成 before it goes to 归档. */
export const ARCHIVE_AFTER_DAYS = 3;

/** How long a task stays in 归档 before it is deleted. */
export const DELETE_AFTER_DAYS = 7;

/** The clean-up runs at most this often; it is triggered by page loads. */
export const TIDY_EVERY_SECONDS = 60 * 60;

const DAY = 24 * 60 * 60 * 1000;

/**
 * Whether a finished task has waited long enough to go to 归档 on its own. A
 * task someone restored waits again, counted from when it came back.
 */
export function isDueForArchive(
  task: { finishedAt: Date; restoredAt: Date | null },
  now: Date,
): boolean {
  const since = Math.max(
    task.finishedAt.getTime(),
    task.restoredAt?.getTime() ?? 0,
  );
  return now.getTime() - since >= ARCHIVE_AFTER_DAYS * DAY;
}

/** When a task that went to 归档 at `archivedAt` is deleted. */
export function deletesAt(archivedAt: Date): Date {
  return new Date(archivedAt.getTime() + DELETE_AFTER_DAYS * DAY);
}

export function isDueForDeletion(archivedAt: Date, now: Date): boolean {
  return now.getTime() >= deletesAt(archivedAt).getTime();
}

/** The moment before which a task in 归档 is due for deletion. */
export function deletionCutoff(now: Date): Date {
  return new Date(now.getTime() - DELETE_AFTER_DAYS * DAY);
}

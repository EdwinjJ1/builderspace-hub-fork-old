import { TbCalendarDue } from "react-icons/tb";
import { twMerge } from "tailwind-merge";

import { functionNames } from "@kan/hub/public";

import type { RouterOutputs } from "~/utils/api";
import { copy } from "~/hub/copy/zh";
import { cardHref } from "~/hub/lib/routes";
import { colorOf, useFunctionColors } from "~/hub/lib/use-function-colors";
import { useOpenInProject } from "~/hub/lib/use-open-in-project";

/**
 * How a task looks in the Hub's lists (the home page; the overall board's
 * cards are in BoardCard). Clicking it opens Kan's card page in the task's
 * own project.
 */

export type HubTask = RouterOutputs["hub"]["tasks"]["home"]["myTasks"][number];

const text = copy.tasks;

const dayFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
});

function isSameDay(a: Date, b: Date) {
  return a.toDateString() === b.toDateString();
}

export function DueBadge({ task }: { task: HubTask }) {
  if (!task.dueDate) return null;
  const due = new Date(task.dueDate);
  const label =
    task.dueState === "overdue"
      ? `${text.due.overdue} · ${dayFormat.format(due)}`
      : isSameDay(due, new Date())
        ? text.due.today
        : dayFormat.format(due);

  return (
    <span
      className={twMerge(
        "inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-light-900 dark:text-dark-900",
        task.dueState === "soon" && "text-amber-700 dark:text-amber-400",
        task.dueState === "overdue" &&
          "font-medium text-red-600 dark:text-red-400",
      )}
    >
      <TbCalendarDue className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

/** "CourseMate · 技术", or the board's own name when it is not a function. */
export function taskWhere(task: HubTask): string {
  const where = task.functionKey
    ? functionNames[task.functionKey]
    : task.board.name;
  return `${task.project.name} · ${where}`;
}

/** The task's labels, each with its own colour dot. */
export function Labels({ task }: { task: HubTask }) {
  if (task.labels.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {task.labels.map((label) => (
        <span
          key={label.name}
          className="inline-flex items-center gap-1 rounded border border-light-300 px-1.5 text-[11px] leading-5 text-light-1000 dark:border-dark-300 dark:text-dark-1000"
        >
          <span
            className="h-1.5 w-1.5 rounded-full bg-light-700 dark:bg-dark-700"
            style={
              label.colourCode
                ? { backgroundColor: label.colourCode }
                : undefined
            }
            aria-hidden="true"
          />
          {label.name}
        </span>
      ))}
    </span>
  );
}

/** Opens the task's card page in the task's own project. */
export function useOpenTask(task: Pick<HubTask, "project" | "publicId">) {
  const openInProject = useOpenInProject();
  return () => openInProject(task.project.publicId, cardHref(task.publicId));
}

/** One row in a list (the home page). */
export function TaskRow({ task }: { task: HubTask }) {
  const open = useOpenTask(task);
  const colors = useFunctionColors();
  return (
    <button
      type="button"
      onClick={open}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-light-200 dark:hover:bg-dark-200"
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{
          backgroundColor: colorOf(
            colors,
            task.functionKey,
            task.board.publicId,
          ),
        }}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-light-1000 dark:text-dark-1000">
          {task.title}
        </span>
        <span className="mt-0.5 block truncate text-xs text-light-900 dark:text-dark-900">
          {taskWhere(task)} · {task.listName}
        </span>
      </span>
      <DueBadge task={task} />
    </button>
  );
}

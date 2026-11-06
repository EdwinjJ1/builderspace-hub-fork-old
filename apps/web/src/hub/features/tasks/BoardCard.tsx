import { useDraggable } from "@dnd-kit/core";
import { useState } from "react";
import { TbCalendarDue } from "react-icons/tb";
import { twMerge } from "tailwind-merge";

import type { HubTask } from "./task-display";
import { copy } from "~/hub/copy/zh";
import { cardHref } from "~/hub/lib/routes";
import {
  colorOf,
  tint,
  useFunctionColors,
} from "~/hub/lib/use-function-colors";
import { useOpenInProject } from "~/hub/lib/use-open-in-project";
import { CardMenu } from "./CardMenu";
import { DueBadge, Labels, taskWhere } from "./task-display";

const text = copy.tasks;

/** "2026-10-16" for a date input, in the viewer's own time zone. */
function toDateInput(date: Date | null): string {
  if (!date) return "";
  const d = new Date(date);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A due date picked as a day means "by the end of that day", locally. */
function fromDateInput(value: string): Date | null {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 23, 59, 0);
}

/** Initials of the people a task is assigned to (at most three), and 我. */
function Assignees({ names, mine }: { names: string[]; mine: boolean }) {
  if (names.length === 0) return null;
  return (
    <span
      className="ml-auto flex items-center gap-1.5"
      title={names.join("、")}
    >
      {mine && (
        <span className="rounded-full bg-light-1000 px-1.5 text-[11px] leading-5 text-light-50 dark:bg-dark-1000 dark:text-dark-50">
          {text.assignedToMe}
        </span>
      )}
      <span className="flex -space-x-1.5">
        {names.slice(0, 3).map((name, index) => (
          <span
            key={`${name}-${index}`}
            className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-light-50 bg-light-300 text-[10px] font-semibold text-light-1000 dark:border-dark-100 dark:bg-dark-300 dark:text-dark-1000"
          >
            {name.trim().charAt(0).toUpperCase()}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * One task on the overall board. Its left edge and tag take the colour of its
 * function. When the person may edit tasks in its project it can be dragged
 * to another column, its due date changed and the task put in 归档 here, and
 * deleted where they may delete; every change lands on the task's own board,
 * because it is the same card.
 */
export function BoardCard({
  task,
  canEdit,
  onSetDue,
  onArchive,
  onDelete,
  isOverlay = false,
}: {
  task: HubTask;
  canEdit: boolean;
  onSetDue: (task: HubTask, dueDate: Date | null) => void;
  /** Left out where the person may not put the task in 归档. */
  onArchive?: (task: HubTask) => void;
  /** Left out where the person may not delete the task. */
  onDelete?: (task: HubTask) => void;
  isOverlay?: boolean;
}) {
  const colors = useFunctionColors();
  const color = colorOf(colors, task.functionKey);
  const openInProject = useOpenInProject();
  const [editingDue, setEditingDue] = useState(false);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.publicId,
    data: { task },
    disabled: !canEdit,
  });

  const open = () =>
    openInProject(task.project.publicId, cardHref(task.publicId));

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter") open();
      }}
      className={twMerge(
        "group relative block w-full cursor-pointer overflow-hidden rounded-lg border border-light-300 bg-light-50 py-2.5 pl-3.5 pr-3 text-left shadow-sm transition hover:border-light-600 dark:border-dark-300 dark:bg-dark-100 dark:hover:border-dark-600",
        canEdit && "cursor-grab active:cursor-grabbing",
        isDragging && !isOverlay && "opacity-40",
        isOverlay && "rotate-1 shadow-lg",
      )}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-1"
        style={{ backgroundColor: color }}
      />
      <span
        className="inline-block max-w-[calc(100%-1.75rem)] truncate rounded px-1.5 align-top text-[11px] font-medium leading-5"
        style={{ backgroundColor: tint(color, 0.14), color }}
      >
        {taskWhere(task)}
      </span>
      {!isOverlay && (
        <CardMenu
          onArchive={onArchive && (() => onArchive(task))}
          onDelete={onDelete && (() => onDelete(task))}
        />
      )}
      <span className="mt-1 block text-sm font-medium leading-5 text-light-1000 dark:text-dark-1000">
        {task.title}
      </span>

      <span className="mt-2 flex flex-wrap items-center gap-2">
        <Labels task={task} />

        {editingDue ? (
          // Inputs inside a draggable must not start a drag or open the card.
          <span
            className="flex items-center gap-1"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <input
              type="date"
              autoFocus
              aria-label={text.dueEdit}
              className="rounded border border-light-400 bg-light-50 px-1 py-0.5 text-xs text-light-1000 dark:border-dark-400 dark:bg-dark-50 dark:text-dark-1000"
              defaultValue={toDateInput(task.dueDate)}
              onChange={(event) => {
                const due = fromDateInput(event.target.value);
                if (due) {
                  onSetDue(task, due);
                  setEditingDue(false);
                }
              }}
              onBlur={() => setEditingDue(false)}
            />
            {task.dueDate && (
              <button
                type="button"
                className="text-xs text-light-900 underline dark:text-dark-900"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onSetDue(task, null);
                  setEditingDue(false);
                }}
              >
                {text.dueClear}
              </button>
            )}
          </span>
        ) : canEdit ? (
          <button
            type="button"
            title={text.dueEdit}
            className="rounded px-0.5 hover:bg-light-200 dark:hover:bg-dark-200"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setEditingDue(true);
            }}
          >
            {task.dueDate ? (
              <DueBadge task={task} />
            ) : (
              <TbCalendarDue
                className="h-3.5 w-3.5 text-light-700 opacity-0 transition-opacity group-hover:opacity-100 dark:text-dark-700"
                aria-label={text.dueEdit}
              />
            )}
          </button>
        ) : (
          <DueBadge task={task} />
        )}

        <Assignees names={task.assignees} mine={task.assignedToMe} />
      </span>
    </div>
  );
}

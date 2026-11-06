import { useEffect, useState } from "react";
import { twMerge } from "tailwind-merge";

import type { BrushKind, ScheduleBlock } from "./schedule-display";
import { copy } from "~/hub/copy/zh";
import { buttonClass, inputClass, Pill } from "~/hub/ui/admin-primitives";
import { useOpenTask } from "../tasks/task-display";
import { brushKinds, formatSpan } from "./schedule-display";

const text = copy.schedule;

/**
 * The bar that opens above the table when a block is selected. A block people
 * drew can be retitled and retyped; a task block only shows the task, because
 * the task owns its title and state.
 */
export function BlockEditor({
  block,
  onEdit,
  onRemove,
  onClose,
}: {
  block: ScheduleBlock;
  onEdit: (change: { title?: string | null; kind?: BrushKind }) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-light-400 bg-light-50 p-4 dark:border-dark-400 dark:bg-dark-100 md:flex-row md:items-end">
      <div className="min-w-0 flex-1">
        <p className="text-xs tabular-nums text-light-900 dark:text-dark-900">
          {formatSpan(block)}
        </p>
        {block.task ? (
          <TaskSummary block={block} />
        ) : (
          <ManualFields block={block} onEdit={onEdit} />
        )}
      </div>

      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          className={buttonClass.dangerText}
          onClick={onRemove}
        >
          {block.task ? text.editor.unplan : text.editor.remove}
        </button>
        <button type="button" className={buttonClass.primary} onClick={onClose}>
          {text.editor.done}
        </button>
      </div>
    </div>
  );
}

function ManualFields({
  block,
  onEdit,
}: {
  block: ScheduleBlock;
  onEdit: (change: { title?: string | null; kind?: BrushKind }) => void;
}) {
  const [title, setTitle] = useState(block.title ?? "");
  // A different block, or the saved title changing underneath, resets the field.
  useEffect(() => setTitle(block.title ?? ""), [block.publicId, block.title]);

  const commit = () => {
    if (title.trim() !== (block.title ?? "")) onEdit({ title });
  };

  return (
    <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end">
      <label className="block min-w-0 flex-1">
        <span className="mb-1 block text-xs font-medium text-light-900 dark:text-dark-900">
          {text.editor.titleLabel}
        </span>
        <input
          className={inputClass}
          value={title}
          maxLength={80}
          placeholder={text.editor.titlePlaceholder}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </label>
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-light-900 dark:text-dark-900">
          {text.editor.kindLabel}
        </legend>
        <div className="flex gap-1">
          {brushKinds.map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={block.kind === kind}
              onClick={() => onEdit({ kind })}
              className={twMerge(
                buttonClass.ghost,
                block.kind === kind &&
                  "border-light-1000 bg-light-200 dark:border-dark-1000 dark:bg-dark-200",
              )}
            >
              {text.kinds[kind]}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

function TaskSummary({ block }: { block: ScheduleBlock }) {
  const task = block.task;
  if (!task) return null;
  return <TaskLine task={task} />;
}

function TaskLine({ task }: { task: NonNullable<ScheduleBlock["task"]> }) {
  const open = useOpenTask(task);
  // The 归档 clean-up deleted its card: the time stays, but there is nothing
  // to open.
  if (task.deleted) {
    return (
      <div className="mt-2">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-light-1000 dark:text-dark-1000">
            {task.title}
          </span>
          <Pill tone="neutral">{text.editor.cleanedUp}</Pill>
        </div>
        <p className="mt-1 text-xs text-light-900 dark:text-dark-900">
          {text.editor.cleanedUpNote}
        </p>
      </div>
    );
  }
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={open}
          className="truncate text-left text-sm font-semibold text-light-1000 underline-offset-2 hover:underline dark:text-dark-1000"
          title={text.editor.openTask}
        >
          {task.title}
        </button>
        {task.stage === "done" && (
          <Pill tone="strong">{text.editor.finished}</Pill>
        )}
      </div>
      <p className="mt-1 text-xs text-light-900 dark:text-dark-900">
        {text.editor.taskNote}
      </p>
    </div>
  );
}

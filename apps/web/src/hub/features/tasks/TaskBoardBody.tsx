import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useState } from "react";
import {
  TbArchive,
  TbChevronLeft,
  TbChevronRight,
  TbPlus,
  TbSquare,
  TbSquareCheck,
} from "react-icons/tb";
import { twMerge } from "tailwind-merge";

import type { Stage, TaskView } from "@kan/hub/public";
import {
  ARCHIVE_AFTER_DAYS,
  functionKeys,
  functionNames,
  stageNames,
} from "@kan/hub/public";

import type { HubTask } from "./task-display";
import type { RouterOutputs } from "~/utils/api";
import { copy } from "~/hub/copy/zh";
import { archivedTasksHref } from "~/hub/lib/routes";
import { useFunctionColors } from "~/hub/lib/use-function-colors";
import { buttonClass, ErrorText } from "~/hub/ui/admin-primitives";
import { BoardCard } from "./BoardCard";
import { columnUnderPointer } from "./column-collision";
import { columnMode } from "./column-layout";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { DoneToast } from "./DoneToast";
import { NewTaskForm } from "./NewTaskForm";
import { chipClass } from "./ScopeSwitcher";
import { UndoToast } from "./UndoToast";
import { useBoardActions } from "./use-board-actions";

type Board = RouterOutputs["hub"]["tasks"]["board"];
type Column = Board["columns"][number];
type OpenStage = Exclude<Stage, "other">;

const text = copy.tasks;

function stageTitle(stage: Stage): string {
  return stage === "other" ? text.otherStage : stageNames[stage];
}

/**
 * The working part of a task board: the colour legend, 只看我的, 归档,
 * 新建任务, the new-task form and the columns. Shared by the board page
 * (`/tasks/<view>`, where it fills the screen) and the home page (where it is
 * embedded as the 总版 of the chosen scope). Where the person may edit, tasks
 * can be dragged to another column, given a due date, put in 归档 and created
 * here, and deleted where they may delete; every change but 归档 goes through
 * Kan's own card API, so it lands on the task's own board.
 */
export function TaskBoardBody({
  board,
  query,
  fill = false,
  onOnlyMineChange,
}: {
  board: Board;
  /** The query `board` was loaded with, so changes can update it in place. */
  query: { view: TaskView; project?: string; onlyMine?: boolean };
  /** Fill the remaining height of the page instead of a fixed column height. */
  fill?: boolean;
  /**
   * Turns 只看我的 on or off. Left out, or on 指派给我的 where it would change
   * nothing, the board offers no such switch.
   */
  onOnlyMineChange?: (onlyMine: boolean) => void;
}) {
  const actions = useBoardActions(board, query);
  const [formStage, setFormStage] = useState<OpenStage | null>(null);
  // The task whose 删除 is waiting for "are you sure".
  const [pendingDelete, setPendingDelete] = useState<HubTask | null>(null);
  const canCreateSomewhere = board.boards.some(
    (target) => board.access[target.project.publicId]?.canCreate,
  );
  const onlyMine = query.onlyMine ?? false;
  // The board on screen is the one from before 只看我的 was switched.
  const switching = board.onlyMine !== onlyMine;
  const noneOfMine =
    board.onlyMine &&
    !switching &&
    board.columns.every((column) => column.total === 0);

  return (
    <div className={twMerge("flex flex-col", fill && "min-h-0 flex-1")}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <ColorLegend />
        <div className="flex flex-wrap items-center gap-2">
          {onOnlyMineChange && query.view !== "mine" && (
            <OnlyMineToggle pressed={onlyMine} onChange={onOnlyMineChange} />
          )}
          <Link
            href={archivedTasksHref(board.scope.current?.publicId)}
            title={text.archived.linkHint(ARCHIVE_AFTER_DAYS)}
            className={twMerge(
              chipClass(false),
              "inline-flex items-center gap-1.5",
            )}
          >
            <TbArchive className="h-4 w-4" aria-hidden="true" />
            {text.archived.link}
          </Link>
          {canCreateSomewhere && (
            <button
              type="button"
              className={buttonClass.primary}
              onClick={() => setFormStage("todo")}
            >
              <TbPlus className="mr-1 h-4 w-4" aria-hidden="true" />
              {text.newTask}
            </button>
          )}
        </div>
      </div>

      {formStage && (
        <NewTaskForm
          key={formStage}
          board={board}
          initialStage={formStage}
          isPending={actions.isCreating}
          onCreate={actions.create}
          onClose={() => setFormStage(null)}
        />
      )}
      <ErrorText message={actions.error ?? undefined} />
      {noneOfMine && (
        <p
          role="status"
          className="mb-3 text-sm text-light-900 dark:text-dark-900"
        >
          {text.onlyMine.empty}
          {onOnlyMineChange && (
            <button
              type="button"
              className="ml-2 underline hover:text-light-1000 dark:hover:text-dark-1000"
              onClick={() => onOnlyMineChange(false)}
            >
              {text.onlyMine.showAll}
            </button>
          )}
        </p>
      )}

      <Columns
        board={board}
        fill={fill}
        busy={switching}
        onMove={actions.move}
        onSetDue={actions.setDue}
        onArchive={actions.archive}
        onDelete={setPendingDelete}
        onAdd={canCreateSomewhere ? setFormStage : undefined}
      />
      {pendingDelete && (
        <ConfirmDeleteDialog
          task={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onConfirm={(task) => {
            setPendingDelete(null);
            void actions.remove(task);
          }}
        />
      )}
      <DoneToast toast={actions.doneToast} onClose={actions.dismissDoneToast} />
      <UndoToast notice={actions.notice} onClose={actions.dismissNotice} />
    </div>
  );
}

/** 只看我的: narrows the board to the tasks assigned to me, and back. */
function OnlyMineToggle({
  pressed,
  onChange,
}: {
  pressed: boolean;
  onChange: (pressed: boolean) => void;
}) {
  const Icon = pressed ? TbSquareCheck : TbSquare;
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={text.onlyMine.hint}
      className={twMerge(
        chipClass(pressed),
        "inline-flex items-center gap-1.5",
      )}
      onClick={() => onChange(!pressed)}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {text.onlyMine.label}
    </button>
  );
}

/** 技术 / 活动 / 运营 and their colours. */
export function ColorLegend() {
  const colors = useFunctionColors();
  return (
    <p className="flex flex-wrap gap-3 text-xs text-light-900 dark:text-dark-900">
      {functionKeys.map((key) => (
        <span key={key} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: colors[key] }}
          />
          {functionNames[key]}
        </span>
      ))}
    </p>
  );
}

function Columns({
  board,
  fill,
  busy,
  onMove,
  onSetDue,
  onArchive,
  onDelete,
  onAdd,
}: {
  board: Board;
  fill: boolean;
  /** A new board is on its way; this one is dimmed until it arrives. */
  busy: boolean;
  onMove: (task: HubTask, to: Stage) => Promise<void>;
  onSetDue: (task: HubTask, dueDate: Date | null) => void;
  onArchive: (task: HubTask) => void;
  onDelete: (task: HubTask) => void;
  onAdd?: (stage: OpenStage) => void;
}) {
  // A small distance before a drag starts keeps plain clicks opening the card.
  // On a touch screen a drag starts after a short press, so a swipe still
  // scrolls the board.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
  );
  const [dragging, setDragging] = useState<HubTask | null>(null);
  const [otherOpen, setOtherOpen] = useState(false);
  const canEdit = (task: HubTask) =>
    board.access[task.project.publicId]?.canEdit ?? false;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={columnUnderPointer}
      autoScroll={{ threshold: { x: 0.12, y: 0.15 }, acceleration: 14 }}
      onDragStart={(event: DragStartEvent) =>
        setDragging((event.active.data.current as { task: HubTask }).task)
      }
      onDragCancel={() => setDragging(null)}
      onDragEnd={(event: DragEndEvent) => {
        setDragging(null);
        const task = (
          event.active.data.current as { task: HubTask } | undefined
        )?.task;
        const to = event.over?.id as Stage | undefined;
        if (task && to) void onMove(task, to);
      }}
    >
      <div
        aria-busy={busy || undefined}
        className={twMerge(
          "flex gap-3 overflow-x-auto pb-2 transition-opacity",
          fill && "min-h-0 flex-1 pb-4",
          busy && "opacity-60",
        )}
      >
        {board.columns.map((column) => (
          <TaskColumn
            key={column.stage}
            column={column}
            fill={fill}
            canEdit={canEdit}
            onSetDue={onSetDue}
            onArchive={onArchive}
            onDelete={onDelete}
            onAdd={onAdd}
            dragging={dragging !== null}
            otherOpen={otherOpen}
            onToggleOther={() => setOtherOpen((open) => !open)}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging && (
          <BoardCard task={dragging} canEdit onSetDue={onSetDue} isOverlay />
        )}
      </DragOverlay>
    </DndContext>
  );
}

function TaskColumn({
  column,
  fill,
  canEdit,
  onSetDue,
  onArchive,
  onDelete,
  onAdd,
  dragging,
  otherOpen,
  onToggleOther,
}: {
  column: Column;
  fill: boolean;
  canEdit: (task: HubTask) => boolean;
  onSetDue: (task: HubTask, dueDate: Date | null) => void;
  onArchive: (task: HubTask) => void;
  onDelete: (task: HubTask) => void;
  onAdd?: (stage: OpenStage) => void;
  /** Someone is dragging a task: the column under the pointer says so. */
  dragging: boolean;
  otherOpen: boolean;
  onToggleOther: () => void;
}) {
  // "Other" holds renamed lists; there is no single list to move a task into.
  const { setNodeRef, isOver } = useDroppable({
    id: column.stage,
    disabled: column.stage === "other",
  });
  const limited = column.total > column.tasks.length;
  const stage = column.stage;
  const mode = columnMode(stage, column.total, otherOpen);

  // 其他 closed: a thin bar, since nothing can be dropped there.
  if (mode === "strip") {
    return (
      <button
        type="button"
        title={copy.tasks.columns.otherHint}
        aria-label={copy.tasks.columns.openOther}
        disabled={column.total === 0}
        onClick={onToggleOther}
        className="flex w-10 shrink-0 flex-col items-center gap-2 rounded-xl bg-light-100 py-3 text-xs text-light-900 transition-colors enabled:hover:bg-light-200 disabled:cursor-default disabled:opacity-60 dark:bg-dark-100 dark:text-dark-900 dark:enabled:hover:bg-dark-200"
      >
        <TbChevronLeft className="h-4 w-4" aria-hidden="true" />
        <span className="tabular-nums">{column.total}</span>
        <span className="[writing-mode:vertical-rl]">{stageTitle(stage)}</span>
      </button>
    );
  }

  return (
    <section
      ref={setNodeRef}
      className={twMerge(
        "flex min-w-[15rem] max-w-[24rem] flex-1 basis-0 flex-col rounded-xl bg-light-100 p-2 transition-colors dark:bg-dark-100",
        // Nothing here yet: narrower, so the columns with tasks get the room,
        // but still wide enough to drop a task on.
        mode === "slim" && "min-w-[11rem] max-w-[13rem] flex-none basis-44",
        // Embedded (the home page): a column scrolls on its own past this height.
        !fill && "max-h-[34rem]",
        isOver &&
          "bg-light-200 ring-1 ring-light-600 dark:bg-dark-200 dark:ring-dark-600",
      )}
    >
      <h2 className="flex items-center justify-between px-2 py-1.5 text-sm font-semibold text-light-1000 dark:text-dark-1000">
        {stageTitle(stage)}
        <span className="flex items-center gap-1">
          {dragging && isOver && stage !== "other" ? (
            <span className="rounded bg-light-1000 px-1.5 text-xs font-normal leading-5 text-light-50 dark:bg-dark-1000 dark:text-dark-50">
              {copy.tasks.columns.dropHere}
            </span>
          ) : (
            <span className="text-xs font-normal tabular-nums text-light-900 dark:text-dark-900">
              {column.total}
            </span>
          )}
          {stage === "other" && (
            <button
              type="button"
              title={copy.tasks.columns.closeOther}
              aria-label={copy.tasks.columns.closeOther}
              className="rounded p-0.5 text-light-900 hover:bg-light-300 hover:text-light-1000 dark:text-dark-900 dark:hover:bg-dark-300"
              onClick={onToggleOther}
            >
              <TbChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          {onAdd && stage !== "other" && (
            <button
              type="button"
              title={text.newTaskIn(stageTitle(stage))}
              aria-label={text.newTaskIn(stageTitle(stage))}
              className="rounded p-0.5 text-light-900 hover:bg-light-300 hover:text-light-1000 dark:text-dark-900 dark:hover:bg-dark-300"
              onClick={() => onAdd(stage)}
            >
              <TbPlus className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </span>
      </h2>
      {stage === "done" && (
        <p className="px-2 pb-1 text-xs text-light-800 dark:text-dark-800">
          {text.archived.doneHint(ARCHIVE_AFTER_DAYS)}
        </p>
      )}
      {limited && (
        <p className="px-2 pb-1 text-xs text-light-900 dark:text-dark-900">
          {text.doneLimited(column.tasks.length, column.total)}
        </p>
      )}
      <div className="mt-1 min-h-0 flex-1 space-y-2 overflow-y-auto">
        {column.tasks.length === 0 ? (
          <p className="px-2 py-3 text-xs text-light-800 dark:text-dark-800">
            {text.emptyColumn}
          </p>
        ) : (
          column.tasks.map((task) => (
            <BoardCard
              key={task.publicId}
              task={task}
              canEdit={canEdit(task)}
              onSetDue={onSetDue}
              onArchive={canEdit(task) ? onArchive : undefined}
              onDelete={task.canDelete ? onDelete : undefined}
            />
          ))
        )}
      </div>
    </section>
  );
}

export function ColumnsSkeleton() {
  return (
    <div className="flex gap-3 overflow-hidden" aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-80 w-72 shrink-0 animate-pulse rounded-xl bg-light-200 dark:bg-dark-200"
        />
      ))}
    </div>
  );
}

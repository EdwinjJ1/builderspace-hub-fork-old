import Link from "next/link";
import { useState } from "react";
import { TbArrowLeft } from "react-icons/tb";

import { ARCHIVE_AFTER_DAYS, DELETE_AFTER_DAYS } from "@kan/hub/public";

import type { RouterOutputs } from "~/utils/api";
import { PageHead } from "~/components/PageHead";
import { copy } from "~/hub/copy/zh";
import { archivedTasksHref, taskBoardHref } from "~/hub/lib/routes";
import { colorOf, useFunctionColors } from "~/hub/lib/use-function-colors";
import {
  buttonClass,
  Card,
  ConfirmButton,
  ErrorText,
} from "~/hub/ui/admin-primitives";
import { api } from "~/utils/api";
import {
  ScopeSwitcher,
  useFollowScope,
  useProjectParam,
} from "./ScopeSwitcher";
import { taskWhere, useOpenTask } from "./task-display";

type Archived = RouterOutputs["hub"]["tasks"]["archived"];
type ArchivedTask = Archived["tasks"][number];

const text = copy.archivedTasks;
const DAY = 24 * 60 * 60 * 1000;

const dayFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
});

/**
 * 归档 (`/tasks/archived`): tasks put away off the boards, by hand or on
 * their own once finished for a while, scoped like the task board. Each can be
 * brought back or deleted; the clean-up deletes them after a while anyway.
 */
export function ArchivedTasksPage() {
  const { projectPublicId, isReady } = useProjectParam();
  const query = { project: projectPublicId };
  const archived = api.hub.tasks.archived.useQuery(query, {
    enabled: isReady,
    retry: false,
  });
  useFollowScope(archived.data?.scope.current);
  const scopeName = archived.data?.scope.current?.name;

  return (
    <div className="m-auto w-full max-w-[960px] px-5 py-8 md:px-10 md:py-10">
      <PageHead title={`${text.title} · ${copy.brand}`} />
      <header className="mb-6 space-y-4">
        <Link
          href={taskBoardHref("all", projectPublicId)}
          className="inline-flex items-center gap-1 text-xs text-light-900 hover:text-light-1000 dark:text-dark-900 dark:hover:text-dark-1000"
        >
          <TbArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {text.back}
        </Link>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="max-w-xl">
            <h1 className="text-xl font-bold tracking-tight text-light-1000 dark:text-dark-1000">
              {text.title}
              {scopeName && (
                <span className="ml-2 text-base font-medium text-light-900 dark:text-dark-900">
                  · {scopeName}
                </span>
              )}
            </h1>
            <p className="mt-1 text-xs leading-5 text-light-900 dark:text-dark-900">
              {text.description(ARCHIVE_AFTER_DAYS, DELETE_AFTER_DAYS)}
            </p>
          </div>
          {archived.data && (
            <ScopeSwitcher
              projects={archived.data.scope.projects}
              current={archived.data.scope.current}
              hrefFor={archivedTasksHref}
            />
          )}
        </div>
      </header>

      {archived.error?.data?.code === "NOT_FOUND" ? (
        <Card className="max-w-xl">
          <p className="text-sm text-light-1000 dark:text-dark-1000">
            {copy.home.scopeMissing}{" "}
            <Link href={archivedTasksHref(null)} className="underline">
              {copy.home.scopeMissingBack}
            </Link>
          </p>
        </Card>
      ) : archived.error ? (
        <ErrorText message={archived.error.message} />
      ) : !archived.data ? (
        <div
          aria-busy="true"
          className="h-64 animate-pulse rounded-xl bg-light-200 dark:bg-dark-200"
        />
      ) : archived.data.tasks.length === 0 ? (
        <Card className="max-w-xl">
          <p className="text-sm text-light-900 dark:text-dark-900">
            {text.empty}
          </p>
        </Card>
      ) : (
        <ArchivedList archived={archived.data} />
      )}
    </div>
  );
}

function ArchivedList({ archived }: { archived: Archived }) {
  const utils = api.useUtils();
  const restore = api.hub.tasks.restore.useMutation();
  const remove = api.card.delete.useMutation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (task: ArchivedTask, work: () => Promise<unknown>) => {
    setError(null);
    setBusy(task.publicId);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
      void Promise.all([
        utils.hub.tasks.archived.invalidate(),
        utils.hub.tasks.board.invalidate(),
        utils.hub.tasks.home.invalidate(),
      ]);
    }
  };

  return (
    <div className="space-y-3">
      <ErrorText message={error} />
      <Card>
        <ul className="-my-1 divide-y divide-light-200 dark:divide-dark-200">
          {archived.tasks.map((task) => {
            const access = archived.access[task.project.publicId];
            return (
              <ArchivedRow
                key={task.publicId}
                task={task}
                busy={busy === task.publicId}
                onRestore={
                  access?.canEdit
                    ? () =>
                        run(task, () =>
                          restore.mutateAsync({ cardPublicId: task.publicId }),
                        )
                    : undefined
                }
                onDelete={
                  task.canDelete
                    ? () =>
                        run(task, () =>
                          remove.mutateAsync({ cardPublicId: task.publicId }),
                        )
                    : undefined
                }
              />
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

function ArchivedRow({
  task,
  busy,
  onRestore,
  onDelete,
}: {
  task: ArchivedTask;
  busy: boolean;
  onRestore?: () => void;
  onDelete?: () => void;
}) {
  const open = useOpenTask(task);
  const colors = useFunctionColors();
  const daysLeft = Math.ceil(
    (new Date(task.deletesAt).getTime() - Date.now()) / DAY,
  );

  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-3">
      <button
        type="button"
        onClick={open}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left"
      >
        <span
          aria-hidden="true"
          className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: colorOf(colors, task.functionKey) }}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-light-1000 hover:underline dark:text-dark-1000">
            {task.title}
          </span>
          <span className="mt-0.5 block truncate text-xs text-light-900 dark:text-dark-900">
            {taskWhere(task)} · {task.listName}
          </span>
          <span className="mt-0.5 block text-xs text-light-800 dark:text-dark-800">
            {text.archivedOn(
              dayFormat.format(new Date(task.archivedAt)),
              task.automatic,
            )}{" "}
            · {text.deletesIn(daysLeft)}
          </span>
        </span>
      </button>
      {(onRestore ?? onDelete) && (
        <span className="flex shrink-0 gap-2 pl-5 sm:pl-0">
          {onRestore && (
            <button
              type="button"
              className={buttonClass.ghost}
              disabled={busy}
              onClick={onRestore}
            >
              {text.restore}
            </button>
          )}
          {onDelete && (
            <ConfirmButton
              label={text.delete}
              isPending={busy}
              onConfirm={onDelete}
            />
          )}
        </span>
      )}
    </li>
  );
}

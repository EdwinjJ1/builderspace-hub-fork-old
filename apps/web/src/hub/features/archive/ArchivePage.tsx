import { useEffect, useMemo, useState } from "react";

import type { FunctionKey } from "@kan/hub/public";
import { functionKeys, functionNames } from "@kan/hub/public";

import type { RouterOutputs } from "~/utils/api";
import { PageHead } from "~/components/PageHead";
import { copy } from "~/hub/copy/zh";
import { colorOf, useFunctionColors } from "~/hub/lib/use-function-colors";
import { Card, ErrorText, PageHeader } from "~/hub/ui/admin-primitives";
import { api } from "~/utils/api";
import { PersonalTabs } from "../personal/PersonalTabs";
import { taskWhere, useOpenTask } from "../tasks/task-display";
import { MonthBars } from "./MonthBars";

type Archive = RouterOutputs["hub"]["archive"]["get"];
type Finished = Archive["recent"][number];

const text = copy.archive;

const dayFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
});

/** 个人 → 我完成的: what this person has finished, from the boards' own history. */
export function ArchivePage() {
  // The browser's zone decides which month a task falls in, so the query
  // waits until it is known on the client.
  const [timeZone, setTimeZone] = useState<string | null>(null);
  useEffect(
    () => setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone),
    [],
  );
  const archive = api.hub.archive.get.useQuery(
    { timeZone: timeZone ?? "UTC" },
    { enabled: !!timeZone, retry: false },
  );

  return (
    <div className="m-auto w-full max-w-[1100px] px-5 py-8 md:px-12 md:py-12">
      <PageHead title={`${text.title} · ${copy.brand}`} />
      <PersonalTabs />
      <PageHeader title={text.title} description={text.description} />

      <ErrorText message={archive.error?.message} />
      {archive.data ? (
        <ArchiveContent archive={archive.data} />
      ) : (
        !archive.error && <Skeleton />
      )}
    </div>
  );
}

function ArchiveContent({ archive }: { archive: Archive }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <Stat label={text.total} value={archive.total} />
        <Stat label={text.thisMonth} value={archive.thisMonth} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <Card title={text.months.title}>
          <MonthBars months={archive.months} />
        </Card>
        <div className="space-y-4">
          <ByFunction counts={archive.byFunction} />
          <ByProject rows={archive.byProject} />
        </div>
      </div>

      <Card title={text.recent.title}>
        <RecentList archive={archive} />
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-light-300 bg-light-50 p-4 dark:border-dark-300 dark:bg-dark-100">
      <p className="text-xs text-light-900 dark:text-dark-900">{label}</p>
      <p className="mt-1 text-3xl font-semibold tracking-tight text-light-1000 dark:text-dark-1000">
        {value}
      </p>
    </div>
  );
}

function ByFunction({ counts }: { counts: Archive["byFunction"] }) {
  const colors = useFunctionColors();
  const rows: { key: FunctionKey | null; label: string; count: number }[] = [
    ...functionKeys.map((key) => ({
      key,
      label: functionNames[key],
      count: counts[key],
    })),
    ...(counts.other > 0
      ? [{ key: null, label: text.otherBoards, count: counts.other }]
      : []),
  ];

  return (
    <Card title={text.byFunction}>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.label}
            className="flex items-center gap-2 text-sm text-light-1000 dark:text-dark-1000"
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: colorOf(colors, row.key) }}
              aria-hidden="true"
            />
            <span className="flex-1">{row.label}</span>
            <span className="tabular-nums text-light-900 dark:text-dark-900">
              {row.count}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ByProject({ rows }: { rows: Archive["byProject"] }) {
  if (rows.length === 0) return null;
  return (
    <Card title={text.byProject}>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.project.publicId}
            className="flex items-center gap-2 text-sm text-light-1000 dark:text-dark-1000"
          >
            <span className="min-w-0 flex-1 truncate">{row.project.name}</span>
            <span className="tabular-nums text-light-900 dark:text-dark-900">
              {row.count}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Newest first, under a heading per month of the viewer's calendar. */
function RecentList({ archive }: { archive: Archive }) {
  const groups = useMemo(() => {
    const byMonth = new Map<
      string,
      { year: number; month: number; items: Finished[] }
    >();
    for (const item of archive.recent) {
      const year = item.finishedAt.getFullYear();
      const month = item.finishedAt.getMonth() + 1;
      const key = `${year}-${month}`;
      const group = byMonth.get(key) ?? { year, month, items: [] };
      group.items.push(item);
      byMonth.set(key, group);
    }
    return [...byMonth.values()];
  }, [archive.recent]);

  if (archive.total === 0) {
    return (
      <p className="text-sm text-light-900 dark:text-dark-900">
        {text.recent.empty}
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={`${group.year}-${group.month}`}>
          <h3 className="mb-1 text-xs font-medium text-light-900 dark:text-dark-900">
            {text.recent.monthHeading(group.year, group.month)}
          </h3>
          <ul>
            {group.items.map((item) => (
              <FinishedRow key={item.task.publicId} item={item} />
            ))}
          </ul>
        </section>
      ))}
      {archive.total > archive.recent.length && (
        <p className="text-xs text-light-900 dark:text-dark-900">
          {text.recent.limited(archive.recent.length, archive.total)}
        </p>
      )}
    </div>
  );
}

function FinishedRow({ item }: { item: Finished }) {
  const open = useOpenTask(item.task);
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-light-1000 dark:text-dark-1000">
          {item.task.title}
        </span>
        <span className="mt-0.5 block truncate text-xs text-light-900 dark:text-dark-900">
          {taskWhere(item.task)}
          {item.task.deleted && ` · ${text.recent.deleted}`}
        </span>
      </span>
      <span className="shrink-0 text-xs tabular-nums text-light-900 dark:text-dark-900">
        {dayFormat.format(item.finishedAt)}
      </span>
    </>
  );
  // The clean-up deleted its card: still counted, but there is nothing to open.
  if (item.task.deleted) {
    return <li className="flex w-full items-center gap-3 px-3 py-2">{body}</li>;
  }
  return (
    <li>
      <button
        type="button"
        onClick={open}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-light-200 dark:hover:bg-dark-200"
      >
        {body}
      </button>
    </li>
  );
}

function Skeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <div className="h-20 animate-pulse rounded-xl bg-light-200 dark:bg-dark-200" />
        <div className="h-20 animate-pulse rounded-xl bg-light-200 dark:bg-dark-200" />
      </div>
      <div className="h-56 animate-pulse rounded-xl bg-light-200 dark:bg-dark-200" />
    </div>
  );
}

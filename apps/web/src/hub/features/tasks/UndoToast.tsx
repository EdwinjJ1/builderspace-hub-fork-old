import { useEffect } from "react";
import { TbX } from "react-icons/tb";

import { copy } from "~/hub/copy/zh";

/** A short message about what just happened, maybe with a way to take it back. */
export interface Notice {
  message: string;
  undo?: () => void;
}

/** Long enough to notice a slip and reach for 撤销. */
const SHOW_FOR_MS = 10_000;

/**
 * Pops up at the bottom of the screen after a task went to 归档 or was
 * deleted, with 撤销 where that can be taken back. Goes away on its own.
 */
export function UndoToast({
  notice,
  onClose,
}: {
  notice: Notice | null;
  /** Must keep its identity between renders, or the timer restarts. */
  onClose: () => void;
}) {
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(onClose, SHOW_FOR_MS);
    return () => clearTimeout(timer);
  }, [notice, onClose]);

  if (!notice) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-30 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl bg-light-1000 py-2.5 pl-4 pr-2 text-sm text-light-50 shadow-lg dark:bg-dark-1000 dark:text-dark-50"
    >
      <span className="min-w-0 truncate">{notice.message}</span>
      {notice.undo && (
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 font-semibold underline-offset-2 hover:underline"
          onClick={notice.undo}
        >
          {copy.tasks.archived.undo}
        </button>
      )}
      <button
        type="button"
        aria-label={copy.tasks.archived.close}
        className="shrink-0 rounded-md p-1 opacity-80 hover:opacity-100"
        onClick={onClose}
      >
        <TbX className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

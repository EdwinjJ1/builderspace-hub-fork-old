import {
  Button,
  Description,
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
} from "@headlessui/react";
import { TbTrash } from "react-icons/tb";

import type { HubTask } from "./task-display";
import { copy } from "~/hub/copy/zh";
import { buttonClass } from "~/hub/ui/admin-primitives";

const text = copy.tasks.deleteDialog;

/**
 * "Delete this task?" in the middle of the page. 删除 deletes it at once;
 * 取消, Esc and a click outside leave it as it was. Focus starts on 取消, so a
 * stray Enter never deletes anything. It is a Headless UI Dialog, as the rest
 * of the app's modals are: Tab stays inside it, the board behind it cannot be
 * reached, and focus goes back to where it was when it closes.
 */
export function ConfirmDeleteDialog({
  task,
  onConfirm,
  onCancel,
}: {
  task: HubTask;
  onConfirm: (task: HubTask) => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onCancel}
      className="relative z-50"
    >
      <DialogBackdrop className="fixed inset-0 bg-black/40" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-sm rounded-xl border border-light-300 bg-light-50 p-5 shadow-xl dark:border-dark-300 dark:bg-dark-100">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold text-light-1000 dark:text-dark-1000">
            <TbTrash
              className="h-5 w-5 text-red-600 dark:text-red-400"
              aria-hidden="true"
            />
            {text.title}
          </DialogTitle>
          <Description as="div" className="mt-3 text-sm leading-6">
            <p className="line-clamp-3 font-medium text-light-1000 dark:text-dark-1000">
              {task.title}
            </p>
            <p className="mt-1 text-light-900 dark:text-dark-900">
              {text.body}
            </p>
          </Description>
          <div className="mt-5 flex justify-end gap-2">
            <Button autoFocus className={buttonClass.ghost} onClick={onCancel}>
              {text.cancel}
            </Button>
            <button
              type="button"
              className={buttonClass.danger}
              onClick={() => onConfirm(task)}
            >
              {text.confirm}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

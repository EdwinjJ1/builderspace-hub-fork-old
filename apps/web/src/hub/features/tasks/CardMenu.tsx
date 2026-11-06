import { Popover, PopoverButton, PopoverPanel } from "@headlessui/react";
import { useState } from "react";
import { TbArchive, TbDots, TbTrash } from "react-icons/tb";
import { twMerge } from "tailwind-merge";

import { copy } from "~/hub/copy/zh";
import { buttonClass } from "~/hub/ui/admin-primitives";

const text = copy.tasks.cardMenu;

/**
 * Keeps a press inside the menu from starting a drag or opening the card. The
 * panel is drawn outside the card, but React still bubbles its events here.
 */
const stop = (event: { stopPropagation: () => void }) =>
  event.stopPropagation();

/**
 * The "⋯" in a task card's corner: 归档, and 删除 behind a second "are you
 * sure". Shown on hover where there is a mouse, always on touch screens. The
 * panel floats above the page, so neither the card nor its column clips it.
 */
export function CardMenu({
  onArchive,
  onDelete,
}: {
  onArchive?: () => void;
  onDelete?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!onArchive && !onDelete) return null;

  return (
    <Popover
      as="span"
      className="absolute right-1.5 top-1.5"
      onPointerDown={stop}
      onClick={stop}
      onKeyDown={stop}
    >
      <PopoverButton
        aria-label={text.label}
        title={text.label}
        className={twMerge(
          "rounded p-1 text-light-800 transition data-[open]:bg-light-200 data-[open]:opacity-100 hover:bg-light-200 hover:text-light-1000 focus:outline-none focus-visible:opacity-100 dark:text-dark-800 dark:data-[open]:bg-dark-200 dark:hover:bg-dark-200 dark:hover:text-dark-1000",
          "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:data-[open]:opacity-100",
        )}
        onClick={() => setConfirming(false)}
      >
        <TbDots className="h-4 w-4" aria-hidden="true" />
      </PopoverButton>

      <PopoverPanel
        anchor={{ to: "bottom end", gap: 4 }}
        className="z-30 w-48 rounded-lg border border-light-300 bg-light-50 p-1 text-left shadow-lg dark:border-dark-300 dark:bg-dark-100"
      >
        {({ close }) =>
          confirming && onDelete ? (
            <div className="p-2">
              <p className="text-xs leading-5 text-light-1000 dark:text-dark-1000">
                {text.confirmDelete}
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  autoFocus
                  className={twMerge(buttonClass.danger, "px-2 py-1 text-xs")}
                  onClick={() => {
                    close();
                    onDelete();
                  }}
                >
                  {text.confirm}
                </button>
                <button
                  type="button"
                  className={twMerge(buttonClass.ghost, "px-2 py-1 text-xs")}
                  onClick={() => setConfirming(false)}
                >
                  {text.cancel}
                </button>
              </div>
            </div>
          ) : (
            <>
              {onArchive && (
                <MenuItem
                  icon={<TbArchive className="h-4 w-4" aria-hidden="true" />}
                  onClick={() => {
                    close();
                    onArchive();
                  }}
                >
                  {text.archive}
                </MenuItem>
              )}
              {onDelete && (
                <MenuItem
                  danger
                  icon={<TbTrash className="h-4 w-4" aria-hidden="true" />}
                  onClick={() => setConfirming(true)}
                >
                  {text.delete}
                </MenuItem>
              )}
            </>
          )
        }
      </PopoverPanel>
    </Popover>
  );
}

function MenuItem({
  icon,
  danger = false,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={twMerge(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-light-1000 hover:bg-light-200 dark:text-dark-1000 dark:hover:bg-dark-200",
        danger &&
          "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950",
      )}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}

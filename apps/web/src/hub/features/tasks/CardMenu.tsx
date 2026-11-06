import { Popover, PopoverButton, PopoverPanel } from "@headlessui/react";
import { TbArchive, TbDots, TbTrash } from "react-icons/tb";
import { twMerge } from "tailwind-merge";

import { copy } from "~/hub/copy/zh";
import { noDrag } from "./no-drag";

const text = copy.tasks.cardMenu;

/**
 * The "⋯" in a task card's corner: 归档 and 删除. 删除 only asks the page to
 * delete; the page puts up its own "are you sure". Shown on hover where there
 * is a mouse, always on touch screens. The panel floats above the page, so
 * neither the card nor its column clips it. A press inside the menu must
 * neither start a drag nor open the card; the panel is drawn outside the card,
 * but React still bubbles its events to it.
 */
export function CardMenu({
  onArchive,
  onDelete,
}: {
  onArchive?: () => void;
  onDelete?: () => void;
}) {
  if (!onArchive && !onDelete) return null;

  return (
    <Popover as="span" className="absolute right-1.5 top-1.5" {...noDrag}>
      <PopoverButton
        aria-label={text.label}
        title={text.label}
        className={twMerge(
          "rounded p-1 text-light-800 transition data-[open]:bg-light-200 data-[open]:opacity-100 hover:bg-light-200 hover:text-light-1000 focus:outline-none focus-visible:opacity-100 dark:text-dark-800 dark:data-[open]:bg-dark-200 dark:hover:bg-dark-200 dark:hover:text-dark-1000",
          "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:data-[open]:opacity-100",
        )}
      >
        <TbDots className="h-4 w-4" aria-hidden="true" />
      </PopoverButton>

      <PopoverPanel
        anchor={{ to: "bottom end", gap: 4 }}
        className="z-30 w-48 rounded-lg border border-light-300 bg-light-50 p-1 text-left shadow-lg dark:border-dark-300 dark:bg-dark-100"
      >
        {({ close }) => (
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
                onClick={() => {
                  close();
                  onDelete();
                }}
              >
                {text.delete}
              </MenuItem>
            )}
          </>
        )}
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

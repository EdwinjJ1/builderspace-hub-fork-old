import { twMerge } from "tailwind-merge";

import type { AudienceChoice } from "./audience-choice";
import type { RouterOutputs } from "~/utils/api";
import { copy } from "~/hub/copy/zh";

export type EditAccess = RouterOutputs["hub"]["documents"]["get"]["editAccess"];

const text = copy.documents.editAccess;

/**
 * 谁能改: only the owner and the people it was assigned to, or everyone who can
 * read it (under 谁能看). A document only its editors can read has no one else
 * to open it to, so that choice is off for it.
 */
export function EditAccessPicker({
  value,
  onChange,
  audience,
}: {
  value: EditAccess;
  onChange: (value: EditAccess) => void;
  audience: AudienceChoice["kind"];
}) {
  const openable = audience !== "editors";
  const options = [
    {
      kind: "assigned" as const,
      label: text.assigned.label,
      hint: text.assigned.hint,
      disabled: false,
    },
    {
      kind: "readers" as const,
      label: text.readers.label[audience],
      hint: openable ? text.readers.hint : text.readers.unavailable,
      disabled: !openable,
    },
  ];

  return (
    <fieldset className="text-sm">
      <legend className="text-sm">{text.label}</legend>
      <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
        {options.map((option) => (
          <label
            key={option.kind}
            className={twMerge(
              "flex cursor-pointer gap-2 rounded-lg border border-light-300 p-2.5 dark:border-dark-300",
              value === option.kind &&
                "border-light-1000 dark:border-dark-1000",
              option.disabled && "cursor-not-allowed opacity-60",
            )}
          >
            <input
              type="radio"
              name="editAccess"
              className="mt-0.5"
              checked={value === option.kind}
              disabled={option.disabled}
              onChange={() => onChange(option.kind)}
            />
            <span>
              <span className="block font-medium">{option.label}</span>
              <span className="block text-xs text-light-900 dark:text-dark-900">
                {option.hint}
              </span>
            </span>
          </label>
        ))}
      </div>
      {value === "readers" && (
        <p className="mt-1.5 text-xs text-light-900 dark:text-dark-900">
          {text.scope}
        </p>
      )}
    </fieldset>
  );
}

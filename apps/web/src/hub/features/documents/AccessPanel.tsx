import { useEffect, useState } from "react";

import { copy } from "~/hub/copy/zh";
import {
  buttonClass,
  Card,
  ErrorText,
  inputClass,
  Pill,
} from "~/hub/ui/admin-primitives";
import { api } from "~/utils/api";
import { formatDate } from "./document-display";

const text = copy.documents.access;

interface Detail {
  publicId: string;
  editAccess: "assigned" | "readers";
  canEdit: boolean;
  canEditContent: boolean;
  canManageEditors: boolean;
  canRequestEdit: boolean;
  myRequest: {
    status: "pending" | "approved" | "denied";
    note: string | null;
    createdAt: Date;
  } | null;
  editors: { userId: string; name: string; email: string | null }[];
  pendingRequests: {
    publicId: string;
    note: string | null;
    createdAt: Date;
    requester: { name: string; email: string };
  }[];
}

/**
 * Who may change this document, and how to get the right: ordinary members ask,
 * owners and the document's admin-editors assign and decide. A document open
 * to its readers needs no asking for its content.
 */
export function AccessPanel({ detail }: { detail: Detail }) {
  const utils = api.useUtils();
  const refresh = () =>
    Promise.all([
      utils.hub.documents.get.invalidate(),
      utils.hub.documents.library.invalidate(),
      utils.hub.documents.requests.invalidate(),
    ]);

  return (
    <Card title={text.title} hint={text.hint}>
      <div className="space-y-5">
        {detail.editAccess === "readers" && (
          <p className="text-sm text-light-900 dark:text-dark-900">
            {text.openToReaders}
          </p>
        )}
        <EditorList detail={detail} onChanged={() => void refresh()} />
        {detail.canEdit && !detail.canManageEditors && (
          <p className="text-sm text-light-900 dark:text-dark-900">
            {text.canEdit}
          </p>
        )}
        {!detail.canEditContent && (
          <RequestBox detail={detail} onChanged={() => void refresh()} />
        )}
        {detail.canManageEditors && (
          <>
            <PendingRequests detail={detail} onChanged={() => void refresh()} />
            <GrantBox detail={detail} onChanged={() => void refresh()} />
          </>
        )}
      </div>
    </Card>
  );
}

function EditorList({
  detail,
  onChanged,
}: {
  detail: Detail;
  onChanged: () => void;
}) {
  const revoke = api.hub.documents.revokeEditor.useMutation({
    onSuccess: onChanged,
  });

  return (
    <div>
      <h3 className="text-xs font-medium text-light-900 dark:text-dark-900">
        {text.editors}
      </h3>
      {detail.editors.length === 0 ? (
        <p className="mt-1 text-sm text-light-900 dark:text-dark-900">
          {text.nobody}
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {detail.editors.map((editor) => (
            <li
              key={editor.userId}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="min-w-0 truncate">
                {editor.name}
                {editor.email && (
                  <span className="ml-2 text-xs text-light-900 dark:text-dark-900">
                    {editor.email}
                  </span>
                )}
              </span>
              {detail.canManageEditors && (
                <button
                  type="button"
                  className={buttonClass.dangerText}
                  disabled={revoke.isPending}
                  onClick={() =>
                    revoke.mutate({
                      documentPublicId: detail.publicId,
                      userId: editor.userId,
                    })
                  }
                >
                  {text.revoke}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorText message={revoke.error?.message} />
    </div>
  );
}

function RequestBox({
  detail,
  onChanged,
}: {
  detail: Detail;
  onChanged: () => void;
}) {
  const [note, setNote] = useState("");
  const request = api.hub.documents.requestEdit.useMutation({
    onSuccess: () => {
      setNote("");
      onChanged();
    },
  });
  const mine = detail.myRequest;

  return (
    <div className="space-y-2 border-t border-light-200 pt-4 dark:border-dark-200">
      <h3 className="text-sm font-semibold">{text.request.title}</h3>
      {mine?.status === "pending" && (
        <p className="text-sm text-light-900 dark:text-dark-900">
          {text.request.pending}
          <span className="ml-2 text-xs">{formatDate(mine.createdAt)}</span>
        </p>
      )}
      {mine?.status === "denied" && (
        <p className="text-sm text-light-900 dark:text-dark-900">
          {text.request.denied}
        </p>
      )}
      {detail.canRequestEdit && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            request.mutate({
              documentPublicId: detail.publicId,
              note: note.trim() || null,
            });
          }}
        >
          <p className="text-xs text-light-900 dark:text-dark-900">
            {text.request.hint}
          </p>
          <textarea
            className={`${inputClass} min-h-16`}
            aria-label={text.request.title}
            placeholder={text.request.notePlaceholder}
            maxLength={280}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <button
            type="submit"
            className={buttonClass.primary}
            disabled={request.isPending}
          >
            {text.request.submit}
          </button>
        </form>
      )}
      <ErrorText message={request.error?.message} />
    </div>
  );
}

function PendingRequests({
  detail,
  onChanged,
}: {
  detail: Detail;
  onChanged: () => void;
}) {
  const decide = api.hub.documents.decideRequest.useMutation({
    onSuccess: onChanged,
  });

  return (
    <div className="space-y-2 border-t border-light-200 pt-4 dark:border-dark-200">
      <h3 className="text-sm font-semibold">{text.pendingTitle}</h3>
      {detail.pendingRequests.length === 0 ? (
        <p className="text-sm text-light-900 dark:text-dark-900">
          {text.noPending}
        </p>
      ) : (
        <ul className="space-y-3">
          {detail.pendingRequests.map((item) => (
            <li key={item.publicId} className="text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {item.requester.name}
                    <span className="ml-2 text-xs font-normal text-light-900 dark:text-dark-900">
                      {item.requester.email} · {formatDate(item.createdAt)}
                    </span>
                  </p>
                  {item.note && (
                    <p className="mt-0.5 text-light-900 dark:text-dark-900">
                      {item.note}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    className={buttonClass.primary}
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({
                        requestPublicId: item.publicId,
                        approve: true,
                      })
                    }
                  >
                    {text.approve}
                  </button>
                  <button
                    type="button"
                    className={buttonClass.ghost}
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({
                        requestPublicId: item.publicId,
                        approve: false,
                      })
                    }
                  >
                    {text.deny}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ErrorText message={decide.error?.message} />
    </div>
  );
}

function GrantBox({
  detail,
  onChanged,
}: {
  detail: Detail;
  onChanged: () => void;
}) {
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(input.trim()), 250);
    return () => clearTimeout(timer);
  }, [input]);

  const candidates = api.hub.documents.candidates.useQuery(
    { documentPublicId: detail.publicId, search },
    { enabled: search.length > 0, retry: false },
  );
  const grant = api.hub.documents.grantEditor.useMutation({
    onSuccess: () => {
      setInput("");
      onChanged();
    },
  });

  return (
    <div className="space-y-2 border-t border-light-200 pt-4 dark:border-dark-200">
      <h3 className="text-sm font-semibold">{text.grantTitle}</h3>
      <input
        className={inputClass}
        aria-label={text.grantTitle}
        placeholder={text.grantPlaceholder}
        value={input}
        onChange={(event) => setInput(event.target.value)}
      />
      {search.length > 0 && candidates.data && (
        <ul className="space-y-1">
          {candidates.data.length === 0 && (
            <li className="text-sm text-light-900 dark:text-dark-900">
              {text.noMatch}
            </li>
          )}
          {candidates.data.map((person) => (
            <li
              key={person.userId}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="min-w-0 truncate">
                {person.name}
                <span className="ml-2 text-xs text-light-900 dark:text-dark-900">
                  {person.email}
                </span>
                {person.hubRole && (
                  <span className="ml-2">
                    <Pill>{copy.admin.roles[person.hubRole]}</Pill>
                  </span>
                )}
              </span>
              <button
                type="button"
                className={buttonClass.ghost}
                disabled={grant.isPending}
                onClick={() =>
                  grant.mutate({
                    documentPublicId: detail.publicId,
                    userId: person.userId,
                  })
                }
              >
                {text.grant}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorText message={grant.error?.message ?? candidates.error?.message} />
    </div>
  );
}

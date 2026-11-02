import { useRouter } from "next/router";
import { useState } from "react";
import { TbPaperclip } from "react-icons/tb";
import { twMerge } from "tailwind-merge";

import {
  hasRemoteImages,
  inboxAttachmentHref,
  MAIL_FRAME_SANDBOX,
  mailFrameDocument,
  splitAddress,
} from "@kan/hub/public";

import type { RouterOutputs } from "~/utils/api";
import { copy } from "~/hub/copy/zh";
import { AdminLayout } from "~/hub/features/admin/AdminLayout";
import { buttonClass, ErrorText, PageHeader } from "~/hub/ui/admin-primitives";
import { api } from "~/utils/api";
import { Facts, formatTime, Segmented } from "./site-ui";

const text = copy.admin.site.inbox;

type Mail = RouterOutputs["hub"]["inbox"]["message"];

const muted = "text-sm text-light-900 dark:text-dark-900";

/** The sender's name if the mail gives one, otherwise the address. */
const senderName = (from: string) => {
  const { name, address } = splitAddress(from);
  return name ?? address;
};

/** Renders the page only once a Resend key is set; until then, says what is missing. */
function InboxGate({ children }: { children: React.ReactNode }) {
  const status = api.hub.inbox.status.useQuery();
  if (status.isLoading) return <p className={muted}>{copy.admin.loading}</p>;
  if (!status.data?.connected) {
    return (
      <div className="max-w-md">
        <h1 className="text-xl font-bold">{text.notConnected.heading}</h1>
        <p className={`mt-2 ${muted}`}>{text.notConnected.body}</p>
      </div>
    );
  }
  return <>{children}</>;
}

function Inbox() {
  const router = useRouter();
  const selected =
    typeof router.query.mail === "string" ? router.query.mail : null;
  // Resend pages by cursor: each entry is the last id of the page before.
  const [cursors, setCursors] = useState<string[]>([]);
  const after = cursors.at(-1);
  const list = api.hub.inbox.list.useQuery(
    { after },
    { refetchOnWindowFocus: false },
  );

  const select = (id: string) =>
    void router.push(
      { pathname: router.pathname, query: { ...router.query, mail: id } },
      undefined,
      { shallow: true },
    );

  const items = list.data?.items ?? [];
  const lastId = items.at(-1)?.id;

  return (
    <>
      <PageHeader title={text.title} description={text.description}>
        <button
          type="button"
          className={buttonClass.ghost}
          disabled={list.isFetching}
          onClick={() => {
            setCursors([]);
            void list.refetch();
          }}
        >
          {text.refresh}
        </button>
      </PageHeader>
      <ErrorText message={list.error?.message} />

      <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <section className="min-w-0">
          <ul className="divide-y divide-light-300 overflow-hidden rounded-xl border border-light-300 dark:divide-dark-300 dark:border-dark-300">
            {items.map((mail) => (
              <li key={mail.id}>
                <button
                  type="button"
                  onClick={() => select(mail.id)}
                  aria-current={mail.id === selected ? "true" : undefined}
                  className={twMerge(
                    "block w-full px-4 py-3 text-left hover:bg-light-200 dark:hover:bg-dark-200",
                    mail.id === selected && "bg-light-200 dark:bg-dark-200",
                  )}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {senderName(mail.from)}
                    </span>
                    <span className="shrink-0 text-xs text-light-900 dark:text-dark-900">
                      {formatTime(mail.receivedAt)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-1 text-sm text-light-900 dark:text-dark-900">
                    <span className="truncate">
                      {mail.subject ?? text.noSubject}
                    </span>
                    {mail.attachmentCount > 0 && (
                      <TbPaperclip
                        className="shrink-0"
                        aria-label={text.hasAttachments(mail.attachmentCount)}
                      />
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {list.isLoading && (
            <p className={`px-1 py-4 ${muted}`}>{copy.admin.loading}</p>
          )}
          {list.data && items.length === 0 && (
            <p className={`px-1 py-4 ${muted}`}>{text.empty}</p>
          )}
          <div className="mt-3 flex justify-between">
            <button
              type="button"
              className={buttonClass.ghost}
              disabled={cursors.length === 0 || list.isFetching}
              onClick={() => setCursors(cursors.slice(0, -1))}
            >
              {text.newer}
            </button>
            <button
              type="button"
              className={buttonClass.ghost}
              disabled={!list.data?.hasMore || !lastId || list.isFetching}
              onClick={() => lastId && setCursors([...cursors, lastId])}
            >
              {text.older}
            </button>
          </div>
        </section>

        <section className="min-w-0">
          {selected ? (
            <MailView emailId={selected} />
          ) : (
            <p className="rounded-xl border border-dashed border-light-400 p-8 text-center text-sm text-light-900 dark:border-dark-400 dark:text-dark-900">
              {text.pick}
            </p>
          )}
        </section>
      </div>
    </>
  );
}

function MailView({ emailId }: { emailId: string }) {
  const mail = api.hub.inbox.message.useQuery(
    { emailId },
    { retry: false, refetchOnWindowFocus: false, staleTime: 5 * 60_000 },
  );

  if (mail.isLoading) return <p className={muted}>{copy.admin.loading}</p>;
  if (!mail.data) return <ErrorText message={mail.error?.message} />;
  // Remounts per mail, so the image switch starts off again.
  return <MailBody key={mail.data.id} mail={mail.data} />;
}

function MailBody({ mail }: { mail: Mail }) {
  const [view, setView] = useState<"html" | "text">(
    mail.html ? "html" : "text",
  );
  const [remoteImages, setRemoteImages] = useState(false);
  const list = (addresses: string[]) => addresses.join("、");

  return (
    <article className="rounded-xl border border-light-300 bg-light-50 dark:border-dark-300 dark:bg-dark-100">
      <header className="space-y-3 border-b border-light-300 p-4 dark:border-dark-300">
        <h2 className="break-words text-lg font-semibold">
          {mail.subject ?? text.noSubject}
        </h2>
        {mail.authentication?.dmarc === "fail" && (
          <p
            role="alert"
            className="rounded-md border border-red-300 px-3 py-2 text-sm text-red-600 dark:border-red-900 dark:text-red-400"
          >
            {text.suspicious}
          </p>
        )}
        <Facts
          rows={[
            [text.from, mail.from],
            [text.to, list(mail.to)],
            [text.cc, list(mail.cc)],
            [text.replyTo, list(mail.replyTo)],
            [text.receivedAt, formatTime(mail.receivedAt)],
          ]}
        />
        {mail.attachments.length > 0 && (
          <div>
            <p className="text-xs font-medium text-light-900 dark:text-dark-900">
              {text.attachments}
            </p>
            <ul className="mt-1 flex flex-wrap gap-2">
              {mail.attachments.map((file) => (
                <li key={file.id}>
                  <a
                    href={inboxAttachmentHref(mail.id, file.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-light-400 px-2 py-1 text-sm hover:bg-light-200 dark:border-dark-400 dark:hover:bg-dark-200"
                  >
                    <TbPaperclip className="shrink-0" />
                    <span className="max-w-[16rem] truncate">
                      {file.filename ?? file.contentType}
                    </span>
                    <span className="text-xs text-light-900 dark:text-dark-900">
                      {formatSize(file.size)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </header>

      <div className="space-y-3 p-4">
        {mail.html && mail.text && (
          <Segmented
            label={text.frameTitle}
            value={view}
            onChange={setView}
            options={[
              { value: "html", label: text.html },
              { value: "text", label: text.text },
            ]}
          />
        )}
        {view === "html" && mail.html ? (
          <>
            {!remoteImages && hasRemoteImages(mail.html) && (
              <p className="flex flex-wrap items-center gap-2 text-xs text-light-900 dark:text-dark-900">
                {text.imagesHidden}
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => setRemoteImages(true)}
                >
                  {text.showImages}
                </button>
              </p>
            )}
            {/* The mail's HTML only ever goes into this frame: no scripts, no
                origin of ours, and a CSP that blocks remote loads. */}
            <iframe
              title={text.frameTitle}
              sandbox={MAIL_FRAME_SANDBOX}
              referrerPolicy="no-referrer"
              srcDoc={mailFrameDocument(mail.html, { remoteImages })}
              className="block h-[70vh] w-full rounded-lg border border-light-300 bg-white dark:border-dark-300"
            />
          </>
        ) : mail.text ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm">
            {mail.text}
          </pre>
        ) : (
          <p className={muted}>{text.noBody}</p>
        )}
      </div>
    </article>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SiteInboxPage() {
  return (
    <AdminLayout title={text.title} mail>
      <InboxGate>
        <Inbox />
      </InboxGate>
    </AdminLayout>
  );
}

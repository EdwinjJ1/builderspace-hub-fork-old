import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { TbChevronRight, TbFolder, TbSearch } from "react-icons/tb";

import type { ImportedDocument } from "@kan/hub/documents/file-import";

import { PageHead } from "~/components/PageHead";
import { copy } from "~/hub/copy/zh";
import {
  buttonClass,
  ConfirmButton,
  ErrorText,
  inputClass,
  PageHeader,
  Pill,
  tableClass,
} from "~/hub/ui/admin-primitives";
import { api } from "~/utils/api";
import {
  documentHref,
  documentsHref,
  formatBytes,
  formatDate,
} from "./document-display";
import { NewDocumentDialog } from "./NewDocumentDialog";
import { UploadButton } from "./UploadButton";

const text = copy.documents;

/** 文档: the shared library of contracts, decks and other files. */
export function DocumentsPage() {
  const router = useRouter();
  const folder =
    typeof router.query.folder === "string" ? router.query.folder : null;

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const [creating, setCreating] = useState(false);
  const [writing, setWriting] = useState(false);
  // Numbered so each finished upload gets a fresh dialog (see the key below).
  const [uploaded, setUploaded] = useState<{
    id: number;
    document: ImportedDocument;
  } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const utils = api.useUtils();
  const library = api.hub.documents.library.useQuery(
    { folderPublicId: folder, search: search || null },
    { enabled: router.isReady, retry: false },
  );
  const data = library.data;

  const requests = api.hub.documents.requests.useQuery(undefined, {
    enabled: !!data?.canCreate,
    retry: false,
  });
  const refresh = () => utils.hub.documents.library.invalidate();

  return (
    <>
      <PageHead title={`${text.title} | ${copy.brand}`} />
      <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6">
        <PageHeader title={text.title} description={text.description}>
          {data?.canCreate && (
            <>
              {(requests.data?.length ?? 0) > 0 && (
                <Link href="/documents/requests" className={buttonClass.ghost}>
                  {text.actions.requests}
                  <span className="ml-1.5">
                    <Pill tone="alert">{requests.data?.length}</Pill>
                  </span>
                </Link>
              )}
              <button
                type="button"
                className={buttonClass.ghost}
                onClick={() => setCreating(true)}
              >
                {text.actions.newFolder}
              </button>
              <UploadButton
                onImported={(document) => {
                  setWriting(false);
                  setUploaded((previous) => ({
                    id: (previous?.id ?? 0) + 1,
                    document,
                  }));
                }}
                onError={setUploadError}
              />
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => setWriting(true)}
              >
                {text.actions.newText}
              </button>
            </>
          )}
        </PageHeader>

        <div className="relative mb-4">
          <TbSearch
            aria-hidden="true"
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-light-800 dark:text-dark-800"
          />
          <input
            type="search"
            aria-label={text.searchPlaceholder}
            placeholder={text.searchPlaceholder}
            className={`${inputClass} pl-9`}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>

        <ErrorText message={library.error?.message ?? uploadError} />
        {library.isLoading && (
          <p className="text-sm text-light-900 dark:text-dark-900">
            {text.loading}
          </p>
        )}

        {data && (
          <>
            {data.search ? (
              <p className="mb-3 text-sm text-light-900 dark:text-dark-900">
                {text.searchResults(data.documents.length)}
              </p>
            ) : (
              <Breadcrumbs crumbs={data.breadcrumbs} />
            )}

            {creating && (
              <NewFolderForm
                parentPublicId={data.folder?.publicId ?? null}
                onDone={() => {
                  setCreating(false);
                  void refresh();
                }}
                onCancel={() => setCreating(false)}
              />
            )}

            {data.folder && data.canCreate && (
              <FolderActions
                folder={data.folder}
                onRenamed={() => void refresh()}
                onDeleted={(parent) => {
                  void refresh();
                  void router.push(documentsHref(parent));
                }}
              />
            )}

            {data.folders.length > 0 && (
              <ul className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {data.folders.map((item) => (
                  <li key={item.publicId}>
                    <Link
                      href={documentsHref(item.publicId)}
                      className="flex items-center gap-3 rounded-xl border border-light-300 bg-light-50 p-3 hover:bg-light-100 dark:border-dark-300 dark:bg-dark-100 dark:hover:bg-dark-200"
                    >
                      <TbFolder
                        size={22}
                        aria-hidden="true"
                        className="shrink-0 text-light-900 dark:text-dark-900"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-light-1000 dark:text-dark-1000">
                          {item.name}
                        </span>
                        <span className={tableClass.sub}>
                          {text.folderMeta(
                            item.documentCount,
                            item.folderCount,
                          )}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            {data.documents.length === 0 && data.folders.length === 0 ? (
              <p className="rounded-xl border border-dashed border-light-400 p-8 text-center text-sm text-light-900 dark:border-dark-400 dark:text-dark-900">
                {data.search ? text.empty.search : text.empty.folder}
                {!data.search && data.canCreate && ` ${text.empty.managerHint}`}
              </p>
            ) : (
              data.documents.length > 0 && (
                <div className={tableClass.wrap}>
                  <table className={tableClass.table}>
                    <thead>
                      <tr>
                        <th className={tableClass.th}>{text.columns.name}</th>
                        <th className={tableClass.th}>{text.columns.type}</th>
                        <th className={tableClass.th}>{text.columns.size}</th>
                        <th className={tableClass.th}>
                          {text.columns.updated}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-light-200 dark:divide-dark-200">
                      {data.documents.map((doc) => (
                        <tr key={doc.publicId}>
                          <td className={tableClass.td}>
                            <Link
                              href={documentHref(doc.publicId)}
                              className="font-medium hover:underline"
                            >
                              {doc.title}
                            </Link>
                            {doc.folderPath && data.search && (
                              <p className={tableClass.sub}>{doc.folderPath}</p>
                            )}
                            {doc.description && (
                              <p className={`${tableClass.sub} line-clamp-1`}>
                                {doc.description}
                              </p>
                            )}
                            <div className="mt-1 flex gap-1.5">
                              {doc.canEditContent && (
                                <Pill tone="strong">{text.badges.canEdit}</Pill>
                              )}
                              {doc.audience === "selected" && (
                                <Pill>{text.badges.selected}</Pill>
                              )}
                              {doc.audience === "editors" && (
                                <Pill tone="alert">{text.badges.hidden}</Pill>
                              )}
                            </div>
                          </td>
                          <td className={tableClass.td}>
                            <Pill>{doc.label}</Pill>
                          </td>
                          <td className={`${tableClass.td} whitespace-nowrap`}>
                            {formatBytes(doc.size)}
                          </td>
                          <td className={`${tableClass.td} whitespace-nowrap`}>
                            {formatDate(doc.updatedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </>
        )}
      </div>

      {(writing || uploaded) && data && (
        <NewDocumentDialog
          // The form copies `initial` once, when it mounts. A file that
          // finishes reading while a blank draft is open must replace that
          // draft, not leave it under the file's name.
          key={uploaded ? `upload-${uploaded.id}` : "blank"}
          folderPublicId={data.folder?.publicId ?? null}
          folderName={data.folder?.name ?? null}
          initial={uploaded?.document ?? null}
          onClose={() => {
            setWriting(false);
            setUploaded(null);
          }}
          onCreated={(publicId) => {
            setWriting(false);
            setUploaded(null);
            void refresh();
            void router.push(documentHref(publicId));
          }}
        />
      )}
    </>
  );
}

function Breadcrumbs({
  crumbs,
}: {
  crumbs: { publicId: string; name: string }[];
}) {
  return (
    <nav
      aria-label="breadcrumb"
      className="mb-3 flex flex-wrap items-center gap-1 text-sm text-light-900 dark:text-dark-900"
    >
      <Link href={documentsHref()} className="hover:underline">
        {text.root}
      </Link>
      {crumbs.map((crumb) => (
        <span key={crumb.publicId} className="inline-flex items-center gap-1">
          <TbChevronRight size={14} aria-hidden="true" />
          <Link
            href={documentsHref(crumb.publicId)}
            className="hover:underline"
          >
            {crumb.name}
          </Link>
        </span>
      ))}
    </nav>
  );
}

function NewFolderForm({
  parentPublicId,
  onDone,
  onCancel,
}: {
  parentPublicId: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const create = api.hub.documents.createFolder.useMutation({
    onSuccess: onDone,
  });

  return (
    <form
      className="mb-4 flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate({ name, parentPublicId });
      }}
    >
      <input
        autoFocus
        className={`${inputClass} max-w-xs`}
        aria-label={text.folder.namePlaceholder}
        placeholder={text.folder.namePlaceholder}
        maxLength={80}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <button
        type="submit"
        className={buttonClass.primary}
        disabled={create.isPending}
      >
        {text.folder.create}
      </button>
      <button type="button" className={buttonClass.ghost} onClick={onCancel}>
        {text.actions.cancel}
      </button>
      <ErrorText message={create.error?.message} />
    </form>
  );
}

function FolderActions({
  folder,
  onRenamed,
  onDeleted,
}: {
  folder: { publicId: string; name: string; parentPublicId: string | null };
  onRenamed: () => void;
  onDeleted: (parentPublicId: string | null) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(folder.name);
  const rename = api.hub.documents.renameFolder.useMutation({
    onSuccess: () => {
      setRenaming(false);
      onRenamed();
    },
  });
  const remove = api.hub.documents.deleteFolder.useMutation({
    onSuccess: () => onDeleted(folder.parentPublicId),
  });

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {renaming ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate({ folderPublicId: folder.publicId, name });
          }}
        >
          <input
            autoFocus
            className={`${inputClass} max-w-xs`}
            aria-label={text.folder.renamePrompt}
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="submit"
            className={buttonClass.primary}
            disabled={rename.isPending}
          >
            {text.actions.save}
          </button>
          <button
            type="button"
            className={buttonClass.ghost}
            onClick={() => setRenaming(false)}
          >
            {text.actions.cancel}
          </button>
        </form>
      ) : (
        <>
          <button
            type="button"
            className={buttonClass.ghost}
            onClick={() => {
              setName(folder.name);
              setRenaming(true);
            }}
          >
            {text.actions.rename}
          </button>
          <ConfirmButton
            label={text.actions.deleteFolder}
            isPending={remove.isPending}
            onConfirm={() => remove.mutate({ folderPublicId: folder.publicId })}
          />
        </>
      )}
      <ErrorText message={rename.error?.message ?? remove.error?.message} />
    </div>
  );
}

import Link from "next/link";
import { format } from "date-fns";
import { useState } from "react";

import type { HubRole } from "@kan/hub/public";
import { can, roleLabels, siteAccessLabels } from "@kan/hub/public";

import type { ProjectRole } from "./ProjectRolePicker";
import { copy } from "~/hub/copy/zh";
import {
  buttonClass,
  Card,
  ErrorText,
  inputClass,
  OneTimeSecret,
  PageHeader,
  Pagination,
  Pill,
  tableClass,
} from "~/hub/ui/admin-primitives";
import { api } from "~/utils/api";
import { AdminLayout } from "./AdminLayout";
import { ProjectRolePicker } from "./ProjectRolePicker";
import { usePageParam } from "./use-page-param";

const text = copy.admin.accounts;

function AddAccountForm({ myRole }: { myRole: HubRole | null }) {
  const utils = api.useUtils();
  const projects = api.hub.projects.useQuery();
  const create = api.hub.accounts.create.useMutation({
    onSuccess: () => utils.hub.accounts.list.invalidate(),
  });

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [hubRole, setHubRole] = useState<HubRole | "">("");
  const [roles, setRoles] = useState<Record<string, ProjectRole | null>>({});

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    create.mutate({
      name,
      email,
      hubRole: hubRole || null,
      projects: Object.entries(roles).flatMap(([projectPublicId, role]) =>
        role ? [{ projectPublicId, role }] : [],
      ),
    });
  };

  if (create.data) {
    return (
      <Card title={text.form.heading}>
        <div className="space-y-3">
          <p className="text-sm">{create.data.email}</p>
          <OneTimeSecret
            label={text.form.created}
            value={create.data.temporaryPassword}
          />
          <button
            type="button"
            className={buttonClass.ghost}
            onClick={() => {
              create.reset();
              setName("");
              setEmail("");
              setHubRole("");
              setRoles({});
            }}
          >
            {text.add}
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card title={text.form.heading} hint={text.form.hint}>
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <label className="block text-sm">
            {text.form.name}
            <input
              className={`${inputClass} mt-1`}
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            {text.form.email}
            <input
              className={`${inputClass} mt-1`}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {can(myRole, "admins.manage") && (
            <label className="block text-sm">
              {text.form.hubRole}
              <select
                className={`${inputClass} mt-1`}
                value={hubRole}
                onChange={(e) => setHubRole(e.target.value as HubRole | "")}
              >
                <option value="">{copy.admin.roles.none}</option>
                <option value="viewer">{roleLabels.viewer}</option>
                <option value="admin">{roleLabels.admin}</option>
                <option value="owner">{roleLabels.owner}</option>
              </select>
            </label>
          )}
        </div>
        <div>
          <p className="mb-2 text-sm">{text.form.projects}</p>
          <ProjectRolePicker
            projects={projects.data ?? []}
            value={roles}
            onChange={(id, role) =>
              setRoles((current) => ({ ...current, [id]: role }))
            }
          />
        </div>
        <div className="space-y-2 md:col-span-2">
          <ErrorText message={create.error?.message} />
          <button
            type="submit"
            className={buttonClass.primary}
            disabled={create.isPending}
          >
            {text.form.submit}
          </button>
        </div>
      </form>
    </Card>
  );
}

function AccountsContent() {
  const [page, setPage] = usePageParam();
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const me = api.hub.me.get.useQuery();
  const accounts = api.hub.accounts.list.useQuery({
    page,
    search: search || undefined,
  });
  const canManage = can(me.data?.role ?? null, "accounts.manage");

  return (
    <>
      <PageHeader title={text.title} description={text.description}>
        {canManage && (
          <button
            type="button"
            className={buttonClass.primary}
            onClick={() => setShowForm((v) => !v)}
          >
            {text.add}
          </button>
        )}
      </PageHeader>

      {showForm && canManage && (
        <div className="mb-6">
          <AddAccountForm myRole={me.data?.role ?? null} />
        </div>
      )}

      <input
        className={`${inputClass} mb-4 max-w-xs`}
        placeholder={text.search}
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          if (page !== 1) setPage(1);
        }}
      />

      <div className={tableClass.wrap}>
        <table className={tableClass.table}>
          <thead>
            <tr>
              <th className={tableClass.th}>{text.columns.name}</th>
              <th className={tableClass.th}>{text.columns.role}</th>
              <th className={tableClass.th}>{text.columns.projects}</th>
              <th className={tableClass.th}>{text.columns.status}</th>
              <th className={tableClass.th}>{text.columns.createdAt}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-light-300 dark:divide-dark-300">
            {accounts.data?.items.map((account) => (
              <tr
                key={account.userId}
                className="hover:bg-light-100 dark:hover:bg-dark-100"
              >
                <td className={tableClass.td}>
                  <Link
                    href={`/admin/accounts/${account.userId}`}
                    className="font-medium hover:underline"
                  >
                    {account.name ?? account.email}
                  </Link>
                  <div className={tableClass.sub}>{account.email}</div>
                </td>
                <td className={tableClass.td}>
                  {account.role ? (
                    <Pill tone="strong">{roleLabels[account.role]}</Pill>
                  ) : (
                    <span className={tableClass.sub}>
                      {copy.admin.roles.none}
                    </span>
                  )}
                  {account.siteAccess && (
                    <div className="mt-1">
                      <Pill>
                        {copy.admin.groups.site} ·{" "}
                        {siteAccessLabels[account.siteAccess]}
                      </Pill>
                    </div>
                  )}
                  {account.mailAccess && (
                    <div className="mt-1">
                      <Pill>{copy.admin.site.inbox.title}</Pill>
                    </div>
                  )}
                </td>
                <td className={tableClass.td}>
                  {account.projects.length === 0 ? (
                    <span className={tableClass.sub}>{text.noProjects}</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {account.projects.map((project) => (
                        <Pill key={project.projectPublicId}>
                          {project.projectName} ·{" "}
                          {copy.admin.projectRoles[project.role]}
                        </Pill>
                      ))}
                    </div>
                  )}
                </td>
                <td className={tableClass.td}>
                  <Pill
                    tone={account.status === "suspended" ? "alert" : "neutral"}
                  >
                    {copy.admin.statuses[account.status]}
                  </Pill>
                </td>
                <td className={`${tableClass.td} ${tableClass.sub}`}>
                  {format(account.createdAt, "yyyy-MM-dd")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {accounts.data?.items.length === 0 && (
          <p className="px-4 py-6 text-sm text-light-900 dark:text-dark-900">
            {text.empty}
          </p>
        )}
      </div>
      {accounts.data && (
        <Pagination
          page={page}
          pageSize={accounts.data.pageSize}
          total={accounts.data.total}
          onChange={setPage}
        />
      )}
    </>
  );
}

export function AccountsPage() {
  return (
    <AdminLayout title={text.title}>
      <AccountsContent />
    </AdminLayout>
  );
}

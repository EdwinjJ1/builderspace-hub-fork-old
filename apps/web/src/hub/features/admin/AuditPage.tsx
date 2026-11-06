import { format } from "date-fns";

import { copy } from "~/hub/copy/zh";
import { PageHeader, Pagination, tableClass } from "~/hub/ui/admin-primitives";
import { api } from "~/utils/api";
import { AdminLayout } from "./AdminLayout";
import { usePageParam } from "./use-page-param";

const text = copy.admin.audit;

function AuditContent() {
  const [page, setPage] = usePageParam();
  const audit = api.hub.audit.list.useQuery({ page });

  return (
    <>
      <PageHeader title={text.title} description={text.description} />
      <div className={tableClass.wrap}>
        <table className={tableClass.table}>
          <thead>
            <tr>
              <th className={tableClass.th}>{text.columns.at}</th>
              <th className={tableClass.th}>{text.columns.actor}</th>
              <th className={tableClass.th}>{text.columns.summary}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-light-300 dark:divide-dark-300">
            {audit.data?.items.map((entry) => (
              <tr key={entry.publicId}>
                <td
                  className={`${tableClass.td} ${tableClass.sub} whitespace-nowrap`}
                >
                  {format(entry.at, "yyyy-MM-dd HH:mm")}
                </td>
                <td className={tableClass.td}>
                  {entry.actorEmail === "cli"
                    ? "命令行"
                    : entry.actorEmail === "auto-tidy"
                      ? "自动清理"
                      : entry.actorEmail}
                </td>
                <td className={tableClass.td}>
                  {entry.summary}
                  <div className={tableClass.sub}>{entry.action}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {audit.data?.items.length === 0 && (
          <p className="px-4 py-6 text-sm text-light-900 dark:text-dark-900">
            {text.empty}
          </p>
        )}
      </div>
      {audit.data && (
        <Pagination
          page={page}
          pageSize={audit.data.pageSize}
          total={audit.data.total}
          onChange={setPage}
        />
      )}
    </>
  );
}

export function AuditPage() {
  return (
    <AdminLayout title={text.title}>
      <AuditContent />
    </AdminLayout>
  );
}

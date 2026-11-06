import Link from "next/link";
import { useRouter } from "next/router";
import {
  TbFiles,
  TbForms,
  TbPlugConnected,
  TbShieldLock,
} from "react-icons/tb";
import { twMerge } from "tailwind-merge";

import { can, HUB_MCP_GUIDE_PATH } from "@kan/hub/public";

import { copy } from "~/hub/copy/zh";
import { adminHome } from "~/hub/lib/routes";
import { api } from "~/utils/api";

const linkClass =
  "mt-1 flex items-center gap-3 rounded-md p-1.5 text-sm font-medium text-neutral-600 hover:bg-light-200 hover:text-light-1000 dark:text-dark-900 dark:hover:bg-dark-200 dark:hover:text-dark-1000";

/**
 * The Hub's own sidebar links, rendered once under Kan's navigation: 文档,
 * 表单 and MCP for every member, 后台 for back-office members and for those with
 * website or mailbox access (who land in the 官网 section). They live in one component so the
 * sidebar needs a single registered edit (docs/hub/UPSTREAM_SEAMS.md).
 */
export function HubAdminLink({
  isCollapsed,
  onCloseSideNav,
}: {
  isCollapsed?: boolean;
  onCloseSideNav?: () => void;
}) {
  const { pathname } = useRouter();
  const me = api.hub.me.get.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const role = me.data?.role ?? null;
  const access = {
    role,
    siteAccess: me.data?.siteAccess ?? null,
    mailAccess: me.data?.mailAccess ?? false,
  };
  const showAdmin =
    can(role, "admin.view") || Boolean(access.siteAccess) || access.mailAccess;

  return (
    <>
      <Link
        href="/documents"
        onClick={onCloseSideNav}
        title={copy.documents.entry}
        className={twMerge(
          linkClass,
          isCollapsed && "justify-center",
          pathname.startsWith("/documents") && "bg-light-200 dark:bg-dark-200",
        )}
      >
        <TbFiles size={18} className="shrink-0" />
        {!isCollapsed && copy.documents.entry}
      </Link>
      <Link
        href="/forms"
        onClick={onCloseSideNav}
        title={copy.forms.entry}
        className={twMerge(
          linkClass,
          isCollapsed && "justify-center",
          pathname.startsWith("/forms") && "bg-light-200 dark:bg-dark-200",
        )}
      >
        <TbForms size={18} className="shrink-0" />
        {!isCollapsed && copy.forms.entry}
      </Link>
      <Link
        href={HUB_MCP_GUIDE_PATH}
        onClick={onCloseSideNav}
        title={copy.mcp.entry}
        className={twMerge(
          linkClass,
          isCollapsed && "justify-center",
          pathname.startsWith(HUB_MCP_GUIDE_PATH) &&
            "bg-light-200 dark:bg-dark-200",
        )}
      >
        <TbPlugConnected size={18} className="shrink-0" />
        {!isCollapsed && copy.mcp.entry}
      </Link>
      {showAdmin && (
        <Link
          href={adminHome(access)}
          onClick={onCloseSideNav}
          title={copy.admin.entry}
          className={twMerge(
            linkClass,
            isCollapsed && "justify-center",
            pathname.startsWith("/admin") && "bg-light-200 dark:bg-dark-200",
          )}
        >
          <TbShieldLock size={18} className="shrink-0" />
          {!isCollapsed && copy.admin.entry}
        </Link>
      )}
    </>
  );
}

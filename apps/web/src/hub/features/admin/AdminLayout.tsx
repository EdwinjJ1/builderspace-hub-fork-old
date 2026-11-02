import Link from "next/link";
import { useRouter } from "next/router";
import { twMerge } from "tailwind-merge";

import type {
  HubPermission,
  HubRole,
  SiteAccess,
  SitePermission,
} from "@kan/hub/public";
import { can, canOnSite, canReadMail, roleLabels } from "@kan/hub/public";

import { PageHead } from "~/components/PageHead";
import { copy } from "~/hub/copy/zh";
import { adminHome, hubRoutes } from "~/hub/lib/routes";
import { Pill } from "~/hub/ui/admin-primitives";
import { api } from "~/utils/api";

const text = copy.admin;

/** A back-office page needs a back-office permission, a website one, or mailbox access. */
type PageAccess =
  | { permission: HubPermission }
  | { site: SitePermission }
  | { mail: true };

/** What the signed-in person may open; mirrors `hub.me.get`. */
interface Access {
  role: HubRole | null;
  siteAccess: SiteAccess | null;
  mailAccess: boolean;
}

interface NavItem {
  href: string;
  label: string;
  access: PageAccess;
}

const allows = (access: PageAccess, me: Access) =>
  "mail" in access
    ? canReadMail(me.mailAccess)
    : "site" in access
      ? canOnSite(me.siteAccess, access.site)
      : can(me.role, access.permission);

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: text.groups.overview,
    items: [
      {
        href: "/admin",
        label: text.overview.title,
        access: { permission: "admin.view" },
      },
    ],
  },
  {
    label: text.groups.content,
    items: [
      {
        href: "/admin/forms",
        label: copy.forms.title,
        access: { permission: "admin.view" },
      },
    ],
  },
  {
    label: text.groups.people,
    items: [
      {
        href: "/admin/accounts",
        label: text.accounts.title,
        access: { permission: "admin.view" },
      },
      {
        href: "/admin/grants",
        label: text.grants.title,
        access: { permission: "admin.view" },
      },
      {
        href: "/admin/departments",
        label: text.departments.title,
        access: { permission: "admin.view" },
      },
    ],
  },
  {
    label: text.groups.system,
    items: [
      {
        href: "/admin/permissions",
        label: text.permissions.title,
        access: { permission: "admin.view" },
      },
      {
        href: "/admin/colors",
        label: text.colors.title,
        access: { permission: "admin.view" },
      },
      {
        href: "/admin/repos",
        label: text.repos.title,
        access: { permission: "admin.view" },
      },
      {
        href: "/admin/audit",
        label: text.audit.title,
        access: { permission: "audit.view" },
      },
    ],
  },
  {
    label: text.groups.site,
    items: [
      {
        href: "/admin/site",
        label: text.site.overview.title,
        access: { site: "site.people" },
      },
      {
        href: "/admin/site/projects",
        label: text.site.projects.title,
        access: { site: "site.review" },
      },
      {
        href: "/admin/site/volunteers",
        label: text.site.volunteers.title,
        access: { site: "site.people" },
      },
      {
        href: "/admin/site/joins",
        label: text.site.joins.title,
        access: { site: "site.people" },
      },
      {
        href: "/admin/site/inbox",
        label: text.site.inbox.title,
        access: { mail: true },
      },
    ],
  },
];

/** Section start pages match exactly, so they are not lit on their sub-pages. */
const EXACT = new Set(["/admin", "/admin/site"]);

const isActive = (pathname: string, href: string) =>
  EXACT.has(href) ? pathname === href : pathname.startsWith(href);

/**
 * Frame of every back-office page: grouped sidebar, a top bar with the
 * current page and the signed-in person's role, and the page itself.
 *
 * The page is only rendered for those it is meant for: back-office members,
 * on 官网 pages (`site`) those with website access, and on the mailbox page
 * (`mail`) those with mailbox access. That is for clarity, not security:
 * every `hub.*` procedure checks permissions on the server.
 */
export function AdminLayout({
  title,
  site,
  mail,
  children,
}: {
  title: string;
  /** Makes this a 官网 page that needs this website permission. */
  site?: SitePermission;
  /** Makes this the mailbox page, which needs mailbox access. */
  mail?: boolean;
  children: React.ReactNode;
}) {
  const { pathname } = useRouter();
  const me = api.hub.me.get.useQuery(undefined, { retry: false });
  const role = me.data?.role ?? null;
  const access: Access = {
    role,
    siteAccess: me.data?.siteAccess ?? null,
    mailAccess: me.data?.mailAccess ?? false,
  };
  const pageAccess: PageAccess = mail
    ? { mail: true }
    : site
      ? { site }
      : { permission: "admin.view" };
  const denied = mail
    ? text.site.inbox.noAccess
    : site
      ? text.site.noAccess
      : text.denied;

  const currentLabel =
    NAV_GROUPS.flatMap((group) => group.items).find((item) =>
      isActive(pathname, item.href),
    )?.label ?? text.title;

  return (
    <>
      <PageHead title={`${title} | ${text.title} | ${copy.brand}`} />
      <div className="flex min-h-screen bg-light-100 text-light-1000 dark:bg-dark-50 dark:text-dark-1000">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-light-300 bg-light-100 px-3 py-4 dark:border-dark-300 dark:bg-dark-100 md:flex">
          <Link
            href={adminHome(access)}
            className="px-2 text-[15px] font-bold tracking-tight"
          >
            {copy.brand}
            <span className="ml-1 font-normal text-light-900 dark:text-dark-900">
              · {text.title}
            </span>
          </Link>
          <nav className="mt-6 flex-1 space-y-5">
            {NAV_GROUPS.map((group) => {
              const items = group.items.filter((item) =>
                allows(item.access, access),
              );
              if (items.length === 0) return null;
              return (
                <div key={group.label}>
                  <p className="px-2 text-xs font-medium text-light-900 dark:text-dark-900">
                    {group.label}
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {items.map((item) => (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={
                            isActive(pathname, item.href) ? "page" : undefined
                          }
                          className={twMerge(
                            "block rounded-md px-2 py-1.5 text-sm hover:bg-light-200 dark:hover:bg-dark-200",
                            isActive(pathname, item.href) &&
                              "bg-light-1000 text-light-50 hover:bg-light-1000 dark:bg-dark-1000 dark:text-dark-50 dark:hover:bg-dark-1000",
                          )}
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </nav>
          <Link
            href={hubRoutes.afterLogin}
            className="px-2 text-sm text-light-900 hover:text-light-1000 dark:text-dark-900 dark:hover:text-dark-1000"
          >
            ← {text.backToApp}
          </Link>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-light-300 bg-light-100/80 px-6 backdrop-blur dark:border-dark-300 dark:bg-dark-50/80">
            <span className="text-sm font-medium">{currentLabel}</span>
            {me.data && (
              <span className="flex items-center gap-2 text-sm text-light-900 dark:text-dark-900">
                <span className="hidden sm:inline">{me.data.email}</span>
                {role && <Pill tone="strong">{roleLabels[role]}</Pill>}
              </span>
            )}
          </header>
          <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
            {me.isLoading ? (
              <p className="text-sm text-light-900 dark:text-dark-900">
                {text.loading}
              </p>
            ) : allows(pageAccess, access) ? (
              children
            ) : (
              <div className="max-w-md">
                <h1 className="text-xl font-bold">{denied.heading}</h1>
                <p className="mt-2 text-sm text-light-900 dark:text-dark-900">
                  {denied.body}
                </p>
                <Link
                  href={hubRoutes.afterLogin}
                  className="mt-4 inline-block text-sm underline"
                >
                  {text.backToApp}
                </Link>
              </div>
            )}
          </main>
        </div>
      </div>
    </>
  );
}

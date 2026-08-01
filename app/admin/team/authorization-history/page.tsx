import Link from "next/link";
import { redirect } from "next/navigation";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  TEAM_AUTHORIZATION_HISTORY_PAGE_SIZE,
  loadTeamAuthorizationHistoryReadModel,
  type TeamAuthorizationHistoryView,
} from "@/lib/auth/teamAuthorizationHistoryReadModel";
import AuthorizationHistoryList from "./AuthorizationHistoryList";

export const dynamic = "force-dynamic";

function resolveView(value: string | undefined): TeamAuthorizationHistoryView {
  return value === "roles-permissions"
    ? "roles-permissions"
    : "team-changes";
}

function pageHref(view: TeamAuthorizationHistoryView, page = 1) {
  const params = new URLSearchParams({ view });
  if (page > 1) params.set("page", String(page));
  return `/admin/team/authorization-history?${params.toString()}`;
}

export default async function AuthorizationHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; view?: string }>;
}) {
  const params = await searchParams;
  const view = resolveView(params.view);
  const parsedPage = Number.parseInt(params.page ?? "1", 10);
  const page =
    Number.isSafeInteger(parsedPage) &&
    parsedPage >= 1 &&
    parsedPage <=
      Math.floor(
        Number.MAX_SAFE_INTEGER / TEAM_AUTHORIZATION_HISTORY_PAGE_SIZE
      )
      ? parsedPage
      : 1;
  let readModel;

  try {
    readModel = await loadTeamAuthorizationHistoryReadModel({ view, page });
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }

  const hasNextPage =
    readModel.page * readModel.pageSize < readModel.total;

  return (
    <div className="mx-auto max-w-6xl pb-12">
      <header className="mb-7">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-300/75">
          {readModel.isAdmin
            ? "Owner audit · Read-only"
            : "Delegated audit · Read-only"}
        </p>
        <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">
          Authorization History
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-white/60">
          Team membership and role-assignment events are separated from role
          definition and permission events, with independent server-side
          pagination.
        </p>
      </header>

      <nav
        aria-label="Authorization history views"
        className="mb-6 flex flex-wrap gap-2"
      >
        {(
          [
            ["team-changes", "Team changes"],
            ["roles-permissions", "Roles & Permissions"],
          ] as const
        ).map(([tabView, label]) => {
          const active = readModel.view === tabView;
          return (
            <Link
              key={tabView}
              href={pageHref(tabView)}
              aria-current={active ? "page" : undefined}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "border-orange-400/45 bg-orange-400/10 text-orange-100"
                  : "border-white/10 bg-white/[0.025] text-white/60 hover:border-white/25 hover:text-white"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {readModel.view === "team-changes"
            ? "Team changes"
            : "Roles & Permissions"}
        </h2>
        <p className="text-xs text-white/45">
          {readModel.total} recorded event
          {readModel.total === 1 ? "" : "s"}
        </p>
      </div>

      <AuthorizationHistoryList
        audit={readModel.entries}
        isAdmin={readModel.isAdmin}
      />

      <nav
        aria-label="Authorization history pages"
        className="mt-5 flex items-center gap-4 text-sm"
      >
        {readModel.page > 1 ? (
          <Link
            href={pageHref(readModel.view, readModel.page - 1)}
            className="text-orange-200 hover:text-orange-100"
          >
            Previous
          </Link>
        ) : null}
        <span className="text-white/40">Page {readModel.page}</span>
        {hasNextPage ? (
          <Link
            href={pageHref(readModel.view, readModel.page + 1)}
            className="text-orange-200 hover:text-orange-100"
          >
            Next
          </Link>
        ) : null}
      </nav>
    </div>
  );
}

export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import {
  resolveFlagPageView,
  type FlagPageView,
} from "@/lib/admin/flagPageView";
import {
  listUserFlagCases,
  listUserFlagReviewWorklist,
  listUserWarningAutoFlagCases,
  type UserFlagCase,
} from "@/lib/admin/userFlagCases";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  getTeamAuthorizationContext,
  hasResolvedTeamCapability,
} from "@/lib/auth/teamAuthorization";
import AutomaticWarningFlagCaseCard from "./AutomaticWarningFlagCaseCard";

const HISTORY_PAGE_SIZE = 25;

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Legacy time unavailable";
}

function CaseCard({
  flagCase,
  canReview,
}: {
  flagCase: UserFlagCase;
  canReview: boolean;
}) {
  return (
    <article
      style={{ border: "1px solid #333", borderRadius: 6, padding: 12 }}
    >
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <strong>{flagCase.userDisplayName}</strong>
        <span>{flagCase.status}</span>
        <span>{flagCase.category ?? "legacy category unavailable"}</span>
        <span>Version {flagCase.rowVersion}</span>
      </div>
      <p style={{ marginTop: 8 }}>
        {flagCase.reason ?? "Legacy reason unavailable"}
      </p>
      <p style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
        Discord ID: {flagCase.discordUserId} · Created:{" "}
        {formatTime(flagCase.createdAt)}
      </p>
      <div style={{ marginTop: 10 }}>
        <Link href={`/admin/flags/${flagCase.caseId}`}>
          {canReview && flagCase.status === "open"
            ? "Open review"
            : "Open case details"}
        </Link>
      </div>
    </article>
  );
}

async function loadFlagPage(
  view: FlagPageView,
  query: string,
  historyPage: number
) {
  try {
    const authorization = await getTeamAuthorizationContext();
    const canView = hasResolvedTeamCapability(authorization, "users.flag.view");
    const canReview = hasResolvedTeamCapability(
      authorization,
      "users.flag.review"
    );
    const isAdmin = authorization.isAdmin;

    if (!canView && !canReview) redirect("/403");

    if (!canView) {
      const worklist = await listUserFlagReviewWorklist();
      return { kind: "review" as const, worklist };
    }

    if (view === "history") {
      const [closedPage, automaticClosedPage] = await Promise.all([
        listUserFlagCases({
          section: "history",
          query,
          limit: HISTORY_PAGE_SIZE,
          offset: (historyPage - 1) * HISTORY_PAGE_SIZE,
        }),
        listUserWarningAutoFlagCases({
          section: "history",
          query,
          limit: HISTORY_PAGE_SIZE,
          offset: (historyPage - 1) * HISTORY_PAGE_SIZE,
        }),
      ]);
      return {
        kind: "view" as const,
        view,
        closedPage,
        automaticClosedPage,
        canReview,
        isAdmin,
      };
    }

    const [activePage, automaticActivePage] = await Promise.all([
      listUserFlagCases({
        section: "active",
        limit: 100,
      }),
      listUserWarningAutoFlagCases({
        section: "active",
        limit: 100,
      }),
    ]);
    return {
      kind: "view" as const,
      view,
      activePage,
      automaticActivePage,
      canReview,
      isAdmin,
    };
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }
}

function ViewNavigation({ view }: { view: FlagPageView }) {
  const linkStyle = (selected: boolean) => ({
    border: "1px solid #555",
    borderRadius: 6,
    padding: "8px 12px",
    background: selected ? "#2a2a2a" : "transparent",
    fontWeight: selected ? 700 : 400,
    textDecoration: "none",
  });

  return (
    <nav
      aria-label="Flag case views"
      style={{ display: "flex", gap: 8, marginTop: 18 }}
    >
      <Link
        href="/admin/flags?view=open"
        aria-current={view === "open" ? "page" : undefined}
        style={linkStyle(view === "open")}
      >
        Open flags
      </Link>
      <Link
        href="/admin/flags?view=history"
        aria-current={view === "history" ? "page" : undefined}
        style={linkStyle(view === "history")}
      >
        Flag history
      </Link>
    </nav>
  );
}

export default async function AdminFlaggedUsersPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    page?: string;
    activeStatus?: string;
    view?: string;
  }>;
}) {
  const params = await searchParams;
  const view = resolveFlagPageView(params.view);
  const query = typeof params.q === "string" ? params.q.trim().slice(0, 100) : "";
  const historyPage = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const activeStatus =
    params.activeStatus === "open" || params.activeStatus === "escalated"
      ? params.activeStatus
      : "all";
  const data = await loadFlagPage(view, query, historyPage);

  if (data.kind === "review") {
    return (
      <div data-flag-view="open" style={{ padding: 24 }}>
        <h1>Open user flag worklist</h1>
        <p style={{ marginTop: 8, opacity: 0.75 }}>
          Only open cases assigned to the review workflow are shown. History and
          escalated cases are outside this permission.
        </p>
        <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
          {data.worklist.length === 0 ? (
            <p>No open cases.</p>
          ) : (
            data.worklist.map((flagCase) => (
              <CaseCard key={flagCase.caseId} flagCase={flagCase} canReview />
            ))
          )}
        </div>
      </div>
    );
  }

  if (data.view === "history") {
    const hasNextPage = historyPage * HISTORY_PAGE_SIZE < data.closedPage.total ||
      historyPage * HISTORY_PAGE_SIZE < data.automaticClosedPage.total;

    return (
      <div data-flag-view="history" style={{ padding: 24 }}>
        <h1>User flag cases</h1>
        <ViewNavigation view={data.view} />
        <section style={{ marginTop: 28 }}>
          <h2>Flag history</h2>
          <h3 style={{ marginTop: 18 }}>Manual flags</h3>
          <form method="get" style={{ marginTop: 10 }}>
            <input type="hidden" name="view" value="history" />
            <input
              name="q"
              defaultValue={query}
              maxLength={100}
              placeholder="Discord ID or username"
            />
            <button type="submit" style={{ marginLeft: 6 }}>
              Search
            </button>
          </form>
          <p style={{ marginTop: 8, opacity: 0.7 }}>
            {data.closedPage.total} matching closed case(s)
          </p>
          <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
            {data.closedPage.items.length === 0 ? (
              <p>No closed cases found.</p>
            ) : (
              data.closedPage.items.map((flagCase) => (
                <CaseCard
                  key={flagCase.caseId}
                  flagCase={flagCase}
                  canReview={false}
                />
              ))
            )}
          </div>
          <section style={{ marginTop: 28 }} aria-labelledby="automatic-flag-history-heading">
            <h3 id="automatic-flag-history-heading">Automatic Warning flags</h3>
            <p style={{ marginTop: 6, opacity: 0.7 }}>
              {data.automaticClosedPage.total} matching closed automatic case(s)
            </p>
            <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
              {data.automaticClosedPage.items.length === 0 ? (
                <p>No closed automatic Warning flags found.</p>
              ) : (
                data.automaticClosedPage.items.map((flagCase) => (
                  <AutomaticWarningFlagCaseCard
                    key={flagCase.caseId}
                    flagCase={flagCase}
                  />
                ))
              )}
            </div>
          </section>
          <nav
            aria-label="Closed-case history pages"
            style={{ display: "flex", gap: 12, marginTop: 14 }}
          >
            {historyPage > 1 ? (
              <Link
                href={`/admin/flags?view=history&q=${encodeURIComponent(query)}&page=${historyPage - 1}`}
              >
                Previous
              </Link>
            ) : null}
            {hasNextPage ? (
              <Link
                href={`/admin/flags?view=history&q=${encodeURIComponent(query)}&page=${historyPage + 1}`}
              >
                Next
              </Link>
            ) : null}
          </nav>
        </section>
      </div>
    );
  }

  const visibleActiveCases = data.isAdmin
    ? data.activePage.items
    : data.activePage.items.filter((flagCase) => flagCase.status === "open");
  const activeCases =
    activeStatus === "all"
      ? visibleActiveCases
      : visibleActiveCases.filter(
          (flagCase) => flagCase.status === activeStatus
        );

  return (
    <div data-flag-view="open" style={{ padding: 24 }}>
      <h1>User flag cases</h1>
      <ViewNavigation view={data.view} />
      <section style={{ marginTop: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2>Open flags</h2>
          {data.isAdmin ? (
            <form method="get">
              <input type="hidden" name="view" value="open" />
              <select name="activeStatus" defaultValue={activeStatus}>
                <option value="all">Open and escalated</option>
                <option value="open">Open only</option>
                <option value="escalated">Escalated only</option>
              </select>
              <button type="submit" style={{ marginLeft: 6 }}>
                Filter
              </button>
            </form>
          ) : null}
        </div>
        <h3 style={{ marginTop: 18 }}>Manual flags</h3>
        <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
          {activeCases.length === 0 ? (
            <p>No active cases.</p>
          ) : (
            activeCases.map((flagCase) => (
              <CaseCard
                key={flagCase.caseId}
                flagCase={flagCase}
                canReview={data.canReview}
              />
            ))
          )}
        </div>
      </section>
      <section style={{ marginTop: 28 }} aria-labelledby="automatic-open-flags-heading">
        <h2 id="automatic-open-flags-heading">Automatic Warning flags</h2>
        <p style={{ marginTop: 6, opacity: 0.7 }}>
          Warning-threshold cases are read-only and close only through canonical Warning expiry or Overrule recalculation.
        </p>
        <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
          {data.automaticActivePage.items.length === 0 ? (
            <p>No active automatic Warning flags.</p>
          ) : (
            data.automaticActivePage.items.map((flagCase) => (
              <AutomaticWarningFlagCaseCard
                key={flagCase.caseId}
                flagCase={flagCase}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

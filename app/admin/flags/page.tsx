export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import {
  listUserFlagCases,
  listUserFlagReviewWorklist,
  type UserFlagCase,
} from "@/lib/admin/userFlagCases";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  getTeamAuthorizationContext,
  hasResolvedTeamCapability,
} from "@/lib/auth/teamAuthorization";

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
        Discord ID: {flagCase.discordUserId} · Created: {formatTime(flagCase.createdAt)}
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

async function loadFlagPage(query: string, historyPage: number) {
  try {
    const authorization = await getTeamAuthorizationContext();
    const canView = hasResolvedTeamCapability(authorization, "users.flag.view");
    const canReview = hasResolvedTeamCapability(authorization, "users.flag.review");
    const isAdmin = authorization.isAdmin;

    if (!canView && !canReview) redirect("/403");

    if (!canView) {
      const worklist = await listUserFlagReviewWorklist();
      return { kind: "review" as const, worklist };
    }

    const [activePage, closedPage] = await Promise.all([
      listUserFlagCases({ section: "active", limit: 100 }),
      listUserFlagCases({
        section: "history",
        query,
        limit: HISTORY_PAGE_SIZE,
        offset: (historyPage - 1) * HISTORY_PAGE_SIZE,
      }),
    ]);
    return { kind: "view" as const, activePage, closedPage, canReview, isAdmin };
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }
}

export default async function AdminFlaggedUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; activeStatus?: string }>;
}) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim().slice(0, 100) : "";
  const historyPage = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const activeStatus = params.activeStatus === "open" || params.activeStatus === "escalated"
    ? params.activeStatus
    : "all";
  const data = await loadFlagPage(query, historyPage);

  if (data.kind === "review") {
    return (
      <div style={{ padding: 24 }}>
        <h1>Open user flag worklist</h1>
        <p style={{ marginTop: 8, opacity: 0.75 }}>
          Only open cases assigned to the review workflow are shown. History and
          escalated cases are outside this permission.
        </p>
        <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
          {data.worklist.length === 0 ? <p>No open cases.</p> : data.worklist.map((flagCase) => (
            <CaseCard key={flagCase.caseId} flagCase={flagCase} canReview />
          ))}
        </div>
      </div>
    );
  }

  const activeCases = activeStatus === "all"
    ? data.activePage.items
    : data.activePage.items.filter((flagCase) => flagCase.status === activeStatus);
  const hasNextPage = historyPage * HISTORY_PAGE_SIZE < data.closedPage.total;

  return (
      <div style={{ padding: 24 }}>
        <h1>User flag cases</h1>
        <section style={{ marginTop: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h2>Active cases</h2>
            {data.isAdmin ? (
              <form method="get">
                {query ? <input type="hidden" name="q" value={query} /> : null}
                <select name="activeStatus" defaultValue={activeStatus}>
                  <option value="all">Open and escalated</option>
                  <option value="open">Open only</option>
                  <option value="escalated">Escalated only</option>
                </select>
                <button type="submit" style={{ marginLeft: 6 }}>Filter</button>
              </form>
            ) : null}
          </div>
          <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
            {activeCases.length === 0 ? <p>No active cases.</p> : activeCases.map((flagCase) => (
              <CaseCard
                key={flagCase.caseId}
                flagCase={flagCase}
                canReview={data.canReview}
              />
            ))}
          </div>
        </section>

        <section style={{ marginTop: 28 }}>
          <h2>Closed-case history</h2>
          <form method="get" style={{ marginTop: 10 }}>
            <input
              name="q"
              defaultValue={query}
              maxLength={100}
              placeholder="Discord ID or username"
            />
            <button type="submit" style={{ marginLeft: 6 }}>Search</button>
          </form>
          <p style={{ marginTop: 8, opacity: 0.7 }}>
            {data.closedPage.total} matching closed case(s)
          </p>
          <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
            {data.closedPage.items.length === 0 ? <p>No closed cases found.</p> : data.closedPage.items.map((flagCase) => (
              <CaseCard key={flagCase.caseId} flagCase={flagCase} canReview={false} />
            ))}
          </div>
          <nav aria-label="Closed-case history pages" style={{ display: "flex", gap: 12, marginTop: 14 }}>
            {historyPage > 1 ? (
              <Link href={`/admin/flags?q=${encodeURIComponent(query)}&page=${historyPage - 1}`}>
                Previous
              </Link>
            ) : null}
            {hasNextPage ? (
              <Link href={`/admin/flags?q=${encodeURIComponent(query)}&page=${historyPage + 1}`}>
                Next
              </Link>
            ) : null}
          </nav>
        </section>
      </div>
  );
}

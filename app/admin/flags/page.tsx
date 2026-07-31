export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import { listUserFlagCases } from "@/lib/admin/userFlagCases";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  hasResolvedTeamCapability,
  requireDynamicTeamCapability,
} from "@/lib/auth/teamAuthorization";

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Legacy time unavailable";
}

async function loadFlagCasesPage() {
  try {
    const authorization = await requireDynamicTeamCapability(
      "users.flag.view"
    );
    const canReview = hasResolvedTeamCapability(
      authorization,
      "users.flag.review"
    );
    const cases = await listUserFlagCases();
    return { canReview, cases };
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }
}

export default async function AdminFlaggedUsersPage() {
  const { canReview, cases } = await loadFlagCasesPage();

  return (
    <div style={{ padding: 24 }}>
      <h1>User flag cases</h1>
      <p style={{ marginTop: 8, opacity: 0.75 }}>
        Read-only case list and append-only history.
      </p>
      {cases.length === 0 ? (
        <p style={{ marginTop: 16 }}>No user flag cases.</p>
      ) : (
        <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
          {cases.map((flagCase) => (
            <article
              key={flagCase.caseId}
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
              {flagCase.comment ? <p>{flagCase.comment}</p> : null}
              <p style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
                Created: {formatTime(flagCase.createdAt)}
              </p>
              <details style={{ marginTop: 8 }}>
                <summary>History ({flagCase.events.length})</summary>
                <ol>
                  {flagCase.events.map((event) => (
                    <li key={event.eventId} style={{ marginTop: 6 }}>
                      {event.eventType}: {event.previousStatus ?? "none"} -&gt;{" "}
                      {event.newStatus} - {formatTime(event.occurredAt)}
                      {event.reason ? ` - ${event.reason}` : ""}
                    </li>
                  ))}
                </ol>
              </details>
              <div style={{ marginTop: 10 }}>
                <Link href={`/admin/flags/${flagCase.caseId}`}>
                  {canReview && flagCase.status === "open"
                    ? "Open review"
                    : "Open case details"}
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

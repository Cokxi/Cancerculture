export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import { getUserFlagCase } from "@/lib/admin/userFlagCases";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  getTeamAuthorizationContext,
  hasResolvedTeamCapability,
} from "@/lib/auth/teamAuthorization";
import FlagCaseReviewActions from "./FlagCaseReviewActions";

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Legacy time unavailable";
}

async function loadFlagCasePage(caseId: string) {
  try {
    const authorization = await getTeamAuthorizationContext();
    const canView = hasResolvedTeamCapability(
      authorization,
      "users.flag.view"
    );
    const canReview = hasResolvedTeamCapability(
      authorization,
      "users.flag.review"
    );
    if (!canView && !canReview) redirect("/403");
    const flagCase = await getUserFlagCase(caseId);
    return { canView, canReview, flagCase };
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }
}

export default async function UserFlagCasePage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  const { canView, canReview, flagCase } = await loadFlagCasePage(caseId);

  return (
    <div style={{ padding: 24 }}>
      {canView ? <Link href="/admin/flags">Back to user flag cases</Link> : null}
      <h1 style={{ marginTop: 12 }}>User flag case</h1>
      <dl>
        <dt>User</dt>
        <dd>{flagCase.userDisplayName}</dd>
        <dt>Status</dt>
        <dd>{flagCase.status}</dd>
        <dt>Category</dt>
        <dd>{flagCase.category ?? "Legacy category unavailable"}</dd>
        <dt>Reason</dt>
        <dd>{flagCase.reason ?? "Legacy reason unavailable"}</dd>
        <dt>Comment</dt>
        <dd>{flagCase.comment ?? "None"}</dd>
        <dt>Created</dt>
        <dd>{formatTime(flagCase.createdAt)}</dd>
        <dt>Version</dt>
        <dd>{flagCase.rowVersion}</dd>
      </dl>
      <h2>Case history</h2>
      <ol>
        {flagCase.events.map((event) => (
          <li key={event.eventId} style={{ marginTop: 8 }}>
            {event.eventType}: {event.previousStatus ?? "none"} -&gt;{" "}
            {event.newStatus} - {formatTime(event.occurredAt)}
            {event.reason ? ` - ${event.reason}` : ""}
          </li>
        ))}
      </ol>
      {canReview && flagCase.status === "open" ? (
        <FlagCaseReviewActions
          caseId={flagCase.caseId}
          rowVersion={flagCase.rowVersion}
        />
      ) : null}
    </div>
  );
}

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
    return { canView, canReview, isAdmin: authorization.isAdmin, flagCase };
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
  const { canView, canReview, isAdmin, flagCase } = await loadFlagCasePage(caseId);

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
        <dt>Created by</dt>
        <dd>
          {flagCase.createdByDisplayName ?? "Unknown actor"} · {flagCase.createdByDiscordUserId ?? "legacy/system"}
        </dd>
        {flagCase.escalatedAt ? (
          <>
            <dt>Escalated</dt>
            <dd>{formatTime(flagCase.escalatedAt)}</dd>
            <dt>Escalated by</dt>
            <dd>
              {flagCase.escalatedByDisplayName ?? "Unknown actor"} · {flagCase.escalatedByDiscordUserId}
            </dd>
            <dt>Escalation reason</dt>
            <dd>{flagCase.escalationReason}</dd>
          </>
        ) : null}
        <dt>Version</dt>
        <dd>{flagCase.rowVersion}</dd>
      </dl>
      {canView ? (
        <>
          <h2>Case history</h2>
          <ol>
            {flagCase.events.map((event) => (
              <li key={event.eventId} style={{ marginTop: 8 }}>
                <strong>{event.eventType}</strong>: {event.previousStatus ?? "none"} -&gt;{" "}
                {event.newStatus} - {formatTime(event.occurredAt)}
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  Actor: {event.actorUsername ?? event.actorDisplayName ?? "Unknown"} · {event.actorDiscordUserId ?? "legacy/system"}
                </div>
                <details>
                  <summary>Actor snapshot details</summary>
                  <dl>
                    <dt>Account ID</dt><dd>{event.actorAccountId ?? "Unavailable"}</dd>
                    <dt>Discord ID</dt><dd>{event.actorDiscordUserId ?? "Unavailable"}</dd>
                    <dt>Username snapshot</dt><dd>{event.actorUsername ?? "Unavailable"}</dd>
                  </dl>
                </details>
                {event.reason ? <div>{event.reason}</div> : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {(canReview && flagCase.status === "open") ||
      (isAdmin && flagCase.status === "escalated") ? (
        <FlagCaseReviewActions
          caseId={flagCase.caseId}
          rowVersion={flagCase.rowVersion}
          status={flagCase.status}
          isAdmin={isAdmin}
        />
      ) : null}
    </div>
  );
}

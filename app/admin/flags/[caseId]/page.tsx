export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getUserFlagCase,
  type UserFlagEvent,
  type UserFlagStatus,
} from "@/lib/admin/userFlagCases";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  getTeamAuthorizationContext,
  hasResolvedTeamCapability,
} from "@/lib/auth/teamAuthorization";
import FlagCaseReviewActions from "./FlagCaseReviewActions";

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Legacy time unavailable";
}

function formatStatus(value: UserFlagStatus) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatEventLabel(eventType: UserFlagEvent["eventType"]) {
  switch (eventType) {
    case "case_created":
      return "Case created";
    case "legacy_case_migrated":
      return "Legacy case recorded";
    case "case_escalated":
      return "Case escalated";
    case "case_resolved":
      return "Case resolved";
    case "case_dismissed":
      return "Case dismissed";
    case "case_banned_and_resolved":
      return "User banned and case resolved";
  }
}

function actorSummary(
  displayName: string | null,
  username: string | null,
  discordUserId: string | null
) {
  const name = displayName ?? username ?? discordUserId ?? "Unknown actor";
  return discordUserId && discordUserId !== name
    ? `${name} · ${discordUserId}`
    : name;
}

function actorLabel(event: UserFlagEvent) {
  return actorSummary(
    event.actorDisplayName,
    event.actorUsername,
    event.actorDiscordUserId
  );
}

function StatusBadge({ status }: { status: UserFlagStatus }) {
  const colors: Record<UserFlagStatus, string> = {
    open: "border-amber-400/50 bg-amber-400/10 text-amber-200",
    escalated: "border-red-400/50 bg-red-400/10 text-red-200",
    resolved: "border-emerald-400/50 bg-emerald-400/10 text-emerald-200",
    dismissed: "border-slate-400/50 bg-slate-400/10 text-slate-200",
  };

  return (
    <span
      data-flag-status-badge
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${colors[status]}`}
    >
      {formatStatus(status)}
    </span>
  );
}

function OverviewField({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border border-white/10 bg-white/[0.03] p-4 ${wide ? "sm:col-span-2 lg:col-span-3" : ""}`}
    >
      <dt className="text-xs font-semibold uppercase tracking-wide text-white/50">
        {label}
      </dt>
      <dd className="mt-2 break-words text-sm text-white/90">{children}</dd>
    </div>
  );
}

function LifecycleCard({
  label,
  time,
  actor,
  action,
  reason,
  comment,
}: {
  label: string;
  time: string | null;
  actor: string | null;
  action: string;
  reason: string | null;
  comment: string | null;
}) {
  return (
    <article className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <h3 className="font-semibold text-white">{label}</h3>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-white/50">Time</dt>
          <dd className="mt-1">{formatTime(time)}</dd>
        </div>
        <div>
          <dt className="text-white/50">Actor</dt>
          <dd className="mt-1">{actor ?? "Unknown actor"}</dd>
        </div>
        <div>
          <dt className="text-white/50">Action / final status</dt>
          <dd className="mt-1">{action}</dd>
        </div>
        {reason ? (
          <div>
            <dt className="text-white/50">Reason</dt>
            <dd className="mt-1 break-words">{reason}</dd>
          </div>
        ) : null}
        {comment ? (
          <div className="sm:col-span-2">
            <dt className="text-white/50">Comment</dt>
            <dd className="mt-1 break-words">{comment}</dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
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
  const { canView, canReview, isAdmin, flagCase } =
    await loadFlagCasePage(caseId);
  const createdEvent = flagCase.events.find(
    (event) =>
      event.eventType === "case_created" ||
      event.eventType === "legacy_case_migrated"
  );
  const escalatedEvent = flagCase.events.find(
    (event) => event.eventType === "case_escalated"
  );
  const finalEvent = flagCase.events.find(
    (event) =>
      event.eventType === "case_resolved" ||
      event.eventType === "case_dismissed" ||
      event.eventType === "case_banned_and_resolved"
  );

  return (
    <main className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:px-6">
      <header>
        {canView ? (
          <Link
            href="/admin/flags"
            className="text-sm text-orange-300 underline underline-offset-4"
          >
            Back to user flag cases
          </Link>
        ) : null}
        <h1 className="mt-3 text-3xl font-bold">User flag case</h1>
      </header>

      <section
        data-flag-case-overview
        aria-labelledby="case-overview-heading"
      >
        <h2 id="case-overview-heading" className="text-xl font-semibold">
          Case Overview
        </h2>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <OverviewField label="User">{flagCase.userDisplayName}</OverviewField>
          <OverviewField label="Status">
            <StatusBadge status={flagCase.status} />
          </OverviewField>
          <OverviewField label="Category">
            {flagCase.category ?? "Legacy category unavailable"}
          </OverviewField>
          <OverviewField label="Reason" wide>
            {flagCase.reason ?? "Legacy reason unavailable"}
          </OverviewField>
          <OverviewField label="Comment" wide>
            {flagCase.comment ?? "None"}
          </OverviewField>
          <OverviewField label="Version">{flagCase.rowVersion}</OverviewField>
        </dl>
      </section>

      <section data-flag-lifecycle aria-labelledby="lifecycle-heading">
        <h2 id="lifecycle-heading" className="text-xl font-semibold">
          Lifecycle
        </h2>
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <LifecycleCard
            label="Created"
            time={createdEvent?.occurredAt ?? flagCase.createdAt}
            actor={
              createdEvent
                ? actorLabel(createdEvent)
                : actorSummary(
                    flagCase.createdByDisplayName,
                    null,
                    flagCase.createdByDiscordUserId
                  )
            }
            action={createdEvent ? formatEventLabel(createdEvent.eventType) : "Case created"}
            reason={createdEvent?.reason ?? flagCase.reason}
            comment={createdEvent?.comment ?? flagCase.comment}
          />
          {escalatedEvent || flagCase.escalatedAt ? (
            <LifecycleCard
              label="Escalated"
              time={escalatedEvent?.occurredAt ?? flagCase.escalatedAt}
              actor={
                escalatedEvent
                  ? actorLabel(escalatedEvent)
                  : actorSummary(
                      flagCase.escalatedByDisplayName,
                      null,
                      flagCase.escalatedByDiscordUserId
                    )
              }
              action={
                escalatedEvent
                  ? formatEventLabel(escalatedEvent.eventType)
                  : "Case escalated"
              }
              reason={escalatedEvent?.reason ?? flagCase.escalationReason}
              comment={escalatedEvent?.comment ?? null}
            />
          ) : null}
          {finalEvent || flagCase.reviewedAt ? (
            <LifecycleCard
              label="Final Decision"
              time={finalEvent?.occurredAt ?? flagCase.reviewedAt}
              actor={
                finalEvent
                  ? actorLabel(finalEvent)
                  : actorSummary(
                      flagCase.reviewedByDisplayName,
                      null,
                      flagCase.reviewedByDiscordUserId
                    )
              }
              action={
                finalEvent
                  ? formatEventLabel(finalEvent.eventType)
                  : formatStatus(flagCase.status)
              }
              reason={finalEvent?.reason ?? flagCase.reviewReason}
              comment={finalEvent?.comment ?? null}
            />
          ) : null}
        </div>
      </section>

      {canView ? (
        <section aria-labelledby="case-history-heading">
          <h2 id="case-history-heading" className="text-xl font-semibold">
            Case History
          </h2>
          <ol className="mt-4 space-y-4">
            {flagCase.events.map((event) => (
              <li
                data-flag-history-event
                key={event.eventId}
                className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <strong>{formatEventLabel(event.eventType)}</strong>
                  <span className="rounded-full border border-white/15 px-2.5 py-1 text-xs text-white/75">
                    {event.previousStatus
                      ? `${formatStatus(event.previousStatus)} → ${formatStatus(event.newStatus)}`
                      : formatStatus(event.newStatus)}
                  </span>
                </div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-white/50">Time</dt>
                    <dd className="mt-1">{formatTime(event.occurredAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-white/50">Recorded</dt>
                    <dd className="mt-1">{formatTime(event.recordedAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-white/50">Actor</dt>
                    <dd className="mt-1">{actorLabel(event)}</dd>
                  </div>
                  <div>
                    <dt className="text-white/50">Case version</dt>
                    <dd className="mt-1">{event.caseVersion}</dd>
                  </div>
                  {event.reason ? (
                    <div>
                      <dt className="text-white/50">Reason</dt>
                      <dd className="mt-1 break-words">{event.reason}</dd>
                    </div>
                  ) : null}
                  {event.comment ? (
                    <div>
                      <dt className="text-white/50">Comment</dt>
                      <dd className="mt-1 break-words">{event.comment}</dd>
                    </div>
                  ) : null}
                </dl>
                <details className="mt-4 rounded-lg border border-white/10 p-3 text-sm">
                  <summary className="cursor-pointer font-medium">
                    Actor snapshot details
                  </summary>
                  <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <dt className="text-white/50">Account ID</dt>
                      <dd className="mt-1 break-all">
                        {event.actorAccountId ?? "Unavailable"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-white/50">Discord ID</dt>
                      <dd className="mt-1 break-all">
                        {event.actorDiscordUserId ?? "Unavailable"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-white/50">Username snapshot</dt>
                      <dd className="mt-1 break-words">
                        {event.actorUsername ?? "Unavailable"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-white/50">Display name snapshot</dt>
                      <dd className="mt-1 break-words">
                        {event.actorDisplayName ?? "Unavailable"}
                      </dd>
                    </div>
                  </dl>
                </details>
              </li>
            ))}
          </ol>
        </section>
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
    </main>
  );
}

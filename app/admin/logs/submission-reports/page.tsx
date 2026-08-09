export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  encodeSubmissionReportModerationCursor,
  parseSubmissionReportModerationCursor,
} from "@/lib/reports/submissionReportModerationCursor";
import { loadSubmissionReportModerationEvents } from "@/lib/reports/submissionReportTeam.server";

function text(value: unknown, fallback = "-") {
  return typeof value === "string" && value ? value : fallback;
}

function number(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function date(value: unknown) {
  return typeof value === "string"
    ? new Date(value).toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      })
    : "-";
}

export default async function SubmissionReportModerationLogPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor: rawCursor } = await searchParams;
  const cursor = parseSubmissionReportModerationCursor(rawCursor);
  let result: Awaited<ReturnType<typeof loadSubmissionReportModerationEvents>>;
  try {
    result = await loadSubmissionReportModerationEvents(cursor);
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }

  const canOpen = (event: Record<string, unknown>) =>
    (event.caseArea === "live" && result.canViewLive) ||
    (event.caseArea === "finalized" && result.canViewFinalized);

  return (
    <div className="space-y-6 text-white">
      <header className="rounded-2xl border border-white/10 bg-black/40 p-6">
        <h1 className="text-3xl font-semibold">Submission Report Workflow Log</h1>
        <p className="mt-2 max-w-3xl text-sm text-white/60">
          Append-only Case claim, release, reassignment, recovery, and outcome
          events. Delegated viewers receive no stable actor IDs or free-text notes.
        </p>
      </header>

      {result.events.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-black/40 p-6 text-sm text-white/60">
          No workflow events are available.
        </div>
      ) : (
        <ol className="space-y-3">
          {result.events.map((event) => (
            <li
              key={text(event.eventId)}
              className="rounded-xl border border-white/10 bg-black/40 p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-orange-200">
                    {text(event.eventType)}
                  </div>
                  <div className="mt-1 text-xs text-white/50">
                    {date(event.occurredAt)} UTC · Case version {number(event.caseVersion)}
                  </div>
                </div>
                {canOpen(event) ? (
                  <Link
                    href={`/admin/reports/${text(event.caseId)}`}
                    className="text-sm text-orange-300 underline underline-offset-4"
                  >
                    Open Case
                  </Link>
                ) : null}
              </div>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <dt className="text-white/40">Submission</dt>
                  <dd className="mt-1">#{number(event.submissionId)}</dd>
                </div>
                <div>
                  <dt className="text-white/40">State</dt>
                  <dd className="mt-1">
                    {text(event.previousStatus)} → {text(event.newStatus)}
                  </dd>
                </div>
                <div>
                  <dt className="text-white/40">Actor</dt>
                  <dd className="mt-1">
                    {text(event.actorDisplayName)} · {text(event.actorRoleKey)}
                  </dd>
                </div>
              </dl>
              {event.previousAssigneeDisplayName || event.newAssigneeDisplayName ? (
                <p className="mt-3 text-sm text-white/65">
                  Assignment: {text(event.previousAssigneeDisplayName, "unassigned")} → {text(event.newAssigneeDisplayName, "unassigned")}
                </p>
              ) : null}
              {event.disposition ? (
                <p className="mt-3 text-sm text-emerald-200">
                  Outcome: {text(event.disposition)}
                </p>
              ) : null}
              {event.note ? (
                <p className="mt-3 whitespace-pre-wrap rounded-lg bg-white/[0.04] p-3 text-sm text-white/70">
                  {text(event.note)}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {result.nextCursor?.occurredAt && result.nextCursor.eventId ? (
        <Link
          href={`/admin/logs/submission-reports?cursor=${encodeURIComponent(
            encodeSubmissionReportModerationCursor(result.nextCursor)
          )}`}
          className="inline-flex rounded-full border border-white/20 px-4 py-2 text-sm text-white/80"
        >
          Older events
        </Link>
      ) : null}
    </div>
  );
}

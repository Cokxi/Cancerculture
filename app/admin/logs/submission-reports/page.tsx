export const dynamic = "force-dynamic";

import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  encodeSubmissionReportModerationCursor,
  parseSubmissionReportModerationCursor,
} from "@/lib/reports/submissionReportModerationCursor";
import {
  getSubmissionReportOutcomeHistoryLabel,
  parseSubmissionReportOutcomeHistoryFilter,
  SUBMISSION_REPORT_OUTCOME_HISTORY_FILTERS,
} from "@/lib/reports/submissionReportOutcomeHistory";
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
  searchParams: Promise<{ cursor?: string; outcome?: string }>;
}) {
  const { cursor: rawCursor, outcome: rawOutcome } = await searchParams;
  const cursor = parseSubmissionReportModerationCursor(rawCursor);
  const outcomeFilter = parseSubmissionReportOutcomeHistoryFilter(rawOutcome);
  let result: Awaited<ReturnType<typeof loadSubmissionReportModerationEvents>>;
  try {
    result = await loadSubmissionReportModerationEvents(cursor, outcomeFilter);
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }

  return (
    <div className="space-y-6 text-white">
      <header className="rounded-2xl border border-white/10 bg-black/40 p-6">
        <h1 className="text-3xl font-semibold">
          Submission Report Outcome History
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-white/60">
          Append-only Case outcomes and Report-caused reopenings. Claim and
          release mechanics remain in the protected audit record but are not
          part of this normal outcome view. Delegated viewers receive no stable
          actor IDs or free-text notes.
        </p>
      </header>

      <nav aria-label="Filter outcome history" className="flex flex-wrap gap-2">
        {SUBMISSION_REPORT_OUTCOME_HISTORY_FILTERS.map((option) => {
          const selected = option.value === outcomeFilter;
          const href = option.value
            ? `/admin/logs/submission-reports?outcome=${encodeURIComponent(option.value)}`
            : "/admin/logs/submission-reports";
          return (
            <Link
              key={option.value ?? "all"}
              href={href}
              aria-current={selected ? "page" : undefined}
              className={`cursor-pointer rounded-full border px-4 py-2 text-sm transition ${
                selected
                  ? "border-orange-300 bg-orange-500/20 text-orange-100"
                  : "border-white/15 text-white/65 hover:border-orange-300/50 hover:text-white"
              }`}
            >
              {option.label}
            </Link>
          );
        })}
      </nav>

      {result.events.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-black/40 p-6 text-sm text-white/60">
          No outcomes match this filter.
        </div>
      ) : (
        <ol className="space-y-3">
          {result.events.map((event) => (
            <li
              key={text(event.eventId)}
              className="grid gap-5 rounded-xl border border-white/10 bg-black/40 p-5 sm:grid-cols-[160px_minmax(0,1fr)]"
            >
              {typeof event.thumbnailUrl === "string" ? (
                <Image
                  src={event.thumbnailUrl}
                  alt={`Current public preview of submission #${number(event.submissionId)}`}
                  width={400}
                  height={240}
                  unoptimized
                  className="h-36 w-full rounded-xl border border-white/15 object-cover"
                />
              ) : (
                <div className="flex h-36 items-center justify-center rounded-xl border border-white/10 bg-white/[0.02] px-3 text-center text-xs text-white/40">
                  Current public preview unavailable
                </div>
              )}

              <div className="min-w-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="font-semibold text-emerald-200">
                    {getSubmissionReportOutcomeHistoryLabel(event.outcomeCode)}
                  </div>
                  <div className="mt-1 text-xs text-white/50">
                    {date(event.occurredAt)} UTC · Case version {number(event.caseVersion)}
                  </div>
                </div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <dt className="text-white/40">Submission</dt>
                    <dd className="mt-1">#{number(event.submissionId)}</dd>
                  </div>
                  <div>
                    <dt className="text-white/40">Cycle</dt>
                    <dd className="mt-1">#{number(event.cycleId)}</dd>
                  </div>
                  {event.actorDisplayName || event.actorRoleKey ? (
                    <div>
                      <dt className="text-white/40">Reviewed by</dt>
                      <dd className="mt-1">
                        {text(event.actorDisplayName)} · {text(event.actorRoleKey)}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {event.note ? (
                  <p className="mt-3 whitespace-pre-wrap rounded-lg bg-white/[0.04] p-3 text-sm text-white/70">
                    {text(event.note)}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}

      {result.nextCursor?.occurredAt && result.nextCursor.eventId ? (
        <Link
          href={`/admin/logs/submission-reports?${new URLSearchParams({
            cursor: encodeSubmissionReportModerationCursor(result.nextCursor),
            ...(outcomeFilter ? { outcome: outcomeFilter } : {}),
          }).toString()}`}
          className="inline-flex cursor-pointer rounded-full border border-white/20 px-4 py-2 text-sm text-white/80"
        >
          Older outcomes
        </Link>
      ) : null}
    </div>
  );
}

export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import BackButton from "@/app/components/ui/BackButton";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import { SUBMISSION_REPORT_REASON_LABELS, type SubmissionReportReason } from "@/lib/reports/submissionReportContract";
import { loadSubmissionReportCase } from "@/lib/reports/submissionReportTeam.server";
import SubmissionReportReviewActions from "./SubmissionReportReviewActions";

type Item = Record<string, unknown>;
function text(value: unknown, fallback = "-") { return typeof value === "string" && value ? value : fallback; }
function number(value: unknown) { return typeof value === "number" ? value : Number(value); }
function items(value: unknown): Item[] { return Array.isArray(value) ? value.filter((item): item is Item => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }
function date(value: unknown) { return typeof value === "string" ? new Date(value).toLocaleString("en-GB", { timeZone: "UTC" }) : "-"; }
function reasonLabel(value: unknown) { const key = text(value, "") as SubmissionReportReason; return SUBMISSION_REPORT_REASON_LABELS[key] ?? text(value); }

export default async function SubmissionReportCasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  let result: Awaited<ReturnType<typeof loadSubmissionReportCase>>;
  try {
    result = await loadSubmissionReportCase(caseId);
  } catch (error) {
    if (getAuthErrorStatus(error) === 404) notFound();
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }
  const reportCase = result.case;
  const reports = items(reportCase.reports);
  const events = items(reportCase.events);
  const status = text(reportCase.status) as "open" | "in_review" | "closed";
  const latestReportId = text(reportCase.latestReportId, "");
  const unseen = text(reportCase.acknowledgedReportId, "") !== latestReportId;

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6 text-white">
      <BackButton href="/admin/reports" label="Submission Reports" />
      <header className="rounded-xl border border-white/10 bg-black/40 p-6">
        <div className="flex flex-wrap gap-2 text-xs uppercase tracking-wide text-white/70"><span>{status}</span><span>·</span><span>{unseen ? "new reports" : "seen through latest"}</span></div>
        <h1 className="mt-3 text-3xl font-semibold">Submission #{number(reportCase.submissionId)}</h1>
        <p className="mt-2 text-sm text-white/60">Cycle #{number(reportCase.cycleId)} · {number(reportCase.reportCount)} reports · row version {number(reportCase.rowVersion)}</p>
      </header>

      {result.canReview && status !== "closed" ? (
        <SubmissionReportReviewActions
          caseId={caseId}
          latestReportId={latestReportId}
          rowVersion={number(reportCase.rowVersion)}
          status={status}
          unseen={unseen}
        />
      ) : null}

      {status === "closed" ? (
        <section className="rounded-xl border border-emerald-300/20 bg-emerald-500/[0.06] p-5">
          <h2 className="text-xl font-semibold">Completed review</h2>
          <p className="mt-2 text-sm">{text(reportCase.closeDisposition)} · {date(reportCase.closedAt)} UTC</p>
          <p className="mt-3 whitespace-pre-wrap text-sm text-white/70">{text(reportCase.closeNote)}</p>
        </section>
      ) : null}

      <section>
        <h2 className="text-xl font-semibold">Reports</h2>
        <div className="mt-3 space-y-3">
          {reports.map((report) => (
            <article key={text(report.reportId)} className="rounded-xl border border-white/10 bg-black/40 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><div className="font-semibold text-orange-200">{reasonLabel(report.reasonCode)}</div><div className="mt-1 text-xs text-white/55">{text(report.phaseSnapshot)} · {date(report.createdAt)} UTC</div></div>
                {typeof report.reporterPublicProfileId === "string" ? <Link href={`/admin/reports/users/${report.reporterPublicProfileId}`} className="cursor-pointer text-sm text-orange-300 underline">{text(report.reporterLabel, "Reporter")}</Link> : <span className="text-sm text-white/50">Anonymous reporter</span>}
              </div>
              {report.subcategoryCode ? <p className="mt-3 text-sm text-white/70">Detail: {text(report.subcategoryCode)}</p> : null}
              {report.comment ? <p className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-white/[0.04] p-3 text-sm text-white/80">{text(report.comment)}</p> : null}
              <p className="mt-3 text-xs text-white/40">Visibility snapshot: {text(report.visibilitySnapshot)}{report.contentSha256 ? " · evidence fingerprint retained" : ""}</p>
            </article>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-xl font-semibold">Append-only case history</h2>
        <ol className="mt-3 space-y-2">
          {events.map((event) => <li key={text(event.eventId)} className="rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm"><div className="font-medium">{text(event.eventType)}</div><div className="mt-1 text-xs text-white/55">{date(event.occurredAt)} UTC · version {number(event.caseVersion)}{event.actorDisplayName ? ` · ${text(event.actorDisplayName)}` : ""}</div>{event.note ? <p className="mt-2 whitespace-pre-wrap text-white/70">{text(event.note)}</p> : null}</li>)}
        </ol>
      </section>
    </main>
  );
}

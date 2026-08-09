export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import BackButton from "@/app/components/ui/BackButton";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import { SUBMISSION_REPORT_REASON_LABELS, type SubmissionReportReason } from "@/lib/reports/submissionReportContract";
import { loadSubmissionReporterHistory } from "@/lib/reports/submissionReportTeam.server";

type Item = Record<string, unknown>;
function text(value: unknown, fallback = "-") { return typeof value === "string" && value ? value : fallback; }
function items(value: unknown): Item[] { return Array.isArray(value) ? value.filter((item): item is Item => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }
function reason(value: unknown) { const key = text(value, "") as SubmissionReportReason; return SUBMISSION_REPORT_REASON_LABELS[key] ?? text(value); }

export default async function SubmissionReporterHistoryPage({ params }: { params: Promise<{ publicProfileId: string }> }) {
  const { publicProfileId } = await params;
  let history: Awaited<ReturnType<typeof loadSubmissionReporterHistory>>;
  try { history = await loadSubmissionReporterHistory(publicProfileId); }
  catch (error) { if (getAuthErrorStatus(error) === 404) notFound(); const destination = getTeamPageAccessRedirect(error); if (destination) redirect(destination); throw error; }
  const reports = items(history.reports);
  const current = reports.filter((report) => report.phaseSnapshot !== "history");
  const archived = reports.filter((report) => report.phaseSnapshot === "history");
  const group = (title: string, entries: Item[]) => (
    <section><h2 className="text-xl font-semibold">{title}</h2>{entries.length === 0 ? <p className="mt-3 text-sm text-white/50">No reports in this group.</p> : <div className="mt-3 space-y-3">{entries.map((report) => <article key={text(report.reportId)} className="rounded-xl border border-white/10 bg-black/40 p-5"><div className="flex flex-wrap justify-between gap-3"><div><div className="font-semibold text-orange-200">{reason(report.reasonCode)}</div><div className="mt-1 text-xs text-white/55">Cycle #{String(report.cycleId)} · {text(report.phaseSnapshot)} · {text(report.createdAt)}</div></div><Link href={`/admin/reports/${text(report.caseId)}`} className="cursor-pointer text-sm text-orange-300 underline">Open case</Link></div>{report.comment ? <p className="mt-3 whitespace-pre-wrap rounded-lg bg-white/[0.04] p-3 text-sm text-white/75">{text(report.comment)}</p> : null}<p className="mt-3 text-xs text-white/45">Case: {text(report.caseStatus)}{report.closeDisposition ? ` · ${text(report.closeDisposition)}` : ""}</p></article>)}</div>}</section>
  );
  return <main className="mx-auto max-w-5xl space-y-8 p-6 text-white"><BackButton href="/admin/reports/users" label="Reporter User Logs" /><header className="rounded-xl border border-white/10 bg-black/40 p-6"><h1 className="text-3xl font-semibold">Reporter history</h1><p className="mt-2 text-orange-200">{text(history.label, "Reporter")}</p><p className="mt-3 text-sm text-white/60">{String(history.reportCount)} reports · {String(history.actionTakenCaseCount)} in cases closed with action. An action count is case context, not proof that one report caused the action and not an automatic score or sanction.</p></header>{group("Current and pre-finalization cycles", current)}{group("Cycle History", archived)}</main>;
}

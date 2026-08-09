export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import { loadSubmissionReportQueue } from "@/lib/reports/submissionReportTeam.server";
import { getSubmissionDestinationHref } from "@/lib/submissions/getSubmissionDestinationHref";

function text(value: unknown, fallback = "-") {
  return typeof value === "string" && value ? value : fallback;
}
function number(value: unknown) {
  return typeof value === "number" ? value : Number(value);
}
function date(value: unknown) {
  return typeof value === "string" ? new Date(value).toLocaleString("en-GB", { timeZone: "UTC" }) : "-";
}

export default async function SubmissionReportQueuePage() {
  let result: Awaited<ReturnType<typeof loadSubmissionReportQueue>>;
  try {
    result = await loadSubmissionReportQueue();
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }

  return (
    <main className="space-y-6 p-6 text-white">
      <header>
        <h1 className="text-3xl font-semibold">Submission Reports</h1>
        <p className="mt-2 max-w-3xl text-sm text-white/60">Case-centered queue. Unseen state, review state, and future viewer-specific unread state are deliberately separate.</p>
        <Link href="/admin/reports/users" className="mt-3 inline-flex cursor-pointer text-sm text-orange-300 underline underline-offset-4">Reporter-centered User Logs</Link>
      </header>

      {result.cases.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-black/40 p-6 text-sm text-white/60">No Submission Report cases are available.</div>
      ) : (
        <div className="space-y-3">
          {result.cases.map((item) => {
            const caseId = text(item.caseId, "");
            const submissionId = number(item.submissionId);
            const cycleId = number(item.cycleId);
            const currentStatus = text(item.currentCycleStatus, "");
            const destination = item.currentAvailable === true
              ? getSubmissionDestinationHref({
                  cycleId,
                  cycleStatus: currentStatus,
                  isDisqualified: item.currentDisqualified === true,
                  publicVisibilityStatus: text(item.currentVisibility, ""),
                  submissionId,
                })
              : null;
            return (
              <article key={caseId} className="rounded-xl border border-white/10 bg-black/40 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap gap-2 text-xs uppercase tracking-wide">
                      <span className={`rounded-full px-2 py-1 ${item.unseen === true ? "bg-orange-500/20 text-orange-200" : "bg-white/10 text-white/60"}`}>{item.unseen === true ? "New reports" : "Seen through latest"}</span>
                      <span className="rounded-full bg-white/10 px-2 py-1 text-white/70">{text(item.priority)}</span>
                      <span className="rounded-full bg-white/10 px-2 py-1 text-white/70">{text(item.status)}</span>
                    </div>
                    <h2 className="mt-3 text-lg font-semibold">Submission #{submissionId} · Cycle #{cycleId}</h2>
                    <p className="mt-1 text-sm text-white/60">{number(item.reportCount)} reports · latest {date(item.latestReportAt)} UTC</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {destination ? <Link href={destination} className="cursor-pointer rounded-full border border-white/20 px-3 py-2 text-xs">Open submission</Link> : null}
                    <Link href={`/admin/reports/${caseId}`} className="cursor-pointer rounded-full bg-orange-500 px-4 py-2 text-sm font-semibold">Open case</Link>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}

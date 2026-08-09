import Link from "next/link";
import { redirect } from "next/navigation";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  loadSubmissionReportQueue,
  type SubmissionReportArea,
} from "@/lib/reports/submissionReportTeam.server";
import SubmissionReportQueueClient from "./SubmissionReportQueueClient";

export default async function SubmissionReportAreaPage({
  area,
  initialCaseId,
}: {
  area: SubmissionReportArea;
  initialCaseId?: string;
}) {
  let result: Awaited<ReturnType<typeof loadSubmissionReportQueue>>;
  try {
    result = await loadSubmissionReportQueue(area);
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }

  const live = area === "live";
  return (
    <div className="space-y-6 text-white">
      <header className="rounded-2xl border border-white/10 bg-black/40 p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-300">
          Submission Reports
        </p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold">
              {live ? "Live Cycle Reports" : "Finalized Cycle Reports"}
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-white/60">
              Cases group all Reports for one Submission. A red count represents
              individual Reports you have not opened yet; opening a Case alone does
              not mark them read.
            </p>
          </div>
          <nav aria-label="Submission Report areas" className="flex gap-2">
            {result.canViewLive ? <Link
              href="/admin/reports/live"
              aria-current={live ? "page" : undefined}
              className={`rounded-full px-4 py-2 text-sm ${
                live ? "bg-orange-500 font-semibold" : "border border-white/15 text-white/70"
              }`}
            >
              Live
            </Link> : null}
            {result.canViewFinalized ? <Link
              href="/admin/reports/finalized"
              aria-current={!live ? "page" : undefined}
              className={`rounded-full px-4 py-2 text-sm ${
                !live ? "bg-orange-500 font-semibold" : "border border-white/15 text-white/70"
              }`}
            >
              Finalized
            </Link> : null}
          </nav>
        </div>
      </header>

      <SubmissionReportQueueClient
        area={area}
        initialCases={result.cases}
        canReview={result.canReview}
        canOverrideRelease={result.canOverrideRelease}
        initialCaseId={initialCaseId}
      />
    </div>
  );
}

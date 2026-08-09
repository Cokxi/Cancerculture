export const dynamic = "force-dynamic";

import { notFound, redirect } from "next/navigation";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import { loadSubmissionReportCaseSummary } from "@/lib/reports/submissionReportTeam.server";

export default async function SubmissionReportCaseRedirectPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  try {
    const result = await loadSubmissionReportCaseSummary(caseId);
    const area = result.case.area === "live" ? "live" : "finalized";
    redirect(`/admin/reports/${area}?case=${encodeURIComponent(caseId)}`);
  } catch (error) {
    if (getAuthErrorStatus(error) === 404) notFound();
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }
}

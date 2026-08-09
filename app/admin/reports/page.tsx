export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import { loadSubmissionReportLandingArea } from "@/lib/reports/submissionReportTeam.server";

export default async function SubmissionReportLandingPage() {
  try {
    redirect(`/admin/reports/${await loadSubmissionReportLandingArea()}`);
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }
}

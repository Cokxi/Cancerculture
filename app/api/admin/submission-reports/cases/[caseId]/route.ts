export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getAuthErrorCode, getAuthErrorStatus } from "@/lib/auth/AuthError";
import { loadSubmissionReportCaseSummary } from "@/lib/reports/submissionReportTeam.server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  try {
    const { caseId } = await params;
    return NextResponse.json(await loadSubmissionReportCaseSummary(caseId));
  } catch (error) {
    return NextResponse.json(
      { error: getAuthErrorCode(error) ?? "REPORT_CASE_FAILED" },
      { status: getAuthErrorStatus(error) ?? 500 }
    );
  }
}

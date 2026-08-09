export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getAuthErrorCode, getAuthErrorStatus } from "@/lib/auth/AuthError";
import { loadSubmissionReportDetail } from "@/lib/reports/submissionReportTeam.server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ reportId: string }> }
) {
  try {
    const { reportId } = await params;
    return NextResponse.json(await loadSubmissionReportDetail(reportId));
  } catch (error) {
    return NextResponse.json(
      { error: getAuthErrorCode(error) ?? "REPORT_DETAIL_FAILED" },
      { status: getAuthErrorStatus(error) ?? 500 }
    );
  }
}

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import {
  getSubmissionReportEligibility,
  submissionReportErrorResponse,
} from "@/lib/reports/submissionReportRpc.server";

export async function GET(request: Request) {
  try {
    const session = await requireSession();
    const submissionId = Number(new URL(request.url).searchParams.get("submissionId"));
    if (!Number.isSafeInteger(submissionId) || submissionId < 1) {
      return NextResponse.json(
        { error: "INVALID_SUBMISSION_ID" },
        { status: 400 }
      );
    }

    return NextResponse.json(
      await getSubmissionReportEligibility({
        discordUserId: session.discord_user_id,
        submissionId,
      }),
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const response = submissionReportErrorResponse(error);
    return NextResponse.json(
      { error: response.code },
      { status: response.status }
    );
  }
}

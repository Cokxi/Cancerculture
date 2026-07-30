export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireSubmissionModerator } from "@/lib/auth/guards";
import { setSubmissionDisqualification } from "@/lib/moderation/setSubmissionDisqualification";
import { NextResponse } from "next/server";

function getErrorResponse(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Forbidden";
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : 403;

  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  try {
    const actor = await requireSubmissionModerator();

    const {
      submissionId,
      disqualificationType,
      reasonCode,
      reasonText,
    } = await req.json();

    if (!submissionId || !reasonCode) {
      return NextResponse.json(
        { error: "Invalid payload" },
        { status: 400 }
      );
    }

    await setSubmissionDisqualification({
      actor,
      submissionId,
      mode: "disqualify",
      disqualificationType,
      reasonCode,
      reasonText,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return getErrorResponse(error);
  }
}

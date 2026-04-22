export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireModOrAdmin } from "@/lib/auth/guards";
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
    const actor = await requireModOrAdmin();
    const { submissionId } = await req.json();

    if (!submissionId) {
      return NextResponse.json(
        { error: "submissionId required" },
        { status: 400 }
      );
    }

    await setSubmissionDisqualification({
      actor,
      submissionId,
      mode: "reinstate",
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return getErrorResponse(error);
  }
}

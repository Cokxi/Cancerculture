export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireModOrAdmin } from "@/lib/auth/guards";
import { setSubmissionPublicVisibility } from "@/lib/moderation/setSubmissionPublicVisibility";
import {
  SUBMISSION_PUBLIC_VISIBILITY,
  type SubmissionPublicVisibilityStatus,
} from "@/lib/moderation/submissionPublicVisibility";

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

function isAllowedStatus(
  status: unknown
): status is SubmissionPublicVisibilityStatus {
  return (
    status === SUBMISSION_PUBLIC_VISIBILITY.visible ||
    status === SUBMISSION_PUBLIC_VISIBILITY.legalReview ||
    status === SUBMISSION_PUBLIC_VISIBILITY.removed
  );
}

export async function POST(req: Request) {
  try {
    const actor = await requireModOrAdmin();
    const {
      submissionId,
      status,
      reasonCode,
      reasonText,
    } = await req.json();

    if (!submissionId || !isAllowedStatus(status)) {
      return NextResponse.json(
        { error: "Invalid payload" },
        { status: 400 }
      );
    }

    if (
      status !== SUBMISSION_PUBLIC_VISIBILITY.visible &&
      !reasonCode
    ) {
      return NextResponse.json(
        { error: "Reason required" },
        { status: 400 }
      );
    }

    if (
      actor.role === "mod" &&
      status !== SUBMISSION_PUBLIC_VISIBILITY.legalReview
    ) {
      return NextResponse.json(
        { error: "Mods can only mark legal review" },
        { status: 403 }
      );
    }

    await setSubmissionPublicVisibility({
      actor,
      submissionId,
      status,
      reasonCode,
      reasonText,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return getErrorResponse(error);
  }
}

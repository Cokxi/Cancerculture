export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getAdminApiErrorResponse } from "@/lib/auth/adminApiErrorResponse";
import { requireAdmin } from "@/lib/auth/guards";
import { republishDiscordBanSubmission } from "@/lib/moderation/republishDiscordBanSubmission";

function revalidatePublicSubmissionSurfaces() {
  revalidatePath("/");
  revalidatePath("/submissions");
  revalidatePath("/admin/moderation/legal-review");
  revalidatePath("/cycle-history");
  revalidatePath("/profile/[publicProfileId]", "page");
  revalidatePath("/wall/fame");
  revalidatePath("/wall/shame");
}

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const body = await req.json();
    const submissionId = Number(body?.submissionId);
    const reason =
      typeof body?.reason === "string" ? body.reason.trim() : "";
    const manualReviewConfirmed =
      body?.manualReviewConfirmed === true;

    if (!Number.isInteger(submissionId) || submissionId <= 0) {
      return NextResponse.json(
        { error: "INVALID_SUBMISSION_ID" },
        { status: 400 }
      );
    }

    if (reason.length < 10 || reason.length > 1000) {
      return NextResponse.json(
        { error: "REPUBLISH_REASON_REQUIRED" },
        { status: 400 }
      );
    }

    if (!manualReviewConfirmed) {
      return NextResponse.json(
        { error: "MANUAL_REVIEW_CONFIRMATION_REQUIRED" },
        { status: 400 }
      );
    }

    const result = await republishDiscordBanSubmission({
      actorDiscordUserId: admin.discord_user_id,
      manualReviewConfirmed,
      reason,
      submissionId,
    });

    revalidatePublicSubmissionSurfaces();

    return NextResponse.json({
      success: true,
      outcome: result.outcome,
      competitionDisqualified: result.competitionDisqualified,
    });
  } catch (error) {
    return getAdminApiErrorResponse(
      error,
      "Discord-ban Submission republish"
    );
  }
}

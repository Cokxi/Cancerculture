export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireModOrAdmin } from "@/lib/auth/guards";
import { logModerationAction } from "@/lib/logging/logModerationAction";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

export async function POST(req: Request) {
  try {
    const actor = await requireModOrAdmin();

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

    const { data: submission } = await supabaseAdmin
      .from("submissions")
      .select("id, cycle_id, r2_key, discord_user_id")
      .eq("id", submissionId)
      .single();

    if (!submission) {
      return NextResponse.json(
        { error: "Submission not found" },
        { status: 404 }
      );
    }

    await supabaseAdmin
      .from("submissions")
      .update({
        is_disqualified: true,
        disqualification_type: disqualificationType,
        disqualification_reason_code: reasonCode,
        disqualification_reason_text: reasonText ?? null,
      })
      .eq("id", submissionId);

    await logModerationAction({
      actorRole: actor.role,
      actorId: actor.discord_user_id,
      action: "disqualify_submission",
      targetType: "submission",
      targetId: submissionId,
      cycleId: submission.cycle_id,
      reasonCode,
      reasonText,
      evidence: {
  submission_image_url: getPublicImageUrl(submission.r2_key),
},
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message ?? "Forbidden" },
      { status: err.status ?? 403 }
    );
  }
}

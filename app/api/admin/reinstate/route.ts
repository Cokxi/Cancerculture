export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireModOrAdmin } from "@/lib/auth/guards";
import { logModerationAction } from "@/lib/logging/logModerationAction";


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
        is_disqualified: false,
        disqualification_type: null,
        disqualification_reason_code: null,
        disqualification_reason_text: null,
      })
      .eq("id", submissionId);

    await logModerationAction({
      actorRole: actor.role,
      actorId: actor.discord_user_id,
      action: "reinstate_submission",
      targetType: "submission",
      targetId: submissionId,
      cycleId: submission.cycle_id,
      reasonCode: "manual_review",
      evidence: {
  r2_key: submission.r2_key,
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

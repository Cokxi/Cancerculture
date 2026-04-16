export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireModOrAdmin } from "@/lib/auth/guards";
import { logModerationAction } from "@/lib/logging/logModerationAction";


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
      .select("*")
      .eq("id", submissionId)
      .single();

console.log("SUBMISSION:", submission);

    if (!submission) {
      return NextResponse.json(
        { error: "Submission not found" },
        { status: 404 }
      );
    }

    const { data: actorLog } = await supabaseAdmin
  .from("user_logs")
  .select("current_discord_username")
  .eq("discord_user_id", actor.discord_user_id)
  .maybeSingle();

const actorUsername =
  actorLog?.current_discord_username ?? null;

    await supabaseAdmin
      .from("submissions")
      .update({
        is_disqualified: true,
        disqualification_type: disqualificationType,
        disqualification_reason_code: reasonCode,
        disqualification_reason_text: reasonText ?? null,
        disqualified_at: new Date().toISOString(),
        disqualified_by_discord_user_id: actor.discord_user_id,
        disqualified_by_discord_username: actorUsername,
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
  r2_key: submission.r2_key ?? null,
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

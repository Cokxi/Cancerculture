export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";

export async function GET(
  _req: Request,
  context: {
    params: Promise<{ submissionId: string }>;
  }
) {
  try {
    await requireAdmin();

    const { submissionId: submissionIdRaw } =
      await context.params;
    const submissionId = Number(submissionIdRaw);

    if (!Number.isInteger(submissionId)) {
      return NextResponse.json(
        { error: "Invalid submission id" },
        { status: 400 }
      );
    }

    const { data: submission, error: submissionError } =
      await supabaseAdmin
        .from("submissions")
        .select(
          `
            id,
            cycle_id,
            discord_user_id,
            discord_username_at_upload,
            r2_key,
            created_at,
            is_disqualified,
            disqualification_type,
            disqualification_reason_code,
            disqualification_reason_text,
            disqualified_at,
            disqualified_by_discord_user_id,
            disqualified_by_discord_username,
            public_visibility_status,
            public_visibility_reason_code,
            public_visibility_reason_text,
            public_visibility_updated_at,
            public_visibility_updated_by_discord_user_id,
            public_visibility_updated_by_discord_username
          `
        )
        .eq("id", submissionId)
        .single();

    if (submissionError || !submission) {
      return NextResponse.json(
        { error: "Submission not found" },
        { status: 404 }
      );
    }

    const [
      submissionPrivateDataResult,
      cycleResultsResult,
      winnerProfileResult,
      moderationLogsResult,
    ] = await Promise.all([
      supabaseAdmin
        .from("submission_private_data")
        .select(
          "submission_id, x_username, wallet_address, payout_choice, split_percent, charity, created_at"
        )
        .eq("submission_id", submissionId)
        .maybeSingle(),
      supabaseAdmin
        .from("cycle_results")
        .select(
          "submission_id, vote_count, is_winner, rank"
        )
        .eq("submission_id", submissionId)
        .maybeSingle(),
      supabaseAdmin
        .from("winner_public_profiles")
        .select("*")
        .eq("submission_id", submissionId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("moderation_action_logs")
        .select("*")
        .eq("target_type", "submission")
        .eq("target_id", String(submissionId))
        .order("created_at", { ascending: true }),
    ]);

    const exportPayload = {
      exported_at: new Date().toISOString(),
      submission,
      submission_private_data:
        submissionPrivateDataResult.data ?? null,
      cycle_result: cycleResultsResult.data ?? null,
      winner_public_profile:
        winnerProfileResult.data ?? null,
      moderation_action_logs:
        moderationLogsResult.data ?? [],
    };

    const filename = `submission-${submissionId}-audit.json`;

    return new NextResponse(
      JSON.stringify(exportPayload, null, 2),
      {
        status: 200,
        headers: {
          "Content-Type":
            "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}

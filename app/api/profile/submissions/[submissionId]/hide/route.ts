export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { supabaseAdmin } from "@/lib/db/admin";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";

export async function POST(
  _req: Request,
  context: {
    params: Promise<{ submissionId: string }>;
  }
) {
  try {
    const { discord_user_id: discordUserId } =
      await requireSession();
    const { submissionId: submissionIdRaw } =
      await context.params;
    const submissionId = Number(submissionIdRaw);

    if (
      !Number.isInteger(submissionId) ||
      submissionId <= 0
    ) {
      return NextResponse.json(
        { error: "Invalid submission id" },
        { status: 400 }
      );
    }

    const { data: submission, error: submissionError } =
      await supabaseAdmin
        .from("submissions")
        .select("id, cycle_id, discord_user_id, is_disqualified")
        .eq("id", submissionId)
        .maybeSingle();

    if (submissionError || !submission) {
      return NextResponse.json(
        { error: "Submission not found" },
        { status: 404 }
      );
    }

    if (submission.discord_user_id !== discordUserId) {
      return NextResponse.json(
        { error: "Forbidden" },
        { status: 403 }
      );
    }

    if (!submission.is_disqualified) {
      return NextResponse.json(
        {
          error:
            "Only disqualified submissions can be hidden from profile",
        },
        { status: 400 }
      );
    }

    const { data: cycle, error: cycleError } =
      await supabaseAdmin
        .from("voting_cycles")
        .select("id, status")
        .eq("id", submission.cycle_id)
        .maybeSingle();

    if (cycleError || !cycle) {
      return NextResponse.json(
        { error: "Cycle not found" },
        { status: 404 }
      );
    }

    if (cycle.status !== "finished") {
      return NextResponse.json(
        {
          error:
            "Submission can only be hidden after the cycle is finished",
        },
        { status: 400 }
      );
    }

    const { error: updateError } = await supabaseAdmin
      .from("submissions")
      .update({
        hidden_from_profile_at: new Date().toISOString(),
        hidden_from_profile_by_discord_user_id: discordUserId,
      })
      .eq("id", submissionId)
      .eq("discord_user_id", discordUserId);

    if (updateError) {
      return NextResponse.json(
        {
          error:
            "Failed to hide submission from profile. Run supabase/submission_profile_hide.sql first.",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}

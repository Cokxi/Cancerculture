export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireSession } from "@/lib/auth/requireSession";
import { logVote } from "@/lib/logging/logVote";
import { touchUserLog } from "@/lib/logging/touchUserLog";

export async function POST(req: Request) {
  try {
    
    const { discord_user_id: discordUserId } = await requireSession();

    
const { data: userLog } = await supabaseAdmin
  .from("user_logs")
  .select("is_banned")
  .eq("discord_user_id", discordUserId)
  .single();

if (userLog?.is_banned) {
  await logVote({
    cycleId: null,
    discordUserId,
    status: "rejected",
    reason: "banned",
  });

  return NextResponse.json(
    { error: "BANNED" },
    { status: 403 }
  );
}

await touchUserLog({
  discordUserId,
  
});

    
    const formData = await req.formData();
    const submissionIdRaw = formData.get("submissionId");

    if (typeof submissionIdRaw !== "string") {
      return NextResponse.json(
        { error: "Invalid submissionId" },
        { status: 400 }
      );
    }

    const submissionId = Number(submissionIdRaw);

    if (!Number.isInteger(submissionId)) {
      return NextResponse.json(
        { error: "Invalid submissionId" },
        { status: 400 }
      );
    }

    
    const { data: cycle } = await supabaseAdmin
      .from("voting_cycles")
      .select("id")
      .eq("status", "active")
      .single();

    if (!cycle) {
      return NextResponse.json(
        { error: "No active voting cycle" },
        { status: 400 }
      );
    }

    
    const { data: submission } = await supabaseAdmin
      .from("submissions")
      .select("id, discord_user_id")
      .eq("id", submissionId)
      .eq("cycle_id", cycle.id)
      .single();

    if (!submission) {
      return NextResponse.json(
        { error: "Submission not found" },
        { status: 404 }
      );
    }

    
    if (submission.discord_user_id === discordUserId) {
      await logVote({
        cycleId: cycle.id,
        submissionId,
        discordUserId,
        status: "rejected",
        reason: "self_vote",
      });

      return NextResponse.json(
        { error: "You can’t vote for your own submission" },
        { status: 403 }
      );
    }

    
    const { data: existingVote } = await supabaseAdmin
      .from("votes")
      .select("id")
      .eq("cycle_id", cycle.id)
      .eq("discord_user_id", discordUserId)
      .maybeSingle();

    if (existingVote) {
      await logVote({
        cycleId: cycle.id,
        submissionId,
        discordUserId,
        status: "rejected",
        reason: "already_voted",
      });

      return NextResponse.json(
        { error: "You already voted in this cycle" },
        { status: 400 }
      );
    }

    
    const { error: insertError } = await supabaseAdmin
      .from("votes")
      .insert({
        cycle_id: cycle.id,
        submission_id: submissionId,
        discord_user_id: discordUserId,
      });

    if (insertError) {
      throw insertError;
    }

    
    await logVote({
      cycleId: cycle.id,
      submissionId,
      discordUserId,
      status: "accepted",
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("VOTE ERROR", error);

    
    if (error instanceof Response) {
      throw error;
    }

    return NextResponse.json(
      { error: "Voting failed" },
      { status: 500 }
    );
  }
}

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { isUniqueViolation } from "@/lib/db/isUniqueViolation";
import { requireSession } from "@/lib/auth/requireSession";
import { logVote } from "@/lib/logging/logVote";
import { touchUserLog } from "@/lib/logging/touchUserLog";
import { getVoteEligibility } from "@/lib/vote/getVoteEligibility";

export async function POST(req: Request) {
  try {
    const { discord_user_id: discordUserId } = await requireSession();
    const voteEligibility = await getVoteEligibility(discordUserId);

    if (voteEligibility.isBanned) {
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

    if (!voteEligibility.activeCycleId) {
      return NextResponse.json(
        { error: "No active voting cycle" },
        { status: 400 }
      );
    }

    
    const { data: submission } = await supabaseAdmin
      .from("submissions")
      .select("id, discord_user_id")
      .eq("id", submissionId)
      .eq("cycle_id", voteEligibility.activeCycleId)
      .single();

    if (!submission) {
      return NextResponse.json(
        { error: "Submission not found" },
        { status: 404 }
      );
    }

    
    if (submission.discord_user_id === discordUserId) {
      await logVote({
        cycleId: voteEligibility.activeCycleId,
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

    if (voteEligibility.hasVoted) {
      await logVote({
        cycleId: voteEligibility.activeCycleId,
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
        cycle_id: voteEligibility.activeCycleId,
        submission_id: submissionId,
        discord_user_id: discordUserId,
      });

    if (insertError) {
      if (isUniqueViolation(insertError)) {
        await logVote({
          cycleId: voteEligibility.activeCycleId,
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

      throw insertError;
    }

    
    await logVote({
      cycleId: voteEligibility.activeCycleId,
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

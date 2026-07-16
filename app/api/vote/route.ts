export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
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

    if (!voteEligibility.membership.isInDiscord) {
      await logVote({
        cycleId: voteEligibility.activeCycleId,
        discordUserId,
        status: "rejected",
        reason: "not_in_discord",
      });

      return NextResponse.json(
        { error: "NOT_IN_DISCORD" },
        { status: 403 }
      );
    }

    if (voteEligibility.membership.joinedTooRecently) {
      await logVote({
        cycleId: voteEligibility.activeCycleId,
        discordUserId,
        status: "rejected",
        reason: "joined_too_recently",
      });

      return NextResponse.json(
        {
          error: "JOINED_TOO_RECENTLY",
          joinedAt: voteEligibility.membership.joinedAt,
        },
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
        { error: "No active voting phase" },
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
        { error: "You cannot vote for your own submission" },
        { status: 403 }
      );
    }

    const { data: existingSubmissionVote } = await supabaseAdmin
      .from("votes")
      .select("id")
      .eq("cycle_id", voteEligibility.activeCycleId)
      .eq("submission_id", submissionId)
      .eq("discord_user_id", discordUserId)
      .maybeSingle();

    if (existingSubmissionVote) {
      await logVote({
        cycleId: voteEligibility.activeCycleId,
        submissionId,
        discordUserId,
        status: "rejected",
        reason: "already_voted",
      });

      return NextResponse.json(
        { error: "You already voted for this submission" },
        { status: 400 }
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
        { error: "You used all votes for this cycle" },
        { status: 400 }
      );
    }

    
    const { data: voteResult, error: voteError } =
      await supabaseAdmin.rpc("cast_cycle_vote", {
        p_cycle_id: voteEligibility.activeCycleId,
        p_submission_id: submissionId,
        p_discord_user_id: discordUserId,
      });

    if (voteError) {
      const errorMessage = voteError.message ?? "";
      const isSelfVote = errorMessage.includes("SELF_VOTE");
      const isDuplicate = errorMessage.includes(
        "DUPLICATE_SUBMISSION_VOTE"
      );
      const isLimitReached = errorMessage.includes(
        "VOTE_LIMIT_REACHED"
      );
      const isVotingClosed = errorMessage.includes(
        "NO_ACTIVE_VOTING_PHASE"
      );
      const isSubmissionMissing = errorMessage.includes(
        "SUBMISSION_NOT_FOUND"
      );

      if (
        isSelfVote ||
        isDuplicate ||
        isLimitReached ||
        isVotingClosed ||
        isSubmissionMissing
      ) {
        await logVote({
          cycleId: voteEligibility.activeCycleId,
          submissionId,
          discordUserId,
          status: "rejected",
          reason: isSelfVote
            ? "self_vote"
            : isVotingClosed
              ? "voting_closed"
              : isSubmissionMissing
                ? "submission_not_found"
              : "already_voted",
        });

        return NextResponse.json(
          {
            error: isSelfVote
              ? "You cannot vote for your own submission"
              : isDuplicate
                ? "You already voted for this submission"
                : isVotingClosed
                  ? "No active voting phase"
                  : isSubmissionMissing
                    ? "Submission not found"
                  : "You used all votes for this cycle",
          },
          {
            status: isSelfVote
              ? 403
              : isSubmissionMissing
                ? 404
                : 400,
          }
        );
      }

      throw voteError;
    }

    
    await logVote({
      cycleId: voteEligibility.activeCycleId,
      submissionId,
      discordUserId,
      status: "accepted",
    });

    const normalizedResult =
      voteResult && typeof voteResult === "object"
        ? (voteResult as Record<string, unknown>)
        : {};

    return NextResponse.json({
      success: true,
      voteCount:
        typeof normalizedResult.voteCount === "number"
          ? normalizedResult.voteCount
          : voteEligibility.voteCount + 1,
      votesPerUser:
        typeof normalizedResult.votesPerUser === "number"
          ? normalizedResult.votesPerUser
          : voteEligibility.votesPerUser,
      hasVoted:
        typeof normalizedResult.hasVoted === "boolean"
          ? normalizedResult.hasVoted
          : voteEligibility.voteCount + 1 >=
            voteEligibility.votesPerUser,
    });
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

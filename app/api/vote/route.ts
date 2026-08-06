export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  getAuthErrorCode,
  getAuthErrorStatus,
} from "@/lib/auth/AuthError";
import { requireParticipation } from "@/lib/auth/participationGuard";
import { logVote } from "@/lib/logging/logVote";
import { touchUserLog } from "@/lib/logging/touchUserLog";
import { TURNSTILE_ACTIONS } from "@/lib/turnstile/shared";
import { verifyTurnstileRequest } from "@/lib/turnstile/verify.server";
import { getVoteEligibility } from "@/lib/vote/getVoteEligibility";

export async function POST(req: Request) {
  try {
    const { membership, session } = await requireParticipation();
    const discordUserId = session.discord_user_id;
    const turnstileResult = await verifyTurnstileRequest(
      req,
      TURNSTILE_ACTIONS.vote
    );

    if (turnstileResult.status === "rejected") {
      return NextResponse.json(
        { error: turnstileResult.code },
        { status: 400 }
      );
    }

    if (turnstileResult.status === "configuration_error") {
      return NextResponse.json(
        { error: turnstileResult.code },
        { status: 503 }
      );
    }

    const voteEligibility = await getVoteEligibility(
      discordUserId,
      membership
    );

    if (voteEligibility.isBanned) {
      await logVote({
        cycleId: voteEligibility.activeCycleId,
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
        reason: "duplicate_submission_vote",
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
        reason: "vote_limit_reached",
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
      const isSubmissionIneligible = errorMessage.includes(
        "SUBMISSION_NOT_COMPETITION_ELIGIBLE"
      );
      const isDiscordBanned = errorMessage.includes("DISCORD_BANNED");
      const isWebsiteBanned = errorMessage.includes("WEBSITE_BANNED");
      const isParticipationUnavailable = errorMessage.includes(
        "PARTICIPATION_UNAVAILABLE"
      );
      const isNotInDiscord = errorMessage.includes("NOT_IN_DISCORD");
      const isJoinCooldown = errorMessage.includes(
        "JOINED_TOO_RECENTLY"
      );

      if (
        isSelfVote ||
        isDuplicate ||
        isLimitReached ||
        isVotingClosed ||
        isSubmissionMissing ||
        isSubmissionIneligible ||
        isDiscordBanned ||
        isWebsiteBanned ||
        isParticipationUnavailable ||
        isNotInDiscord ||
        isJoinCooldown
      ) {
        await logVote({
          cycleId: voteEligibility.activeCycleId,
          submissionId,
          discordUserId,
          status: "rejected",
          reason: isSelfVote
            ? "self_vote"
            : isDuplicate
              ? "duplicate_submission_vote"
              : isLimitReached
                ? "vote_limit_reached"
                : isVotingClosed
                  ? "voting_closed"
                  : isSubmissionMissing
                    ? "submission_not_found"
                    : isSubmissionIneligible
                      ? "submission_ineligible"
                      : isDiscordBanned
                        ? "discord_banned"
                        : isWebsiteBanned
                          ? "website_banned"
                          : isParticipationUnavailable
                            ? "participation_unavailable"
                            : isNotInDiscord
                              ? "not_in_discord"
                              : "joined_too_recently",
        });

        return NextResponse.json(
          {
            error: isSelfVote
              ? "You cannot vote for your own submission"
              : isDiscordBanned
                ? "DISCORD_BANNED"
                : isWebsiteBanned
                  ? "WEBSITE_BANNED"
                  : isParticipationUnavailable
                    ? "PARTICIPATION_UNAVAILABLE"
                  : isNotInDiscord
                    ? "NOT_IN_DISCORD"
                    : isJoinCooldown
                      ? "JOINED_TOO_RECENTLY"
                      : isSubmissionIneligible
                        ? "SUBMISSION_NOT_COMPETITION_ELIGIBLE"
              : isDuplicate
                ? "You already voted for this submission"
                : isVotingClosed
                  ? "No active voting phase"
                  : isSubmissionMissing
                    ? "Submission not found"
                  : "You used all votes for this cycle",
          },
          {
            status:
              isSelfVote ||
              isDiscordBanned ||
              isWebsiteBanned ||
              isParticipationUnavailable ||
              isNotInDiscord ||
              isJoinCooldown
              ? 403
              : isSubmissionMissing
                ? 404
                : isSubmissionIneligible
                  ? 409
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
    const authStatus = getAuthErrorStatus(error);
    if (authStatus) {
      const fullAuthCode = getAuthErrorCode(error) ?? "";
      const [authCode, ...authCodeDetails] = fullAuthCode.split(":");
      const joinedAt =
        authCode === "JOINED_TOO_RECENTLY" && authCodeDetails.length > 0
          ? authCodeDetails.join(":")
          : null;
      return NextResponse.json(
        joinedAt
          ? { error: authCode, joinedAt }
          : { error: authCode || "AUTHENTICATION_UNAVAILABLE" },
        { status: authStatus }
      );
    }

    console.error("VOTE ERROR", error);
    return NextResponse.json(
      { error: "Voting failed" },
      { status: 500 }
    );
  }
}

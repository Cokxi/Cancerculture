export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  getAuthErrorCode,
  getAuthErrorStatus,
} from "@/lib/auth/AuthError";
import { getDiscordSyncDelayNotice } from "@/lib/auth/discordSyncDelayNotice";
import { getParticipationAccess } from "@/lib/auth/participationGuard";
import { createParticipationAccessState } from "@/lib/eligibility/participation";
import { getVoteEligibility } from "@/lib/vote/getVoteEligibility";

export async function GET() {
  try {
    const participationResult = await getParticipationAccess();
    const { membership, session } = participationResult;
    const eligibility = await getVoteEligibility(
      session.discord_user_id,
      membership
    );
    const participation = eligibility.isBanned
      ? createParticipationAccessState({
          authenticated: true,
          websiteBanned: true,
        })
      : participationResult.access;
    const showDiscordSyncDelayNotice =
      await getDiscordSyncDelayNotice({
        authenticated: participation.authenticated,
        participationEligible: participation.participationEligible,
        membershipReason: membership.reason,
        websiteBanned: participation.websiteBanned,
        discordBanned: participation.discordBanned,
        sessionValid: true,
        dependencyUnavailable: participation.dependencyUnavailable,
        usedDegradedGrace:
          participationResult.discordSyncParticipationGrace
            ?.usedDegradedGrace === true,
      });
    const response = NextResponse.json({
      participation,
      showDiscordSyncDelayNotice,
      hasVoted: eligibility.hasVoted,
      voteCount: eligibility.voteCount,
      votesPerUser: eligibility.votesPerUser,
      votedSubmissionIds: eligibility.votedSubmissionIds,
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    const authStatus = getAuthErrorStatus(error);
    if (authStatus) {
      const code =
        getAuthErrorCode(error)?.split(":")[0] ??
        "AUTHENTICATION_UNAVAILABLE";
      return NextResponse.json(
        {
          status:
            code === "NOT_AUTHENTICATED"
              ? "anonymous"
              : code === "DISCORD_BANNED" || code === "WEBSITE_BANNED"
                ? "restricted"
                : "dependency_unavailable",
          error: code,
        },
        { status: authStatus }
      );
    }

    console.error("[vote eligibility] dependency unavailable", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        status: "dependency_unavailable",
        error: "MEMBERSHIP_UNAVAILABLE",
      },
      { status: 503 }
    );
  }
}

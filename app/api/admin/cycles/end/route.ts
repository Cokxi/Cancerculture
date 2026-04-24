export const runtime = "nodejs";

import { logAdminAction } from "@/lib/audit/logAdminAction";
import { requireAdmin } from "@/lib/auth/guards";
import { markCycleSponsorshipEnded } from "@/lib/cycles/sponsoredCycle";
import { supabaseAdmin as supabase } from "@/lib/db/admin";
import {
  normalizeSubmissionPublicVisibilityStatus,
  SUBMISSION_PUBLIC_VISIBILITY,
} from "@/lib/moderation/submissionPublicVisibility";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { NextResponse } from "next/server";

function getErrorResponse(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Forbidden";
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : 403;

  return NextResponse.json({ error: message }, { status });
}

export async function POST() {
  try {
    const admin = await requireAdmin();

    const { data: cycle } = await supabase
      .from("voting_cycles")
      .select("*")
      .eq("status", "active")
      .maybeSingle();

    if (!cycle) {
      return NextResponse.json(
        { error: "No active cycle found" },
        { status: 400 }
      );
    }

    const { data: lockedCycle, error: lockError } = await supabase
      .from("voting_cycles")
      .update({ status: "finalizing" })
      .eq("id", cycle.id)
      .eq("status", "active")
      .select()
      .single();

    if (lockError || !lockedCycle) {
      return NextResponse.json(
        { error: "Cycle could not be locked" },
        { status: 409 }
      );
    }

    const { data: results, error: resultsError } = await supabase
      .from("submissions_with_votes")
      .select("id, vote_count")
      .eq("cycle_id", cycle.id)
      .eq("is_disqualified", false);

    if (resultsError || !results || results.length === 0) {
      return NextResponse.json(
        { error: "No valid submissions with votes" },
        { status: 400 }
      );
    }

    const visibilityRowsResult = await supabase
      .from("submissions")
      .select("id, public_visibility_status")
      .in(
        "id",
        results.map((result) => result.id)
      );

    if (visibilityRowsResult.error) {
      return NextResponse.json(
        {
          error:
            "Failed to load submission visibility states",
        },
        { status: 500 }
      );
    }

    const visibleSubmissionIds = new Set(
      (visibilityRowsResult.data ?? [])
        .filter(
          (submission) =>
            normalizeSubmissionPublicVisibilityStatus(
              submission.public_visibility_status
            ) === SUBMISSION_PUBLIC_VISIBILITY.visible
        )
        .map((submission) => submission.id)
    );

    const visibleResults = results.filter((result) =>
      visibleSubmissionIds.has(result.id)
    );

    if (visibleResults.length === 0) {
      return NextResponse.json(
        {
          error:
            "No publicly visible submissions remain for finalization",
        },
        { status: 400 }
      );
    }

    const maxVotes = Math.max(
      ...visibleResults.map((result) => result.vote_count)
    );

    const finalizedResults = visibleResults.map((r) => ({
      cycle_id: cycle.id,
      submission_id: r.id,
      vote_count: r.vote_count,
      is_winner: r.vote_count === maxVotes,
      rank: r.vote_count === maxVotes ? 1 : null,
    }));

    await supabase
      .from("cycle_results")
      .delete()
      .eq("cycle_id", cycle.id);

    const { error: insertResultsError } = await supabase
      .from("cycle_results")
      .insert(finalizedResults);

    if (insertResultsError) {
      return NextResponse.json(
        { error: "Failed to save cycle results" },
        { status: 500 }
      );
    }

    await supabase
      .from("winner_public_profiles")
      .delete()
      .eq("cycle_id", cycle.id);

    const winners = finalizedResults.filter((r) => r.is_winner);
    const winShare = 1 / winners.length;

    for (const winner of winners) {
      const {
        data: submission,
        error: submissionError,
      } = await supabase
        .from("submissions")
        .select("r2_key, discord_username_at_upload")
        .eq("id", winner.submission_id)
        .single();

      const {
        data: privateData,
        error: privateDataError,
      } = await supabase
        .from("submission_private_data")
        .select("*")
        .eq("submission_id", winner.submission_id)
        .single();

      if (submissionError || !submission) {
        throw new Error(
          `Failed to load submission ${winner.submission_id}`
        );
      }

      if (privateDataError || !privateData) {
        throw new Error(
          `Failed to load private data for submission ${winner.submission_id}`
        );
      }

      const charitySharePercent =
        privateData.payout_choice === "donate"
          ? 100
          : privateData.payout_choice === "split" &&
              typeof privateData.split_percent === "number"
            ? 100 - privateData.split_percent
            : 0;
      const winnerWall =
        charitySharePercent >= 1 ? "fame" : "shame";

      const {
        error: winnerProfileInsertError,
      } = await supabase
        .from("winner_public_profiles")
        .insert({
          cycle_id: cycle.id,
          submission_id: winner.submission_id,
          r2_key: submission.r2_key,
          image_url: getPublicImageUrl(submission.r2_key) ?? "",
          wall: winnerWall,
          // Compatibility fallback for legacy schemas that still require x_username.
          x_username:
            privateData.x_username ??
            submission.discord_username_at_upload ??
            "unknown",
          wallet_address: privateData.wallet_address,
          payout_choice: privateData.payout_choice,
          split_percent: privateData.split_percent,
          charity: privateData.charity,
          win_share: winShare,
          vote_count: winner.vote_count,
        });

      if (winnerProfileInsertError) {
        throw new Error(
          `Failed to insert winner profile for submission ${winner.submission_id}: ${winnerProfileInsertError.message}`
        );
      }
    }

    await supabase
      .from("voting_cycles")
      .update({
        status: "finished",
        winners_published: true,
        finalized_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
      })
      .eq("id", cycle.id);

    await supabase
      .from("app_config")
      .update({ value: null })
      .eq("key", "cycle_end_at");

    await supabase
      .from("app_config")
      .update({ value: null })
      .eq("key", "cycle_theme");

    await markCycleSponsorshipEnded(cycle.id);

    await logAdminAction({
      actorType: "admin",
      actorId: admin.discord_user_id,
      action: "cycle_finalized",
      targetType: "cycle",
      targetId: cycle.id,
      meta: {
        submissions: finalizedResults.length,
        winners: winners.length,
        maxVotes,
      },
    });

    return NextResponse.json({
      success: true,
      cycleId: cycle.id,
      finalized: true,
    });
  } catch (error) {
    return getErrorResponse(error);
  }
}

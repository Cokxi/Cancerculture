export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin as supabase } from "@/lib/db/admin";
import { logAdminAction } from "@/lib/audit/logAdminAction";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

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

    
    const { data: lockedCycle, error: lockError } =
      await supabase
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

    
    const { data: results, error: resultsError } =
      await supabase
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

    const maxVotes = Math.max(...results.map(r => r.vote_count));

    const finalizedResults = results.map(r => ({
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

    const { error: insertResultsError } =
      await supabase
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

    
    const winners = finalizedResults.filter(r => r.is_winner);
    const winShare = 1 / winners.length;

    for (const winner of winners) {
      const { data: submission } = await supabase
        .from("submissions")
        .select("r2_key")
        .eq("id", winner.submission_id)
        .single();

      const { data: privateData } = await supabase
        .from("submission_private_data")
        .select("*")
        .eq("submission_id", winner.submission_id)
        .single();

      if (!submission || !privateData) continue;

      const wall =
        privateData.payout_choice === "keep"
          ? "shame"
          : "fame";

      await supabase
        .from("winner_public_profiles")
        .insert({
          cycle_id: cycle.id,
          submission_id: winner.submission_id,
          r2_key: submission.r2_key,
          image_url: getPublicImageUrl(submission.r2_key) ?? "",
          wall,
          x_username: privateData.x_username,
          wallet_address: privateData.wallet_address,
          payout_choice: privateData.payout_choice,
          split_percent: privateData.split_percent,
          charity: privateData.charity,
          win_share: winShare,
          vote_count: winner.vote_count,
        });
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
console.log("🔥 RESETTING NEXT THEME");

      
const { data: resetData, error: resetError } = await supabase
  .from("app_config")
  .update({ value: null })
  .eq("key", "next_cycle_theme")
  .select();

console.log("RESET RESULT:", resetData, resetError);


await supabase
  .from("app_config")
  .update({ value: null })
  .eq("key", "cycle_end_at");



    
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
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message ?? "Forbidden" },
      { status: err.status ?? 403 }
    );
  }
}

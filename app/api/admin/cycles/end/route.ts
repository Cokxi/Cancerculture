export const runtime = "nodejs";

import { getAdminApiErrorResponse } from "@/lib/auth/adminApiErrorResponse";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { finalizeCycleTransactional } from "@/lib/cycles/finalizeCycle";
import { supabaseAdmin as supabase } from "@/lib/db/admin";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const authorization =
      await requireDynamicTeamCapability("cycles.manage");
    const body = await req.json().catch(() => null);
    const requestedCycleId = Number(body?.cycleId);
    let cycleId = Number.isInteger(requestedCycleId)
      ? requestedCycleId
      : null;

    if (cycleId === null) {
      const { data: cycle, error } = await supabase
        .from("voting_cycles")
        .select("id")
        .in("status", ["voting_closed", "finalizing", "active"])
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error("[cycle finalization][cycle lookup]", error);
        throw new Error("Failed to load cycle for finalization");
      }

      cycleId = cycle?.id ?? null;
    }

    if (cycleId === null) {
      return NextResponse.json(
        { error: "No cycle is ready for finalization" },
        { status: 409 }
      );
    }

    const result = await finalizeCycleTransactional({
      actorDiscordUserId: authorization.discord_user_id,
      cycleId,
    });

    return NextResponse.json({
      success: true,
      cycleId: result.cycleId,
      finalStatus: result.finalStatus,
      rankedSubmissionCount: result.rankedSubmissionCount,
      winnerCount: result.winnerCount,
      highestRank: result.highestRank,
      alreadyFinalized: result.alreadyFinalized,
    });
  } catch (error) {
    return getAdminApiErrorResponse(error, "POST /api/admin/cycles/end");
  }
}

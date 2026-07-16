export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import { getAdminApiErrorResponse } from "@/lib/auth/adminApiErrorResponse";
import { supabaseAdmin } from "@/lib/db/admin";

export async function GET() {
  try {
    await requireAdmin();

    const [healthResult, activeBanResult] = await Promise.all([
      supabaseAdmin
        .from("discord_sync_health")
        .select(
          "last_event_at, last_reconciliation_started_at, last_reconciliation_succeeded_at, last_ban_snapshot_at, last_membership_snapshot_at, last_error_at, last_error_code"
        )
        .eq("id", 1)
        .single(),
      supabaseAdmin
        .from("discord_member_state")
        .select("discord_user_id", {
          count: "exact",
          head: true,
        })
        .eq("discord_ban_active", true),
    ]);

    if (healthResult.error || activeBanResult.error) {
      throw new Error("Discord sync health unavailable");
    }

    return NextResponse.json({
      health: healthResult.data,
      activeDiscordBanCount: activeBanResult.count ?? 0,
    });
  } catch (error) {
    return getAdminApiErrorResponse(error, "discord sync health");
  }
}

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";

type UnblockRpcResult = {
  outcome?: string;
};

export async function GET() {
  try {
    await requireDynamicTeamCapability("users.upload_blocks.view");

    const { data: states, error } = await supabaseAdmin
      .from("submission_upload_abuse_states")
      .select(
        "discord_user_id, cycle_id, invalid_attempt_count, total_invalid_attempt_count, last_error_code, last_invalid_attempt_at, blocked_at, block_count, unblocked_at, unblock_reason"
      )
      .order("updated_at", { ascending: false })
      .limit(200);

    if (error) throw error;

    const userIds = [...new Set((states ?? []).map((state) => state.discord_user_id))];
    const { data: users, error: userError } = userIds.length
      ? await supabaseAdmin
          .from("user_logs")
          .select(
            "discord_user_id, current_discord_username, current_display_name, public_profile_id"
          )
          .in("discord_user_id", userIds)
      : { data: [], error: null };

    if (userError) throw userError;

    const usersById = new Map(
      (users ?? []).map((user) => [user.discord_user_id, user])
    );
    return NextResponse.json({
      states: (states ?? []).map((state) => {
        const user = usersById.get(state.discord_user_id);
        return {
          ...state,
          display_name:
            user?.current_display_name ??
            user?.current_discord_username ??
            "Unknown user",
          public_profile_id: user?.public_profile_id ?? null,
        };
      }),
    });
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const body = (await req.json()) as Record<string, unknown>;
    const discordUserId =
      typeof body.discordUserId === "string"
        ? body.discordUserId.trim()
        : "";
    const cycleId =
      typeof body.cycleId === "number" ? body.cycleId : Number.NaN;
    const reason =
      typeof body.reason === "string" ? body.reason.trim() : "";

    if (!discordUserId || !Number.isSafeInteger(cycleId) || !reason) {
      return NextResponse.json(
        { error: "INVALID_UNBLOCK_REQUEST" },
        { status: 400 }
      );
    }

    const { data, error } = await supabaseAdmin.rpc(
      "unblock_submission_upload",
      {
        p_actor_discord_user_id: admin.discord_user_id,
        p_cycle_id: cycleId,
        p_discord_user_id: discordUserId,
        p_reason: reason,
      }
    );

    if (error) throw error;
    const result = data as UnblockRpcResult | null;
    if (result?.outcome === "unblocked") {
      return NextResponse.json({ success: true });
    }
    if (result?.outcome === "already_unblocked") {
      return NextResponse.json({ success: true, alreadyUnblocked: true });
    }
    if (result?.outcome === "forbidden") {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }
    if (result?.outcome === "not_found") {
      return NextResponse.json(
        { error: "UPLOAD_BLOCK_NOT_FOUND" },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: "INVALID_UNBLOCK_REQUEST" },
      { status: 400 }
    );
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}

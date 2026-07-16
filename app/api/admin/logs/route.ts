export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireModOrAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import { formatDiscordUserLabel } from "@/lib/discord/formatDiscordUserLabel";

export async function GET(request: Request) {
  try {
    
    await requireModOrAdmin();

    
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type"); // cycle | upload | vote | null

    let query = supabaseAdmin
      .from("admin_action_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);

    if (type) {
      query = query.eq("target_type", type);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json(
        { error: "Failed to load admin logs" },
        { status: 500 }
      );
    }

    const actorIds = Array.from(
      new Set(
        (data ?? [])
          .map((log) => log.actor_id)
          .filter((actorId): actorId is string => Boolean(actorId))
      )
    );
    const { data: actors } =
      actorIds.length > 0
        ? await supabaseAdmin
            .from("user_logs")
            .select(
              "discord_user_id, public_profile_id, current_discord_username, current_discord_handle, current_display_name, current_guild_nickname"
            )
            .in("discord_user_id", actorIds)
        : { data: [] };
    const actorById = new Map(
      (actors ?? []).map((actor) => [actor.discord_user_id, actor])
    );
    const logs = (data ?? []).map((log) => {
      const actor = actorById.get(log.actor_id);

      return {
        ...log,
        actor_label: actor
          ? formatDiscordUserLabel(actor, "admin")
          : null,
        actor_public_profile_id: actor?.public_profile_id ?? null,
      };
    });

    return NextResponse.json({ logs });
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireAdmin } from "@/lib/auth/guards";
import { logAdminAction } from "@/lib/audit/logAdminAction";

export async function POST(req: Request) {
  try {
    
    const admin = await requireAdmin();
    const actorId = admin.discord_user_id;

    
    const { targetDiscordId, role } = await req.json();

    if (
      !targetDiscordId ||
      !["mod", "remove"].includes(role)
    ) {
      return NextResponse.json(
        { error: "Invalid payload" },
        { status: 400 }
      );
    }

    if (role === "mod") {
      const { data: userLog } = await supabaseAdmin
        .from("user_logs")
        .select("current_discord_username")
        .eq("discord_user_id", targetDiscordId)
        .maybeSingle();

      const discordUsername: string | null =
        userLog?.current_discord_username ?? null;

      
      await supabaseAdmin
        .from("team_members")
        .upsert({
          discord_user_id: targetDiscordId,
          discord_username: discordUsername,
          role: "mod",
        });

      await logAdminAction({
        actorType: "admin",
        actorId,
        action: "make_mod",
        targetType: "user",
        targetId: targetDiscordId,
      });
    }

    if (role === "remove") {
      
      await supabaseAdmin
        .from("team_members")
        .delete()
        .eq("discord_user_id", targetDiscordId)
        .neq("role", "admin");

      await logAdminAction({
        actorType: "admin",
        actorId,
        action: "remove_mod",
        targetType: "user",
        targetId: targetDiscordId,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      (error.status === 401 || error.status === 403) &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }

    console.error("UPDATE TEAM ROLE ERROR", error);

    return NextResponse.json(
      { error: "Failed to update role" },
      { status: 500 }
    );
  }
}

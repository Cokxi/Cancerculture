export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireAdmin } from "@/lib/auth/guards";
import { logAdminAction } from "@/lib/audit/logAdminAction";

export async function POST(req: Request) {
  try {
    /* 🔐 Admin-only */
    const admin = await requireAdmin();
    const actorId = admin.discord_user_id;

    /* 📥 Input */
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
      /* 🔍 Username aus Invite-Logs holen (optional) */
      const { data: inviteLog } =
        await supabaseAdmin
          .from("invite_auth_logs")
          .select("discord_username")
          .eq(
            "invited_discord_user_id",
            targetDiscordId
          )
          .order("created_at", {
            ascending: false,
          })
          .limit(1)
          .maybeSingle();

      const discordUsername: string | null =
        inviteLog?.discord_username ?? null;

      /* ➕ Make Mod */
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
      /* ➖ Remove Mod (Admins geschützt) */
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
  } catch (error: any) {
    if (error?.status === 401 || error?.status === 403) {
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

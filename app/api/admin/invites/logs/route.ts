export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireAdmin } from "@/lib/auth/guards";

export async function GET() {
  try {
    /* 🔐 Admin-only */
    await requireAdmin();

    /* 📦 Invites + Nutzungen */
    const { data, error } = await supabaseAdmin
      .from("admin_invites")
      .select(`
        id,
        invite_slug,
        note,
        invited_by_discord_id,
        is_active,
        created_at,
        invite_auth_logs (
          invited_discord_user_id,
          discord_username,
          discord_discriminator,
          discord_avatar,
          created_at
        )
      `)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json(
        { error: "Failed to load invite logs" },
        { status: 500 }
      );
    }

    return NextResponse.json({ invites: data ?? [] });
  } catch (error: any) {
    // 🔑 Auth-Fehler sauber zurückgeben
    if (error?.status === 401 || error?.status === 403) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }

    console.error("INVITE LOGS ERROR", error);

    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 403 }
    );
  }
}

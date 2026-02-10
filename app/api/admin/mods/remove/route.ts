import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireAdmin } from "@/lib/auth/guards";

export async function POST(req: Request) {
  try {
    /* 🔐 Admin-only */
    const admin = await requireAdmin();
    const actorId = admin.discord_user_id;

    /* 📥 Form-Daten lesen */
    const formData = await req.formData();
    const targetId = formData.get("discord_user_id");

    if (typeof targetId !== "string" || !targetId) {
      return NextResponse.json(
        { error: "Missing user id" },
        { status: 400 }
      );
    }

    /* 🛑 Selbstschutz */
    if (targetId === actorId) {
      return NextResponse.json(
        { error: "Cannot remove yourself" },
        { status: 400 }
      );
    }

    /* 🔴 Mod entfernen (Admin bleibt unberührt) */
    await supabaseAdmin
      .from("team_members")
      .delete()
      .eq("discord_user_id", targetId)
      .eq("role", "mod");

    /* 🔁 Zurück zur Mod-Liste */
    return NextResponse.redirect(
      new URL("/admin/mods", req.url)
    );
  } catch (error: any) {
    // 🔑 Auth-Fehler sauber zurückgeben
    if (error?.status === 401 || error?.status === 403) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }

    console.error("REMOVE MOD ERROR", error);

    return NextResponse.json(
      { error: "Failed to remove mod" },
      { status: 500 }
    );
  }
}

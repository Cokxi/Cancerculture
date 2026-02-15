export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";
import { logAdminAction } from "@/lib/audit/logAdminAction";

export async function POST(req: Request) {
  try {
    // 🔐 ADMIN ONLY
    const admin = await requireAdmin();

    // 📥 Input
    const body = await req.json();
    const { endsAt, theme } = body;

    if (!endsAt) {

      return NextResponse.json(
        { error: "endsAt is required" },
        { status: 400 }
      );
    }

          // 🎨 Theme normalisieren ("" → null)
const cleanTheme =
  typeof theme === "string" && theme.trim().length > 0
    ? theme.trim()
    : null;

    // 🔁 Sicherheitscheck: nur ein aktiver Cycle
    const { data: activeCycle } = await supabaseAdmin
      .from("voting_cycles")
      .select("id")
      .eq("status", "active")
      .maybeSingle();

    if (activeCycle) {
      return NextResponse.json(
        { error: "There is already an active cycle" },
        { status: 400 }
      );
    }

    // 🗳️ Cycle anlegen
    const { data: cycle, error } = await supabaseAdmin
      .from("voting_cycles")
      .insert({
        status: "active",
        starts_at: new Date().toISOString(),
        ends_at: endsAt,
        created_by_discord_id: admin.discord_user_id,
        theme: cleanTheme,
      })

      .select()
      .single();

    if (error) {
      console.error("❌ Cycle start error:", error);
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    // 🧾 Audit-Log (ADMIN)
    await logAdminAction({
      actorType: "admin",
      actorId: admin.discord_user_id,
      action: "cycle_started",
      targetType: "cycle",
      targetId: cycle.id,
      meta: {
        ends_at: endsAt,
      },
    });

    return NextResponse.json({ success: true, cycle });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message ?? "Forbidden" },
      { status: err.status ?? 403 }
    );
  }
}

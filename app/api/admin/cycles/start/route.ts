export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";
import { logAdminAction } from "@/lib/audit/logAdminAction";

export async function POST(req: Request) {
  try {
    
    const admin = await requireAdmin();

    
    const body = await req.json();
    const { endsAt, theme } = body;

    if (!endsAt) {

      return NextResponse.json(
        { error: "endsAt is required" },
        { status: 400 }
      );
    }

          
const cleanTheme =
  typeof theme === "string" && theme.trim().length > 0
    ? theme.trim()
    : null;

    
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

    
await supabaseAdmin
  .from("user_logs")
  .update({
    upload_fail_count: 0,
  })
  .neq("upload_fail_count", 0);

   
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

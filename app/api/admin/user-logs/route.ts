export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireModOrAdmin } from "@/lib/auth/guards";

export async function GET() {
  try {
    
    await requireModOrAdmin();

    const { data, error } = await supabaseAdmin
      .from("user_logs_with_stats")
      .select("*")
      .order("last_seen_at", { ascending: false });

    if (error) {
      console.error("USER LOGS LOAD ERROR", error);
      return NextResponse.json(
        { error: "Failed to load user logs" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      users: data ?? [],
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message ?? "Unauthorized" },
      { status: 403 }
    );
  }
}

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireModOrAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";

export async function GET() {
  try {
   
    await requireModOrAdmin();

    const { data, error } = await supabaseAdmin
      .from("moderation_action_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(300);

    if (error) {
      return NextResponse.json(
        { error: "Failed to load moderation logs" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      logs: data ?? [],
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message ?? "Forbidden" },
      { status: err.status ?? 403 }
    );
  }
}

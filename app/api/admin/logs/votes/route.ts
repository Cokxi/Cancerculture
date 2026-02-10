export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireModOrAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";

export async function GET() {
  try {
    // 🔐 MOD oder ADMIN
    await requireModOrAdmin();

    const { data, error } = await supabaseAdmin
      .from("vote_logs")
      .select(
  "id, created_at, cycle_id, submission_id, discord_user_id, status, reason"
)

      .order("created_at", { ascending: false })
      .limit(300);

    if (error) {
      return NextResponse.json(
        { error: "Failed to load vote logs" },
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

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireModOrAdmin } from "@/lib/auth/guards";

export async function GET(req: Request) {
  try {
    /* 🔐 Admin oder Mod */
    await requireModOrAdmin();

    const { searchParams } = new URL(req.url);
    const cycleId = searchParams.get("cycle_id");
    const limit = Number(searchParams.get("limit") ?? 50);

    let query = supabaseAdmin
      .from("submissions")
      .select(
        `
        id,
        cycle_id,
        image_url,
        is_disqualified,
        disqualification_type,
        disqualification_reason_code,
        disqualification_reason_text,
        created_at,
        voting_cycles!inner(status)
        `
      )
      .eq("voting_cycles.status", "active")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (cycleId) {
      query = query.eq("cycle_id", cycleId);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json(
        { error: "Failed to load submissions" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      submissions: data ?? [],
    });
  } catch (error: any) {
    // 🔑 konsistente Auth-Fehler
    if (error?.status === 401 || error?.status === 403) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }

    console.error("ADMIN SUBMISSIONS ERROR", error);

    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 403 }
    );
  }
}

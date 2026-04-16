import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireModOrAdmin } from "@/lib/auth/guards";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

export async function GET(req: Request) {
  try {
    
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
        r2_key,
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

    const submissionsWithUrls =
  data?.map((s) => ({
    ...s,
    image_url: getPublicImageUrl(s.r2_key) ?? "",
  })) ?? [];

    if (error) {
      return NextResponse.json(
        { error: "Failed to load submissions" },
        { status: 500 }
      );
    }

    return NextResponse.json({
  submissions: submissionsWithUrls,
});
  } catch (error: any) {
    
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

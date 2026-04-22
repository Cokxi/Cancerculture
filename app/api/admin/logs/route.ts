export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireModOrAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";

export async function GET(request: Request) {
  try {
    
    await requireModOrAdmin();

    
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type"); // cycle | upload | vote | null

    let query = supabaseAdmin
      .from("admin_action_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);

    if (type) {
      query = query.eq("target_type", type);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json(
        { error: "Failed to load admin logs" },
        { status: 500 }
      );
    }

    return NextResponse.json({ logs: data ?? [] });
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}

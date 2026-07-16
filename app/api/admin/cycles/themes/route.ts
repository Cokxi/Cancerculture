export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getAdminApiErrorResponse } from "@/lib/auth/adminApiErrorResponse";
import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";

export async function GET(req: Request) {
  try {
    
    await requireAdmin();

    const { searchParams } = new URL(req.url);
    const idsParam = searchParams.get("ids");

    if (!idsParam) {
      return NextResponse.json({ themes: {} });
    }

    const ids = idsParam
      .split(",")
      .map((id) => Number(id))
      .filter((id) => !isNaN(id));

    if (ids.length === 0) {
      return NextResponse.json({ themes: {} });
    }

    const { data, error } = await supabaseAdmin
      .from("voting_cycles")
      .select("id, theme")
      .in("id", ids);

    if (error) {
      return NextResponse.json(
        { error: "Failed to load themes" },
        { status: 500 }
      );
    }

    const themes: Record<number, string | null> = {};

    for (const cycle of data ?? []) {
      themes[cycle.id] = cycle.theme ?? null;
    }

    return NextResponse.json({ themes });
  } catch (error) {
    return getAdminApiErrorResponse(
      error,
      "GET /api/admin/cycles/themes"
    );
  }
}

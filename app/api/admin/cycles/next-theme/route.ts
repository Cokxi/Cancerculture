export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getAdminApiErrorResponse } from "@/lib/auth/adminApiErrorResponse";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";

export async function POST(req: Request) {
  try {
    await requireDynamicTeamCapability("cycles.manage");

    const body = await req.json();
    const theme =
      typeof body.theme === "string" && body.theme.trim().length > 0
        ? body.theme.trim()
        : null;

    const { error } = await supabaseAdmin
      .from("app_config")
      .upsert(
        {
          key: "next_cycle_theme",
          value: theme,
        },
        { onConflict: "key" }
      );

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      nextTheme: theme,
    });
  } catch (error) {
    return getAdminApiErrorResponse(
      error,
      "POST /api/admin/cycles/next-theme"
    );
  }
}

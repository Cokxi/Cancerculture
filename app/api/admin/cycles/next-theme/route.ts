export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";

function getErrorResponse(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Forbidden";
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : 403;

  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  try {
    await requireAdmin();

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
    return getErrorResponse(error);
  }
}

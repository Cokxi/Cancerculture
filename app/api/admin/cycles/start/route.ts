export const runtime = "nodejs";

import { logAdminAction } from "@/lib/audit/logAdminAction";
import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";
import { NextResponse } from "next/server";

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
    const admin = await requireAdmin();
    const body = await req.json();
    const { endsAt, theme } = body;

    if (!endsAt) {
      return NextResponse.json(
        { error: "endsAt is required" },
        { status: 400 }
      );
    }

    const manualTheme =
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

    const { data: nextThemeConfig } = await supabaseAdmin
      .from("app_config")
      .select("value")
      .eq("key", "next_cycle_theme")
      .maybeSingle();

    const storedNextTheme =
      typeof nextThemeConfig?.value === "string" &&
      nextThemeConfig.value.trim().length > 0
        ? nextThemeConfig.value.trim()
        : null;

    const resolvedTheme = manualTheme ?? storedNextTheme;

    const { data: cycle, error } = await supabaseAdmin
      .from("voting_cycles")
      .insert({
        status: "active",
        starts_at: new Date().toISOString(),
        ends_at: endsAt,
        created_by_discord_id: admin.discord_user_id,
        theme: resolvedTheme,
      })
      .select()
      .single();

    if (error) {
      console.error("Cycle start error:", error);
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

    await supabaseAdmin
      .from("app_config")
      .update({ value: null })
      .eq("key", "next_cycle_theme");

    await logAdminAction({
      actorType: "admin",
      actorId: admin.discord_user_id,
      action: "cycle_started",
      targetType: "cycle",
      targetId: cycle.id,
      meta: {
        ends_at: endsAt,
        theme: resolvedTheme,
        theme_source: manualTheme
          ? "manual"
          : storedNextTheme
            ? "next_cycle_theme"
            : "none",
      },
    });

    return NextResponse.json({ success: true, cycle });
  } catch (error) {
    return getErrorResponse(error);
  }
}

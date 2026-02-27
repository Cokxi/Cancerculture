import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { supabaseAdmin } from "@/lib/db/admin";

export async function GET() {
  const { discord_user_id } = await requireSession();

  const { data: user } = await supabaseAdmin
    .from("user_logs")
    .select("accepted_rules_version")
    .eq("discord_user_id", discord_user_id)
    .single();

  const { data: rules } = await supabaseAdmin
    .from("rules_meta")
    .select("current_version, updated_at")
    .eq("id", 1)
    .single();

  if (!rules) {
    return NextResponse.json(
      { error: "Rules not configured" },
      { status: 500 }
    );
  }

  const needsAccept =
    user?.accepted_rules_version !== rules.current_version;

  const isFirstAccept =
    user?.accepted_rules_version === null;

  return NextResponse.json({
    needsAccept,
    isFirstAccept,
    updatedAt: rules.updated_at,
  });
}
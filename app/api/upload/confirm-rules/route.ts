import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { supabaseAdmin } from "@/lib/db/admin";

export async function POST() {
  const { discord_user_id } = await requireSession();

  const { data: rules } = await supabaseAdmin
    .from("rules_meta")
    .select("current_version")
    .eq("id", 1)
    .single();

  if (!rules) {
    return NextResponse.json(
      { error: "Rules not configured" },
      { status: 500 }
    );
  }

  await supabaseAdmin
    .from("user_logs")
    .update({
      accepted_rules_version: rules.current_version,
    })
    .eq("discord_user_id", discord_user_id);

  return NextResponse.json({ success: true });
}
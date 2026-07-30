"use server";

import { supabaseAdmin } from "@/lib/db/admin";
import { requireAdmin } from "@/lib/auth/guards";

export async function updateRulesVersion() {
  await requireAdmin();

  const { data: rules } = await supabaseAdmin
    .from("rules_meta")
    .select("current_version")
    .eq("id", 1)
    .single();

  if (!rules) {
    throw new Error("Rules meta not found");
  }

  await supabaseAdmin
    .from("rules_meta")
    .update({
      current_version: rules.current_version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
}

"use server";

import { supabaseAdmin } from "@/lib/db/admin";

export async function updateNextTheme(formData: FormData) {
  const raw = formData.get("next_cycle_theme");

  const value =
    typeof raw === "string" && raw.trim().length > 0
      ? raw.trim()
      : null;

  await supabaseAdmin
  .from("app_config")
  .update({ value })
  .eq("key", "next_cycle_theme");

}

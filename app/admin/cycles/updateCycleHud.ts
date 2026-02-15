"use server";

import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";

export async function updateCycleHud(formData: FormData) {
  await requireAdmin();

  const theme = formData.get("cycle_theme")?.toString() ?? "";
  const nextTheme = formData.get("next_cycle_theme")?.toString() ?? "";
    const hours = Number(formData.get("timer_hours") ?? 0);
  const minutes = Number(formData.get("timer_minutes") ?? 0);


  await supabaseAdmin
    .from("app_config")
    .update({ value: theme })
    .eq("key", "cycle_theme");

  await supabaseAdmin
    .from("app_config")
    .update({ value: nextTheme })
    .eq("key", "next_cycle_theme");

    if (hours > 0 || minutes > 0) {
  const now = new Date();
  const end = new Date(
    now.getTime() + (hours * 60 + minutes) * 60 * 1000
  );

  await supabaseAdmin
    .from("app_config")
    .update({ value: end.toISOString() })
    .eq("key", "cycle_end_at");
}

}

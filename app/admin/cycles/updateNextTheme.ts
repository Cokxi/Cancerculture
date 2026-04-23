"use server";

import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";

export async function updateNextTheme(formData: FormData) {
  await requireAdmin();

  const raw = formData.get("next_cycle_theme");

  const value =
    typeof raw === "string" && raw.trim().length > 0
      ? raw.trim()
      : null;

  await supabaseAdmin
    .from("app_config")
    .upsert(
      {
        key: "next_cycle_theme",
        value,
      },
      { onConflict: "key" }
    );
}

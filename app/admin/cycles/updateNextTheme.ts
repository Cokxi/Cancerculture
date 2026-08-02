"use server";

import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";

export async function updateNextTheme(formData: FormData) {
  await requireDynamicTeamCapability("cycles.manage");

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

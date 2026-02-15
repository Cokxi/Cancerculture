"use server";

import { supabaseAdmin } from "@/lib/db/admin";

export async function updateCycleTimer(formData: FormData) {
  const hours = Number(formData.get("timer_hours") || 0);
  const minutes = Number(formData.get("timer_minutes") || 0);

  if (hours <= 0 && minutes <= 0) {
    // Timer löschen
    await supabaseAdmin
      .from("app_config")
      .upsert({
        key: "cycle_end_at",
        value: null,
      });
    return;
  }

  const end = new Date();
  end.setHours(end.getHours() + hours);
  end.setMinutes(end.getMinutes() + minutes);

  await supabaseAdmin
    .from("app_config")
    .upsert({
      key: "cycle_end_at",
      value: end.toISOString(),
    });
}

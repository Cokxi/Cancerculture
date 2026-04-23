"use server";

import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";

export async function updateCycleTimer(formData: FormData) {
  await requireAdmin();

  const hours = Number(formData.get("timer_hours") || 0);
  const minutes = Number(formData.get("timer_minutes") || 0);
  const totalMinutes = hours * 60 + minutes;

  const { data: activeCycle } = await supabaseAdmin
    .from("voting_cycles")
    .select("id")
    .eq("status", "active")
    .maybeSingle();

  if (totalMinutes <= 0) {
    if (activeCycle) {
      await supabaseAdmin
        .from("voting_cycles")
        .update({ ends_at: null })
        .eq("id", activeCycle.id);
    }

    await supabaseAdmin
      .from("app_config")
      .upsert({
        key: "cycle_end_at",
        value: null,
      });
    return;
  }

  const end = new Date();
  end.setMinutes(end.getMinutes() + totalMinutes);

  if (activeCycle) {
    await supabaseAdmin
      .from("voting_cycles")
      .update({ ends_at: end.toISOString() })
      .eq("id", activeCycle.id);
  }

  await supabaseAdmin
    .from("app_config")
    .upsert({
      key: "cycle_end_at",
      value: end.toISOString(),
    });
}

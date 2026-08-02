"use server";

import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { manageCyclePhase } from "@/lib/cycles/manageCycle";
import { supabaseAdmin } from "@/lib/db/admin";

export async function updateCycleTimer(formData: FormData) {
  const authorization =
    await requireDynamicTeamCapability("cycles.manage");

  const hours = Number(formData.get("timer_hours") || 0);
  const minutes = Number(formData.get("timer_minutes") || 0);
  const totalMinutes = hours * 60 + minutes;

  const { data: currentCycle } = await supabaseAdmin
    .from("voting_cycles")
    .select("id, status")
    .in("status", ["submission_open", "voting_open"])
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!currentCycle) {
    return;
  }

  if (totalMinutes <= 0) {
    await manageCyclePhase({
      cycleId: currentCycle.id,
      actorDiscordUserId: authorization.discord_user_id,
      operation: "clear_timer",
      expectedStatus: currentCycle.status,
      idempotencyKey: crypto.randomUUID(),
    });
    return;
  }

  await manageCyclePhase({
    cycleId: currentCycle.id,
    actorDiscordUserId: authorization.discord_user_id,
    operation: "set_timer",
    expectedStatus: currentCycle.status,
    durationMinutes: totalMinutes,
    idempotencyKey: crypto.randomUUID(),
  });
}

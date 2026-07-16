"use server";

import { requireAdmin } from "@/lib/auth/guards";
import {
  clearPhaseTimer,
  setSubmissionPhaseEnd,
  setVotingPhaseEnd,
} from "@/lib/cycles/phaseTransitions";
import { supabaseAdmin } from "@/lib/db/admin";

export async function updateCycleTimer(formData: FormData) {
  const admin = await requireAdmin();

  const hours = Number(formData.get("timer_hours") || 0);
  const minutes = Number(formData.get("timer_minutes") || 0);
  const totalMinutes = hours * 60 + minutes;

  const { data: currentCycle } = await supabaseAdmin
    .from("voting_cycles")
    .select("id, status")
    .in("status", ["submission_open", "voting_open", "active"])
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!currentCycle) {
    return;
  }

  if (totalMinutes <= 0) {
    if (
      currentCycle.status === "submission_open" ||
      currentCycle.status === "voting_open"
    ) {
      await clearPhaseTimer({
        cycleId: currentCycle.id,
        phase: currentCycle.status,
        actorType: "admin",
        actorDiscordUserId: admin.discord_user_id,
      });
    } else {
      await supabaseAdmin
        .from("voting_cycles")
        .update({ ends_at: null })
        .eq("id", currentCycle.id);
    }
    return;
  }

  if (currentCycle.status === "submission_open") {
    await setSubmissionPhaseEnd({
      cycleId: currentCycle.id,
      durationMinutes: totalMinutes,
      actorType: "admin",
      actorDiscordUserId: admin.discord_user_id,
      expectedStatuses: ["submission_open"],
    });
    return;
  }

  if (currentCycle.status === "voting_open") {
    await setVotingPhaseEnd({
      cycleId: currentCycle.id,
      durationMinutes: totalMinutes,
      actorType: "admin",
      actorDiscordUserId: admin.discord_user_id,
      expectedStatuses: ["voting_open"],
    });
    return;
  }

  const end = new Date();
  end.setMinutes(end.getMinutes() + totalMinutes);

  if (currentCycle.status === "active") {
    await supabaseAdmin
      .from("voting_cycles")
      .update({ ends_at: end.toISOString() })
      .eq("id", currentCycle.id);
  }
}

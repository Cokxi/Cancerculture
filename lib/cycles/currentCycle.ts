import "server-only";

import { processDueCycleTransitions } from "@/lib/cycles/phaseAutomation";
import { supabaseAdmin } from "@/lib/db/admin";

type CurrentCycleRow = {
  id: number;
  status: string;
  votes_per_user?: number | null;
  submissions_per_user?: number | null;
  upload_success_cooldown_seconds?: number | null;
  paused_from_status?: string | null;
};

async function getNewestCycleByStatuses(
  statuses: string[],
  { throwOnError = false }: { throwOnError?: boolean } = {}
) {
  await processDueCycleTransitions();

  const { data, error } = await supabaseAdmin
    .from("voting_cycles")
    .select(
      "id, status, votes_per_user, submissions_per_user, upload_success_cooldown_seconds"
    )
    .in("status", statuses)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("[current cycle lookup]", error.message);

    if (throwOnError) {
      throw new Error("Current cycle lookup failed");
    }
  }

  return (data as CurrentCycleRow | null) ?? null;
}

export async function getCurrentSubmissionCycle(options?: {
  throwOnError?: boolean;
}) {
  return getNewestCycleByStatuses(
    ["submission_open", "active"],
    options
  );
}

export async function getCurrentVotingCycle(options?: {
  throwOnError?: boolean;
}) {
  return getNewestCycleByStatuses(["voting_open", "active"], options);
}

export async function getCurrentPublicCycle() {
  return getNewestCycleByStatuses([
    "submission_open",
    "voting_open",
    "voting_closed",
    "paused",
    "active",
  ]);
}

export async function getLatestCycleState() {
  await processDueCycleTransitions();

  const { data, error } = await supabaseAdmin
    .from("voting_cycles")
    .select(
      "id, status, votes_per_user, submissions_per_user, upload_success_cooldown_seconds, paused_from_status"
    )
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("[latest cycle state lookup]", error.message);
  }

  return (data as CurrentCycleRow | null) ?? null;
}

"use server";

import { revalidatePath } from "next/cache";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { manageCyclePhase } from "@/lib/cycles/manageCycle";
import { supabaseAdmin } from "@/lib/db/admin";

type CycleLookupStatus =
  | "active"
  | "draft"
  | "submission_open"
  | "submission_closed"
  | "voting_open"
  | "voting_closed"
  | "paused"
  | "finalizing";

const OPENISH_CYCLE_STATUSES: CycleLookupStatus[] = [
  "active",
  "draft",
  "submission_open",
  "submission_closed",
  "voting_open",
  "voting_closed",
  "paused",
  "finalizing",
];

function getPositiveInteger(formData: FormData, key: string) {
  const value = Number(formData.get(key));
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function getLatestOpenishCycle(
  statuses: CycleLookupStatus[] = OPENISH_CYCLE_STATUSES
) {
  const { data, error } = await supabaseAdmin
    .from("voting_cycles")
    .select("id, status, votes_per_user")
    .in("status", statuses)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("No compatible cycle found for this phase action");
  }

  return data as {
    id: number;
    status: CycleLookupStatus;
    votes_per_user: number | null;
  };
}

function revalidateAdminCycles() {
  revalidatePath("/admin/cycles");
}

export async function closeSubmissionPhaseAction() {
  const authorization =
    await requireDynamicTeamCapability("cycles.manage");
  const cycle = await getLatestOpenishCycle(["submission_open"]);

  await manageCyclePhase({
    cycleId: cycle.id,
    actorDiscordUserId: authorization.discord_user_id,
    operation: "end_submission_start_voting",
    expectedStatus: "submission_open",
    idempotencyKey: crypto.randomUUID(),
  });

  revalidateAdminCycles();
  revalidatePath("/");
  revalidatePath("/upload");
  revalidatePath("/submissions");
}

export async function setVotesPerUserAction(formData: FormData) {
  const authorization =
    await requireDynamicTeamCapability("cycles.manage");
  const votesPerUser = getPositiveInteger(formData, "votes_per_user");

  if (!votesPerUser || votesPerUser > 50) {
    throw new Error("Votes per user must be between 1 and 50");
  }

  const cycle = await getLatestOpenishCycle(["submission_open"]);

  await manageCyclePhase({
    cycleId: cycle.id,
    actorDiscordUserId: authorization.discord_user_id,
    operation: "set_votes_per_user",
    expectedStatus: "submission_open",
    votesPerUser,
    idempotencyKey: crypto.randomUUID(),
  });

  revalidateAdminCycles();
  revalidatePath("/");
}

export async function startVotingPhaseAction() {
  const authorization =
    await requireDynamicTeamCapability("cycles.manage");
  const cycle = await getLatestOpenishCycle(["submission_closed"]);

  await manageCyclePhase({
    cycleId: cycle.id,
    actorDiscordUserId: authorization.discord_user_id,
    operation: "start_voting",
    expectedStatus: "submission_closed",
    idempotencyKey: crypto.randomUUID(),
  });

  revalidateAdminCycles();
  revalidatePath("/");
  revalidatePath("/submissions");
}

export async function pauseCurrentPhaseAction(formData: FormData) {
  const authorization =
    await requireDynamicTeamCapability("cycles.manage");
  const cycle = await getLatestOpenishCycle([
    "submission_open",
    "voting_open",
  ]);
  const rawReason = formData.get("pause_reason");

  await manageCyclePhase({
    cycleId: cycle.id,
    actorDiscordUserId: authorization.discord_user_id,
    operation: "pause",
    expectedStatus: cycle.status,
    reason: typeof rawReason === "string" ? rawReason : null,
    idempotencyKey: crypto.randomUUID(),
  });

  revalidateAdminCycles();
  revalidatePath("/");
  revalidatePath("/upload");
  revalidatePath("/submissions");
}

export async function resumeCurrentPhaseAction() {
  const authorization =
    await requireDynamicTeamCapability("cycles.manage");
  const cycle = await getLatestOpenishCycle(["paused"]);

  await manageCyclePhase({
    cycleId: cycle.id,
    actorDiscordUserId: authorization.discord_user_id,
    operation: "resume",
    expectedStatus: "paused",
    idempotencyKey: crypto.randomUUID(),
  });

  revalidateAdminCycles();
  revalidatePath("/");
  revalidatePath("/upload");
  revalidatePath("/submissions");
}

export async function closeVotingPhaseAction() {
  const authorization =
    await requireDynamicTeamCapability("cycles.manage");
  const cycle = await getLatestOpenishCycle(["voting_open"]);

  await manageCyclePhase({
    cycleId: cycle.id,
    actorDiscordUserId: authorization.discord_user_id,
    operation: "end_voting",
    expectedStatus: "voting_open",
    idempotencyKey: crypto.randomUUID(),
  });

  revalidateAdminCycles();
  revalidatePath("/");
  revalidatePath("/submissions");
}

"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import {
  closeSubmissionPhase,
  closeVotingPhase,
  pauseCyclePhase,
  resumeCyclePhase,
  setCycleVotesPerUser,
  startVotingPhaseWithoutTimer,
} from "@/lib/cycles/phaseTransitions";
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
  const admin = await requireAdmin();
  const cycle = await getLatestOpenishCycle(["submission_open"]);

  await closeSubmissionPhase({
    cycleId: cycle.id,
    actorType: "admin",
    actorDiscordUserId: admin.discord_user_id,
    expectedStatuses: ["submission_open"],
  });

  await startVotingPhaseWithoutTimer({
    cycleId: cycle.id,
    votesPerUser: cycle.votes_per_user ?? 2,
    actorType: "admin",
    actorDiscordUserId: admin.discord_user_id,
    expectedStatuses: ["submission_closed"],
  });

  revalidateAdminCycles();
  revalidatePath("/");
  revalidatePath("/upload");
  revalidatePath("/submissions");
}

export async function setVotesPerUserAction(formData: FormData) {
  const admin = await requireAdmin();
  const votesPerUser = getPositiveInteger(formData, "votes_per_user");

  if (!votesPerUser || votesPerUser > 10) {
    throw new Error("Votes per user must be between 1 and 10");
  }

  const cycle = await getLatestOpenishCycle(["submission_open"]);

  await setCycleVotesPerUser({
    cycleId: cycle.id,
    votesPerUser,
    actorType: "admin",
    actorDiscordUserId: admin.discord_user_id,
  });

  revalidateAdminCycles();
  revalidatePath("/");
}

export async function startVotingPhaseAction() {
  const admin = await requireAdmin();
  const cycle = await getLatestOpenishCycle(["submission_closed"]);

  await startVotingPhaseWithoutTimer({
    cycleId: cycle.id,
    votesPerUser: cycle.votes_per_user ?? 2,
    actorType: "admin",
    actorDiscordUserId: admin.discord_user_id,
    expectedStatuses: ["submission_closed"],
  });

  revalidateAdminCycles();
  revalidatePath("/");
  revalidatePath("/submissions");
}

export async function pauseCurrentPhaseAction(formData: FormData) {
  const admin = await requireAdmin();
  const cycle = await getLatestOpenishCycle([
    "submission_open",
    "voting_open",
  ]);
  const rawReason = formData.get("pause_reason");

  await pauseCyclePhase({
    cycleId: cycle.id,
    reason: typeof rawReason === "string" ? rawReason : null,
    actorType: "admin",
    actorDiscordUserId: admin.discord_user_id,
  });

  revalidateAdminCycles();
  revalidatePath("/");
  revalidatePath("/upload");
  revalidatePath("/submissions");
}

export async function resumeCurrentPhaseAction() {
  const admin = await requireAdmin();
  const cycle = await getLatestOpenishCycle(["paused"]);

  await resumeCyclePhase({
    cycleId: cycle.id,
    actorType: "admin",
    actorDiscordUserId: admin.discord_user_id,
  });

  revalidateAdminCycles();
  revalidatePath("/");
  revalidatePath("/upload");
  revalidatePath("/submissions");
}

export async function closeVotingPhaseAction() {
  const admin = await requireAdmin();
  const cycle = await getLatestOpenishCycle(["voting_open"]);

  await closeVotingPhase({
    cycleId: cycle.id,
    actorType: "admin",
    actorDiscordUserId: admin.discord_user_id,
    expectedStatuses: ["voting_open"],
  });

  revalidateAdminCycles();
  revalidatePath("/");
  revalidatePath("/submissions");
}

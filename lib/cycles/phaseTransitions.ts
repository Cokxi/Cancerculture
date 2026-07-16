import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";

export type CyclePhaseStatus =
  | "draft"
  | "submission_open"
  | "submission_closed"
  | "voting_open"
  | "voting_closed"
  | "paused"
  | "finalizing"
  | "completed"
  | "archived"
  | "cancelled";

type CycleActorType = "system" | "admin" | "moderator" | "bot";

type CycleTransitionActor = {
  actorType?: CycleActorType;
  actorDiscordUserId?: string | null;
};

type TransitionOptions = CycleTransitionActor & {
  expectedStatuses?: string[];
};

type CycleEventPayload = Record<string, unknown>;

type CycleUpdateResult = {
  id: number;
  status: string;
};

export const DEFAULT_VOTES_PER_USER = 2;
export const MAX_VOTES_PER_USER = 10;

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function assertPositiveDuration(durationMinutes: number) {
  if (
    !Number.isFinite(durationMinutes) ||
    !Number.isInteger(durationMinutes) ||
    durationMinutes <= 0
  ) {
    throw new Error("durationMinutes must be a positive integer");
  }
}

function normalizeVotesPerUser(votesPerUser: number) {
  if (
    !Number.isInteger(votesPerUser) ||
    votesPerUser < 1 ||
    votesPerUser > MAX_VOTES_PER_USER
  ) {
    throw new Error(
      `votesPerUser must be between 1 and ${MAX_VOTES_PER_USER}`
    );
  }

  return votesPerUser;
}

function getReminderOffsets(durationMinutes: number) {
  if (durationMinutes >= 120) {
    return [60, 30, 15, 10, 5, 1];
  }

  if (durationMinutes >= 60) {
    return [30, 15, 10, 5, 1];
  }

  if (durationMinutes >= 30) {
    return [20, 10, 5, 1];
  }

  if (durationMinutes >= 15) {
    return [10, 5, 1];
  }

  if (durationMinutes >= 10) {
    return [5, 1];
  }

  return durationMinutes > 1 ? [1] : [];
}

function normalizeOptionalString(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

async function updateCycle(
  cycleId: number,
  values: Record<string, unknown>,
  expectedStatuses?: string[]
) {
  const baseQuery = supabaseAdmin
    .from("voting_cycles")
    .update(values)
    .eq("id", cycleId);

  const query =
    expectedStatuses && expectedStatuses.length > 0
      ? baseQuery.in("status", expectedStatuses)
      : baseQuery;

  const { data, error } = await query
    .select("id, status")
    .single();

  if (error || !data) {
    throw new Error(
      error?.message ?? `Failed to update cycle ${cycleId}`
    );
  }

  return data as CycleUpdateResult;
}

async function createCycleEvent({
  cycleId,
  eventType,
  actorType = "system",
  actorDiscordUserId = null,
  payload,
}: CycleTransitionActor & {
  cycleId: number;
  eventType: string;
  payload: CycleEventPayload;
}) {
  const { error } = await supabaseAdmin.from("cycle_events").insert({
    cycle_id: cycleId,
    event_type: eventType,
    actor_type: actorType,
    actor_discord_user_id: actorDiscordUserId,
    payload,
  });

  if (error) {
    console.warn("[cycle phase transition][event]", error.message);
  }
}

async function createCycleReminders({
  cycleId,
  phase,
  startsAt,
  endsAt,
  durationMinutes,
  messagePayload,
}: {
  cycleId: number;
  phase: CyclePhaseStatus;
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  messagePayload: CycleEventPayload;
}) {
  const reminderRows = getReminderOffsets(durationMinutes).map(
    (remainingMinutes) => ({
      cycle_id: cycleId,
      phase,
      reminder_type: `phase_ends_in_${remainingMinutes}m`,
      due_at: addMinutes(endsAt, -remainingMinutes).toISOString(),
      message_payload: {
        ...messagePayload,
        phase,
        remaining_minutes: remainingMinutes,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
      },
      status: "pending",
    })
  );

  reminderRows.push({
    cycle_id: cycleId,
    phase,
    reminder_type: "phase_end_due",
    due_at: endsAt.toISOString(),
    message_payload: {
      ...messagePayload,
      phase,
      remaining_minutes: 0,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    },
    status: "pending",
  });

  const { error } = await supabaseAdmin
    .from("cycle_reminders")
    .insert(reminderRows);

  if (error) {
    console.warn("[cycle phase transition][reminders]", error.message);
  }
}

async function cancelPendingPhaseReminders({
  cycleId,
  phase,
}: {
  cycleId: number;
  phase: CyclePhaseStatus;
}) {
  const { error } = await supabaseAdmin
    .from("cycle_reminders")
    .update({ status: "cancelled" })
    .eq("cycle_id", cycleId)
    .eq("phase", phase)
    .eq("status", "pending");

  if (error) {
    console.warn(
      "[cycle phase transition][cancel reminders]",
      error.message
    );
  }
}

export async function recordCycleEvent({
  cycleId,
  eventType,
  actorType,
  actorDiscordUserId,
  payload,
}: CycleTransitionActor & {
  cycleId: number;
  eventType: string;
  payload: CycleEventPayload;
}) {
  await createCycleEvent({
    cycleId,
    eventType,
    actorType,
    actorDiscordUserId,
    payload,
  });
}

export async function startSubmissionPhase({
  cycleId,
  durationMinutes,
  theme,
  submissionWarnThreshold,
  actorType,
  actorDiscordUserId,
  expectedStatuses,
}: TransitionOptions & {
  cycleId: number;
  durationMinutes: number;
  theme?: string | null;
  submissionWarnThreshold?: number | null;
}) {
  assertPositiveDuration(durationMinutes);

  const startsAt = new Date();
  const endsAt = addMinutes(startsAt, durationMinutes);
  const normalizedTheme = normalizeOptionalString(theme);
  const updateValues: Record<string, unknown> = {
    status: "submission_open",
    submission_starts_at: startsAt.toISOString(),
    submission_ends_at: endsAt.toISOString(),
    paused_from_status: null,
    phase_paused_at: null,
    phase_paused_remaining_seconds: null,
    phase_pause_reason: null,
  };

  if (normalizedTheme !== undefined) {
    updateValues.theme = normalizedTheme;
  }

  if (
    typeof submissionWarnThreshold === "number" &&
    Number.isInteger(submissionWarnThreshold) &&
    submissionWarnThreshold > 0
  ) {
    updateValues.submission_warn_threshold =
      submissionWarnThreshold;
  }

  const cycle = await updateCycle(
    cycleId,
    updateValues,
    expectedStatuses
  );

  const payload = {
    phase: "submission_open",
    duration_minutes: durationMinutes,
    ends_at: endsAt.toISOString(),
    theme: normalizedTheme ?? null,
    submission_warn_threshold:
      updateValues.submission_warn_threshold ?? null,
  };

  await createCycleEvent({
    cycleId,
    eventType: "submission_phase_opened",
    actorType,
    actorDiscordUserId,
    payload,
  });

  await createCycleReminders({
    cycleId,
    phase: "submission_open",
    startsAt,
    endsAt,
    durationMinutes,
    messagePayload: payload,
  });

  return cycle;
}

export async function setSubmissionPhaseEnd({
  cycleId,
  durationMinutes,
  actorType,
  actorDiscordUserId,
  expectedStatuses,
}: TransitionOptions & {
  cycleId: number;
  durationMinutes: number;
}) {
  assertPositiveDuration(durationMinutes);

  const startsAt = new Date();
  const endsAt = addMinutes(startsAt, durationMinutes);
  const cycle = await updateCycle(
    cycleId,
    {
      status: "submission_open",
      submission_ends_at: endsAt.toISOString(),
    },
    expectedStatuses
  );
  const payload = {
    phase: "submission_open",
    duration_minutes: durationMinutes,
    ends_at: endsAt.toISOString(),
  };

  await createCycleEvent({
    cycleId,
    eventType: "submission_phase_timer_set",
    actorType,
    actorDiscordUserId,
    payload,
  });

  await cancelPendingPhaseReminders({
    cycleId,
    phase: "submission_open",
  });
  await createCycleReminders({
    cycleId,
    phase: "submission_open",
    startsAt,
    endsAt,
    durationMinutes,
    messagePayload: payload,
  });

  return cycle;
}

export async function closeSubmissionPhase({
  cycleId,
  actorType,
  actorDiscordUserId,
  expectedStatuses,
}: TransitionOptions & {
  cycleId: number;
}) {
  const cycle = await updateCycle(
    cycleId,
    { status: "submission_closed" },
    expectedStatuses
  );

  await cancelPendingPhaseReminders({
    cycleId,
    phase: "submission_open",
  });

  await createCycleEvent({
    cycleId,
    eventType: "submission_phase_closed",
    actorType,
    actorDiscordUserId,
    payload: { phase: "submission_closed" },
  });

  return cycle;
}

export async function startVotingPhaseWithoutTimer({
  cycleId,
  votesPerUser = DEFAULT_VOTES_PER_USER,
  actorType,
  actorDiscordUserId,
  expectedStatuses,
}: TransitionOptions & {
  cycleId: number;
  votesPerUser?: number;
}) {
  const startsAt = new Date();
  const normalizedVotesPerUser = normalizeVotesPerUser(votesPerUser);
  const cycle = await updateCycle(
    cycleId,
    {
      status: "voting_open",
      voting_starts_at: startsAt.toISOString(),
      voting_ends_at: null,
      votes_per_user: normalizedVotesPerUser,
      paused_from_status: null,
      phase_paused_at: null,
      phase_paused_remaining_seconds: null,
      phase_pause_reason: null,
    },
    expectedStatuses
  );

  await createCycleEvent({
    cycleId,
    eventType: "voting_phase_opened",
    actorType,
    actorDiscordUserId,
    payload: {
      phase: "voting_open",
      votes_per_user: normalizedVotesPerUser,
    },
  });

  return cycle;
}

export async function startVotingPhase({
  cycleId,
  durationMinutes,
  votesPerUser = DEFAULT_VOTES_PER_USER,
  actorType,
  actorDiscordUserId,
  expectedStatuses,
}: TransitionOptions & {
  cycleId: number;
  durationMinutes: number;
  votesPerUser?: number;
}) {
  assertPositiveDuration(durationMinutes);

  const startsAt = new Date();
  const endsAt = addMinutes(startsAt, durationMinutes);
  const normalizedVotesPerUser = normalizeVotesPerUser(votesPerUser);

  const cycle = await updateCycle(
    cycleId,
    {
      status: "voting_open",
      voting_starts_at: startsAt.toISOString(),
      voting_ends_at: endsAt.toISOString(),
      votes_per_user: normalizedVotesPerUser,
      paused_from_status: null,
      phase_paused_at: null,
      phase_paused_remaining_seconds: null,
      phase_pause_reason: null,
    },
    expectedStatuses
  );

  const payload = {
    phase: "voting_open",
    duration_minutes: durationMinutes,
    ends_at: endsAt.toISOString(),
    votes_per_user: normalizedVotesPerUser,
  };

  await createCycleEvent({
    cycleId,
    eventType: "voting_phase_opened",
    actorType,
    actorDiscordUserId,
    payload,
  });

  await createCycleReminders({
    cycleId,
    phase: "voting_open",
    startsAt,
    endsAt,
    durationMinutes,
    messagePayload: payload,
  });

  return cycle;
}

export async function setVotingPhaseEnd({
  cycleId,
  durationMinutes,
  actorType,
  actorDiscordUserId,
  expectedStatuses,
}: TransitionOptions & {
  cycleId: number;
  durationMinutes: number;
}) {
  assertPositiveDuration(durationMinutes);

  const startsAt = new Date();
  const endsAt = addMinutes(startsAt, durationMinutes);
  const cycle = await updateCycle(
    cycleId,
    {
      status: "voting_open",
      voting_ends_at: endsAt.toISOString(),
    },
    expectedStatuses
  );
  const payload = {
    phase: "voting_open",
    duration_minutes: durationMinutes,
    ends_at: endsAt.toISOString(),
  };

  await createCycleEvent({
    cycleId,
    eventType: "voting_phase_timer_set",
    actorType,
    actorDiscordUserId,
    payload,
  });

  await cancelPendingPhaseReminders({
    cycleId,
    phase: "voting_open",
  });
  await createCycleReminders({
    cycleId,
    phase: "voting_open",
    startsAt,
    endsAt,
    durationMinutes,
    messagePayload: payload,
  });

  return cycle;
}

export async function closeVotingPhase({
  cycleId,
  actorType,
  actorDiscordUserId,
  expectedStatuses,
}: TransitionOptions & {
  cycleId: number;
}) {
  const cycle = await updateCycle(
    cycleId,
    { status: "voting_closed" },
    expectedStatuses
  );

  await cancelPendingPhaseReminders({
    cycleId,
    phase: "voting_open",
  });

  await createCycleEvent({
    cycleId,
    eventType: "voting_phase_closed",
    actorType,
    actorDiscordUserId,
    payload: { phase: "voting_closed" },
  });

  return cycle;
}

export async function clearPhaseTimer({
  cycleId,
  phase,
  actorType,
  actorDiscordUserId,
}: CycleTransitionActor & {
  cycleId: number;
  phase: "submission_open" | "voting_open";
}) {
  const timerField =
    phase === "submission_open"
      ? "submission_ends_at"
      : "voting_ends_at";
  const cycle = await updateCycle(
    cycleId,
    { [timerField]: null },
    [phase]
  );

  await cancelPendingPhaseReminders({ cycleId, phase });
  await createCycleEvent({
    cycleId,
    eventType: `${phase}_timer_cleared`,
    actorType,
    actorDiscordUserId,
    payload: { phase },
  });

  return cycle;
}

export async function setCycleVotesPerUser({
  cycleId,
  votesPerUser,
  actorType,
  actorDiscordUserId,
}: CycleTransitionActor & {
  cycleId: number;
  votesPerUser: number;
}) {
  const normalizedVotesPerUser = normalizeVotesPerUser(votesPerUser);
  const cycle = await updateCycle(
    cycleId,
    { votes_per_user: normalizedVotesPerUser },
    ["submission_open"]
  );

  await createCycleEvent({
    cycleId,
    eventType: "voting_rule_updated",
    actorType,
    actorDiscordUserId,
    payload: {
      phase: "submission_open",
      votes_per_user: normalizedVotesPerUser,
    },
  });

  return cycle;
}

type PausablePhase = "submission_open" | "voting_open";

type PausableCycleRow = {
  id: number;
  status: string;
  submission_ends_at: string | null;
  voting_ends_at: string | null;
  paused_from_status: string | null;
  phase_paused_remaining_seconds: number | null;
};

async function getPausableCycle(cycleId: number) {
  const { data, error } = await supabaseAdmin
    .from("voting_cycles")
    .select(
      "id, status, submission_ends_at, voting_ends_at, paused_from_status, phase_paused_remaining_seconds"
    )
    .eq("id", cycleId)
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? `Cycle ${cycleId} not found`);
  }

  return data as PausableCycleRow;
}

export async function pauseCyclePhase({
  cycleId,
  reason,
  actorType,
  actorDiscordUserId,
}: CycleTransitionActor & {
  cycleId: number;
  reason?: string | null;
}) {
  const cycle = await getPausableCycle(cycleId);

  if (
    cycle.status !== "submission_open" &&
    cycle.status !== "voting_open"
  ) {
    throw new Error("Only an active submission or voting phase can be paused");
  }

  const phase = cycle.status as PausablePhase;
  const endAt =
    phase === "submission_open"
      ? cycle.submission_ends_at
      : cycle.voting_ends_at;
  const remainingSeconds = endAt
    ? Math.max(
        0,
        Math.ceil((new Date(endAt).getTime() - Date.now()) / 1000)
      )
    : null;
  const pausedAt = new Date().toISOString();
  const normalizedReason = normalizeOptionalString(reason) ?? null;

  const updatedCycle = await updateCycle(
    cycleId,
    {
      status: "paused",
      paused_from_status: phase,
      phase_paused_at: pausedAt,
      phase_paused_remaining_seconds: remainingSeconds,
      phase_pause_reason: normalizedReason,
    },
    [phase]
  );

  await cancelPendingPhaseReminders({ cycleId, phase });
  await createCycleEvent({
    cycleId,
    eventType: "cycle_phase_paused",
    actorType,
    actorDiscordUserId,
    payload: {
      phase,
      paused_at: pausedAt,
      remaining_seconds: remainingSeconds,
      reason: normalizedReason,
    },
  });

  return updatedCycle;
}

export async function resumeCyclePhase({
  cycleId,
  actorType,
  actorDiscordUserId,
}: CycleTransitionActor & {
  cycleId: number;
}) {
  const cycle = await getPausableCycle(cycleId);

  if (
    cycle.status !== "paused" ||
    (cycle.paused_from_status !== "submission_open" &&
      cycle.paused_from_status !== "voting_open")
  ) {
    throw new Error("Cycle does not contain a resumable phase");
  }

  const phase = cycle.paused_from_status as PausablePhase;
  const remainingSeconds = cycle.phase_paused_remaining_seconds;
  const resumedAt = new Date();
  const resumedEndAt =
    remainingSeconds === null
      ? null
      : new Date(resumedAt.getTime() + remainingSeconds * 1000);
  const timerField =
    phase === "submission_open"
      ? "submission_ends_at"
      : "voting_ends_at";

  const updatedCycle = await updateCycle(
    cycleId,
    {
      status: phase,
      [timerField]: resumedEndAt?.toISOString() ?? null,
      paused_from_status: null,
      phase_paused_at: null,
      phase_paused_remaining_seconds: null,
      phase_pause_reason: null,
    },
    ["paused"]
  );

  await createCycleEvent({
    cycleId,
    eventType: "cycle_phase_resumed",
    actorType,
    actorDiscordUserId,
    payload: {
      phase,
      resumed_at: resumedAt.toISOString(),
      ends_at: resumedEndAt?.toISOString() ?? null,
      remaining_seconds: remainingSeconds,
    },
  });

  if (resumedEndAt && remainingSeconds && remainingSeconds > 0) {
    await createCycleReminders({
      cycleId,
      phase,
      startsAt: resumedAt,
      endsAt: resumedEndAt,
      durationMinutes: Math.max(1, Math.ceil(remainingSeconds / 60)),
      messagePayload: {
        phase,
        resumed: true,
        ends_at: resumedEndAt.toISOString(),
      },
    });
  }

  return updatedCycle;
}

export async function markCycleFinalizing({
  cycleId,
  actorType,
  actorDiscordUserId,
  expectedStatuses,
}: TransitionOptions & {
  cycleId: number;
}) {
  const cycle = await updateCycle(
    cycleId,
    { status: "finalizing" },
    expectedStatuses
  );

  await createCycleEvent({
    cycleId,
    eventType: "cycle_finalizing",
    actorType,
    actorDiscordUserId,
    payload: { phase: "finalizing" },
  });

  return cycle;
}

export async function markCycleCompleted({
  cycleId,
  actorType,
  actorDiscordUserId,
  expectedStatuses,
}: TransitionOptions & {
  cycleId: number;
}) {
  const resultsPublishedAt = new Date();
  const cycle = await updateCycle(
    cycleId,
    {
      status: "completed",
      results_published_at: resultsPublishedAt.toISOString(),
    },
    expectedStatuses
  );

  await createCycleEvent({
    cycleId,
    eventType: "cycle_completed",
    actorType,
    actorDiscordUserId,
    payload: {
      phase: "completed",
      results_published_at: resultsPublishedAt.toISOString(),
    },
  });

  return cycle;
}

export async function archiveCycle({
  cycleId,
  actorType,
  actorDiscordUserId,
  expectedStatuses,
}: TransitionOptions & {
  cycleId: number;
}) {
  const archivedAt = new Date();
  const cycle = await updateCycle(
    cycleId,
    {
      status: "archived",
      archived_at: archivedAt.toISOString(),
    },
    expectedStatuses
  );

  await createCycleEvent({
    cycleId,
    eventType: "cycle_archived",
    actorType,
    actorDiscordUserId,
    payload: {
      phase: "archived",
      archived_at: archivedAt.toISOString(),
    },
  });

  return cycle;
}

export async function cancelCycle({
  cycleId,
  actorType,
  actorDiscordUserId,
  expectedStatuses,
}: TransitionOptions & {
  cycleId: number;
}) {
  const cycle = await updateCycle(
    cycleId,
    { status: "cancelled" },
    expectedStatuses
  );

  await createCycleEvent({
    cycleId,
    eventType: "cycle_cancelled",
    actorType,
    actorDiscordUserId,
    payload: { phase: "cancelled" },
  });

  return cycle;
}

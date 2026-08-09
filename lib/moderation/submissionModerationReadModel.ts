import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import type { LiveSubmissionModerationPhase } from "@/lib/moderation/submissionModerationAuthorization";

export type CurrentModerationCycle = Readonly<{
  id: number;
  status: LiveSubmissionModerationPhase;
}>;

export type CurrentCycleEndModerationCycle = Readonly<{
  id: number;
  status: "voting_closed";
}>;

export const CYCLE_END_MODERATION_PAGE_SIZE = 48;

function readUnavailable(code: string) {
  return new AuthError(
    503,
    "Submission moderation is temporarily unavailable",
    code
  );
}

export async function getCurrentModerationCycle(): Promise<CurrentModerationCycle | null> {
  const { data, error } = await supabaseAdmin
    .from("voting_cycles")
    .select("id, status")
    .in("status", ["submission_open", "voting_open"])
    .order("id", { ascending: false })
    .limit(2);

  if (error) {
    console.error("[SUBMISSION_MODERATION] cycle read failed", {
      code: error.code,
    });
    throw readUnavailable("MODERATION_CYCLE_READ_UNAVAILABLE");
  }

  if ((data?.length ?? 0) > 1) {
    console.error("[SUBMISSION_MODERATION] multiple current cycles");
    throw readUnavailable("MODERATION_CYCLE_INVARIANT_BROKEN");
  }

  const cycle = data?.[0];
  if (!cycle) return null;
  if (
    cycle.status !== "submission_open" &&
    cycle.status !== "voting_open"
  ) {
    throw readUnavailable("MODERATION_CYCLE_SHAPE_INVALID");
  }

  return Object.freeze({ id: cycle.id, status: cycle.status });
}

async function getCurrentCycleEndModerationCycle(): Promise<CurrentCycleEndModerationCycle | null> {
  const { data, error } = await supabaseAdmin
    .from("voting_cycles")
    .select("id, status")
    .eq("status", "voting_closed")
    .order("id", { ascending: false })
    .limit(2);

  if (error) {
    console.error("[CYCLE_END_MODERATION] cycle read failed", {
      code: error.code,
    });
    throw readUnavailable("CYCLE_END_MODERATION_CYCLE_UNAVAILABLE");
  }

  if ((data?.length ?? 0) > 1) {
    console.error("[CYCLE_END_MODERATION] multiple current cycles");
    throw readUnavailable("CYCLE_END_MODERATION_INVARIANT_BROKEN");
  }

  const cycle = data?.[0];
  if (!cycle) return null;
  if (cycle.status !== "voting_closed") {
    throw readUnavailable("CYCLE_END_MODERATION_SHAPE_INVALID");
  }

  return Object.freeze({ id: cycle.id, status: cycle.status });
}

async function getCycleEndModerationSubmissions(
  cycleId: number,
  page: number,
  focusedSubmissionId: number | null = null
) {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new TypeError("Invalid Cycle End Moderation page");
  }

  if (
    focusedSubmissionId !== null &&
    (!Number.isSafeInteger(focusedSubmissionId) || focusedSubmissionId <= 0)
  ) {
    throw new TypeError("Invalid focused Submission");
  }

  const from = focusedSubmissionId === null
    ? (page - 1) * CYCLE_END_MODERATION_PAGE_SIZE
    : 0;
  const to = focusedSubmissionId === null
    ? from + CYCLE_END_MODERATION_PAGE_SIZE - 1
    : 0;
  let query = supabaseAdmin
    .from("submissions")
    .select(
      "id, cycle_id, r2_key, is_disqualified, discord_user_id, vote_refund_id, vote_refunded_at",
      { count: "exact" }
    )
    .eq("cycle_id", cycleId)
    .order("id", { ascending: false });
  if (focusedSubmissionId !== null) {
    query = query.eq("id", focusedSubmissionId);
  }
  const { data, error, count } = await query.range(from, to);

  if (error) {
    console.error("[CYCLE_END_MODERATION] submission read failed", {
      code: error.code,
    });
    throw readUnavailable("CYCLE_END_MODERATION_SUBMISSIONS_UNAVAILABLE");
  }

  return Object.freeze({
    items: Object.freeze(data ?? []),
    page: focusedSubmissionId === null ? page : 1,
    total: count ?? 0,
    hasPrevious: focusedSubmissionId === null && page > 1,
    hasNext: focusedSubmissionId === null && to + 1 < (count ?? 0),
  });
}

export async function loadCycleEndModerationReadModel(
  page: number,
  focusedSubmissionId: number | null = null
) {
  await requireDynamicTeamCapability("cycles.manage");
  const cycle = await getCurrentCycleEndModerationCycle();

  return Object.freeze({
    cycle,
    submissions: cycle
      ? await getCycleEndModerationSubmissions(
          cycle.id,
          page,
          focusedSubmissionId
        )
      : null,
  });
}

export async function getLiveModerationSubmissions(
  cycleId: number,
  focusedSubmissionId: number | null = null
) {
  if (
    focusedSubmissionId !== null &&
    (!Number.isSafeInteger(focusedSubmissionId) || focusedSubmissionId <= 0)
  ) {
    throw new TypeError("Invalid focused Submission");
  }

  let query = supabaseAdmin
    .from("submissions")
    .select(
      "id, cycle_id, r2_key, is_disqualified, discord_user_id, vote_refund_id, vote_refunded_at"
    )
    .eq("cycle_id", cycleId)
    .order("id", { ascending: false });
  if (focusedSubmissionId !== null) {
    query = query.eq("id", focusedSubmissionId);
  }
  const { data, error } = await query.limit(
    focusedSubmissionId === null ? 50 : 1
  );

  if (error) {
    console.error("[SUBMISSION_MODERATION] submission read failed", {
      code: error.code,
    });
    throw readUnavailable("MODERATION_SUBMISSION_READ_UNAVAILABLE");
  }

  return data ?? [];
}

export async function getDisqualifiedModerationSubmissions(
  cycleId: number
) {
  const { data, error } = await supabaseAdmin
    .from("submissions")
    .select(
      "id, cycle_id, r2_key, is_disqualified, disqualification_reason_code, disqualification_reason_text, disqualified_at, disqualified_by_discord_username, discord_user_id, vote_refund_id, vote_refunded_at"
    )
    .eq("cycle_id", cycleId)
    .eq("is_disqualified", true)
    .order("disqualified_at", { ascending: false });

  if (error) {
    console.error("[SUBMISSION_MODERATION] disqualified read failed", {
      code: error.code,
    });
    throw readUnavailable("MODERATION_SUBMISSION_READ_UNAVAILABLE");
  }

  return data ?? [];
}

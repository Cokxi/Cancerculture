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
  page: number
) {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new TypeError("Invalid Cycle End Moderation page");
  }

  const from = (page - 1) * CYCLE_END_MODERATION_PAGE_SIZE;
  const to = from + CYCLE_END_MODERATION_PAGE_SIZE - 1;
  const { data, error, count } = await supabaseAdmin
    .from("submissions")
    .select(
      "id, cycle_id, r2_key, is_disqualified, discord_user_id, vote_refund_id, vote_refunded_at",
      { count: "exact" }
    )
    .eq("cycle_id", cycleId)
    .order("id", { ascending: false })
    .range(from, to);

  if (error) {
    console.error("[CYCLE_END_MODERATION] submission read failed", {
      code: error.code,
    });
    throw readUnavailable("CYCLE_END_MODERATION_SUBMISSIONS_UNAVAILABLE");
  }

  return Object.freeze({
    items: Object.freeze(data ?? []),
    page,
    total: count ?? 0,
    hasPrevious: page > 1,
    hasNext: to + 1 < (count ?? 0),
  });
}

export async function loadCycleEndModerationReadModel(page: number) {
  await requireDynamicTeamCapability("cycles.manage");
  const cycle = await getCurrentCycleEndModerationCycle();

  return Object.freeze({
    cycle,
    submissions: cycle
      ? await getCycleEndModerationSubmissions(cycle.id, page)
      : null,
  });
}

export async function getLiveModerationSubmissions(cycleId: number) {
  const { data, error } = await supabaseAdmin
    .from("submissions")
    .select(
      "id, cycle_id, r2_key, is_disqualified, discord_user_id, vote_refund_id, vote_refunded_at"
    )
    .eq("cycle_id", cycleId)
    .order("id", { ascending: false })
    .limit(50);

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

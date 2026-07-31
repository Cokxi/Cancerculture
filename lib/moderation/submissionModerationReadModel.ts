import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { supabaseAdmin } from "@/lib/db/admin";
import type { SubmissionModerationPhase } from "@/lib/moderation/submissionModerationAuthorization";

export type CurrentModerationCycle = Readonly<{
  id: number;
  status: SubmissionModerationPhase;
}>;

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

export async function getLiveModerationSubmissions(cycleId: number) {
  const { data, error } = await supabaseAdmin
    .from("submissions")
    .select(
      "id, cycle_id, r2_key, is_disqualified, discord_user_id"
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
      "id, cycle_id, r2_key, is_disqualified, disqualification_reason_code, disqualification_reason_text, disqualified_at, disqualified_by_discord_username, discord_user_id"
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

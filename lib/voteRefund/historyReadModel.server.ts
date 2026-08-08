import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import { formatDiscordUserLabel } from "@/lib/discord/formatDiscordUserLabel";

export const VOTE_REFUND_HISTORY_PAGE_SIZE = 25;

export type VoteRefundHistorySubmission = Readonly<{
  submissionId: number;
  refundedVoteCount: number;
}>;

export type VoteRefundHistoryEntry = Readonly<{
  id: string;
  occurredAt: string;
  actorDiscordUserId: string;
  actorLabel: string | null;
  actorPublicProfileId: string | null;
  cycleId: number;
  resetCount: number;
  votesPerUser: number;
  selectionCount: number;
  refundedVoteCount: number;
  affectedVoterCount: number;
  submissionRefunds: readonly VoteRefundHistorySubmission[];
  reasonCategory: "confirmed_disqualification";
  adminAudit: Readonly<{
    reasonText: string;
    actorRole: string;
    requiredCapability: string;
    requestHash: string;
  }> | null;
}>;

export type VoteRefundHistoryReadModel = Readonly<{
  entries: readonly VoteRefundHistoryEntry[];
  page: number;
  pageSize: number;
  total: number;
  isAdmin: boolean;
}>;

type EventRow = {
  idempotency_key: string;
  created_at: string;
  actor_discord_user_id: string;
  actor_role: string;
  required_capability: string;
  cycle_id: number;
  reset_count: number;
  votes_per_user: number;
  selection_count: number;
  refunded_vote_count: number;
  affected_voter_count: number;
  submission_refunds: unknown;
  reason_code: string;
  reason_text?: string;
  request_hash?: string;
};

type UserRow = {
  discord_user_id: string;
  current_discord_username: string | null;
  current_discord_handle?: string | null;
  current_display_name?: string | null;
  current_guild_nickname?: string | null;
  public_profile_id?: string | null;
};

function historyUnavailable() {
  return new AuthError(
    503,
    "Vote refund history is temporarily unavailable",
    "VOTE_REFUND_HISTORY_UNAVAILABLE"
  );
}

function parseSubmissionRefunds(
  value: unknown
): readonly VoteRefundHistorySubmission[] | null {
  if (!Array.isArray(value)) return null;
  const result: VoteRefundHistorySubmission[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (
      !Number.isSafeInteger(row.submissionId) ||
      !Number.isSafeInteger(row.refundedVoteCount)
    ) {
      return null;
    }
    result.push(
      Object.freeze({
        submissionId: Number(row.submissionId),
        refundedVoteCount: Number(row.refundedVoteCount),
      })
    );
  }
  return Object.freeze(result);
}

export async function loadVoteRefundHistoryReadModel({
  page,
}: {
  page: number;
}): Promise<VoteRefundHistoryReadModel> {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > Math.floor(Number.MAX_SAFE_INTEGER / VOTE_REFUND_HISTORY_PAGE_SIZE)
  ) {
    throw new TypeError("Invalid Vote Refund History page");
  }

  const authorization = await requireDynamicTeamCapability(
    "logs.vote_refunds.view"
  );
  const offset = (page - 1) * VOTE_REFUND_HISTORY_PAGE_SIZE;
  const columns = [
    "idempotency_key",
    "created_at",
    "actor_discord_user_id",
    "actor_role",
    "required_capability",
    "cycle_id",
    "reset_count",
    "votes_per_user",
    "selection_count",
    "refunded_vote_count",
    "affected_voter_count",
    "submission_refunds",
    "reason_code",
    ...(authorization.isAdmin ? ["reason_text", "request_hash"] : []),
  ].join(", ");
  const eventResult = await supabaseAdmin
    .from("vote_refund_events")
    .select(columns, { count: "exact" })
    .order("created_at", { ascending: false })
    .order("idempotency_key", { ascending: false })
    .range(offset, offset + VOTE_REFUND_HISTORY_PAGE_SIZE - 1);

  if (eventResult.error || !Number.isSafeInteger(eventResult.count)) {
    console.error("[VOTE_REFUND_HISTORY] event read failed", {
      errorCode: eventResult.error?.code ?? null,
    });
    throw historyUnavailable();
  }

  const rows = (eventResult.data ?? []) as unknown as EventRow[];
  const actorIds = [...new Set(rows.map((row) => row.actor_discord_user_id))];
  const actorResult = actorIds.length
    ? await supabaseAdmin
        .from("user_logs")
        .select(
          authorization.isAdmin
            ? "discord_user_id, public_profile_id, current_discord_username, current_discord_handle, current_display_name, current_guild_nickname"
            : "discord_user_id, current_discord_username"
        )
        .in("discord_user_id", actorIds)
    : { data: [], error: null };

  if (actorResult.error) {
    console.error("[VOTE_REFUND_HISTORY] actor display lookup failed", {
      errorCode: actorResult.error.code,
    });
  }

  const actors = new Map(
    ((actorResult.data ?? []) as unknown as UserRow[]).map((actor) => [
      actor.discord_user_id,
      actor,
    ])
  );
  const entries = rows.map((row) => {
    const submissionRefunds = parseSubmissionRefunds(row.submission_refunds);
    if (!submissionRefunds || row.reason_code !== "confirmed_disqualification") {
      throw historyUnavailable();
    }
    const actor = actors.get(row.actor_discord_user_id);
    const actorLabel = actor
      ? authorization.isAdmin
        ? formatDiscordUserLabel(actor, "admin")
        : actor.current_discord_username?.trim() || null
      : null;

    return Object.freeze({
      id: row.idempotency_key,
      occurredAt: row.created_at,
      actorDiscordUserId: row.actor_discord_user_id,
      actorLabel,
      actorPublicProfileId:
        authorization.isAdmin && actor ? actor.public_profile_id ?? null : null,
      cycleId: row.cycle_id,
      resetCount: row.reset_count,
      votesPerUser: row.votes_per_user,
      selectionCount: row.selection_count,
      refundedVoteCount: row.refunded_vote_count,
      affectedVoterCount: row.affected_voter_count,
      submissionRefunds,
      reasonCategory: "confirmed_disqualification" as const,
      adminAudit: authorization.isAdmin
        ? Object.freeze({
            reasonText: row.reason_text ?? "",
            actorRole: row.actor_role,
            requiredCapability: row.required_capability,
            requestHash: row.request_hash ?? "",
          })
        : null,
    });
  });

  return Object.freeze({
    entries: Object.freeze(entries),
    page,
    pageSize: VOTE_REFUND_HISTORY_PAGE_SIZE,
    total: eventResult.count ?? 0,
    isAdmin: authorization.isAdmin,
  });
}

import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import {
  hasResolvedTeamCapability,
  requireDynamicTeamCapability,
} from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import { formatDiscordUserLabel } from "@/lib/discord/formatDiscordUserLabel";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { getSubmissionThumbnailUrl } from "@/lib/r2/getSubmissionThumbnailUrl";

export const VOTE_REFUND_HISTORY_PAGE_SIZE = 10;

export type VoteRefundHistoryUser = Readonly<{
  discordUserId: string;
  label: string | null;
  publicProfileId: string | null;
}>;

export type VoteRefundHistoryAction = Readonly<{
  id: string;
  occurredAt: string;
  actor: VoteRefundHistoryUser;
  votesPerUser: number;
  refundedVoteCount: number;
  reasonCategory: "confirmed_disqualification";
  refundedVoters: readonly VoteRefundHistoryUser[] | null;
  adminAudit: Readonly<{
    reasonText: string | null;
    actorRole: string;
    requiredCapability: string;
  }> | null;
}>;

export type VoteRefundHistorySubmission = Readonly<{
  submissionId: number;
  refundedVoteCount: number;
  thumbnailUrl: string | null;
  submitter: VoteRefundHistoryUser | null;
  actions: readonly VoteRefundHistoryAction[];
}>;

export type VoteRefundHistoryCycle = Readonly<{
  cycleId: number;
  resetCount: number;
  refundedVoteCount: number;
  submissions: readonly VoteRefundHistorySubmission[];
}>;

export type VoteRefundHistoryReadModel = Readonly<{
  cycles: readonly VoteRefundHistoryCycle[];
  page: number;
  pageSize: number;
  total: number;
  isAdmin: boolean;
  canViewRefundedVoters: boolean;
}>;

type EventSubmissionRefund = Readonly<{
  submissionId: number;
  refundedVoteCount: number;
}>;

type EventRow = {
  idempotency_key: string;
  created_at: string;
  actor_discord_user_id: string;
  actor_discord_username: string;
  actor_role: string;
  required_capability: string;
  cycle_id: number;
  reset_count: number;
  votes_per_user: number;
  submission_refunds: unknown;
  reason_code: string;
  reason_text?: string | null;
};

type SubmissionRow = {
  id: number;
  r2_key: string | null;
  discord_user_id: string | null;
  discord_username_at_upload: string | null;
};

type RefundSubmissionAuditRow = {
  refund_id: string;
  submission_id: number;
  refunded_vote_count: number;
  refunded_voter_ids: string[];
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
): readonly EventSubmissionRefund[] | null {
  if (!Array.isArray(value)) return null;
  const result: EventSubmissionRefund[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (
      !Number.isSafeInteger(row.submissionId) ||
      Number(row.submissionId) <= 0 ||
      !Number.isSafeInteger(row.refundedVoteCount) ||
      Number(row.refundedVoteCount) <= 0
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

function userIdentity(
  discordUserId: string,
  users: ReadonlyMap<string, UserRow>,
  isAdmin: boolean,
  fallbackLabel: string | null = null
): VoteRefundHistoryUser {
  const user = users.get(discordUserId);
  return Object.freeze({
    discordUserId,
    label: user
      ? isAdmin
        ? formatDiscordUserLabel(user, "admin")
        : user.current_discord_username?.trim() || fallbackLabel
      : fallbackLabel,
    publicProfileId: isAdmin && user ? user.public_profile_id ?? null : null,
  });
}

function submissionAuditKey(refundId: string, submissionId: number) {
  return `${refundId}:${submissionId}`;
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
  const canViewRefundedVoters = hasResolvedTeamCapability(
    authorization,
    "logs.votes.view"
  );
  const offset = (page - 1) * VOTE_REFUND_HISTORY_PAGE_SIZE;
  const columns = [
    "idempotency_key",
    "created_at",
    "actor_discord_user_id",
    "actor_discord_username",
    "actor_role",
    "required_capability",
    "cycle_id",
    "reset_count",
    "votes_per_user",
    "submission_refunds",
    "reason_code",
    ...(authorization.isAdmin ? ["reason_text"] : []),
  ].join(", ");
  const eventResult = await supabaseAdmin
    .from("vote_refund_events")
    .select(columns, { count: "exact" })
    .order("cycle_id", { ascending: false })
    .order("reset_count", { ascending: false })
    .order("refunded_vote_count", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + VOTE_REFUND_HISTORY_PAGE_SIZE - 1);

  if (eventResult.error || !Number.isSafeInteger(eventResult.count)) {
    console.error("[VOTE_REFUND_HISTORY] event read failed", {
      errorCode: eventResult.error?.code ?? null,
    });
    throw historyUnavailable();
  }

  const rows = (eventResult.data ?? []) as unknown as EventRow[];
  const parsedRows = rows.map((row) => {
    const submissionRefunds = parseSubmissionRefunds(row.submission_refunds);
    if (!submissionRefunds || row.reason_code !== "confirmed_disqualification") {
      throw historyUnavailable();
    }
    return Object.freeze({ row, submissionRefunds });
  });
  const eventIds = rows.map((row) => row.idempotency_key);
  const submissionIds = [
    ...new Set(
      parsedRows.flatMap(({ submissionRefunds }) =>
        submissionRefunds.map((submission) => submission.submissionId)
      )
    ),
  ];

  const [submissionResult, auditResult] = await Promise.all([
    submissionIds.length
      ? supabaseAdmin
          .from("submissions")
          .select("id, r2_key, discord_user_id, discord_username_at_upload")
          .in("id", submissionIds)
      : Promise.resolve({ data: [], error: null }),
    canViewRefundedVoters && eventIds.length
      ? supabaseAdmin
          .from("vote_refund_submission_audit")
          .select(
            "refund_id, submission_id, refunded_vote_count, refunded_voter_ids"
          )
          .in("refund_id", eventIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (submissionResult.error || auditResult.error) {
    console.error("[VOTE_REFUND_HISTORY] context read failed", {
      submissionErrorCode: submissionResult.error?.code ?? null,
      auditErrorCode: auditResult.error?.code ?? null,
    });
    throw historyUnavailable();
  }

  const submissions = new Map(
    ((submissionResult.data ?? []) as SubmissionRow[]).map((submission) => [
      submission.id,
      submission,
    ])
  );
  const auditRows = (auditResult.data ?? []) as RefundSubmissionAuditRow[];
  const auditBySubmission = new Map(
    auditRows.map((row) => [
      submissionAuditKey(row.refund_id, row.submission_id),
      row,
    ])
  );
  const identityIds = new Set(rows.map((row) => row.actor_discord_user_id));
  for (const submission of submissions.values()) {
    if (submission.discord_user_id) identityIds.add(submission.discord_user_id);
  }
  if (canViewRefundedVoters) {
    for (const row of auditRows) {
      for (const voterId of row.refunded_voter_ids) identityIds.add(voterId);
    }
  }

  const identityResult = identityIds.size
    ? await supabaseAdmin
        .from("user_logs")
        .select(
          authorization.isAdmin
            ? "discord_user_id, public_profile_id, current_discord_username, current_discord_handle, current_display_name, current_guild_nickname"
            : "discord_user_id, current_discord_username"
        )
        .in("discord_user_id", [...identityIds])
    : { data: [], error: null };

  if (identityResult.error) {
    console.error("[VOTE_REFUND_HISTORY] identity lookup failed", {
      errorCode: identityResult.error.code,
    });
  }
  const users = new Map(
    ((identityResult.data ?? []) as unknown as UserRow[]).map((user) => [
      user.discord_user_id,
      user,
    ])
  );

  const cycleGroups = new Map<
    string,
    {
      cycleId: number;
      resetCount: number;
      submissions: Map<
        number,
        {
          refundedVoteCount: number;
          actions: VoteRefundHistoryAction[];
        }
      >;
    }
  >();

  for (const { row, submissionRefunds } of parsedRows) {
    const cycleKey = `${row.cycle_id}:${row.reset_count}`;
    const cycleGroup = cycleGroups.get(cycleKey) ?? {
      cycleId: row.cycle_id,
      resetCount: row.reset_count,
      submissions: new Map(),
    };
    cycleGroups.set(cycleKey, cycleGroup);

    for (const submissionRefund of submissionRefunds) {
      const audit = canViewRefundedVoters
        ? auditBySubmission.get(
            submissionAuditKey(
              row.idempotency_key,
              submissionRefund.submissionId
            )
          )
        : null;
      if (
        canViewRefundedVoters &&
        (!audit || audit.refunded_vote_count !== submissionRefund.refundedVoteCount)
      ) {
        throw historyUnavailable();
      }
      const submissionGroup = cycleGroup.submissions.get(
        submissionRefund.submissionId
      ) ?? { refundedVoteCount: 0, actions: [] };
      submissionGroup.refundedVoteCount += submissionRefund.refundedVoteCount;
      submissionGroup.actions.push(
        Object.freeze({
          id: row.idempotency_key,
          occurredAt: row.created_at,
          actor: userIdentity(
            row.actor_discord_user_id,
            users,
            authorization.isAdmin,
            row.actor_discord_username
          ),
          votesPerUser: row.votes_per_user,
          refundedVoteCount: submissionRefund.refundedVoteCount,
          reasonCategory: "confirmed_disqualification" as const,
          refundedVoters: canViewRefundedVoters
            ? Object.freeze(
                (audit?.refunded_voter_ids ?? []).map((voterId) =>
                  userIdentity(voterId, users, authorization.isAdmin)
                )
              )
            : null,
          adminAudit: authorization.isAdmin
            ? Object.freeze({
                reasonText: row.reason_text?.trim() || null,
                actorRole: row.actor_role,
                requiredCapability: row.required_capability,
              })
            : null,
        })
      );
      cycleGroup.submissions.set(
        submissionRefund.submissionId,
        submissionGroup
      );
    }
  }

  const cycles = [...cycleGroups.values()]
    .sort(
      (left, right) =>
        right.cycleId - left.cycleId || right.resetCount - left.resetCount
    )
    .map((cycleGroup) => {
      const groupedSubmissions = [...cycleGroup.submissions.entries()]
        .map(([submissionId, group]) => {
          const submission = submissions.get(submissionId);
          const imageUrl = getPublicImageUrl(submission?.r2_key);
          return Object.freeze({
            submissionId,
            refundedVoteCount: group.refundedVoteCount,
            thumbnailUrl: imageUrl
              ? getSubmissionThumbnailUrl(imageUrl)
              : null,
            submitter: submission?.discord_user_id
              ? userIdentity(
                  submission.discord_user_id,
                  users,
                  authorization.isAdmin,
                  submission.discord_username_at_upload
                )
              : null,
            actions: Object.freeze(
              group.actions.sort(
                (left, right) =>
                  Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
              )
            ),
          });
        })
        .sort(
          (left, right) =>
            right.refundedVoteCount - left.refundedVoteCount ||
            right.submissionId - left.submissionId
        );
      return Object.freeze({
        cycleId: cycleGroup.cycleId,
        resetCount: cycleGroup.resetCount,
        refundedVoteCount: groupedSubmissions.reduce(
          (total, submission) => total + submission.refundedVoteCount,
          0
        ),
        submissions: Object.freeze(groupedSubmissions),
      });
    });

  return Object.freeze({
    cycles: Object.freeze(cycles),
    page,
    pageSize: VOTE_REFUND_HISTORY_PAGE_SIZE,
    total: eventResult.count ?? 0,
    isAdmin: authorization.isAdmin,
    canViewRefundedVoters,
  });
}

import "server-only";

import { requirePublicCycleNumber } from "@/lib/cycles/publicCycleNumber";
import { supabaseAdmin } from "@/lib/db/admin";
import { getPreferredDiscordName } from "@/lib/discord/getPreferredDiscordName";
import {
  COMMUNITY_FEED_CLASSIFICATION_VERSION,
  canonicalFeedTimestamp,
} from "@/lib/feed/communityFeed";
import {
  getCommunityFeedDetailMediaPath,
  type CommunityFeedDetailAuthor,
  type CommunityFeedDetail,
} from "@/lib/feed/communityFeedDetail";
import { getPublicProfileAvatarPath } from "@/lib/profile/publicDiscordAvatar";

const LIVE_CYCLE_STATUSES = [
  "submission_open",
  "submission_closed",
  "voting_open",
  "voting_closed",
  "paused",
  "active",
] as const;

const FINALIZED_DETAIL_SELECT = `
  cycle_id,
  submission_id,
  final_vote_count,
  rank_in_cycle,
  finalized_at,
  feed_classification_version,
  feed_eligible,
  submissions!inner(
    id,
    cycle_id,
    r2_key,
    media_width,
    media_height,
    created_at,
    discord_user_id,
    public_visibility_status,
    is_disqualified
  ),
  voting_cycles!inner(
    id,
    public_number,
    status,
    starts_at,
    ends_at
  )
`;

type DetailCycleRow = {
  id: number;
  public_number: number | null;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  reset_count?: number | null;
};

type DetailSubmissionRow = {
  id: number;
  cycle_id: number;
  r2_key: string | null;
  media_width: number | null;
  media_height: number | null;
  created_at: string;
  discord_user_id?: string;
};

type DetailAuthorRow = {
  public_profile_id: string | null;
  current_guild_nickname: string | null;
  current_display_name: string | null;
  current_discord_handle: string | null;
  current_discord_username: string | null;
  avatar_key: string | null;
  avatar_updated_at: string | null;
  discord_avatar: string | null;
};

type FinalizedDetailRow = {
  cycle_id: number;
  submission_id: number;
  final_vote_count: number | null;
  rank_in_cycle: number | null;
  finalized_at: string | null;
  feed_classification_version: number | null;
  feed_eligible: boolean | null;
  submissions: DetailSubmissionRow | DetailSubmissionRow[];
  voting_cycles: DetailCycleRow | DetailCycleRow[];
};

type CommunityFeedDetailSource = {
  detail: CommunityFeedDetail;
  r2Key: string | null;
  authorDiscordUserId: string | null;
};

function requireSubmissionId(submissionId: number) {
  if (!Number.isSafeInteger(submissionId) || submissionId <= 0) {
    throw new Error("COMMUNITY_FEED_DETAIL_SUBMISSION_ID_INVALID");
  }

  return submissionId;
}

function embeddedRow<T>(value: T | T[]) {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function canonicalNullableTimestamp(value: string | null) {
  return value ? canonicalFeedTimestamp(value) : null;
}

function liveCyclesMatch(left: DetailCycleRow, right: DetailCycleRow | null) {
  return (
    right !== null &&
    left.id === right.id &&
    left.public_number === right.public_number &&
    left.status === right.status &&
    (left.reset_count ?? 0) === (right.reset_count ?? 0)
  );
}

async function getCurrentLiveCycle() {
  const { data, error } = await supabaseAdmin
    .from("voting_cycles")
    .select(
      "id, public_number, status, starts_at, ends_at, reset_count"
    )
    .in("status", [...LIVE_CYCLE_STATUSES])
    .not("public_number", "is", null)
    .order("id", { ascending: false })
    .limit(2);

  if (error) {
    throw new Error(`COMMUNITY_FEED_DETAIL_CYCLE_QUERY_FAILED:${error.code}`);
  }

  const rows = (data ?? []) as DetailCycleRow[];
  if (rows.length > 1) {
    throw new Error("COMMUNITY_FEED_DETAIL_MULTIPLE_LIVE_CYCLES");
  }

  return rows[0] ?? null;
}

async function getFinalizedAuthor(
  discordUserId: string
): Promise<CommunityFeedDetailAuthor | null> {
  const { data, error } = await supabaseAdmin
    .from("user_logs")
    .select(
      "public_profile_id, current_guild_nickname, current_display_name, current_discord_handle, current_discord_username, avatar_key, avatar_updated_at, discord_avatar"
    )
    .eq("discord_user_id", discordUserId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`COMMUNITY_FEED_DETAIL_AUTHOR_QUERY_FAILED:${error.code}`);
  }

  const author = (data as DetailAuthorRow | null) ?? null;
  const publicProfileId = author?.public_profile_id?.trim();
  if (!author || !publicProfileId) return null;

  const hasAvatar = Boolean(author.avatar_key || author.discord_avatar);

  return {
    publicProfileId,
    displayName: getPreferredDiscordName(author),
    avatarUrl: hasAvatar
      ? getPublicProfileAvatarPath({
          publicProfileId,
          versionSource: author.avatar_key
            ? `${author.avatar_key}:${author.avatar_updated_at ?? ""}`
            : author.discord_avatar ?? "",
        })
      : null,
  };
}

async function getLiveDetailSource(submissionId: number) {
  const cycle = await getCurrentLiveCycle();
  if (!cycle) return null;

  const { data, error } = await supabaseAdmin
    .from("submissions")
    .select("id, cycle_id, r2_key, media_width, media_height, created_at")
    .eq("cycle_id", cycle.id)
    .eq("id", submissionId)
    .eq("public_visibility_status", "visible")
    .or("is_disqualified.is.null,is_disqualified.eq.false")
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`COMMUNITY_FEED_DETAIL_LIVE_QUERY_FAILED:${error.code}`);
  }

  const submission = (data as DetailSubmissionRow | null) ?? null;
  const verifiedCycle = await getCurrentLiveCycle();
  if (!submission || !liveCyclesMatch(cycle, verifiedCycle)) return null;

  return {
    detail: {
      submissionId: submission.id,
      state: "live",
      cycleNumber: requirePublicCycleNumber(cycle.public_number),
      author: null,
      imageUrl: submission.r2_key
        ? getCommunityFeedDetailMediaPath(submission.id)
        : null,
      mediaWidth: submission.media_width,
      mediaHeight: submission.media_height,
      createdAt: canonicalFeedTimestamp(submission.created_at),
      cycleStartedAt: canonicalNullableTimestamp(cycle.starts_at),
      cycleEndedAt: canonicalNullableTimestamp(cycle.ends_at),
      finalizedAt: null,
      finalVoteCount: null,
      rankInCycle: null,
    },
    r2Key: submission.r2_key,
    authorDiscordUserId: null,
  } satisfies CommunityFeedDetailSource;
}

async function getFinalizedDetailSource(submissionId: number) {
  const { data, error } = await supabaseAdmin
    .from("cycle_results")
    .select(FINALIZED_DETAIL_SELECT)
    .eq("submission_id", submissionId)
    .eq(
      "feed_classification_version",
      COMMUNITY_FEED_CLASSIFICATION_VERSION
    )
    .eq("feed_eligible", true)
    .gt("final_vote_count", 0)
    .not("finalized_at", "is", null)
    .not("rank_in_cycle", "is", null)
    .eq("submissions.public_visibility_status", "visible")
    .or("is_disqualified.is.null,is_disqualified.eq.false", {
      referencedTable: "submissions",
    })
    .eq("voting_cycles.status", "finished")
    .not("voting_cycles.public_number", "is", null)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`COMMUNITY_FEED_DETAIL_FINAL_QUERY_FAILED:${error.code}`);
  }

  const row = (data as unknown as FinalizedDetailRow | null) ?? null;
  if (!row) return null;

  const submission = embeddedRow(row.submissions);
  const cycle = embeddedRow(row.voting_cycles);
  if (
    !submission ||
    !cycle ||
    submission.id !== row.submission_id ||
    submission.cycle_id !== row.cycle_id ||
    cycle.id !== row.cycle_id ||
    row.feed_classification_version !== COMMUNITY_FEED_CLASSIFICATION_VERSION ||
    row.feed_eligible !== true ||
    row.final_vote_count === null ||
    row.final_vote_count <= 0 ||
    row.rank_in_cycle === null ||
    row.rank_in_cycle <= 0 ||
    row.finalized_at === null
  ) {
    throw new Error("COMMUNITY_FEED_DETAIL_FINAL_ROW_INVALID");
  }

  return {
    detail: {
      submissionId: row.submission_id,
      state: "finalized",
      cycleNumber: requirePublicCycleNumber(cycle.public_number),
      author: null,
      imageUrl: submission.r2_key
        ? getCommunityFeedDetailMediaPath(row.submission_id)
        : null,
      mediaWidth: submission.media_width,
      mediaHeight: submission.media_height,
      createdAt: canonicalFeedTimestamp(submission.created_at),
      cycleStartedAt: canonicalNullableTimestamp(cycle.starts_at),
      cycleEndedAt: canonicalNullableTimestamp(cycle.ends_at),
      finalizedAt: canonicalFeedTimestamp(row.finalized_at),
      finalVoteCount: row.final_vote_count,
      rankInCycle: row.rank_in_cycle,
    },
    r2Key: submission.r2_key,
    authorDiscordUserId: submission.discord_user_id ?? null,
  } satisfies CommunityFeedDetailSource;
}

async function resolveCommunityFeedDetailSource(submissionId: number) {
  requireSubmissionId(submissionId);
  return (
    (await getLiveDetailSource(submissionId)) ??
    (await getFinalizedDetailSource(submissionId))
  );
}

export async function getCommunityFeedDetail(submissionId: number) {
  const source = await resolveCommunityFeedDetailSource(submissionId);
  if (!source) return null;

  if (source.detail.state === "live" || !source.authorDiscordUserId) {
    return source.detail;
  }

  return {
    ...source.detail,
    author: await getFinalizedAuthor(source.authorDiscordUserId),
  } satisfies CommunityFeedDetail;
}

export async function resolveCommunityFeedDetailMediaSource(
  submissionId: number
) {
  const source = await resolveCommunityFeedDetailSource(submissionId);
  return source?.r2Key ? { r2Key: source.r2Key } : null;
}

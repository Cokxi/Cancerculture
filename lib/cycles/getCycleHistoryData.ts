import "server-only";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  isSubmissionListedPublicly,
  normalizeSubmissionPublicVisibilityStatus,
  showsSubmissionImagePublicly,
} from "@/lib/moderation/submissionPublicVisibility";
import {
  PUBLIC_PAGINATION_CURSOR_VERSION,
  PUBLIC_PAGINATION_SCOPES,
  PUBLIC_SUBMISSION_PAGE_SIZE,
  type PaginationView,
  type PublicPage,
} from "@/lib/pagination/publicPagination";
import {
  decodeServerPublicPaginationCursor,
  encodeServerPublicPaginationCursor,
} from "@/lib/pagination/publicPaginationCursor.server";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import {
  getSubmissionSocialLinksBySubmissionIds,
} from "@/lib/socials/getSubmissionSocialLinks";
import {
  getCycleSponsoredMeta,
} from "./sponsoredCycle";
import type {
  CycleHistoryCycleSummaryItem,
  CycleHistorySubmission,
  CycleHistoryWinnerProfile,
} from "./cycleHistoryTypes";
import { requirePublicCycleNumber } from "./publicCycleNumber";

type CycleRow = {
  id: number;
  public_number: number | null;
  theme: string | null;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  finalized_at: string | null;
  created_at: string;
};

type SubmissionRow = {
  id: number;
  cycle_id: number;
  r2_key: string | null;
  is_disqualified: boolean | null;
  disqualification_reason_code: string | null;
  disqualification_reason_text: string | null;
  discord_user_id: string;
  discord_username_at_upload: string | null;
  public_visibility_status: string | null;
  public_visibility_reason_code: string | null;
  public_visibility_reason_text: string | null;
  public_visibility_updated_at: string | null;
  public_visibility_updated_by_discord_username: string | null;
};

type MinimalSubmissionRow = {
  id: number;
  is_disqualified: boolean | null;
  public_visibility_status: string | null;
};

type CycleResultRow = {
  cycle_id: number;
  submission_id: number;
  vote_count: number | null;
  is_winner: boolean;
  rank: number | null;
  final_vote_count: number | null;
  rank_in_cycle: number | null;
};

type WinnerProfileRow = CycleHistoryWinnerProfile;

type UserLogRow = {
  discord_user_id: string;
  public_profile_id: string | null;
};

export type HistoryOptions = {
  isAdminView?: boolean;
};

function getView(isAdminView: boolean): PaginationView {
  return isAdminView ? "admin" : "public";
}

function applyPublicHistoryVisibilityFilter<
  T extends {
    or: (
      filters: string
    ) => T;
  },
>(query: T, isAdminView: boolean) {
  return isAdminView
    ? query
    : query.or(
        "public_visibility_status.is.null,public_visibility_status.neq.removed"
      );
}

async function getSubmissionCount(
  cycleId: number,
  isAdminView: boolean
) {
  let query = supabaseAdmin
    .from("submissions")
    .select("id", { count: "exact", head: true })
    .eq("cycle_id", cycleId)
    .or("is_disqualified.is.null,is_disqualified.eq.false");

  query = applyPublicHistoryVisibilityFilter(
    query,
    isAdminView
  );
  const { count, error } = await query;

  if (error) {
    throw new Error(
      `HISTORY_COUNT_QUERY_FAILED:${error.code}`
    );
  }

  return count ?? 0;
}

export async function getCycleHistorySummariesPage({
  cursor,
  isAdminView = false,
}: HistoryOptions & {
  cursor?: string | null;
}): Promise<PublicPage<CycleHistoryCycleSummaryItem>> {
  const view = getView(isAdminView);
  const context = { view };
  const decodedCursor = cursor
    ? decodeServerPublicPaginationCursor(
        cursor,
        PUBLIC_PAGINATION_SCOPES.historyCycles,
        context
      )
    : null;
  let query = supabaseAdmin
    .from("voting_cycles")
    .select(
      "id, public_number, theme, status, starts_at, ends_at, finalized_at, created_at"
    )
    .eq("status", "finished")
    .order("id", { ascending: false })
    .limit(PUBLIC_SUBMISSION_PAGE_SIZE + 1);

  if (decodedCursor) {
    query = query.lt("id", decodedCursor.values.id);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(
      `HISTORY_CYCLES_QUERY_FAILED:${error.code}`
    );
  }

  const rows = (data ?? []) as CycleRow[];
  const hasMore = rows.length > PUBLIC_SUBMISSION_PAGE_SIZE;
  const pageRows = rows.slice(0, PUBLIC_SUBMISSION_PAGE_SIZE);
  const items = await Promise.all(
    pageRows.map(
      async (cycle): Promise<CycleHistoryCycleSummaryItem> => ({
        id: cycle.id,
        cycleNumber: requirePublicCycleNumber(cycle.public_number),
        theme: cycle.theme,
        status: cycle.status,
        startedAt: cycle.starts_at,
        endedAt: cycle.ends_at,
        finalizedAt: cycle.finalized_at,
        createdAt: cycle.created_at,
        submissionCount: await getSubmissionCount(
          cycle.id,
          isAdminView
        ),
        sponsoredMeta: await getCycleSponsoredMeta(
          cycle.id,
          "history_modal"
        ),
      })
    )
  );
  const lastItem = items.at(-1);

  return {
    items,
    hasMore,
    nextCursor:
      hasMore && lastItem
        ? encodeServerPublicPaginationCursor({
            version: PUBLIC_PAGINATION_CURSOR_VERSION,
            scope: PUBLIC_PAGINATION_SCOPES.historyCycles,
            context,
            values: { id: lastItem.id },
          })
        : null,
  };
}

function computeLegacyRanks(
  submissions: Array<{
    id: number;
    voteCount: number;
    isWinner: boolean;
  }>
) {
  const sorted = [...submissions].sort((left, right) => {
    if (left.isWinner !== right.isWinner) {
      return left.isWinner ? -1 : 1;
    }

    if (left.voteCount !== right.voteCount) {
      return right.voteCount - left.voteCount;
    }

    return left.id - right.id;
  });
  const ranks = new Map<number, number>();
  let currentRank = 0;
  let lastVoteCount: number | null = null;

  for (const submission of sorted) {
    if (
      lastVoteCount === null ||
      submission.voteCount !== lastVoteCount
    ) {
      currentRank += 1;
      lastVoteCount = submission.voteCount;
    }

    ranks.set(submission.id, currentRank);
  }

  return ranks;
}

async function getLegacyFallbackRanks(
  cycleId: number,
  isAdminView: boolean
) {
  const [submissionsResult, resultsResult] = await Promise.all([
    supabaseAdmin
      .from("submissions")
      .select(
        "id, is_disqualified, public_visibility_status"
      )
      .eq("cycle_id", cycleId),
    supabaseAdmin
      .from("cycle_results")
      .select(
        "cycle_id, submission_id, vote_count, is_winner, rank, final_vote_count, rank_in_cycle"
      )
      .eq("cycle_id", cycleId),
  ]);

  if (submissionsResult.error || resultsResult.error) {
    throw new Error("HISTORY_LEGACY_RANK_QUERY_FAILED");
  }

  const resultBySubmissionId = new Map(
    ((resultsResult.data ?? []) as CycleResultRow[]).map(
      (result) => [result.submission_id, result]
    )
  );
  const eligibleSubmissions = (
    (submissionsResult.data ?? []) as MinimalSubmissionRow[]
  ).filter((submission) => {
    if (submission.is_disqualified === true) {
      return false;
    }

    return (
      isAdminView ||
      isSubmissionListedPublicly(
        normalizeSubmissionPublicVisibilityStatus(
          submission.public_visibility_status
        )
      )
    );
  });

  return computeLegacyRanks(
    eligibleSubmissions.map((submission) => {
      const result =
        resultBySubmissionId.get(submission.id) ?? null;

      return {
        id: submission.id,
        voteCount:
          result?.final_vote_count ?? result?.vote_count ?? 0,
        isWinner: result?.is_winner ?? false,
      };
    })
  );
}

export async function getCycleHistorySubmissionPage({
  cursor,
  cycleId,
  isAdminView = false,
}: HistoryOptions & {
  cursor?: string | null;
  cycleId: number;
}): Promise<PublicPage<CycleHistorySubmission> | null> {
  const view = getView(isAdminView);
  const context = { cycleId, view };
  const decodedCursor = cursor
    ? decodeServerPublicPaginationCursor(
        cursor,
        PUBLIC_PAGINATION_SCOPES.historySubmissions,
        context
      )
    : null;
  const cycleResult = await supabaseAdmin
    .from("voting_cycles")
    .select("id, public_number")
    .eq("id", cycleId)
    .eq("status", "finished")
    .maybeSingle();

  if (cycleResult.error) {
    throw new Error(
      `HISTORY_CYCLE_QUERY_FAILED:${cycleResult.error.code}`
    );
  }

  if (!cycleResult.data) {
    return null;
  }
  const cycleNumber = requirePublicCycleNumber(
    cycleResult.data.public_number
  );

  let submissionsQuery = supabaseAdmin
    .from("submissions")
    .select(
      "id, cycle_id, r2_key, is_disqualified, disqualification_reason_code, disqualification_reason_text, discord_user_id, discord_username_at_upload, public_visibility_status, public_visibility_reason_code, public_visibility_reason_text, public_visibility_updated_at, public_visibility_updated_by_discord_username"
    )
    .eq("cycle_id", cycleId)
    .or("is_disqualified.is.null,is_disqualified.eq.false")
    .order("id", { ascending: true })
    .limit(PUBLIC_SUBMISSION_PAGE_SIZE + 1);

  submissionsQuery = applyPublicHistoryVisibilityFilter(
    submissionsQuery,
    isAdminView
  );

  if (decodedCursor) {
    submissionsQuery = submissionsQuery.gt(
      "id",
      decodedCursor.values.id
    );
  }

  const submissionsResult = await submissionsQuery;

  if (submissionsResult.error) {
    throw new Error(
      `HISTORY_SUBMISSIONS_QUERY_FAILED:${submissionsResult.error.code}`
    );
  }

  const rows = (submissionsResult.data ?? []) as SubmissionRow[];
  const hasMore = rows.length > PUBLIC_SUBMISSION_PAGE_SIZE;
  const pageRows = rows.slice(0, PUBLIC_SUBMISSION_PAGE_SIZE);
  const submissionIds = pageRows.map(
    (submission) => submission.id
  );
  const discordUserIds = Array.from(
    new Set(
      pageRows.map((submission) => submission.discord_user_id)
    )
  );
  const [resultsResult, winnersResult, userLogsResult, socialLinks] =
    await Promise.all([
      submissionIds.length > 0
        ? supabaseAdmin
            .from("cycle_results")
            .select(
              "cycle_id, submission_id, vote_count, is_winner, rank, final_vote_count, rank_in_cycle"
            )
            .eq("cycle_id", cycleId)
            .in("submission_id", submissionIds)
        : Promise.resolve({ data: [], error: null }),
      submissionIds.length > 0
        ? supabaseAdmin
            .from("winner_public_profiles")
            .select(
              "cycle_id, submission_id, wall, payout_choice, split_percent, charity"
            )
            .eq("cycle_id", cycleId)
            .in("submission_id", submissionIds)
        : Promise.resolve({ data: [], error: null }),
      discordUserIds.length > 0
        ? supabaseAdmin
            .from("user_logs")
            .select("discord_user_id, public_profile_id")
            .in("discord_user_id", discordUserIds)
        : Promise.resolve({ data: [], error: null }),
      getSubmissionSocialLinksBySubmissionIds(submissionIds),
    ]);

  if (
    resultsResult.error ||
    winnersResult.error ||
    userLogsResult.error
  ) {
    throw new Error("HISTORY_RELATED_QUERY_FAILED");
  }

  const resultBySubmissionId = new Map(
    ((resultsResult.data ?? []) as CycleResultRow[]).map(
      (result) => [result.submission_id, result]
    )
  );
  const winnerBySubmissionId = new Map(
    ((winnersResult.data ?? []) as WinnerProfileRow[]).map(
      (winner) => [winner.submission_id, winner]
    )
  );
  const profileIdByDiscordUserId = new Map(
    ((userLogsResult.data ?? []) as UserLogRow[]).map(
      (userLog) => [
        userLog.discord_user_id,
        userLog.public_profile_id,
      ]
    )
  );
  const needsLegacyFallback = pageRows.some((submission) => {
    const result = resultBySubmissionId.get(submission.id);
    return !result?.rank_in_cycle && !result?.rank;
  });
  const legacyRanks = needsLegacyFallback
    ? await getLegacyFallbackRanks(cycleId, isAdminView)
    : new Map<number, number>();
  const items = pageRows.map(
    (submission): CycleHistorySubmission => {
      const result =
        resultBySubmissionId.get(submission.id) ?? null;
      const visibility =
        normalizeSubmissionPublicVisibilityStatus(
          submission.public_visibility_status
        );

      return {
        id: submission.id,
        cycleId: submission.cycle_id,
        cycleNumber,
        imageUrl:
          isAdminView || showsSubmissionImagePublicly(visibility)
            ? getPublicImageUrl(submission.r2_key) ?? null
            : null,
        isDisqualified: submission.is_disqualified === true,
        disqualificationReasonCode:
          submission.disqualification_reason_code,
        disqualificationReasonText:
          submission.disqualification_reason_text,
        discordUsername:
          submission.discord_username_at_upload ?? "unknown",
        publicProfileId:
          profileIdByDiscordUserId.get(
            submission.discord_user_id
          ) ?? null,
        voteCount:
          result?.final_vote_count ?? result?.vote_count ?? 0,
        isWinner: result?.is_winner ?? false,
        rank:
          result?.rank_in_cycle ??
          result?.rank ??
          legacyRanks.get(submission.id) ??
          null,
        publicVisibilityStatus: visibility,
        publicVisibilityReasonCode:
          submission.public_visibility_reason_code,
        publicVisibilityReasonText:
          submission.public_visibility_reason_text,
        publicVisibilityUpdatedAt:
          submission.public_visibility_updated_at,
        publicVisibilityUpdatedByDiscordUsername:
          submission.public_visibility_updated_by_discord_username,
        winnerProfile:
          winnerBySubmissionId.get(submission.id) ?? null,
        socialLinks: socialLinks.get(submission.id) ?? [],
      };
    }
  );
  const lastItem = items.at(-1);

  return {
    items,
    hasMore,
    nextCursor:
      hasMore && lastItem
        ? encodeServerPublicPaginationCursor({
            version: PUBLIC_PAGINATION_CURSOR_VERSION,
            scope:
              PUBLIC_PAGINATION_SCOPES.historySubmissions,
            context,
            values: { id: lastItem.id },
          })
        : null,
  };
}

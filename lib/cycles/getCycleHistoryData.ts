import { supabaseAdmin } from "@/lib/db/admin";
import {
  isSubmissionListedPublicly,
  normalizeSubmissionPublicVisibilityStatus,
  showsSubmissionImagePublicly,
  type SubmissionPublicVisibilityStatus,
} from "@/lib/moderation/submissionPublicVisibility";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import {
  getSubmissionSocialLinksBySubmissionIds,
  type SubmissionSocialLink,
} from "@/lib/socials/getSubmissionSocialLinks";

type CycleRow = {
  id: number;
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
  is_disqualified: boolean;
  disqualification_reason_code: string | null;
  disqualification_reason_text: string | null;
  discord_user_id: string;
  discord_username_at_upload: string | null;
  public_visibility_status: string | null;
  public_visibility_reason_code: string | null;
  public_visibility_reason_text: string | null;
  public_visibility_updated_at: string | null;
  public_visibility_updated_by_discord_user_id: string | null;
  public_visibility_updated_by_discord_username: string | null;
};

type CycleResultRow = {
  cycle_id: number;
  submission_id: number;
  vote_count: number | null;
  is_winner: boolean;
  rank: number | null;
};

type WinnerProfileRow = {
  cycle_id: number;
  submission_id: number;
  wall: string;
  wallet_address: string;
  payout_choice: string;
  split_percent: number | null;
  charity: string | null;
};

type UserLogRow = {
  discord_user_id: string;
  public_profile_id: string | null;
};

type HistoryOptions = {
  isAdminView?: boolean;
};

export type CycleHistorySubmission = {
  id: number;
  cycleId: number;
  imageUrl: string | null;
  isDisqualified: boolean;
  disqualificationReasonCode: string | null;
  disqualificationReasonText: string | null;
  discordUsername: string;
  publicProfileId: string | null;
  voteCount: number;
  isWinner: boolean;
  rank: number | null;
  publicVisibilityStatus: SubmissionPublicVisibilityStatus;
  publicVisibilityReasonCode: string | null;
  publicVisibilityReasonText: string | null;
  publicVisibilityUpdatedAt: string | null;
  publicVisibilityUpdatedByDiscordUserId: string | null;
  publicVisibilityUpdatedByDiscordUsername: string | null;
  winnerProfile: WinnerProfileRow | null;
  socialLinks: SubmissionSocialLink[];
};

export type CycleHistoryCycleSummary = {
  id: number;
  theme: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  submissionCount: number;
};

export type CycleHistoryCycle = CycleHistoryCycleSummary & {
  submissions: CycleHistorySubmission[];
};

function withComputedRanks(
  submissions: CycleHistorySubmission[]
): CycleHistorySubmission[] {
  const sortedSubmissions = [...submissions].sort(
    (left, right) => {
      if (left.isWinner !== right.isWinner) {
        return left.isWinner ? -1 : 1;
      }

      if (left.voteCount !== right.voteCount) {
        return right.voteCount - left.voteCount;
      }

      return left.id - right.id;
    }
  );

  let currentRank = 0;
  let lastVoteCount: number | null = null;

  return sortedSubmissions.map((submission) => {
    if (
      lastVoteCount === null ||
      submission.voteCount !== lastVoteCount
    ) {
      currentRank += 1;
      lastVoteCount = submission.voteCount;
    }

    return {
      ...submission,
      rank: currentRank,
    };
  });
}

async function getFinishedCycleRows() {
  const { data: cycles, error } = await supabaseAdmin
    .from("voting_cycles")
    .select(
      "id, theme, status, starts_at, ends_at, finalized_at, created_at"
    )
    .eq("status", "finished")
    .order("id", { ascending: false });

  if (error) {
    console.error("[getCycleHistoryData][cycles]", error);
    return [];
  }

  return (cycles ?? []) as CycleRow[];
}

export async function getCycleHistorySummaries(
  options?: HistoryOptions
): Promise<CycleHistoryCycleSummary[]> {
  const isAdminView = options?.isAdminView ?? false;
  const cycleRows = await getFinishedCycleRows();

  if (cycleRows.length === 0) {
    return [];
  }

  const cycleIds = cycleRows.map((cycle) => cycle.id);
  const { data: submissions, error } = await supabaseAdmin
    .from("submissions")
    .select("cycle_id, is_disqualified, public_visibility_status")
    .in("cycle_id", cycleIds);

  if (error) {
    console.error(
      "[getCycleHistorySummaries][submissions]",
      error
    );
  }

  const countsByCycleId = new Map<number, number>();

  for (const submission of submissions ?? []) {
    if (submission.is_disqualified) {
      continue;
    }

    const publicVisibilityStatus =
      normalizeSubmissionPublicVisibilityStatus(
        submission.public_visibility_status
      );

    if (
      !isAdminView &&
      !isSubmissionListedPublicly(publicVisibilityStatus)
    ) {
      continue;
    }

    countsByCycleId.set(
      submission.cycle_id,
      (countsByCycleId.get(submission.cycle_id) ?? 0) + 1
    );
  }

  return cycleRows.map((cycle) => ({
    id: cycle.id,
    theme: cycle.theme,
    status: cycle.status,
    startedAt: cycle.starts_at,
    endedAt: cycle.ends_at,
    finalizedAt: cycle.finalized_at,
    createdAt: cycle.created_at,
    submissionCount: countsByCycleId.get(cycle.id) ?? 0,
  }));
}

export async function getCycleHistoryCycleData(
  cycleId: number,
  options?: HistoryOptions
): Promise<CycleHistoryCycle | null> {
  const isAdminView = options?.isAdminView ?? false;

  const { data: cycle, error: cycleError } = await supabaseAdmin
    .from("voting_cycles")
    .select(
      "id, theme, status, starts_at, ends_at, finalized_at, created_at"
    )
    .eq("id", cycleId)
    .eq("status", "finished")
    .maybeSingle();

  if (cycleError) {
    console.error(
      "[getCycleHistoryCycleData][cycle]",
      cycleError
    );
    return null;
  }

  if (!cycle) {
    return null;
  }

  const [submissionsResult, resultsResult, winnersResult] =
    await Promise.all([
      supabaseAdmin
        .from("submissions")
        .select(
          "id, cycle_id, r2_key, is_disqualified, disqualification_reason_code, disqualification_reason_text, discord_user_id, discord_username_at_upload, public_visibility_status, public_visibility_reason_code, public_visibility_reason_text, public_visibility_updated_at, public_visibility_updated_by_discord_user_id, public_visibility_updated_by_discord_username"
        )
        .eq("cycle_id", cycleId)
        .order("id", { ascending: true }),
      supabaseAdmin
        .from("cycle_results")
        .select(
          "cycle_id, submission_id, vote_count, is_winner, rank"
        )
        .eq("cycle_id", cycleId),
      supabaseAdmin
        .from("winner_public_profiles")
        .select(
          "cycle_id, submission_id, wall, wallet_address, payout_choice, split_percent, charity"
        )
        .eq("cycle_id", cycleId),
    ]);

  if (submissionsResult.error) {
    console.error(
      "[getCycleHistoryCycleData][submissions]",
      submissionsResult.error
    );
    return null;
  }

  if (resultsResult.error) {
    console.error(
      "[getCycleHistoryCycleData][results]",
      resultsResult.error
    );
    return null;
  }

  if (winnersResult.error) {
    console.error(
      "[getCycleHistoryCycleData][winners]",
      winnersResult.error
    );
  }

  const typedSubmissions =
    (submissionsResult.data ?? []) as SubmissionRow[];
  const typedResults =
    (resultsResult.data ?? []) as CycleResultRow[];
  const typedWinnerProfiles =
    (winnersResult.data ?? []) as WinnerProfileRow[];

  const discordUserIds = Array.from(
    new Set(
      typedSubmissions.map(
        (submission) => submission.discord_user_id
      )
    )
  );

  const userLogsResult =
    discordUserIds.length > 0
      ? await supabaseAdmin
          .from("user_logs")
          .select("discord_user_id, public_profile_id")
          .in("discord_user_id", discordUserIds)
      : { data: [], error: null };

  if (userLogsResult.error) {
    console.error(
      "[getCycleHistoryCycleData][user_logs]",
      userLogsResult.error
    );
  }

  const userLogRows =
    (userLogsResult.data ?? []) as UserLogRow[];

  const resultBySubmissionId = new Map(
    typedResults.map((result) => [
      result.submission_id,
      result,
    ])
  );

  const winnerProfileBySubmissionId = new Map(
    typedWinnerProfiles.map((winner) => [
      winner.submission_id,
      winner,
    ])
  );

  const profileIdByDiscordUserId = new Map(
    userLogRows.map((userLog) => [
      userLog.discord_user_id,
      userLog.public_profile_id,
    ])
  );
  const socialLinksBySubmissionId =
    await getSubmissionSocialLinksBySubmissionIds(
      typedSubmissions.map((submission) => submission.id)
    );

  const submissions = typedSubmissions.flatMap(
    (submission): CycleHistorySubmission[] => {
      if (submission.is_disqualified) {
        return [];
      }

      const publicVisibilityStatus =
        normalizeSubmissionPublicVisibilityStatus(
          submission.public_visibility_status
        );

      if (
        !isAdminView &&
        !isSubmissionListedPublicly(publicVisibilityStatus)
      ) {
        return [];
      }

      const result =
        resultBySubmissionId.get(submission.id) ?? null;
      const winnerProfile =
        winnerProfileBySubmissionId.get(submission.id) ?? null;

      return [
        {
          id: submission.id,
          cycleId: submission.cycle_id,
          imageUrl:
            isAdminView ||
            showsSubmissionImagePublicly(publicVisibilityStatus)
              ? getPublicImageUrl(submission.r2_key) ?? null
              : null,
          isDisqualified: submission.is_disqualified,
          disqualificationReasonCode:
            submission.disqualification_reason_code,
          disqualificationReasonText:
            submission.disqualification_reason_text,
          discordUsername:
            submission.discord_username_at_upload ??
            "unknown",
          publicProfileId:
            profileIdByDiscordUserId.get(
              submission.discord_user_id
            ) ?? null,
          voteCount: result?.vote_count ?? 0,
          isWinner: result?.is_winner ?? false,
          rank: result?.rank ?? null,
          publicVisibilityStatus,
          publicVisibilityReasonCode:
            submission.public_visibility_reason_code,
          publicVisibilityReasonText:
            submission.public_visibility_reason_text,
          publicVisibilityUpdatedAt:
            submission.public_visibility_updated_at,
          publicVisibilityUpdatedByDiscordUserId:
            submission.public_visibility_updated_by_discord_user_id,
          publicVisibilityUpdatedByDiscordUsername:
            submission.public_visibility_updated_by_discord_username,
          winnerProfile,
          socialLinks:
            socialLinksBySubmissionId.get(submission.id) ?? [],
        },
      ];
    }
  );

  const rankedSubmissions = withComputedRanks(submissions);

  return {
    id: cycle.id,
    theme: cycle.theme,
    status: cycle.status,
    startedAt: cycle.starts_at,
    endedAt: cycle.ends_at,
    finalizedAt: cycle.finalized_at,
    createdAt: cycle.created_at,
    submissionCount: rankedSubmissions.length,
    submissions: rankedSubmissions,
  };
}

export async function getCycleHistoryData(
  options?: HistoryOptions
): Promise<CycleHistoryCycle[]> {
  const summaries = await getCycleHistorySummaries(options);

  const cycles = await Promise.all(
    summaries.map((summary) =>
      getCycleHistoryCycleData(summary.id, options)
    )
  );

  return cycles.filter(
    (cycle): cycle is CycleHistoryCycle => cycle !== null
  );
}

import { supabaseAdmin } from "@/lib/db/admin";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

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
  winnerProfile: WinnerProfileRow | null;
};

export type CycleHistoryCycle = {
  id: number;
  theme: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
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

export async function getCycleHistoryData(): Promise<
  CycleHistoryCycle[]
> {
  const { data: cycles, error: cyclesError } = await supabaseAdmin
    .from("voting_cycles")
    .select(
      "id, theme, status, starts_at, ends_at, finalized_at, created_at"
    )
    .eq("status", "finished")
    .order("id", { ascending: false });

  if (cyclesError) {
    console.error(
      "[getCycleHistoryData][cycles]",
      cyclesError
    );
    return [];
  }

  const typedCycles = (cycles ?? []) as CycleRow[];

  if (typedCycles.length === 0) {
    return [];
  }

  const cycleIds = typedCycles.map((cycle) => cycle.id);

  const [submissionsResult, resultsResult, winnersResult] =
    await Promise.all([
      supabaseAdmin
        .from("submissions")
        .select(
          "id, cycle_id, r2_key, is_disqualified, disqualification_reason_code, disqualification_reason_text, discord_user_id, discord_username_at_upload"
        )
        .in("cycle_id", cycleIds)
        .order("cycle_id", { ascending: false }),
      supabaseAdmin
        .from("cycle_results")
        .select(
          "cycle_id, submission_id, vote_count, is_winner, rank"
        )
        .in("cycle_id", cycleIds),
      supabaseAdmin
        .from("winner_public_profiles")
        .select(
          "cycle_id, submission_id, wall, wallet_address, payout_choice, split_percent, charity"
        )
        .in("cycle_id", cycleIds),
    ]);

  if (submissionsResult.error) {
    console.error(
      "[getCycleHistoryData][submissions]",
      submissionsResult.error
    );
    return [];
  }

  if (resultsResult.error) {
    console.error(
      "[getCycleHistoryData][results]",
      resultsResult.error
    );
    return [];
  }

  if (winnersResult.error) {
    console.error(
      "[getCycleHistoryData][winners]",
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
      "[getCycleHistoryData][user_logs]",
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

  const submissionsByCycleId = new Map<
    number,
    CycleHistorySubmission[]
  >();

  typedSubmissions.forEach((submission) => {
    const result =
      resultBySubmissionId.get(submission.id) ?? null;
    const winnerProfile =
      winnerProfileBySubmissionId.get(submission.id) ?? null;

    const entry: CycleHistorySubmission = {
      id: submission.id,
      cycleId: submission.cycle_id,
      imageUrl: getPublicImageUrl(submission.r2_key) ?? null,
      isDisqualified: submission.is_disqualified,
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
      voteCount: result?.vote_count ?? 0,
      isWinner: result?.is_winner ?? false,
      rank: result?.rank ?? null,
      winnerProfile,
    };

    const submissionsForCycle =
      submissionsByCycleId.get(submission.cycle_id) ?? [];
    submissionsForCycle.push(entry);
    submissionsByCycleId.set(
      submission.cycle_id,
      submissionsForCycle
    );
  });

  return typedCycles.map((cycle) => {
    const rankedSubmissions = withComputedRanks(
      submissionsByCycleId.get(cycle.id) ?? []
    );

    return {
      id: cycle.id,
      theme: cycle.theme,
      status: cycle.status,
      startedAt: cycle.starts_at,
      endedAt: cycle.ends_at,
      finalizedAt: cycle.finalized_at,
      createdAt: cycle.created_at,
      submissions: rankedSubmissions,
    };
  });
}

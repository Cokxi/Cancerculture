import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";

const SNAPSHOT_LIMIT = 24;
const CALCULATION_LIMIT = 8;

export type VoteObservationBucket = Readonly<{
  index: number;
  votes: number;
  startedAt: string;
}>;

export type SubmissionVoteObservation = Readonly<{
  submissionId: number;
  isDisqualified: boolean;
  visibilityStatus: string;
  totalVotes: number;
  cycleVotes: number;
  firstVoteAt: string | null;
  lastVoteAt: string | null;
  peak5mVotes: number;
  peak5mStartedAt: string | null;
  last5mVotes: number;
  last15mVotes: number;
  last60mVotes: number;
  buckets: readonly VoteObservationBucket[];
}>;

export type CycleVoteObservation = Readonly<{
  cycleId: number;
  resetCount: number;
  cycleTitle: string | null;
  cycleStatus: string;
  status: "pending" | "calculating" | "ready" | "failed";
  votingStartedAt: string;
  votingEndedAt: string;
  policyVersion: number;
  policyHash: string;
  voteCount: number | null;
  distinctVoterCount: number | null;
  submissionCount: number | null;
  resultHash: string | null;
  errorCode: string | null;
  requestedAt: string;
  readyAt: string | null;
  submissions: readonly SubmissionVoteObservation[];
}>;

type SnapshotRow = {
  cycle_id: number;
  reset_count: number;
  status: CycleVoteObservation["status"];
  voting_started_at: string;
  voting_ended_at: string;
  policy_version: number;
  policy_hash: string;
  vote_count: number | null;
  distinct_voter_count: number | null;
  submission_count: number | null;
  result_hash: string | null;
  error_code: string | null;
  requested_at: string;
  ready_at: string | null;
};

type ObservationRow = {
  cycle_id: number;
  reset_count: number;
  submission_id: number;
  total_votes: number;
  cycle_votes: number;
  first_vote_at: string | null;
  last_vote_at: string | null;
  peak_5m_votes: number;
  peak_5m_started_at: string | null;
  last_5m_votes: number;
  last_15m_votes: number;
  last_60m_votes: number;
  nonempty_5m_buckets: unknown;
};

function snapshotKey(cycleId: number, resetCount: number) {
  return `${cycleId}:${resetCount}`;
}

function parseBuckets(value: unknown): readonly VoteObservationBucket[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof (candidate as { index?: unknown }).index !== "number" ||
      typeof (candidate as { votes?: unknown }).votes !== "number" ||
      typeof (candidate as { startedAt?: unknown }).startedAt !== "string"
    ) {
      return [];
    }

    return [
      {
        index: (candidate as { index: number }).index,
        votes: (candidate as { votes: number }).votes,
        startedAt: (candidate as { startedAt: string }).startedAt,
      },
    ];
  });
}

async function loadSnapshotRows(): Promise<SnapshotRow[]> {
  const { data, error } = await supabaseAdmin
    .from("cycle_vote_observation_snapshots")
    .select(
      "cycle_id, reset_count, status, voting_started_at, voting_ended_at, policy_version, policy_hash, vote_count, distinct_voter_count, submission_count, result_hash, error_code, requested_at, ready_at"
    )
    .order("voting_ended_at", { ascending: false })
    .limit(SNAPSHOT_LIMIT);

  if (error) {
    throw new Error("Cycle vote observations are temporarily unavailable");
  }

  return (data ?? []) as SnapshotRow[];
}

export async function loadCycleVoteObservationReadModel(): Promise<
  readonly CycleVoteObservation[]
> {
  let snapshots = await loadSnapshotRows();
  const unfinished = snapshots
    .filter((snapshot) =>
      snapshot.status === "pending" || snapshot.status === "failed"
    )
    .slice(0, CALCULATION_LIMIT);

  if (unfinished.length > 0) {
    await Promise.all(
      unfinished.map(async (snapshot) => {
        const { error } = await supabaseAdmin.rpc(
          "calculate_cycle_vote_observation_snapshot",
          {
            p_cycle_id: snapshot.cycle_id,
            p_reset_count: snapshot.reset_count,
          }
        );

        if (error) {
          console.error(
            "[CYCLE_VOTE_OBSERVATION] snapshot calculation request failed",
            {
              cycleId: snapshot.cycle_id,
              resetCount: snapshot.reset_count,
              code: error.code,
            }
          );
        }
      })
    );
    snapshots = await loadSnapshotRows();
  }

  if (snapshots.length === 0) {
    return [];
  }

  const cycleIds = [...new Set(snapshots.map((snapshot) => snapshot.cycle_id))];
  const readySnapshots = snapshots.filter(
    (snapshot) => snapshot.status === "ready"
  );

  const [cyclesResult, submissionsResult, observationsResult] =
    await Promise.all([
      supabaseAdmin
        .from("voting_cycles")
        .select("id, title, status")
        .in("id", cycleIds),
      supabaseAdmin
        .from("submissions")
        .select("id, cycle_id, is_disqualified, public_visibility_status")
        .in("cycle_id", cycleIds),
      readySnapshots.length > 0
        ? supabaseAdmin
            .from("cycle_vote_submission_observations")
            .select(
              "cycle_id, reset_count, submission_id, total_votes, cycle_votes, first_vote_at, last_vote_at, peak_5m_votes, peak_5m_started_at, last_5m_votes, last_15m_votes, last_60m_votes, nonempty_5m_buckets"
            )
            .in("cycle_id", cycleIds)
            .order("total_votes", { ascending: false })
            .order("submission_id", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
    ]);

  if (cyclesResult.error || submissionsResult.error || observationsResult.error) {
    throw new Error("Cycle vote observation details are temporarily unavailable");
  }

  const cycleById = new Map(
    (cyclesResult.data ?? []).map((cycle) => [cycle.id, cycle])
  );
  const submissionById = new Map(
    (submissionsResult.data ?? []).map((submission) => [
      submission.id,
      submission,
    ])
  );
  const observationsBySnapshot = new Map<
    string,
    SubmissionVoteObservation[]
  >();

  for (const row of (observationsResult.data ?? []) as ObservationRow[]) {
    const key = snapshotKey(row.cycle_id, row.reset_count);
    const submission = submissionById.get(row.submission_id);
    const current = observationsBySnapshot.get(key) ?? [];
    current.push({
      submissionId: row.submission_id,
      isDisqualified: submission?.is_disqualified === true,
      visibilityStatus: submission?.public_visibility_status ?? "unavailable",
      totalVotes: row.total_votes,
      cycleVotes: row.cycle_votes,
      firstVoteAt: row.first_vote_at,
      lastVoteAt: row.last_vote_at,
      peak5mVotes: row.peak_5m_votes,
      peak5mStartedAt: row.peak_5m_started_at,
      last5mVotes: row.last_5m_votes,
      last15mVotes: row.last_15m_votes,
      last60mVotes: row.last_60m_votes,
      buckets: parseBuckets(row.nonempty_5m_buckets),
    });
    observationsBySnapshot.set(key, current);
  }

  return snapshots.map((snapshot) => {
    const cycle = cycleById.get(snapshot.cycle_id);
    return {
      cycleId: snapshot.cycle_id,
      resetCount: snapshot.reset_count,
      cycleTitle: cycle?.title ?? null,
      cycleStatus: cycle?.status ?? "unavailable",
      status: snapshot.status,
      votingStartedAt: snapshot.voting_started_at,
      votingEndedAt: snapshot.voting_ended_at,
      policyVersion: snapshot.policy_version,
      policyHash: snapshot.policy_hash,
      voteCount: snapshot.vote_count,
      distinctVoterCount: snapshot.distinct_voter_count,
      submissionCount: snapshot.submission_count,
      resultHash: snapshot.result_hash,
      errorCode: snapshot.error_code,
      requestedAt: snapshot.requested_at,
      readyAt: snapshot.ready_at,
      submissions:
        observationsBySnapshot.get(
          snapshotKey(snapshot.cycle_id, snapshot.reset_count)
        ) ?? [],
    };
  });
}

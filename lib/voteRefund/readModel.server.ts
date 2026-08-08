import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { getSubmissionThumbnailUrl } from "@/lib/r2/getSubmissionThumbnailUrl";

export const VOTE_REFUND_CANDIDATE_PAGE_SIZE = 48;

export type VoteRefundCycle = Readonly<{
  id: number;
  resetCount: number;
  votesPerUser: number;
}>;

export type VoteRefundCandidate = Readonly<{
  submissionId: number;
  disqualificationType: string | null;
  disqualifiedAt: string;
  refundableVoteCount: number;
  imageUrl: string | null;
  thumbnailUrl: string | null;
}>;

export type VoteRefundReadModel = Readonly<{
  cycle: VoteRefundCycle | null;
  candidates: readonly VoteRefundCandidate[];
  page: number;
  pageSize: number;
  total: number;
}>;

type CycleRow = {
  id: number;
  reset_count: number;
  votes_per_user: number;
};

type CandidateRow = {
  submission_id: number;
  r2_key: string | null;
  disqualification_type: string | null;
  disqualified_at: string;
  refundable_vote_count: number;
};

function refundReadUnavailable() {
  return new AuthError(
    503,
    "Vote refunds are temporarily unavailable",
    "VOTE_REFUND_READ_UNAVAILABLE"
  );
}

export async function loadVoteRefundReadModel({
  page,
}: {
  page: number;
}): Promise<VoteRefundReadModel> {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > Math.floor(Number.MAX_SAFE_INTEGER / VOTE_REFUND_CANDIDATE_PAGE_SIZE)
  ) {
    throw new TypeError("Invalid Vote Refund page");
  }

  await requireDynamicTeamCapability("votes.refund_disqualified");

  const cycleResult = await supabaseAdmin
    .from("voting_cycles")
    .select("id, reset_count, votes_per_user")
    .eq("status", "voting_open")
    .order("id", { ascending: false })
    .limit(2);

  if (cycleResult.error || (cycleResult.data?.length ?? 0) > 1) {
    console.error("[VOTE_REFUND] current cycle read failed", {
      errorCode: cycleResult.error?.code ?? null,
      rowCount: cycleResult.data?.length ?? null,
    });
    throw refundReadUnavailable();
  }

  const cycleRow = (cycleResult.data?.[0] as CycleRow | undefined) ?? null;
  if (!cycleRow) {
    return Object.freeze({
      cycle: null,
      candidates: Object.freeze([]),
      page,
      pageSize: VOTE_REFUND_CANDIDATE_PAGE_SIZE,
      total: 0,
    });
  }

  const offset = (page - 1) * VOTE_REFUND_CANDIDATE_PAGE_SIZE;
  const candidateResult = await supabaseAdmin
    .from("vote_refund_candidates")
    .select(
      "submission_id, r2_key, disqualification_type, disqualified_at, refundable_vote_count",
      { count: "exact" }
    )
    .eq("cycle_id", cycleRow.id)
    .order("submission_id", { ascending: true })
    .range(offset, offset + VOTE_REFUND_CANDIDATE_PAGE_SIZE - 1);

  if (candidateResult.error || !Number.isSafeInteger(candidateResult.count)) {
    console.error("[VOTE_REFUND] candidate read failed", {
      errorCode: candidateResult.error?.code ?? null,
    });
    throw refundReadUnavailable();
  }

  const candidates = ((candidateResult.data ?? []) as CandidateRow[]).map(
    (row) => {
      const imageUrl = getPublicImageUrl(row.r2_key) ?? null;
      return Object.freeze({
        submissionId: row.submission_id,
        disqualificationType: row.disqualification_type,
        disqualifiedAt: row.disqualified_at,
        refundableVoteCount: row.refundable_vote_count,
        imageUrl,
        thumbnailUrl: imageUrl ? getSubmissionThumbnailUrl(imageUrl) : null,
      });
    }
  );

  return Object.freeze({
    cycle: Object.freeze({
      id: cycleRow.id,
      resetCount: cycleRow.reset_count,
      votesPerUser: cycleRow.votes_per_user,
    }),
    candidates: Object.freeze(candidates),
    page,
    pageSize: VOTE_REFUND_CANDIDATE_PAGE_SIZE,
    total: candidateResult.count ?? 0,
  });
}

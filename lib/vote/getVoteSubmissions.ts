import { supabaseAdmin } from "@/lib/db/admin";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

export const VOTE_SUBMISSIONS_PAGE_SIZE = 48;

type VoteSubmissionRow = {
  id: number;
  r2_key: string | null;
  vote_count: number;
  discord_user_id: string;
};

export type VoteSubmission = {
  id: number;
  image_url: string;
  vote_count: number;
  discord_user_id: string;
};

export async function getVoteSubmissions({
  cycleId,
  limit = VOTE_SUBMISSIONS_PAGE_SIZE,
  offset = 0,
}: {
  cycleId: number;
  limit?: number;
  offset?: number;
}): Promise<{
  submissions: VoteSubmission[];
  hasMore: boolean;
  nextOffset: number;
}> {
  const pageSize = Math.max(1, Math.min(limit, 100));
  const fetchSize = pageSize * 3;

  const { data, error } = await supabaseAdmin
    .from("public_submissions_with_votes")
    .select("id, r2_key, vote_count, discord_user_id")
    .eq("cycle_id", cycleId)
    .order("id", { ascending: true })
    .range(offset, offset + fetchSize - 1);

  if (error) {
    console.error("[getVoteSubmissions]", error);
    return {
      submissions: [],
      hasMore: false,
      nextOffset: offset,
    };
  }

  const rows = (data ?? []) as VoteSubmissionRow[];

  if (rows.length === 0) {
    return {
      submissions: [],
      hasMore: false,
      nextOffset: offset,
    };
  }

  const submissions = rows
    .slice(0, pageSize)
    .map((submission) => ({
      ...submission,
      image_url:
        getPublicImageUrl(submission.r2_key) ?? "",
    }));

  return {
    submissions,
    hasMore: rows.length === fetchSize,
    nextOffset: offset + rows.length,
  };
}

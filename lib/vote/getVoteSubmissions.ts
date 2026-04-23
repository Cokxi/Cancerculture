import { supabaseAdmin } from "@/lib/db/admin";
import {
  normalizeSubmissionPublicVisibilityStatus,
  SUBMISSION_PUBLIC_VISIBILITY,
} from "@/lib/moderation/submissionPublicVisibility";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

export const VOTE_SUBMISSIONS_PAGE_SIZE = 48;

type VoteSubmissionRow = {
  id: number;
  r2_key: string | null;
  vote_count: number;
  discord_user_id: string;
};

type VisibilityRow = {
  id: number;
  public_visibility_status: string | null;
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
    .from("submissions_with_votes")
    .select("id, r2_key, vote_count, discord_user_id")
    .eq("cycle_id", cycleId)
    .eq("is_disqualified", false)
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

  const { data: visibilityRows, error: visibilityError } =
    await supabaseAdmin
      .from("submissions")
      .select("id, public_visibility_status")
      .in(
        "id",
        rows.map((submission) => submission.id)
      );

  if (visibilityError) {
    console.error(
      "[getVoteSubmissions][visibility]",
      visibilityError
    );
  }

  const visibleSubmissionIds = new Set(
    ((visibilityRows ?? []) as VisibilityRow[])
      .filter(
        (submission) =>
          normalizeSubmissionPublicVisibilityStatus(
            submission.public_visibility_status
          ) === SUBMISSION_PUBLIC_VISIBILITY.visible
      )
      .map((submission) => submission.id)
  );

  const visibleRows = rows.filter((submission) =>
    visibleSubmissionIds.has(submission.id)
  );

  const submissions = visibleRows
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

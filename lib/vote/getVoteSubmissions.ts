import "server-only";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  PUBLIC_PAGINATION_CURSOR_VERSION,
  PUBLIC_PAGINATION_SCOPES,
  PUBLIC_SUBMISSION_PAGE_SIZE,
  type PublicPage,
} from "@/lib/pagination/publicPagination";
import {
  decodeServerPublicPaginationCursor,
  encodeServerPublicPaginationCursor,
} from "@/lib/pagination/publicPaginationCursor.server";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import type { VoteSubmission } from "./publicVoteSubmission";

type SubmissionRow = {
  id: number;
  r2_key: string | null;
  discord_user_id: string;
};

type VoteRow = {
  submission_id: number | null;
};

async function addVoteCounts(
  cycleId: number,
  rows: SubmissionRow[],
  viewerDiscordUserId: string | null
): Promise<VoteSubmission[]> {
  const submissionIds = rows.map((row) => row.id);
  const voteCounts = new Map<number, number>();

  if (submissionIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("votes")
      .select("submission_id")
      .eq("cycle_id", cycleId)
      .in("submission_id", submissionIds);

    if (error) {
      throw new Error(`VOTE_COUNTS_QUERY_FAILED:${error.code}`);
    }

    for (const vote of (data ?? []) as VoteRow[]) {
      if (vote.submission_id !== null) {
        voteCounts.set(
          vote.submission_id,
          (voteCounts.get(vote.submission_id) ?? 0) + 1
        );
      }
    }
  }

  return rows.map((submission) => ({
    id: submission.id,
    image_url:
      getPublicImageUrl(submission.r2_key) ?? "",
    vote_count: voteCounts.get(submission.id) ?? 0,
    isOwnSubmission:
      viewerDiscordUserId !== null &&
      submission.discord_user_id === viewerDiscordUserId,
  }));
}

export async function getVoteSubmissions({
  cursor,
  cycleId,
  viewerDiscordUserId = null,
}: {
  cursor?: string | null;
  cycleId: number;
  viewerDiscordUserId?: string | null;
}): Promise<PublicPage<VoteSubmission>> {
  const context = { cycleId };
  const decodedCursor = cursor
    ? decodeServerPublicPaginationCursor(
        cursor,
        PUBLIC_PAGINATION_SCOPES.submissions,
        context
      )
    : null;

  let query = supabaseAdmin
    .from("submissions")
    .select("id, r2_key, discord_user_id")
    .eq("cycle_id", cycleId)
    .eq("public_visibility_status", "visible")
    .or("is_disqualified.is.null,is_disqualified.eq.false")
    .order("id", { ascending: true })
    .limit(PUBLIC_SUBMISSION_PAGE_SIZE + 1);

  if (decodedCursor) {
    query = query.gt("id", decodedCursor.values.id);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`SUBMISSIONS_QUERY_FAILED:${error.code}`);
  }

  const rows = (data ?? []) as SubmissionRow[];
  const hasMore = rows.length > PUBLIC_SUBMISSION_PAGE_SIZE;
  const pageRows = rows.slice(0, PUBLIC_SUBMISSION_PAGE_SIZE);
  const items = await addVoteCounts(
    cycleId,
    pageRows,
    viewerDiscordUserId
  );
  const lastItem = items.at(-1);

  return {
    items,
    hasMore,
    nextCursor:
      hasMore && lastItem
        ? encodeServerPublicPaginationCursor({
            version: PUBLIC_PAGINATION_CURSOR_VERSION,
            scope: PUBLIC_PAGINATION_SCOPES.submissions,
            context,
            values: { id: lastItem.id },
          })
        : null,
  };
}

export async function getVoteSubmissionById({
  cycleId,
  submissionId,
  viewerDiscordUserId = null,
}: {
  cycleId: number;
  submissionId: number;
  viewerDiscordUserId?: string | null;
}) {
  const { data, error } = await supabaseAdmin
    .from("submissions")
    .select("id, r2_key, discord_user_id")
    .eq("cycle_id", cycleId)
    .eq("id", submissionId)
    .eq("public_visibility_status", "visible")
    .or("is_disqualified.is.null,is_disqualified.eq.false")
    .maybeSingle();

  if (error) {
    throw new Error(`SUBMISSION_QUERY_FAILED:${error.code}`);
  }

  if (!data) {
    return null;
  }

  return (await addVoteCounts(
    cycleId,
    [data as SubmissionRow],
    viewerDiscordUserId
  ))[0] ?? null;
}

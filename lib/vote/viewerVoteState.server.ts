import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";

export type ViewerVoteState = Readonly<{
  voteCount: number;
  votedSubmissionIds: readonly number[];
}>;

export class ViewerVoteStateUnavailableError extends Error {
  readonly code = "VIEWER_VOTE_STATE_UNAVAILABLE";

  constructor() {
    super("Viewer vote state is temporarily unavailable");
    this.name = "ViewerVoteStateUnavailableError";
  }
}

export async function getViewerVoteState({
  cycleId,
  discordUserId,
}: {
  cycleId: number;
  discordUserId: string;
}): Promise<ViewerVoteState> {
  const normalizedDiscordUserId = discordUserId.trim();
  if (
    !Number.isSafeInteger(cycleId) ||
    cycleId <= 0 ||
    normalizedDiscordUserId.length < 1 ||
    normalizedDiscordUserId.length > 100
  ) {
    throw new TypeError("Invalid viewer vote-state request");
  }

  const { data, error } = await supabaseAdmin
    .from("votes")
    .select("submission_id")
    .eq("cycle_id", cycleId)
    .eq("discord_user_id", normalizedDiscordUserId);

  if (error) {
    console.error("[VIEWER_VOTE_STATE] vote read failed", {
      errorCode: error.code ?? null,
    });
    throw new ViewerVoteStateUnavailableError();
  }

  const votedSubmissionIds = (data ?? [])
    .map((vote) => vote.submission_id)
    .filter((submissionId): submissionId is number =>
      Number.isSafeInteger(submissionId)
    )
    .sort((left, right) => left - right);

  if (votedSubmissionIds.length !== (data?.length ?? 0)) {
    console.error("[VIEWER_VOTE_STATE] invalid vote row shape");
    throw new ViewerVoteStateUnavailableError();
  }

  return Object.freeze({
    voteCount: votedSubmissionIds.length,
    votedSubmissionIds: Object.freeze(votedSubmissionIds),
  });
}

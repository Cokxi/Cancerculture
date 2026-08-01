export type DelegatedVoteLogReason =
  | "access_denied"
  | "cycle_unavailable"
  | "duplicate_vote"
  | "self_vote"
  | "submission_unavailable"
  | "vote_limit_reached"
  | "vote_rejected";

export function getDelegatedVoteLogReason(
  reason: string | null,
  status: string
): DelegatedVoteLogReason | null {
  if (status.trim().toLowerCase() === "accepted") {
    return null;
  }

  const normalizedReason = reason?.trim().toLowerCase() ?? "";

  if (
    [
      "banned",
      "discord_banned",
      "website_banned",
      "participation_unavailable",
      "not_in_discord",
      "joined_too_recently",
    ].includes(normalizedReason)
  ) {
    return "access_denied";
  }
  if (normalizedReason === "self_vote") {
    return "self_vote";
  }
  if (
    ["already_voted", "duplicate_submission_vote"].includes(
      normalizedReason
    )
  ) {
    return "duplicate_vote";
  }
  if (normalizedReason === "vote_limit_reached") {
    return "vote_limit_reached";
  }
  if (normalizedReason === "voting_closed") {
    return "cycle_unavailable";
  }
  if (
    ["submission_not_found", "submission_ineligible"].includes(
      normalizedReason
    )
  ) {
    return "submission_unavailable";
  }

  return "vote_rejected";
}

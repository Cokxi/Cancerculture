export type VoteBlockedReason =
  | "banned"
  | "not_in_discord"
  | "join_wait"
  | "membership_pending"
  | "dependency_unavailable"
  | "not_authenticated"
  | null;

export function resolveVoteBlockedReason(
  localReason: VoteBlockedReason | undefined,
  initialReason: VoteBlockedReason
): VoteBlockedReason {
  return localReason === undefined ? initialReason : localReason;
}

export type ParticipationStatus =
  | "anonymous"
  | "membership_pending"
  | "not_in_discord"
  | "join_wait"
  | "eligible"
  | "restricted"
  | "dependency_unavailable";

export type ParticipationAccessState = {
  authenticated: boolean;
  membershipKnown: boolean;
  discordMember: boolean;
  participationEligible: boolean;
  discordBanned: boolean;
  websiteBanned: boolean;
  joinWaitActive: boolean;
  dependencyUnavailable: boolean;
  joinedAt: string | null;
  retryAfterMs: number;
  status: ParticipationStatus;
};

export function createParticipationAccessState({
  authenticated = false,
  membershipKnown = false,
  discordMember = false,
  discordBanned = false,
  websiteBanned = false,
  joinWaitActive = false,
  dependencyUnavailable = false,
  joinedAt = null,
  retryAfterMs = 0,
}: Partial<
  Omit<ParticipationAccessState, "participationEligible" | "status">
> = {}): ParticipationAccessState {
  const participationEligible =
    authenticated &&
    membershipKnown &&
    discordMember &&
    !discordBanned &&
    !websiteBanned &&
    !joinWaitActive &&
    !dependencyUnavailable;

  const status: ParticipationStatus = !authenticated
    ? "anonymous"
    : discordBanned || websiteBanned
      ? "restricted"
      : dependencyUnavailable
        ? "dependency_unavailable"
        : !membershipKnown
          ? "membership_pending"
          : !discordMember
            ? "not_in_discord"
            : joinWaitActive
              ? "join_wait"
              : "eligible";

  return {
    authenticated,
    membershipKnown,
    discordMember,
    participationEligible,
    discordBanned,
    websiteBanned,
    joinWaitActive,
    dependencyUnavailable,
    joinedAt,
    retryAfterMs,
    status,
  };
}

import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import { getDiscordMembershipEligibility } from "@/lib/eligibility/discordMembership";
import { createParticipationAccessState } from "@/lib/eligibility/participation";
import { getParticipationHold } from "@/lib/eligibility/participationHold";

function createAccess(
  membership: Awaited<ReturnType<typeof getDiscordMembershipEligibility>>,
  participationHeld: boolean
) {
  return createParticipationAccessState({
    authenticated: true,
    membershipKnown: membership.membershipKnown,
    discordMember: membership.isInDiscord,
    discordBanned: membership.isDiscordBanned,
    joinWaitActive: membership.joinedTooRecently,
    dependencyUnavailable: membership.dependencyUnavailable,
    joinedAt: membership.joinedAt,
    retryAfterMs: membership.retryAfterMs,
    participationHeld,
  });
}

export async function getParticipationAccess() {
  const session = await requireSession();
  const [membership, participationHeld] = await Promise.all([
    getDiscordMembershipEligibility(session.discord_user_id),
    getParticipationHold(session.discord_user_id),
  ]);

  return {
    access: createAccess(membership, participationHeld),
    membership,
    session,
  };
}

export async function requireParticipation() {
  const result = await getParticipationAccess();
  const { access } = result;

  if (access.participationEligible) return result;

  if (access.discordBanned) {
    throw new AuthError(403, "Account restricted", "DISCORD_BANNED");
  }

  if (access.participationHeld) {
    throw new AuthError(
      403,
      "Participation is temporarily unavailable",
      "PARTICIPATION_UNAVAILABLE"
    );
  }

  if (access.dependencyUnavailable) {
    throw new AuthError(
      503,
      "Membership verification temporarily unavailable",
      "MEMBERSHIP_UNAVAILABLE"
    );
  }

  if (!access.membershipKnown) {
    throw new AuthError(
      403,
      "Discord membership verification pending",
      "MEMBERSHIP_PENDING"
    );
  }

  if (!access.discordMember) {
    throw new AuthError(403, "Discord membership required", "NOT_IN_DISCORD");
  }

  if (access.joinWaitActive) {
    const suffix = access.joinedAt ? `:${access.joinedAt}` : "";
    throw new AuthError(
      403,
      "Discord membership cooldown active",
      `JOINED_TOO_RECENTLY${suffix}`
    );
  }

  throw new AuthError(
    503,
    "Membership verification temporarily unavailable",
    "MEMBERSHIP_UNAVAILABLE"
  );
}

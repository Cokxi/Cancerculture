import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import { evaluateDiscordSyncHealth } from "@/lib/discord/discordSyncHealth";
import { readDiscordSyncHealth } from "@/lib/discord/readDiscordSyncHealth";
import { getDiscordMembershipEligibility } from "@/lib/eligibility/discordMembership";
import {
  decideDiscordSyncParticipationGrace,
  type DiscordSyncParticipationGraceDecision,
} from "@/lib/eligibility/discordSyncParticipationGrace";
import { createParticipationAccessState } from "@/lib/eligibility/participation";

function createAccess(
  membership: Awaited<ReturnType<typeof getDiscordMembershipEligibility>>
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
  });
}

export async function getParticipationAccess() {
  const session = await requireSession();
  const membership = await getDiscordMembershipEligibility(
    session.discord_user_id
  );
  const access = createAccess(membership);

  if (
    access.participationEligible ||
    membership.reason !== "membership_pending" ||
    !membership.isInDiscord
  ) {
    return {
      access,
      membership,
      session,
      discordSyncParticipationGrace: null,
    };
  }

  const now = new Date();
  let healthRow: Awaited<ReturnType<typeof readDiscordSyncHealth>> = null;

  try {
    healthRow = await readDiscordSyncHealth();
  } catch {
    healthRow = null;
  }

  if (!healthRow) {
    return {
      access,
      membership,
      session,
      discordSyncParticipationGrace: null,
    };
  }

  let graceDecision: DiscordSyncParticipationGraceDecision;

  try {
    const health = evaluateDiscordSyncHealth({
      now,
      lastHeartbeatAt: healthRow.last_heartbeat_at,
      lastFullReconciliationSucceededAt:
        healthRow.last_full_reconciliation_succeeded_at,
      lastFailureAt: healthRow.last_failure_at,
    });

    if (health.reasons.some((reason) => reason.endsWith("_invalid"))) {
      return {
        access,
        membership,
        session,
        discordSyncParticipationGrace: null,
      };
    }

    graceDecision = decideDiscordSyncParticipationGrace({
      now,
      syncHealthStatus: health.status,
      existingDecision: {
        allowed: access.participationEligible,
        reason: membership.reason,
      },
      isInDiscord: membership.isInDiscord,
      membershipObservedAt: membership.membershipObservedAt,
      joinedAt: membership.joinedAt,
      websiteBanned: access.websiteBanned,
      discordBanned: membership.isDiscordBanned,
      sessionStatus: "valid",
      dependencyUnavailable: membership.dependencyUnavailable,
    });
  } catch {
    return {
      access,
      membership,
      session,
      discordSyncParticipationGrace: null,
    };
  }

  if (!graceDecision.allowed) {
    return {
      access,
      membership,
      session,
      discordSyncParticipationGrace: graceDecision,
    };
  }

  const effectiveMembership = {
    ...membership,
    isEligible: true,
    membershipKnown: true,
    joinedTooRecently: false,
    retryAfterMs: 0,
    reason: null,
  };

  return {
    access: createAccess(effectiveMembership),
    membership: effectiveMembership,
    session,
    discordSyncParticipationGrace: graceDecision,
  };
}

export async function requireParticipation() {
  const result = await getParticipationAccess();
  const { access } = result;

  if (access.participationEligible) return result;

  if (access.discordBanned) {
    throw new AuthError(403, "Account restricted", "DISCORD_BANNED");
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

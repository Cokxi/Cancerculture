import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import type { DynamicTeamAuthorizationResult } from "@/lib/auth/dynamicTeamAuthorization";
import { readDynamicTeamAuthorizationForDiscordUserId } from "@/lib/auth/readDynamicTeamAuthorization";
import { requireSession } from "@/lib/auth/requireSession";
import type { RegisteredTeamCapabilityKey } from "@/lib/auth/teamCapabilityRegistry";

export type TeamAuthorizationContext = Readonly<{
  discord_user_id: string;
  role: string;
  isAdmin: boolean;
  resolvedCapabilities: readonly RegisteredTeamCapabilityKey[];
}>;

function authorizationUnavailable(): AuthError {
  return new AuthError(
    503,
    "Team authorization service temporarily unavailable",
    "TEAM_AUTHORIZATION_UNAVAILABLE"
  );
}

export function createTeamAuthorizationContext(
  discordUserId: string,
  result: DynamicTeamAuthorizationResult
): TeamAuthorizationContext {
  if (
    result.status === "dependency_unavailable" ||
    result.status === "registry_drift"
  ) {
    throw authorizationUnavailable();
  }

  if (
    result.status === "not_team_member" ||
    result.status === "inactive_role" ||
    result.status === "unknown_role"
  ) {
    throw new AuthError(403, "Forbidden", "TEAM_ACCESS_DENIED");
  }

  if (
    result.status !== "resolved" ||
    !result.roleKey ||
    result.isAdmin !== (result.roleKey === "admin")
  ) {
    throw authorizationUnavailable();
  }

  return Object.freeze({
    discord_user_id: discordUserId,
    role: result.roleKey,
    isAdmin: result.isAdmin,
    resolvedCapabilities: Object.freeze([
      ...result.resolvedCapabilities,
    ]),
  });
}

export function hasResolvedTeamCapability(
  context: Pick<
    TeamAuthorizationContext,
    "isAdmin" | "resolvedCapabilities"
  >,
  capabilityKey: RegisteredTeamCapabilityKey
): boolean {
  return (
    context.isAdmin ||
    context.resolvedCapabilities.includes(capabilityKey)
  );
}

export async function readTeamAuthorizationContextForDiscordUserId(
  discordUserId: string
): Promise<TeamAuthorizationContext> {
  return createTeamAuthorizationContext(
    discordUserId,
    await readDynamicTeamAuthorizationForDiscordUserId(discordUserId)
  );
}

export async function getTeamAuthorizationContext(): Promise<TeamAuthorizationContext> {
  const session = await requireSession();
  return readTeamAuthorizationContextForDiscordUserId(
    session.discord_user_id
  );
}

export async function requireDynamicTeamCapability(
  capabilityKey: RegisteredTeamCapabilityKey,
  deniedMessage = "Forbidden"
): Promise<TeamAuthorizationContext> {
  const context = await getTeamAuthorizationContext();

  if (!hasResolvedTeamCapability(context, capabilityKey)) {
    throw new AuthError(
      403,
      deniedMessage,
      "TEAM_CAPABILITY_DENIED"
    );
  }

  return context;
}

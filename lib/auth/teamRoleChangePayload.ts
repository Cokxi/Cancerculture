import {
  isCanonicalTeamRole,
  type CanonicalTeamRole,
} from "@/lib/auth/teamRoles";

export type TeamRoleChangePayload = {
  targetDiscordId: string;
  targetRole: CanonicalTeamRole | null;
  reason: string;
};

export class TeamRolePayloadError extends Error {
  readonly status = 400;
}

export function parseTeamRoleChangePayload(
  value: unknown
): TeamRoleChangePayload {
  if (!value || typeof value !== "object") {
    throw new TeamRolePayloadError("Invalid payload");
  }

  const payload = value as Record<string, unknown>;
  const targetDiscordId =
    typeof payload.targetDiscordId === "string"
      ? payload.targetDiscordId.trim()
      : "";
  const reason =
    typeof payload.reason === "string"
      ? payload.reason.trim()
      : "";
  const targetRole = payload.targetRole;

  if (!targetDiscordId) {
    throw new TeamRolePayloadError(
      "Target Discord user is required"
    );
  }

  if (!reason) {
    throw new TeamRolePayloadError("Reason is required");
  }

  if (
    targetRole !== null &&
    !isCanonicalTeamRole(targetRole)
  ) {
    throw new TeamRolePayloadError("Invalid target role");
  }

  return {
    targetDiscordId,
    targetRole,
    reason,
  };
}

const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

export type TeamRoleCompatibilityPayload = Readonly<{
  targetDiscordId: string;
  targetRole: string;
  reason: string;
}>;

export class TeamRoleCompatibilityPayloadError extends Error {
  readonly status = 400;
}

export function parseTeamRoleCompatibilityPayload(
  value: unknown
): TeamRoleCompatibilityPayload {
  if (!value || typeof value !== "object") {
    throw new TeamRoleCompatibilityPayloadError(
      "Invalid payload"
    );
  }

  const payload = value as Record<string, unknown>;
  const allowed = new Set([
    "targetDiscordId",
    "targetRole",
    "reason",
  ]);

  if (Object.keys(payload).some((key) => !allowed.has(key))) {
    throw new TeamRoleCompatibilityPayloadError(
      "Unexpected payload field"
    );
  }

  const targetDiscordId =
    typeof payload.targetDiscordId === "string"
      ? payload.targetDiscordId.trim()
      : "";
  const targetRole =
    typeof payload.targetRole === "string"
      ? payload.targetRole.trim()
      : "";
  const reason =
    typeof payload.reason === "string"
      ? payload.reason.trim()
      : "";

  if (!targetDiscordId || targetDiscordId.length > 100) {
    throw new TeamRoleCompatibilityPayloadError(
      "Target Discord user is required"
    );
  }

  if (
    !ROLE_KEY_PATTERN.test(targetRole) ||
    targetRole === "admin"
  ) {
    throw new TeamRoleCompatibilityPayloadError(
      "Use the Owner Accounts area for Admin changes"
    );
  }

  if (reason.length < 3 || reason.length > 1000) {
    throw new TeamRoleCompatibilityPayloadError(
      "Reason must contain at least 3 characters"
    );
  }

  return { targetDiscordId, targetRole, reason };
}

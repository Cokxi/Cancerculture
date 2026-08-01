export type TeamAuthorizationRoleSnapshot = Readonly<{
  displayName: string | null;
  description: string | null;
  isActive: boolean | null;
}>;

export type TeamAuthorizationAdminAuditContext = Readonly<{
  beforeState: Readonly<Record<string, unknown>>;
  afterState: Readonly<Record<string, unknown>>;
  requestId: string | null;
}>;

export type TeamAuthorizationHistoryEntry = Readonly<{
  id: string;
  occurredAt: string;
  actorDiscordUserId: string;
  actorRoleKey: string;
  eventType: string;
  targetRoleKey: string | null;
  targetDiscordUserId: string | null;
  targetDiscordUsername: string | null;
  capabilityKey: string | null;
  previousRoleKey: string | null;
  newRoleKey: string | null;
  roleBefore: TeamAuthorizationRoleSnapshot | null;
  roleAfter: TeamAuthorizationRoleSnapshot | null;
  reason: string;
  adminAudit: TeamAuthorizationAdminAuditContext | null;
}>;

export type TeamAuthorizationAuditRow = {
  id: string;
  occurred_at: string;
  actor_discord_user_id: string;
  actor_role_key: string;
  event_type: string;
  target_role_key: string | null;
  target_discord_user_id: string | null;
  capability_key: string | null;
  before_state: Record<string, unknown>;
  after_state: Record<string, unknown>;
  reason: string;
  request_id?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(
  state: Record<string, unknown>,
  key: string
): string | null {
  const value = state[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null;
}

function readRoleSnapshot(
  state: Record<string, unknown>
): TeamAuthorizationRoleSnapshot | null {
  const nestedRole = asRecord(state.role);
  const source = nestedRole ?? state;
  const displayName = readString(source, "displayName");
  const description = readString(source, "description");
  const isActive =
    typeof source.isActive === "boolean" ? source.isActive : null;

  if (displayName === null && description === null && isActive === null) {
    return null;
  }

  return Object.freeze({ displayName, description, isActive });
}

export function buildTeamAuthorizationHistoryEntry(
  row: TeamAuthorizationAuditRow,
  isAdmin: boolean,
  targetDiscordUsername: string | null = null
): TeamAuthorizationHistoryEntry {
  const beforeState = asRecord(row.before_state) ?? {};
  const afterState = asRecord(row.after_state) ?? {};
  const previousRoleKey =
    readString(beforeState, "previousRole") ??
    readString(afterState, "previousRole");
  let newRoleKey = readString(afterState, "newRole");

  if (row.event_type === "member_added" && newRoleKey === null) {
    newRoleKey = row.target_role_key;
  }
  const normalizedTargetDiscordUsername = targetDiscordUsername?.trim() ?? "";

  return Object.freeze({
    id: row.id,
    occurredAt: row.occurred_at,
    actorDiscordUserId: row.actor_discord_user_id,
    actorRoleKey: row.actor_role_key,
    eventType: row.event_type,
    targetRoleKey: row.target_role_key,
    targetDiscordUserId: row.target_discord_user_id,
    targetDiscordUsername:
      normalizedTargetDiscordUsername.length >= 1 &&
      normalizedTargetDiscordUsername.length <= 100
        ? normalizedTargetDiscordUsername
        : null,
    capabilityKey: row.capability_key,
    previousRoleKey,
    newRoleKey,
    roleBefore: readRoleSnapshot(beforeState),
    roleAfter: readRoleSnapshot(afterState),
    reason: row.reason,
    adminAudit: isAdmin
      ? Object.freeze({
          beforeState: Object.freeze({ ...beforeState }),
          afterState: Object.freeze({ ...afterState }),
          requestId: row.request_id ?? null,
        })
      : null,
  });
}

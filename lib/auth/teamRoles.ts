export const CANONICAL_TEAM_ROLES = [
  "trial_moderator",
  "moderator",
  "super_moderator",
  "admin",
] as const;

export type CanonicalTeamRole =
  (typeof CANONICAL_TEAM_ROLES)[number];

/**
 * Temporary rollout-only read compatibility. New writes must always use a
 * canonical role.
 */
export const LEGACY_TEAM_ROLE = "mod" as const;
export type ReadableTeamRole =
  | CanonicalTeamRole
  | typeof LEGACY_TEAM_ROLE;

export const TEAM_CAPABILITIES = [
  "canModerateSubmissionPhase",
  "canDisqualifyDuringVoting",
  "canReinstateDuringVoting",
  "canFlagUsers",
  "canViewBasicUserDirectory",
  "canManageTeamRoles",
] as const;

export type TeamCapability =
  (typeof TEAM_CAPABILITIES)[number];

type TeamCapabilitySet = Readonly<
  Record<TeamCapability, boolean>
>;

const NO_CAPABILITIES: TeamCapabilitySet = {
  canModerateSubmissionPhase: false,
  canDisqualifyDuringVoting: false,
  canReinstateDuringVoting: false,
  canFlagUsers: false,
  canViewBasicUserDirectory: false,
  canManageTeamRoles: false,
};

export const TEAM_ROLE_CAPABILITIES: Readonly<
  Record<CanonicalTeamRole, TeamCapabilitySet>
> = {
  trial_moderator: {
    ...NO_CAPABILITIES,
    canModerateSubmissionPhase: true,
    canFlagUsers: true,
    canViewBasicUserDirectory: true,
  },
  moderator: {
    ...NO_CAPABILITIES,
    canModerateSubmissionPhase: true,
    canDisqualifyDuringVoting: true,
    canFlagUsers: true,
    canViewBasicUserDirectory: true,
  },
  super_moderator: {
    ...NO_CAPABILITIES,
    canModerateSubmissionPhase: true,
    canDisqualifyDuringVoting: true,
    canReinstateDuringVoting: true,
    canFlagUsers: true,
    canViewBasicUserDirectory: true,
  },
  admin: {
    canModerateSubmissionPhase: true,
    canDisqualifyDuringVoting: true,
    canReinstateDuringVoting: true,
    canFlagUsers: true,
    canViewBasicUserDirectory: true,
    canManageTeamRoles: true,
  },
};

export const TEAM_ROLE_LABELS: Readonly<
  Record<CanonicalTeamRole, string>
> = {
  trial_moderator: "Trial Moderator",
  moderator: "Moderator",
  super_moderator: "Super Moderator",
  admin: "Admin",
};

export function isCanonicalTeamRole(
  value: unknown
): value is CanonicalTeamRole {
  return (
    typeof value === "string" &&
    (CANONICAL_TEAM_ROLES as readonly string[]).includes(value)
  );
}

export function normalizeTeamRole(
  value: unknown
): CanonicalTeamRole | null {
  if (value === LEGACY_TEAM_ROLE) {
    return "trial_moderator";
  }

  return isCanonicalTeamRole(value) ? value : null;
}

export function getTeamRoleCapabilities(
  value: unknown
): TeamCapabilitySet {
  const role = normalizeTeamRole(value);
  return role ? TEAM_ROLE_CAPABILITIES[role] : NO_CAPABILITIES;
}

export function hasTeamCapability(
  value: unknown,
  capability: TeamCapability
): boolean {
  return getTeamRoleCapabilities(value)[capability];
}

export function isAdminTeamRole(value: unknown): boolean {
  return normalizeTeamRole(value) === "admin";
}

export function getTeamRoleLabel(value: unknown): string | null {
  const role = normalizeTeamRole(value);
  return role ? TEAM_ROLE_LABELS[role] : null;
}

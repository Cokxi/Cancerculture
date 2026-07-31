import "server-only";

import {
  TEAM_CAPABILITY_REGISTRY,
  isRegisteredTeamCapabilityKey,
  type RegisteredTeamCapabilityKey,
} from "@/lib/auth/teamCapabilityRegistry";
import {
  TEAM_CAPABILITY_COMPATIBILITY_ISSUE_CODES,
  evaluateTeamCapabilityCompatibility,
  type TeamCapabilityCompatibilityIssueCode,
} from "@/lib/auth/teamCapabilityCompatibility";

const TEAM_ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{2,63}$/u;

export type DynamicTeamRoleRecord = Readonly<{
  key: string;
  isActive: boolean;
}>;

export type DynamicCapabilityCatalogRecord = Readonly<{
  key: string;
  isActive: boolean;
  assignableToNonAdmin: boolean;
  implementationVersion: number;
  definitionHash: string;
}>;

export type DynamicRoleCapabilityGrantRecord = Readonly<{
  roleKey: string;
  capabilityKey: string;
}>;

export type DynamicTeamAuthorizationSnapshot = Readonly<{
  teamMemberRoleKey: string | null;
  roles: readonly DynamicTeamRoleRecord[];
  catalog: readonly DynamicCapabilityCatalogRecord[];
  grants: readonly DynamicRoleCapabilityGrantRecord[];
}>;

export const DYNAMIC_TEAM_AUTHORIZATION_STATUSES = [
  "resolved",
  "not_team_member",
  "inactive_role",
  "unknown_role",
  "registry_drift",
  "dependency_unavailable",
] as const;

export type DynamicTeamAuthorizationStatus =
  (typeof DYNAMIC_TEAM_AUTHORIZATION_STATUSES)[number];

export const DYNAMIC_TEAM_AUTHORIZATION_DIAGNOSTIC_CODES = [
  "team_member_not_found",
  "invalid_role_key",
  "role_not_registered",
  "role_inactive",
  ...TEAM_CAPABILITY_COMPATIBILITY_ISSUE_CODES,
  "grant_missing",
  "dependency_unavailable",
] as const;

export type DynamicTeamAuthorizationDiagnosticCode =
  (typeof DYNAMIC_TEAM_AUTHORIZATION_DIAGNOSTIC_CODES)[number];

export type DynamicTeamAuthorizationDiagnostic = Readonly<{
  kind: "denial" | "drift" | "dependency";
  code: DynamicTeamAuthorizationDiagnosticCode;
  roleKey: string | null;
  capabilityKey: string | null;
  reason: string;
}>;

export type DynamicTeamAuthorizationResult = Readonly<{
  status: DynamicTeamAuthorizationStatus;
  roleKey: string | null;
  isAdmin: boolean;
  resolvedCapabilities: readonly RegisteredTeamCapabilityKey[];
  diagnostics: readonly DynamicTeamAuthorizationDiagnostic[];
}>;

function diagnostic(
  value: DynamicTeamAuthorizationDiagnostic
): DynamicTeamAuthorizationDiagnostic {
  return Object.freeze(value);
}

function result(
  value: Omit<
    DynamicTeamAuthorizationResult,
    "resolvedCapabilities" | "diagnostics"
  > & {
    resolvedCapabilities: readonly RegisteredTeamCapabilityKey[];
    diagnostics: readonly DynamicTeamAuthorizationDiagnostic[];
  }
): DynamicTeamAuthorizationResult {
  return Object.freeze({
    ...value,
    resolvedCapabilities: Object.freeze([
      ...value.resolvedCapabilities,
    ]),
    diagnostics: Object.freeze([...value.diagnostics]),
  });
}

function terminalResult(
  status: Exclude<
    DynamicTeamAuthorizationStatus,
    "resolved" | "registry_drift"
  >,
  roleKey: string | null,
  code: DynamicTeamAuthorizationDiagnosticCode,
  reason: string,
  kind: DynamicTeamAuthorizationDiagnostic["kind"] = "denial"
): DynamicTeamAuthorizationResult {
  return result({
    status,
    roleKey,
    isAdmin: false,
    resolvedCapabilities: [],
    diagnostics: [
      diagnostic({
        kind,
        code,
        roleKey,
        capabilityKey: null,
        reason,
      }),
    ],
  });
}

export function dependencyUnavailableTeamAuthorization(): DynamicTeamAuthorizationResult {
  return terminalResult(
    "dependency_unavailable",
    null,
    "dependency_unavailable",
    "The dynamic authorization dependencies are unavailable.",
    "dependency"
  );
}

function compatibilityIssueReason(
  code: TeamCapabilityCompatibilityIssueCode
): string {
  switch (code) {
    case "unknown_catalog_key_active":
      return "An unregistered database capability is active.";
    case "unknown_catalog_key_assignable":
      return "An unregistered database capability is assignable.";
    case "unknown_catalog_key_granted":
      return "An unregistered database capability has a grant.";
    case "active_registry_key_missing_catalog":
      return "An active registered capability is missing from the database catalog.";
    case "catalog_entry_inactive":
      return "The database capability for an active registry entry is inactive.";
    case "capability_not_assignable":
      return "The database capability for an active registry entry is not assignable.";
    case "implementation_version_mismatch":
      return "The database and code implementation versions differ.";
    case "definition_hash_mismatch":
      return "The database and code capability definitions differ.";
    case "inactive_registry_key_active_in_catalog":
      return "A non-active registry capability is active in the database catalog.";
    case "inactive_registry_key_assignable_in_catalog":
      return "A non-active registry capability is assignable in the database catalog.";
    case "inactive_registry_key_granted":
      return "A non-active registry capability has a grant.";
  }
}

export function resolveDynamicTeamAuthorizationSnapshot(
  snapshot: DynamicTeamAuthorizationSnapshot
): DynamicTeamAuthorizationResult {
  if (snapshot.teamMemberRoleKey === null) {
    return terminalResult(
      "not_team_member",
      null,
      "team_member_not_found",
      "No team membership exists."
    );
  }

  const roleKey = snapshot.teamMemberRoleKey;

  if (!TEAM_ROLE_KEY_PATTERN.test(roleKey)) {
    return terminalResult(
      "unknown_role",
      null,
      "invalid_role_key",
      "The team role key has an invalid format."
    );
  }

  const role = snapshot.roles.find(
    (candidate) => candidate.key === roleKey
  );

  if (!role) {
    return terminalResult(
      "unknown_role",
      roleKey,
      "role_not_registered",
      "The team role is not registered."
    );
  }

  if (!role.isActive) {
    return terminalResult(
      "inactive_role",
      roleKey,
      "role_inactive",
      "The team role is inactive."
    );
  }

  if (roleKey === "admin") {
    return result({
      status: "resolved",
      roleKey,
      isAdmin: true,
      resolvedCapabilities: [],
      diagnostics: [],
    });
  }

  const diagnostics: DynamicTeamAuthorizationDiagnostic[] = [];
  const resolvedCapabilities: RegisteredTeamCapabilityKey[] = [];
  const roleGrantKeys = new Set(
    snapshot.grants
      .filter((grant) => grant.roleKey === roleKey)
      .map((grant) => grant.capabilityKey)
  );
  const compatibility = evaluateTeamCapabilityCompatibility({
    registry: TEAM_CAPABILITY_REGISTRY,
    catalog: snapshot.catalog,
    grantedCapabilityKeys: snapshot.grants.map(
      (grant) => grant.capabilityKey
    ),
  });

  for (const compatibilityIssue of compatibility.issues) {
    diagnostics.push(
      diagnostic({
        kind: "drift",
        code: compatibilityIssue.code,
        roleKey,
        capabilityKey: compatibilityIssue.capabilityKey,
        reason: compatibilityIssueReason(compatibilityIssue.code),
      })
    );
  }

  for (const capabilityKey of compatibility.activeCapabilityKeys) {
    if (!isRegisteredTeamCapabilityKey(capabilityKey)) {
      continue;
    }

    if (!roleGrantKeys.has(capabilityKey)) {
      diagnostics.push(
        diagnostic({
          kind: "denial",
          code: "grant_missing",
          roleKey,
          capabilityKey,
          reason:
            "No positive grant exists for the role and capability.",
        })
      );
      continue;
    }

    resolvedCapabilities.push(capabilityKey);
  }

  return result({
    status: diagnostics.some(
      (entry) => entry.kind === "drift"
    )
      ? "registry_drift"
      : "resolved",
    roleKey,
    isAdmin: false,
    resolvedCapabilities,
    diagnostics,
  });
}

export async function resolveDynamicTeamAuthorizationWithLoader(
  loadSnapshot: () => Promise<DynamicTeamAuthorizationSnapshot>
): Promise<DynamicTeamAuthorizationResult> {
  try {
    return resolveDynamicTeamAuthorizationSnapshot(
      await loadSnapshot()
    );
  } catch {
    return dependencyUnavailableTeamAuthorization();
  }
}

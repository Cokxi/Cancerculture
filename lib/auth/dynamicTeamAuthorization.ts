import "server-only";

import {
  REGISTERED_TEAM_CAPABILITY_KEYS,
  TEAM_CAPABILITY_REGISTRY,
  isRegisteredTeamCapabilityKey,
  type RegisteredTeamCapabilityKey,
} from "@/lib/auth/teamCapabilityRegistry";

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
  "unknown_database_capability",
  "catalog_entry_missing",
  "catalog_entry_inactive",
  "capability_not_assignable",
  "implementation_version_mismatch",
  "definition_hash_mismatch",
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
  const unknownDatabaseKeys = new Set<string>();
  const catalogByKey = new Map(
    snapshot.catalog.map((entry) => [entry.key, entry])
  );
  const roleGrantKeys = new Set(
    snapshot.grants
      .filter((grant) => grant.roleKey === roleKey)
      .map((grant) => grant.capabilityKey)
  );

  for (const entry of snapshot.catalog) {
    if (!isRegisteredTeamCapabilityKey(entry.key)) {
      unknownDatabaseKeys.add(entry.key);
    }
  }

  for (const capabilityKey of roleGrantKeys) {
    if (!isRegisteredTeamCapabilityKey(capabilityKey)) {
      unknownDatabaseKeys.add(capabilityKey);
    }
  }

  for (const capabilityKey of [...unknownDatabaseKeys].sort()) {
    diagnostics.push(
      diagnostic({
        kind: "drift",
        code: "unknown_database_capability",
        roleKey,
        capabilityKey,
        reason:
          "The database capability is not present in the code registry.",
      })
    );
  }

  for (const capabilityKey of REGISTERED_TEAM_CAPABILITY_KEYS) {
    const definition =
      TEAM_CAPABILITY_REGISTRY[capabilityKey];
    const catalogEntry = catalogByKey.get(capabilityKey);
    let allowed = true;

    if (!catalogEntry) {
      diagnostics.push(
        diagnostic({
          kind: "drift",
          code: "catalog_entry_missing",
          roleKey,
          capabilityKey,
          reason:
            "The registered capability is missing from the database catalog.",
        })
      );
      allowed = false;
    } else {
      if (!catalogEntry.isActive) {
        diagnostics.push(
          diagnostic({
            kind: "denial",
            code: "catalog_entry_inactive",
            roleKey,
            capabilityKey,
            reason: "The database capability is inactive.",
          })
        );
        allowed = false;
      }

      if (!catalogEntry.assignableToNonAdmin) {
        diagnostics.push(
          diagnostic({
            kind: "denial",
            code: "capability_not_assignable",
            roleKey,
            capabilityKey,
            reason:
              "The database capability is not assignable to non-admin roles.",
          })
        );
        allowed = false;
      }

      if (
        catalogEntry.implementationVersion !==
        definition.implementationVersion
      ) {
        diagnostics.push(
          diagnostic({
            kind: "drift",
            code: "implementation_version_mismatch",
            roleKey,
            capabilityKey,
            reason:
              "The database and code implementation versions differ.",
          })
        );
        allowed = false;
      }

      if (
        catalogEntry.definitionHash !==
        definition.definitionHash
      ) {
        diagnostics.push(
          diagnostic({
            kind: "drift",
            code: "definition_hash_mismatch",
            roleKey,
            capabilityKey,
            reason:
              "The database and code capability definitions differ.",
          })
        );
        allowed = false;
      }
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
      allowed = false;
    }

    if (allowed) {
      resolvedCapabilities.push(capabilityKey);
    }
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

import "server-only";

import type {
  TeamCapabilityDefinition,
  TeamCapabilityLifecycle,
} from "@/lib/auth/teamCapabilityRegistry";

export type TeamCapabilityCompatibilityRegistryDefinition = Pick<
  TeamCapabilityDefinition,
  "implementationVersion" | "definitionHash"
> &
  Readonly<{
    key: string;
    lifecycle: TeamCapabilityLifecycle;
  }>;

export type TeamCapabilityCompatibilityCatalogRecord = Readonly<{
  key: string;
  isActive: boolean;
  assignableToNonAdmin: boolean;
  implementationVersion: number;
  definitionHash: string;
}>;

export const TEAM_CAPABILITY_COMPATIBILITY_ISSUE_CODES = Object.freeze([
  "unknown_catalog_key_active",
  "unknown_catalog_key_assignable",
  "unknown_catalog_key_granted",
  "active_registry_key_missing_catalog",
  "catalog_entry_inactive",
  "capability_not_assignable",
  "implementation_version_mismatch",
  "definition_hash_mismatch",
  "inactive_registry_key_active_in_catalog",
  "inactive_registry_key_assignable_in_catalog",
  "inactive_registry_key_granted",
] as const);

export type TeamCapabilityCompatibilityIssueCode =
  (typeof TEAM_CAPABILITY_COMPATIBILITY_ISSUE_CODES)[number];

export type TeamCapabilityCompatibilityIssue = Readonly<{
  code: TeamCapabilityCompatibilityIssueCode;
  capabilityKey: string;
}>;

export type TeamCapabilityCompatibilityResult = Readonly<{
  activeCapabilityKeys: readonly string[];
  safeTombstoneKeys: readonly string[];
  issues: readonly TeamCapabilityCompatibilityIssue[];
}>;

function issue(
  code: TeamCapabilityCompatibilityIssueCode,
  capabilityKey: string
): TeamCapabilityCompatibilityIssue {
  return Object.freeze({ code, capabilityKey });
}

export function evaluateTeamCapabilityCompatibility(input: Readonly<{
  registry: Readonly<
    Record<string, TeamCapabilityCompatibilityRegistryDefinition>
  >;
  catalog: readonly TeamCapabilityCompatibilityCatalogRecord[];
  grantedCapabilityKeys: ReadonlySet<string> | readonly string[];
}>): TeamCapabilityCompatibilityResult {
  const catalogByKey = new Map(
    input.catalog.map((entry) => [entry.key, entry])
  );
  const grantedCapabilityKeys =
    input.grantedCapabilityKeys instanceof Set
      ? input.grantedCapabilityKeys
      : new Set(input.grantedCapabilityKeys);
  const activeCapabilityKeys: string[] = [];
  const safeTombstoneKeys = new Set<string>();
  const issues: TeamCapabilityCompatibilityIssue[] = [];

  for (const [capabilityKey, definition] of Object.entries(
    input.registry
  )) {
    const catalogEntry = catalogByKey.get(capabilityKey);

    if (definition.lifecycle !== "active") {
      if (!catalogEntry) {
        if (grantedCapabilityKeys.has(capabilityKey)) {
          issues.push(
            issue("inactive_registry_key_granted", capabilityKey)
          );
        } else {
          safeTombstoneKeys.add(capabilityKey);
        }
        continue;
      }

      const issueCount = issues.length;
      if (catalogEntry.isActive) {
        issues.push(
          issue(
            "inactive_registry_key_active_in_catalog",
            capabilityKey
          )
        );
      }
      if (catalogEntry.assignableToNonAdmin) {
        issues.push(
          issue(
            "inactive_registry_key_assignable_in_catalog",
            capabilityKey
          )
        );
      }
      if (grantedCapabilityKeys.has(capabilityKey)) {
        issues.push(
          issue("inactive_registry_key_granted", capabilityKey)
        );
      }
      if (issues.length === issueCount) {
        safeTombstoneKeys.add(capabilityKey);
      }
      continue;
    }

    if (!catalogEntry) {
      issues.push(
        issue("active_registry_key_missing_catalog", capabilityKey)
      );
      continue;
    }

    const issueCount = issues.length;
    if (!catalogEntry.isActive) {
      issues.push(issue("catalog_entry_inactive", capabilityKey));
    }
    if (!catalogEntry.assignableToNonAdmin) {
      issues.push(issue("capability_not_assignable", capabilityKey));
    }
    if (
      catalogEntry.implementationVersion !==
      definition.implementationVersion
    ) {
      issues.push(
        issue("implementation_version_mismatch", capabilityKey)
      );
    }
    if (catalogEntry.definitionHash !== definition.definitionHash) {
      issues.push(issue("definition_hash_mismatch", capabilityKey));
    }
    if (issues.length === issueCount) {
      activeCapabilityKeys.push(capabilityKey);
    }
  }

  for (const catalogEntry of input.catalog) {
    if (Object.hasOwn(input.registry, catalogEntry.key)) {
      continue;
    }

    const issueCount = issues.length;
    if (catalogEntry.isActive) {
      issues.push(issue("unknown_catalog_key_active", catalogEntry.key));
    }
    if (catalogEntry.assignableToNonAdmin) {
      issues.push(
        issue("unknown_catalog_key_assignable", catalogEntry.key)
      );
    }
    if (grantedCapabilityKeys.has(catalogEntry.key)) {
      issues.push(
        issue("unknown_catalog_key_granted", catalogEntry.key)
      );
    }
    if (issues.length === issueCount) {
      safeTombstoneKeys.add(catalogEntry.key);
    }
  }

  for (const capabilityKey of grantedCapabilityKeys) {
    if (
      !Object.hasOwn(input.registry, capabilityKey) &&
      !catalogByKey.has(capabilityKey)
    ) {
      issues.push(issue("unknown_catalog_key_granted", capabilityKey));
    }
  }

  return Object.freeze({
    activeCapabilityKeys: Object.freeze(activeCapabilityKeys),
    safeTombstoneKeys: Object.freeze([...safeTombstoneKeys].sort()),
    issues: Object.freeze(issues),
  });
}

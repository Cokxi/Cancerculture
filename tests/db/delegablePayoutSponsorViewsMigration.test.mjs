import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260802000300_delegable_payout_and_sponsor_report_views.sql",
    import.meta.url
  ),
  "utf8"
);

function canonicalDefinition(entry) {
  return {
    key: entry.key,
    display_name: entry.displayName,
    description: entry.description,
    category: entry.category,
    included_actions: entry.includedActions,
    excluded_actions: entry.excludedActions,
    risk_level: entry.riskLevel,
    assignable_to_non_admin: entry.assignableToNonAdmin,
    implementation_version: entry.implementationVersion,
  };
}

test("the migration adds exactly two high-risk read capabilities with zero grants", () => {
  const expected = new Map([
    [
      "sponsorships.reports.view",
      "421c31be87cac7864a7fb6fad229e614befed4d38374f0fc05e285ffaa24d655",
    ],
    [
      "winners.payouts.view",
      "d482f10a0e15ea2f166f633e7cf8a27760987ea748fddc4b5c34aa6abde978e9",
    ],
  ]);

  for (const [key, expectedHash] of expected) {
    const definition = TEAM_CAPABILITY_REGISTRY[key];
    const actualHash = createHash("sha256")
      .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
      .digest("hex");

    assert.equal(actualHash, expectedHash);
    assert.equal(definition.definitionHash, expectedHash);
    assert.equal(definition.riskLevel, "high");
    assert.equal(definition.assignableToNonAdmin, true);
    assert.match(migration, new RegExp(key.replaceAll(".", "\\."), "u"));
    assert.match(migration, new RegExp(expectedHash, "u"));
  }

  assert.match(
    migration,
    /insert into public\.capability_catalog[\s\S]*values[\s\S]*sponsorships\.reports\.view[\s\S]*winners\.payouts\.view/u
  );
  assert.doesNotMatch(
    migration,
    /insert\s+into\s+public\.team_role_capabilities/iu
  );
});

test("the migration preserves RLS and zero Browser SELECT on every source table", () => {
  for (const table of [
    "winner_public_profiles",
    "cycle_sponsorships",
    "sponsor_tracking_events",
  ]) {
    assert.match(migration, new RegExp(`public\\.${table}`, "u"));
    assert.match(
      migration,
      new RegExp(
        `has_table_privilege\\([\\s\\S]*'anon', 'public\\.${table}', 'select'`,
        "u"
      )
    );
    assert.match(
      migration,
      new RegExp(
        `has_table_privilege\\([\\s\\S]*'authenticated', 'public\\.${table}', 'select'`,
        "u"
      )
    );
  }

  assert.doesNotMatch(
    migration,
    /grant\s+(?:select|insert|update|delete)|create\s+(?:or\s+replace\s+)?function/iu
  );
});

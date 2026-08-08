import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const repoRoot = new URL("../../", import.meta.url);
const migration = await readFile(
  new URL(
    "supabase/migrations/20260808000200_manual_vote_refund_follow_up.sql",
    repoRoot
  ),
  "utf8"
);
const historyReadModel = await readFile(
  new URL("lib/voteRefund/historyReadModel.server.ts", repoRoot),
  "utf8"
);
const moderationReadModel = await readFile(
  new URL("lib/moderation/submissionModerationReadModel.ts", repoRoot),
  "utf8"
);
const reinstatementConcurrencyTest = await readFile(
  new URL(
    "tests/db/manualVoteRefundReinstatementConcurrency.dev.mjs",
    repoRoot
  ),
  "utf8"
);

function canonicalDefinition(definition) {
  return {
    key: definition.key,
    display_name: definition.displayName,
    description: definition.description,
    category: definition.category,
    included_actions: definition.includedActions,
    excluded_actions: definition.excludedActions,
    risk_level: definition.riskLevel,
    assignable_to_non_admin: definition.assignableToNonAdmin,
    implementation_version: definition.implementationVersion,
  };
}

test("the follow-up migration is additive and preserves capability grants", () => {
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /set local lock_timeout = '5s'/u);
  assert.match(
    migration,
    /d973a6edb746cd7740a5dd8142b34aad2be21ed60d66d0cf64a1ee2df1a67619/u
  );

  const definition =
    TEAM_CAPABILITY_REGISTRY["logs.vote_refunds.view"];
  const hash = createHash("sha256")
    .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
    .digest("hex");
  assert.equal(definition.implementationVersion, 2);
  assert.equal(hash, definition.definitionHash);
  assert.match(migration, new RegExp(hash, "u"));
  assert.doesNotMatch(
    migration,
    /(?:insert\s+into|update|delete\s+from)\s+public\.team_role_capabilities/iu
  );
});

test("audit notes are optional at the database boundary", () => {
  assert.match(
    migration,
    /alter column reason_text drop not null[\s\S]*reason_text is null/u
  );
  assert.match(
    migration,
    /v_reason_text text := nullif\(btrim\(coalesce\(p_reason_text, ''\)\), ''\)/u
  );
  assert.match(
    migration,
    /v_reason_text is not null[\s\S]*char_length\(v_reason_text\) not between 3 and 1000/u
  );
  assert.doesNotMatch(
    migration,
    /nullif\(v_reason_text, ''\) is null/u
  );
});

test("successful refunds atomically mark submissions and permanently block reinstatement", () => {
  assert.match(migration, /add column vote_refund_id uuid/u);
  assert.match(migration, /add column vote_refunded_at timestamptz/u);
  assert.match(migration, /references public\.vote_refund_events\(idempotency_key\)[\s\S]*on delete restrict/u);
  assert.match(migration, /with refund_context as[\s\S]*update public\.submissions/u);
  assert.match(migration, /create trigger submissions_vote_refund_insert_guard/u);
  assert.match(migration, /create trigger submissions_vote_refund_update_guard/u);
  assert.match(migration, /VOTE_REFUNDED_SUBMISSION_REINSTATEMENT_BLOCKED/u);
  assert.match(
    migration,
    /insert into public\.vote_refund_items[\s\S]*update public\.submissions[\s\S]*delete from public\.votes/u
  );
  assert.match(
    migration,
    /v_marked_submission_count <> cardinality\(v_submission_ids\)/u
  );
  assert.match(moderationReadModel, /vote_refund_id, vote_refunded_at/u);
});

test("the grouped history view exposes only bounded voter identity aggregates", () => {
  assert.match(
    migration,
    /create view public\.vote_refund_submission_audit[\s\S]*security_invoker = true[\s\S]*security_barrier = true/u
  );
  assert.match(
    migration,
    /array_agg\([\s\S]*voter_discord_user_id[\s\S]*refunded_voter_ids/u
  );
  assert.match(
    migration,
    /revoke all on table public\.vote_refund_submission_audit[\s\S]*grant select on table public\.vote_refund_submission_audit to service_role/u
  );
  assert.match(
    historyReadModel,
    /hasResolvedTeamCapability\([\s\S]*"logs\.votes\.view"/u
  );
  assert.match(
    historyReadModel,
    /\.from\("vote_refund_submission_audit"\)/u
  );
  assert.doesNotMatch(
    historyReadModel,
    /original_vote_id|vote_created_at|request_hash/u
  );
});

test("the practical concurrency gate locks refunded submissions and rolls back", () => {
  assert.match(reinstatementConcurrencyTest, /Promise\.allSettled/u);
  assert.match(reinstatementConcurrencyTest, /for update/u);
  assert.match(
    reinstatementConcurrencyTest,
    /VOTE_REFUNDED_SUBMISSION_REINSTATEMENT_BLOCKED/u
  );
  assert.match(reinstatementConcurrencyTest, /rollback;/u);
  assert.doesNotMatch(reinstatementConcurrencyTest, /delete from public\./u);
});

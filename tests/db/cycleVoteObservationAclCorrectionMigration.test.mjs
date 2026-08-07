import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const foundation = await readFile(
  new URL(
    "supabase/migrations/20260807000100_cycle_vote_observation_foundation.sql",
    repoRoot
  )
);
const migration = await readFile(
  new URL(
    "supabase/migrations/20260807000200_narrow_cycle_vote_observation_service_role_acls.sql",
    repoRoot
  ),
  "utf8"
);

const observationTables = [
  "cycle_vote_signal_policies",
  "cycle_vote_signal_policy_state",
  "cycle_vote_signal_bindings",
  "cycle_vote_observation_snapshots",
  "cycle_vote_submission_observations",
  "cycle_vote_observation_events",
];

test("the applied foundation migration remains byte-for-byte immutable", () => {
  assert.equal(
    createHash("sha256").update(foundation).digest("hex"),
    "615b9b5bcf927cb3e611097e41cd5e88d1197bdea25343d56fb6492d26ac7af0"
  );
});

test("the correction is transactional and guarded by the exact DEV stop state", () => {
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /set local lock_timeout = '5s'/u);
  assert.match(migration, /CYCLE_VOTE_OBSERVATION_ACL_SOURCE_MISMATCH/u);
  assert.match(migration, /CYCLE_VOTE_OBSERVATION_ACL_DATA_MISMATCH/u);
  assert.match(migration, /policy\.mode = 'aggregate_only'/u);
  assert.match(migration, /cycle_vote_observation_events\) <> 0/u);
});

test("all six observation tables become service-role SELECT-only", () => {
  for (const table of observationTables) {
    assert.match(migration, new RegExp(`public\\.${table}`, "u"));
  }

  assert.match(
    migration,
    /revoke all on table[\s\S]*from service_role/u
  );
  assert.match(
    migration,
    /grant select on table[\s\S]*to service_role/u
  );
  assert.match(migration, /not has_table_privilege\('service_role',[\s\S]*'SELECT'\)/u);
  assert.match(migration, /'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'/u);
  assert.doesNotMatch(migration, /alter default privileges/iu);
  assert.doesNotMatch(migration, /grant (?:all|insert|update|delete|truncate|references|trigger)[\s\S]*to service_role/iu);
});

test("anonymous roles remain denied and function ACLs remain unchanged", () => {
  assert.match(migration, /array\['anon', 'authenticated'\]/u);
  assert.match(migration, /has_table_privilege\(\s*forbidden_role/u);
  assert.match(migration, /function_row\.owner_name <> 'postgres'/u);
  assert.match(migration, /function_row\.prosecdef/u);
  assert.match(migration, /search_path=public, pg_temp/u);
  assert.match(migration, /calculate_cycle_vote_observation_snapshot/u);
  assert.doesNotMatch(migration, /create or replace function/iu);
  assert.doesNotMatch(migration, /(?:insert into|update|delete from) public\./iu);
});

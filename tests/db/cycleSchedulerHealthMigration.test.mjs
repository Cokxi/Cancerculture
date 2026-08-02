import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const foundationPath = new URL(
  "../../supabase/migrations/20260802000500_cycle_scheduler_health.sql",
  import.meta.url
);
const ownerAclPath = new URL(
  "../../supabase/migrations/20260802000600_fix_cycle_scheduler_health_owner_acl.sql",
  import.meta.url
);

test("scheduler health uses a protected singleton and two hardened RPCs", async () => {
  const migration = await readFile(foundationPath, "utf8");

  assert.match(migration, /create table public\.cycle_scheduler_health/);
  assert.match(
    migration,
    /alter table public\.cycle_scheduler_health enable row level security/
  );
  assert.match(migration, /constraint cycle_scheduler_health_singleton_check/);
  assert.match(migration, /create function public\.begin_cycle_scheduler_run/);
  assert.match(migration, /create function public\.finish_cycle_scheduler_run/);
  assert.equal(
    (migration.match(/security definer/g) ?? []).length,
    2
  );
  assert.equal(
    (migration.match(/set search_path = public, pg_temp/g) ?? []).length,
    2
  );
});

test("only service_role can read health or execute its outer RPCs", async () => {
  const migration = await readFile(foundationPath, "utf8");

  assert.match(
    migration,
    /grant select on table public\.cycle_scheduler_health to service_role/
  );
  assert.match(
    migration,
    /grant execute on function public\.begin_cycle_scheduler_run\(uuid\) to service_role/
  );
  assert.match(
    migration,
    /grant execute on function public\.finish_cycle_scheduler_run\(uuid, boolean, text\) to service_role/
  );
  assert.doesNotMatch(
    migration,
    /grant (?:select|insert|update|delete).*\b(?:anon|authenticated|discord_bot)\b/i
  );
  assert.doesNotMatch(
    migration,
    /grant execute.*\b(?:anon|authenticated|discord_bot)\b/i
  );
});

test("the additive owner ACL follow-up grants only the DML needed by the RPCs", async () => {
  const migration = await readFile(ownerAclPath, "utf8");

  assert.match(
    migration,
    /grant update on table public\.cycle_scheduler_health to postgres/
  );
  assert.doesNotMatch(migration, /grant (?:insert|delete|truncate)/i);
  assert.match(migration, /CYCLE_SCHEDULER_OWNER_ACL_POSTFLIGHT_FAILED/);
});

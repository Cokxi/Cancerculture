import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const migration = await readFile(
  new URL(
    "supabase/migrations/20260731000700_user_flag_cases_cutover.sql",
    root
  ),
  "utf8"
);

test("the cutover is one guarded forward-only transaction", () => {
  assert.match(migration, /^begin;\s/u);
  assert.match(migration, /commit;\s*$/u);
  assert.match(migration, /USER_FLAG_CUTOVER_CATALOG_BASELINE_MISMATCH/u);
  assert.match(migration, /count\(\*\).*<> 7/su);
  assert.match(migration, /where is_active\) <> 6/u);
  assert.match(migration, /USER_FLAG_CUTOVER_REQUIRES_ZERO_GRANTS/u);
  assert.match(migration, /USER_FLAG_CUTOVER_UNKNOWN_LEGACY_CATEGORY/u);
  assert.doesNotMatch(migration, /\b40001\b/u);
});

test("canonical cases, append-only history, and one-open-case invariant are structural", () => {
  for (const table of [
    "user_flag_cases",
    "user_flag_events",
    "user_flag_requests",
  ]) {
    assert.match(migration, new RegExp(`create table public\\.${table}`, "u"));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "u"));
  }
  assert.match(
    migration,
    /create unique index user_flag_cases_one_open_per_user_idx[\s\S]*where status = 'open'/u
  );
  assert.match(migration, /USER_FLAG_CASE_DELETE_FORBIDDEN/u);
  assert.match(migration, /USER_FLAG_APPEND_ONLY_VIOLATION/u);
  assert.match(migration, /before update or delete[\s\S]*user_flag_events/u);
  assert.match(migration, /before update or delete[\s\S]*user_flag_requests/u);
});

test("legacy flags are migrated with provenance and only legacy flag fields are cleared", () => {
  assert.match(migration, /'legacy_case_migrated'/u);
  assert.match(migration, /'legacy_system'/u);
  for (const field of [
    "flagged_at",
    "flagged_by_discord_user_id",
    "flagged_by_discord_username",
    "flag_reason_code",
    "flag_note",
  ]) {
    assert.match(migration, new RegExp(field, "u"));
  }
  assert.match(migration, /USER_FLAG_LEGACY_CASE_COUNT_MISMATCH/u);
  assert.match(migration, /USER_FLAG_LEGACY_EVENT_COUNT_MISMATCH/u);
  assert.match(migration, /USER_FLAG_NON_FLAG_DATA_CHANGED/u);
  assert.match(migration, /to_jsonb\(user_row\)[\s\S]*- array\[/u);
  assert.match(migration, /disable trigger trg_user_logs_updated_at[\s\S]*update public\.user_logs[\s\S]*enable trigger trg_user_logs_updated_at/u);
});

test("the three capabilities activate while the legacy key becomes an exact tombstone", () => {
  const definitions = {
    "users.flag.create":
      "bf758cdf0fa93e88b27a40582916efbea56d5d25d708d02f9889ed3a3cbe5dbf",
    "users.flag.view":
      "8cbde5054432fc6630bbec66c68ce98393f6c37744eb8452b28ea67dfdbc431c",
    "users.flag.review":
      "d43a7db86453e3432b04b65bad4cb7b01555c77f18cd4c26bd58a626d5508dbe",
  };
  for (const [key, hash] of Object.entries(definitions)) {
    assert.match(migration, new RegExp(`'${key}'`, "u"));
    assert.match(migration, new RegExp(hash, "u"));
  }
  assert.match(migration, /where key = 'users\.flag'/u);
  assert.match(migration, /assignable_to_non_admin = false,[\s\S]*is_active = false,[\s\S]*implementation_version = 2/u);
  assert.match(migration, /4ec252dadafc8d9e149df225825f850fd90666e444fff4edaca43bd5d02b553c/u);
  assert.match(migration, /count\(\*\).*<> 10/su);
  assert.match(migration, /where is_active\) <> 8/u);
});

test("RPCs enforce capability authorization, fixed paths, and service-only execution", () => {
  for (const signature of [
    "create_user_flag_case",
    "list_user_flag_cases",
    "get_user_flag_case",
    "review_user_flag_case",
  ]) {
    assert.match(migration, new RegExp(`create function public\\.${signature}\\(`, "u"));
    assert.match(migration, new RegExp(`grant execute on function public\\.${signature}\\(`, "u"));
  }
  assert.equal(migration.match(/security definer/gu)?.length, 5);
  assert.equal(migration.match(/set search_path = public, pg_temp/gu)?.length, 7);
  assert.match(migration, /from public, anon, authenticated, discord_bot, service_role/u);
  assert.match(migration, /to service_role/u);
  assert.doesNotMatch(migration, /to (?:public|anon|authenticated|discord_bot)\s*;/iu);
});

test("create and review mutations are replay-safe and use deterministic conflict semantics", () => {
  assert.equal(migration.match(/pg_advisory_xact_lock/gu)?.length, 2);
  assert.equal(migration.match(/return jsonb_set\(v_existing_result, '\{replayed\}'/gu)?.length, 2);
  assert.match(migration, /USER_FLAG_IDEMPOTENCY_CONFLICT/u);
  assert.match(migration, /USER_FLAG_OPEN_CASE_CONFLICT/u);
  assert.match(migration, /USER_FLAG_CASE_ALREADY_CLOSED/u);
  assert.match(migration, /USER_FLAG_STALE_VERSION/u);
  assert.equal(migration.match(/errcode = 'PT409'/gu)?.length, 6);
  assert.match(migration, /from public\.user_logs[\s\S]*for update/u);
  assert.match(migration, /from public\.user_flag_cases[\s\S]*for update/u);
  assert.match(migration, /row_version = row_version \+ 1/u);
});

test("base tables deny mutating application DML", () => {
  assert.match(migration, /revoke all on table public\.user_flag_cases[\s\S]*service_role/u);
  assert.match(migration, /grant select on table public\.user_flag_cases[\s\S]*to service_role/u);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete|all)[\s\S]*user_flag_(?:cases|events|requests)[\s\S]*service_role/iu);
});

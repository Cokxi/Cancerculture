import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260826000600_user_warning_issue_target.sql",
    import.meta.url,
  ),
  "utf8",
);

test("Warning target migration requires the exact applied Atomic Core", () => {
  assert.match(migration, /issue_user_warning\(text,uuid,bigint,bigint,text,text,uuid\)/u);
  assert.match(migration, /authorize_user_warning_capability\(text,text\)/u);
  assert.match(migration, /8910867c7eb547473efaf129089bf2e0098d6f471e2057358ddd77f90818811f/u);
  assert.match(migration, /get_user_warning_issue_target\(text,uuid\)[\s\S]*is not null/u);
});

test("Warning target read is guarded by the exact Issue capability", () => {
  assert.match(
    migration,
    /authorize_user_warning_capability\([\s\S]*'users[.]warnings[.]issue'/u,
  );
  assert.doesNotMatch(migration, /community[.]comments[.]moderate/u);
  assert.doesNotMatch(migration, /users[.]warnings[.]overrule/u);
});

test("Warning target returns only exact Comment evidence and permanent source use", () => {
  for (const key of [
    "publicCommentId",
    "objectVersion",
    "textVersion",
    "text",
    "available",
    "alreadyWarned",
  ]) {
    assert.match(migration, new RegExp(`'${key}'`, "u"));
  }
  assert.match(migration, /community_comment_text_versions/u);
  assert.match(migration, /text_version[.]normalized_body/u);
  assert.match(migration, /warning_row[.]source_comment_id = v_comment[.]id/u);
  assert.match(migration, /v_comment[.]author_deleted_at is null/u);
  assert.match(migration, /is_community_comment_submission_eligible/u);
  assert.doesNotMatch(
    migration,
    /'targetDiscordUserId'|'actorDiscordUserId'|'warningId'|'caseId'|'reportId'/u,
  );
});

test("Warning target cannot create a manual-ID or sanction path", () => {
  assert.doesNotMatch(migration, /insert into public[.]user_warnings/iu);
  assert.doesNotMatch(migration, /insert into public[.]user_flag_cases/iu);
  assert.doesNotMatch(migration, /update public[.]user_logs/iu);
  assert.doesNotMatch(migration, /ban|participation_hold|duration_days/iu);
});

test("Warning target RPC is postgres-owned, fixed-search-path, and service-only", () => {
  assert.match(
    migration,
    /get_user_warning_issue_target\([\s\S]*security definer[\s\S]*set search_path = public, pg_temp/u,
  );
  assert.match(
    migration,
    /alter function public[.]get_user_warning_issue_target\(text,uuid\)[\s\S]*owner to postgres/u,
  );
  assert.match(
    migration,
    /revoke all on function public[.]get_user_warning_issue_target\(text,uuid\)[\s\S]*from public, anon, authenticated, discord_bot, service_role/u,
  );
  assert.match(
    migration,
    /grant execute on function public[.]get_user_warning_issue_target\(text,uuid\)[\s\S]*to service_role/u,
  );
  assert.match(migration, /function_row[.]proname = 'get_user_warning_issue_target'/u);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../supabase/migrations/20260821000100_community_votes_foundation.sql",
  import.meta.url
);
const [sql, devContract, concurrencyContract] = await Promise.all([
  readFile(migrationUrl, "utf8"),
  readFile(new URL("./communityVotesFoundation.dev.sql", import.meta.url), "utf8"),
  readFile(new URL("./communityVotesConcurrency.dev.mjs", import.meta.url), "utf8"),
]);

function tableBlock(name, nextName) {
  const start = sql.indexOf(`create table public.${name}`);
  const end = sql.indexOf(`create table public.${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} table block must exist`);
  return sql.slice(start, end);
}

test("migration is additive, guarded, and registers one zero-grant capability", () => {
  assert.match(sql, /^begin;/u);
  assert.match(sql, /COMMUNITY_POLLS_BASELINE_MISMATCH/u);
  assert.match(sql, /count\(\*\) from public\.capability_catalog\) <> 39/u);
  assert.match(sql, /'community\.polls\.manage'/u);
  assert.match(sql, /count\(\*\) from public\.capability_catalog\) <> 40/u);
  assert.match(sql, /implementation_version = 1/u);
  assert.match(
    sql,
    /042a289cd77aca920ab6d07abec54cec1b380423c90aa3693b7fbb11537a9a7e/u
  );
  assert.match(
    sql,
    /exists \([\s\S]*team_role_capabilities[\s\S]*community\.polls\.manage[\s\S]*\)/u
  );
  assert.doesNotMatch(sql, /insert into public\.team_role_capabilities/iu);
  assert.doesNotMatch(sql, /drop table|drop column|truncate/iu);
  assert.match(sql, /commit;\s*$/u);
});

test("participation and options are persistently separated", () => {
  const participants = tableBlock(
    "community_poll_participants",
    "community_poll_admin_events"
  );
  const options = tableBlock(
    "community_poll_options",
    "community_poll_participation_keys"
  );
  assert.match(participants, /participant_digest text not null/u);
  assert.match(participants, /primary key \(poll_id, participant_digest\)/u);
  assert.doesNotMatch(participants, /option_id|option_public_id|discord_user_id/iu);
  assert.match(options, /vote_count bigint not null default 0/u);
  assert.doesNotMatch(options, /participant|discord_user_id/iu);
  assert.match(sql, /extensions\.hmac\([\s\S]*key\.secret[\s\S]*'sha256'/u);
  assert.match(sql, /extensions\.gen_random_bytes\(32\)/u);
  assert.match(
    sql,
    /Poll-scoped pseudonymous participation facts only[\s\S]*never stores an option identity/u
  );
});

test("one irrevocable vote is atomic and does not use membership or Participation Hold", () => {
  const start = sql.indexOf("create function public.cast_community_poll_vote");
  const end = sql.indexOf("create function public.create_community_poll", start);
  const vote = sql.slice(start, end);
  assert.match(vote, /get_cancerculture_session_access\(p_session_id\)/u);
  assert.match(vote, /transaction_timestamp\(\) >= v_poll\.deadline_at/u);
  assert.match(vote, /insert into public\.community_poll_participants/u);
  assert.match(vote, /update public\.community_poll_options/u);
  assert.ok(
    vote.indexOf("insert into public.community_poll_participants") <
      vote.indexOf("update public.community_poll_options")
  );
  assert.match(vote, /exception when unique_violation/u);
  assert.match(vote, /'already_participated'/u);
  assert.doesNotMatch(vote, /participation_hold|is_in_discord|joined_at|membership/iu);
  assert.doesNotMatch(vote, /insert into public\.[a-z_]*votes\s*\([^)]*discord/iu);
});

test("live visibility is participant-specific and closed history is aggregate-only", () => {
  const start = sql.indexOf("create function public.build_community_poll_json");
  const end = sql.indexOf("create function public.get_community_poll_index", start);
  const projection = sql.slice(start, end);
  assert.match(
    projection,
    /v_results_visible := v_poll\.status not in \('draft', 'active'\) or v_participated/u
  );
  assert.match(
    projection,
    /'voteCount', case when v_results_visible then option\.vote_count else null end/u
  );
  assert.match(projection, /'participated', v_participated/u);
  assert.match(projection, /'totalVotes'/u);
  assert.match(projection, /'lastUpdatedAt'/u);
  const returnedDto = projection.slice(projection.indexOf("return jsonb_strip_nulls"));
  assert.doesNotMatch(returnedDto, /actor_discord_user_id|participant_digest|discordUserId/u);
});

test("database time, immutability, zero votes, ties, and repeated runoffs are enforced", () => {
  assert.match(sql, /duration_hours in \(24, 48, 72, 168\)/u);
  assert.match(
    sql,
    /deadline_at = transaction_timestamp\(\) \+ make_interval\(hours => duration_hours\)/u
  );
  assert.match(sql, /COMMUNITY_POLL_ACTIVATED_CONTENT_IMMUTABLE/u);
  assert.match(sql, /if v_total = 0 then\s+v_outcome := 'no_result'/u);
  assert.match(sql, /if v_leaders = 1 then\s+v_outcome := 'winner'/u);
  assert.match(sql, /v_outcome := 'runoff'/u);
  assert.match(sql, /v_poll\.root_poll_id, v_poll\.id, null/u);
  assert.match(sql, /interval '24 hours'/u);
  assert.doesNotMatch(sql, /admin_tiebreak|transfer_sol|wallet_address|payout_amount/iu);
});

test("management transitions are capability checked, versioned, idempotent, and audited", () => {
  for (const name of [
    "create_community_poll",
    "activate_community_poll",
    "close_community_poll",
    "abort_community_poll",
    "replace_community_poll",
    "get_community_poll_management",
  ]) {
    const start = sql.indexOf(`create function public.${name}`);
    assert.ok(start >= 0, `${name} must exist`);
    const next = sql.indexOf("create function public.", start + 24);
    const block = sql.slice(start, next < 0 ? sql.length : next);
    assert.match(block, /assert_community_poll_capability/u);
    assert.match(block, /security definer/u);
    assert.match(block, /set search_path = public, pg_temp/u);
  }
  assert.match(sql, /community_poll_mutation_requests/u);
  assert.match(sql, /COMMUNITY_POLL_REQUEST_CONFLICT/u);
  assert.match(sql, /community_poll_admin_events_no_update/u);
  for (const event of [
    "created",
    "activated",
    "closed",
    "aborted",
    "replaced",
    "replacement_created",
    "runoff_created",
  ]) {
    assert.match(sql, new RegExp(`'${event}'`, "u"));
  }
  const abortBlock = sql.slice(
    sql.indexOf("create function public.abort_community_poll"),
    sql.indexOf("create function public.replace_community_poll")
  );
  const replaceBlock = sql.slice(
    sql.indexOf("create function public.replace_community_poll"),
    sql.indexOf("create function public.get_community_poll_management")
  );
  assert.match(abortBlock, /values \(v_poll\.id, 'aborted'/u);
  assert.doesNotMatch(abortBlock, /values \(v_poll\.id, 'replaced'/u);
  assert.match(replaceBlock, /values \(v_poll\.id, 'replaced'/u);
});

test("DEV contracts cover transactional outcomes and true parallel double votes", () => {
  for (const boundary of [
    "COMMUNITY_POLLS_DEV_NONMEMBER_VOTE_FAILED",
    "COMMUNITY_POLLS_DEV_HOLD_WRONGLY_BLOCKED_VOTE",
    "COMMUNITY_POLLS_DEV_BANNED_VOTE_ACCEPTED",
    "COMMUNITY_POLLS_DEV_PREVOTE_RESULTS_LEAKED",
    "COMMUNITY_POLLS_DEV_ZERO_RESULT_FAILED",
    "COMMUNITY_POLLS_DEV_RUNOFF_FAILED",
    "COMMUNITY_POLLS_DEV_REPEATED_RUNOFF_FAILED",
    "COMMUNITY_POLLS_DEV_INVALID_REPLACE_DID_NOT_ROLL_BACK",
    "COMMUNITY_POLLS_DEV_OUTER_FUNCTION_ACL_INVALID",
  ]) {
    assert.match(devContract, new RegExp(boundary, "u"));
  }
  assert.match(concurrencyContract, /Promise\.all\(calls\.map/u);
  assert.match(concurrencyContract, /already_participated\|voted/u);
  assert.match(concurrencyContract, /participantFacts: 1/u);
  assert.match(concurrencyContract, /abort_community_poll/u);
});

test("RLS and exact service-only function boundaries are present", () => {
  for (const table of [
    "community_polls",
    "community_poll_options",
    "community_poll_participation_keys",
    "community_poll_participants",
    "community_poll_admin_events",
    "community_poll_mutation_requests",
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "u"));
    assert.match(
      sql,
      new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated, discord_bot, service_role`, "u")
    );
  }
  assert.doesNotMatch(sql, /grant (select|insert|update|delete|all).*community_poll/iu);
  assert.match(sql, /grant execute on function public\.cast_community_poll_vote\([^;]+\) to service_role/u);
  assert.match(sql, /COMMUNITY_POLL_FUNCTION_OVERLOAD_MISMATCH/u);
  assert.match(sql, /alter function public\.cast_community_poll_vote\([^;]+\) owner to postgres/u);
});

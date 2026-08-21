\set ON_ERROR_STOP on

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $contract$
declare
  v_admin text;
  v_role text;
  v_base bigint := 970000000000000000 + floor(random() * 1000000000000000)::bigint;
  v_nonmember text := v_base::text;
  v_held text := (v_base + 1)::text;
  v_banned text := (v_base + 2)::text;
  v_nonmember_session_a uuid := gen_random_uuid();
  v_nonmember_session_b uuid := gen_random_uuid();
  v_held_session uuid := gen_random_uuid();
  v_banned_session uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_poll_public_id uuid;
  v_poll_id uuid;
  v_option_a uuid;
  v_option_b uuid;
  v_result jsonb;
  v_replay jsonb;
  v_case_id uuid;
  v_case_version bigint;
  v_zero_public_id uuid;
  v_tie_public_id uuid;
  v_tie_id uuid;
  v_runoff_public_id uuid;
  v_runoff_id uuid;
  v_repeat_public_id uuid;
  v_repeat_id uuid;
  v_replacement_public_id uuid;
  v_seen boolean;
begin
  select member.discord_user_id, member.role
  into v_admin, v_role
  from public.team_members member
  join public.team_roles role on role.key = member.role and role.is_active
  where member.role = 'admin'
  order by member.discord_user_id
  limit 1;

  if v_admin is null or v_role <> 'admin' then
    raise exception 'COMMUNITY_POLLS_DEV_ADMIN_FIXTURE_UNAVAILABLE';
  end if;

  if (select count(*) from public.capability_catalog) <> 40
    or (select count(*) from public.capability_catalog where is_active) <> 36
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key = 'community.polls.manage'
    )
  then
    raise exception 'COMMUNITY_POLLS_DEV_CAPABILITY_BASELINE_INVALID';
  end if;

  insert into public.user_logs (
    discord_user_id, current_discord_username, is_banned
  ) values
    (v_nonmember, 'community-poll-nonmember', false),
    (v_held, 'community-poll-held', false),
    (v_banned, 'community-poll-banned', false);

  insert into public.sessions (id, discord_user_id) values
    (v_nonmember_session_a, v_nonmember),
    (v_nonmember_session_b, v_nonmember),
    (v_held_session, v_held),
    (v_banned_session, v_banned);

  if exists (
    select 1 from public.discord_member_state
    where discord_user_id in (v_nonmember, v_held)
  ) or (public.get_cancerculture_session_access(v_nonmember_session_a) ->> 'outcome') <> 'allowed'
  then
    raise exception 'COMMUNITY_POLLS_DEV_NONMEMBER_SESSION_INVALID';
  end if;

  v_result := public.create_user_flag_case(
    v_admin,
    v_held,
    'other',
    'Community Votes Participation Hold independence verification',
    null,
    null,
    gen_random_uuid()
  );
  v_case_id := (v_result ->> 'caseId')::uuid;
  v_case_version := (v_result ->> 'rowVersion')::bigint;
  v_result := public.review_user_flag_case(
    v_admin,
    v_case_id,
    v_case_version,
    'escalated',
    'Community Votes must remain available while ordinary participation is held',
    gen_random_uuid()
  );
  if not public.is_user_participation_held(v_held) then
    raise exception 'COMMUNITY_POLLS_DEV_HOLD_FIXTURE_INVALID';
  end if;

  v_result := public.create_community_poll(
    v_admin,
    v_request,
    'Which generic Community decision should be recorded?',
    'Rollback-only DEV verification with no payout or Cycle coupling.',
    24,
    '["Option Alpha", "Option Beta"]'::jsonb
  );
  v_replay := public.create_community_poll(
    v_admin,
    v_request,
    'Which generic Community decision should be recorded?',
    'Rollback-only DEV verification with no payout or Cycle coupling.',
    24,
    '["Option Alpha", "Option Beta"]'::jsonb
  );
  if v_result <> v_replay or v_result ->> 'outcome' <> 'created' then
    raise exception 'COMMUNITY_POLLS_DEV_CREATE_IDEMPOTENCY_FAILED';
  end if;
  v_poll_public_id := (v_result ->> 'pollPublicId')::uuid;
  select id into v_poll_id from public.community_polls where public_id = v_poll_public_id;

  v_result := public.activate_community_poll(
    v_admin, v_poll_public_id, gen_random_uuid(), 1
  );
  if v_result ->> 'outcome' <> 'activated'
    or (v_result ->> 'rowVersion')::bigint <> 2
  then
    raise exception 'COMMUNITY_POLLS_DEV_ACTIVATION_FAILED: %', v_result;
  end if;

  select public_id into v_option_a
  from public.community_poll_options
  where poll_id = v_poll_id and display_order = 1;
  select public_id into v_option_b
  from public.community_poll_options
  where poll_id = v_poll_id and display_order = 2;

  v_result := public.get_community_poll(v_poll_public_id, null);
  if v_result #>> '{poll,resultsVisible}' <> 'false'
    or (v_result #> '{poll,options,0}') ? 'voteCount'
    or (v_result #> '{poll}') ? 'totalVotes'
  then
    raise exception 'COMMUNITY_POLLS_DEV_PREVOTE_RESULTS_LEAKED: %', v_result;
  end if;

  v_result := public.cast_community_poll_vote(
    v_nonmember_session_a, v_poll_public_id, v_option_a, gen_random_uuid(), 1
  );
  if v_result ->> 'outcome' <> 'stale' then
    raise exception 'COMMUNITY_POLLS_DEV_STALE_VERSION_NOT_REJECTED: %', v_result;
  end if;

  v_result := public.cast_community_poll_vote(
    gen_random_uuid(), v_poll_public_id, v_option_a, gen_random_uuid(), 2
  );
  if v_result ->> 'outcome' = 'voted' then
    raise exception 'COMMUNITY_POLLS_DEV_ANONYMOUS_VOTE_ACCEPTED';
  end if;

  v_result := public.cast_community_poll_vote(
    v_nonmember_session_a, v_poll_public_id, v_option_a, gen_random_uuid(), 2
  );
  if v_result ->> 'outcome' <> 'voted'
    or v_result #>> '{poll,resultsVisible}' <> 'true'
    or v_result #>> '{poll,totalVotes}' <> '1'
    or v_result #>> '{selectedOption,publicId}' <> v_option_a::text
  then
    raise exception 'COMMUNITY_POLLS_DEV_NONMEMBER_VOTE_FAILED: %', v_result;
  end if;

  v_result := public.cast_community_poll_vote(
    v_nonmember_session_b, v_poll_public_id, v_option_b, gen_random_uuid(), 2
  );
  if v_result ->> 'outcome' <> 'already_participated'
    or v_result #>> '{poll,totalVotes}' <> '1'
  then
    raise exception 'COMMUNITY_POLLS_DEV_MULTISESSION_REPLAY_FAILED: %', v_result;
  end if;

  v_result := public.get_community_poll(v_poll_public_id, v_nonmember);
  if v_result #>> '{poll,participated}' <> 'true'
    or v_result #>> '{poll,totalVotes}' <> '1'
  then
    raise exception 'COMMUNITY_POLLS_DEV_LATER_SESSION_VISIBILITY_FAILED: %', v_result;
  end if;

  v_result := public.cast_community_poll_vote(
    v_held_session, v_poll_public_id, v_option_b, gen_random_uuid(), 2
  );
  if v_result ->> 'outcome' <> 'voted' then
    raise exception 'COMMUNITY_POLLS_DEV_HOLD_WRONGLY_BLOCKED_VOTE: %', v_result;
  end if;

  update public.user_logs set is_banned = true where discord_user_id = v_banned;
  v_result := public.cast_community_poll_vote(
    v_banned_session, v_poll_public_id, v_option_b, gen_random_uuid(), 2
  );
  if v_result ->> 'outcome' = 'voted' then
    raise exception 'COMMUNITY_POLLS_DEV_BANNED_VOTE_ACCEPTED';
  end if;

  v_result := public.close_community_poll(
    v_admin, v_poll_public_id, gen_random_uuid(), 2
  );
  if v_result ->> 'outcome' <> 'deadline_not_reached' then
    raise exception 'COMMUNITY_POLLS_DEV_EARLY_CLOSE_ACCEPTED: %', v_result;
  end if;

  begin
    update public.community_polls
    set question = 'Illegally changed activated question'
    where id = v_poll_id;
    raise exception 'COMMUNITY_POLLS_DEV_ACTIVATED_CONTENT_CHANGED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'COMMUNITY_POLL_ACTIVATED_CONTENT_IMMUTABLE' then raise; end if;
  end;

  begin
    v_result := public.replace_community_poll(
      v_admin,
      v_poll_public_id,
      gen_random_uuid(),
      2,
      'This replacement input is otherwise valid?',
      '',
      24,
      '["Duplicate", "duplicate"]'::jsonb,
      'Rollback behavior for invalid replacement input'
    );
    raise exception 'COMMUNITY_POLLS_DEV_INVALID_REPLACE_ACCEPTED: %', v_result;
  exception
    when sqlstate '22023' then
      if not exists (
        select 1 from public.community_polls
        where public_id = v_poll_public_id and status = 'active' and row_version = 2
      ) then
        raise exception 'COMMUNITY_POLLS_DEV_INVALID_REPLACE_DID_NOT_ROLL_BACK';
      end if;
  end;
end;
$contract$;

do $outcomes$
declare
  v_admin text;
  v_result jsonb;
  v_poll_id uuid;
  v_poll_public_id uuid;
  v_option_ids uuid[];
  v_runoff_public_id uuid;
  v_runoff_id uuid;
  v_repeat_id uuid;
  v_repeat_public_id uuid;
  v_replacement_public_id uuid;
begin
  select discord_user_id into v_admin
  from public.team_members where role = 'admin'
  order by discord_user_id limit 1;

  v_result := public.create_community_poll(
    v_admin, gen_random_uuid(), 'Should a zero-vote poll close without a result?', '', 24,
    '["Yes", "No"]'::jsonb
  );
  v_poll_public_id := (v_result ->> 'pollPublicId')::uuid;
  update public.community_polls set
    status = 'active', row_version = 2,
    activated_at = transaction_timestamp() - interval '25 hours',
    deadline_at = transaction_timestamp()
  where public_id = v_poll_public_id;
  v_result := public.close_community_poll(
    v_admin, v_poll_public_id, gen_random_uuid(), 2
  );
  if v_result ->> 'result' <> 'no_result' then
    raise exception 'COMMUNITY_POLLS_DEV_ZERO_RESULT_FAILED: %', v_result;
  end if;

  v_result := public.create_community_poll(
    v_admin, gen_random_uuid(), 'Which tied leading options should enter a runoff?', '', 24,
    '["Leader One", "Leader Two", "Trailing Option"]'::jsonb
  );
  v_poll_public_id := (v_result ->> 'pollPublicId')::uuid;
  select id into v_poll_id from public.community_polls where public_id = v_poll_public_id;
  update public.community_polls set
    status = 'active', row_version = 2,
    activated_at = transaction_timestamp() - interval '25 hours',
    deadline_at = transaction_timestamp()
  where id = v_poll_id;
  select array_agg(id order by display_order) into v_option_ids
  from public.community_poll_options where poll_id = v_poll_id;
  update public.community_poll_options set vote_count = vote_count + 1,
    tally_updated_at = transaction_timestamp() where id = v_option_ids[1];
  update public.community_poll_options set vote_count = vote_count + 1,
    tally_updated_at = transaction_timestamp() where id = v_option_ids[2];
  v_result := public.close_community_poll(
    v_admin, v_poll_public_id, gen_random_uuid(), 2
  );
  v_runoff_public_id := (v_result ->> 'runoffPollPublicId')::uuid;
  select id into v_runoff_id from public.community_polls where public_id = v_runoff_public_id;
  if v_result ->> 'result' <> 'runoff'
    or (select count(*) from public.community_poll_options where poll_id = v_runoff_id) <> 2
    or not exists (
      select 1 from public.community_polls
      where id = v_runoff_id and parent_poll_id = v_poll_id and root_poll_id = v_poll_id
        and status = 'active'
        and deadline_at = activated_at + interval '24 hours'
    )
  then
    raise exception 'COMMUNITY_POLLS_DEV_RUNOFF_FAILED: %', v_result;
  end if;

  v_repeat_id := public.insert_community_poll_draft(
    v_admin,
    'Can a tied runoff create another linked runoff?',
    '',
    24,
    '["Leader One", "Leader Two"]'::jsonb,
    v_poll_id,
    v_runoff_id,
    null
  );
  select public_id into v_repeat_public_id from public.community_polls where id = v_repeat_id;
  update public.community_polls set
    status = 'active', row_version = 2,
    activated_at = transaction_timestamp() - interval '25 hours',
    deadline_at = transaction_timestamp()
  where id = v_repeat_id;
  select array_agg(id order by display_order) into v_option_ids
  from public.community_poll_options where poll_id = v_repeat_id;
  update public.community_poll_options set vote_count = vote_count + 1,
    tally_updated_at = transaction_timestamp() where id = v_option_ids[1];
  update public.community_poll_options set vote_count = vote_count + 1,
    tally_updated_at = transaction_timestamp() where id = v_option_ids[2];
  v_result := public.close_community_poll(
    v_admin, v_repeat_public_id, gen_random_uuid(), 2
  );
  if v_result ->> 'result' <> 'runoff'
    or not exists (
      select 1 from public.community_polls
      where public_id = (v_result ->> 'runoffPollPublicId')::uuid
        and root_poll_id = v_poll_id and parent_poll_id = v_repeat_id
    )
  then
    raise exception 'COMMUNITY_POLLS_DEV_REPEATED_RUNOFF_FAILED: %', v_result;
  end if;

  v_result := public.create_community_poll(
    v_admin, gen_random_uuid(), 'Can a draft be replaced without editing history?', '', 48,
    '["Original A", "Original B"]'::jsonb
  );
  v_poll_public_id := (v_result ->> 'pollPublicId')::uuid;
  v_result := public.replace_community_poll(
    v_admin, v_poll_public_id, gen_random_uuid(), 1,
    'Should the corrected replacement remain a draft?', '', 72,
    '["Replacement A", "Replacement B"]'::jsonb,
    'Correcting the draft through an append-only replacement'
  );
  v_replacement_public_id := (v_result ->> 'replacementPollPublicId')::uuid;
  if v_result ->> 'outcome' <> 'replaced'
    or not exists (
      select 1 from public.community_polls old_poll
      join public.community_polls replacement
        on replacement.replacement_for_poll_id = old_poll.id
      where old_poll.public_id = v_poll_public_id and old_poll.status = 'replaced'
        and replacement.public_id = v_replacement_public_id and replacement.status = 'draft'
    )
    or not exists (
      select 1 from public.community_poll_admin_events event
      join public.community_polls poll on poll.id = event.poll_id
      where poll.public_id = v_poll_public_id and event.event_type = 'replaced'
    )
  then
    raise exception 'COMMUNITY_POLLS_DEV_REPLACEMENT_FAILED: %', v_result;
  end if;
end;
$outcomes$;

do $security$
declare
  v_outer text[] := array[
    'get_community_poll_index(text)',
    'get_community_poll(uuid,text)',
    'cast_community_poll_vote(uuid,uuid,uuid,uuid,bigint)',
    'create_community_poll(text,uuid,text,text,integer,jsonb)',
    'activate_community_poll(text,uuid,uuid,bigint)',
    'close_community_poll(text,uuid,uuid,bigint)',
    'abort_community_poll(text,uuid,uuid,bigint,text)',
    'replace_community_poll(text,uuid,uuid,bigint,text,text,integer,jsonb,text)',
    'get_community_poll_management(text)'
  ];
  v_signature text;
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'community_poll_participants'
      and column_name in ('option_id', 'option_public_id', 'discord_user_id')
  ) then
    raise exception 'COMMUNITY_POLLS_DEV_PRIVACY_COLUMNS_FOUND';
  end if;

  if exists (
    select 1 from unnest(array[
      'community_polls', 'community_poll_options', 'community_poll_participation_keys',
      'community_poll_participants', 'community_poll_admin_events',
      'community_poll_mutation_requests'
    ]) table_name
    where has_table_privilege('service_role', 'public.' || table_name, 'SELECT')
      or has_table_privilege('authenticated', 'public.' || table_name, 'SELECT')
      or has_table_privilege('anon', 'public.' || table_name, 'SELECT')
  ) then
    raise exception 'COMMUNITY_POLLS_DEV_DIRECT_TABLE_PRIVILEGE_FOUND';
  end if;

  foreach v_signature in array v_outer loop
    if not has_function_privilege('service_role', 'public.' || v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', 'public.' || v_signature, 'EXECUTE')
      or has_function_privilege('anon', 'public.' || v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', 'public.' || v_signature, 'EXECUTE')
    then
      raise exception 'COMMUNITY_POLLS_DEV_OUTER_FUNCTION_ACL_INVALID: %', v_signature;
    end if;
  end loop;

  if exists (
    select 1 from pg_proc function_row
    join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname like '%community_poll%'
      and function_row.proconfig is distinct from array['search_path=public, pg_temp']::text[]
  ) or exists (
    select function_row.proname
    from pg_proc function_row
    join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname in (
        'get_community_poll_index', 'get_community_poll', 'cast_community_poll_vote',
        'create_community_poll', 'activate_community_poll', 'close_community_poll',
        'abort_community_poll', 'replace_community_poll', 'get_community_poll_management'
      )
    group by function_row.proname
    having count(*) <> 1
  ) then
    raise exception 'COMMUNITY_POLLS_DEV_FUNCTION_METADATA_INVALID';
  end if;
end;
$security$;

select 'community_votes_foundation_dev_contract_ok' as result;

rollback;

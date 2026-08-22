\set ON_ERROR_STOP on
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $test$
declare
  v_actor text;
  v_session uuid;
  v_device_one uuid := gen_random_uuid();
  v_device_two uuid := gen_random_uuid();
  v_device_three uuid := gen_random_uuid();
  v_notification_id uuid;
  v_second_notification_id uuid;
  v_third_notification_id uuid;
  v_event_count integer;
  v_result jsonb;
  v_jobs jsonb;
  v_job jsonb;
  v_case_one uuid;
  v_case_two uuid;
  v_idempotency uuid := gen_random_uuid();
  v_return_key uuid := gen_random_uuid();
  v_retry_index integer;
begin
  select member.discord_user_id, session_row.id
  into strict v_actor, v_session
  from public.team_members member
  join public.sessions session_row
    on session_row.discord_user_id = member.discord_user_id
   and session_row.revoked_at is null
  where member.role = 'admin'
  order by session_row.created_at desc
  limit 1;

  v_notification_id := public.enqueue_account_notification_event(
    'dev-contract-notification-1', 'winner_claim_required', 'winners_claims',
    v_actor, '/my-profile', true
  );
  perform public.enqueue_account_notification_event(
    'dev-contract-notification-1', 'winner_claim_required', 'winners_claims',
    v_actor, '/my-profile', true
  );
  select count(*) into v_event_count from public.notification_events
  where producer_key = 'dev-contract-notification-1';
  if v_event_count <> 1 or (
    select count(*) from public.account_notifications
    where id = v_notification_id and owner_discord_user_id = v_actor
  ) <> 1 then
    raise exception 'notification replay contract failed';
  end if;

  v_result := public.get_own_notifications(v_session, null, null, 20);
  if not exists (
      select 1
      from jsonb_array_elements(v_result -> 'items') item
      where item ->> 'id' = v_notification_id::text
        and item ->> 'title' = 'Winner claim required'
        and item ->> 'actionLabel' = 'Review claim'
    )
    or v_result::text like '%' || v_actor || '%'
    or v_result::text ~* '(wallet|discord id|dq reason|report text|comment text|secret|team identity)'
  then
    raise exception 'notification owner/privacy projection failed';
  end if;
  if public.get_own_notification_unread_count(v_session) < 1 then
    raise exception 'notification unread count failed';
  end if;
  v_result := public.mark_all_own_notifications_read(v_session);
  if (v_result ->> 'updatedCount')::integer < 1 then
    raise exception 'notification mark-all-read failed';
  end if;
  if public.get_own_notification_unread_count(v_session) <> 0 then
    raise exception 'notification read state failed';
  end if;
  if public.get_own_notification_destination(v_session, v_notification_id) ->> 'destination'
      <> '/my-profile' then
    raise exception 'notification destination failed';
  end if;
  update public.account_notifications
  set read_at = transaction_timestamp() - interval '4 days'
  where id = v_notification_id;
  v_result := public.get_own_notifications(v_session, null, null, 20);
  if exists (
    select 1 from jsonb_array_elements(v_result -> 'items') item
    where item ->> 'id' = v_notification_id::text
  ) then
    raise exception 'notification three-day visibility failed';
  end if;
  delete from public.account_notification_preferences
  where owner_discord_user_id = v_actor;
  v_result := public.get_own_notification_settings(v_session);
  if jsonb_array_length(v_result -> 'categories') <> (
      select count(*)
      from public.notification_category_catalog
      where is_active and in_product_available
    )
    or exists (
      select 1 from jsonb_array_elements(v_result -> 'categories') category
      where category ->> 'inProductEnabled' <> 'true'
        or category ->> 'requiredInProduct' <> 'false'
        or coalesce(category ->> 'description', '') = ''
    )
  then
    raise exception 'notification voluntary default-on settings failed';
  end if;
  if public.resolve_account_notification_visibility(
      v_actor, 'cycles_voting'
    ) is distinct from false
  then
    raise exception 'Cycle in-product channel must remain unavailable';
  end if;
  perform public.set_own_notification_preference(
    v_session, 'submission_moderation', false
  );
  if public.resolve_account_notification_visibility(
      v_actor, 'submission_moderation'
    ) is distinct from false
  then
    raise exception 'notification preference visibility failed';
  end if;

  perform public.upsert_own_push_subscription(
    v_session, v_device_one, repeat('a', 64), repeat('A', 24),
    repeat('B', 12), repeat('C', 12), 1
  );
  perform public.set_own_push_subscription_preference(
    v_session, v_device_one, 'winners_claims', true
  );
  perform public.upsert_own_push_subscription(
    v_session, v_device_two, repeat('a', 64), repeat('D', 24),
    repeat('E', 12), repeat('F', 12), 1
  );
  if (select count(*) from public.push_subscriptions
      where owner_discord_user_id = v_actor and is_active) <> 1
    or (select count(*) from public.push_subscription_preferences preference
        join public.push_subscriptions subscription on subscription.id = preference.subscription_id
        where subscription.device_id = v_device_two and preference.enabled) <> 0
  then
    raise exception 'push replacement/default-off contract failed';
  end if;
  perform public.upsert_own_push_subscription(
    v_session, v_device_three, repeat('b', 64), repeat('G', 24),
    repeat('H', 12), repeat('I', 12), 1
  );
  if (select count(*) from public.push_subscriptions
      where owner_discord_user_id = v_actor and is_active) <> 2 then
    raise exception 'push multi-device contract failed';
  end if;
  perform public.set_own_push_subscription_preference(
    v_session, v_device_two, 'winners_claims', true
  );
  perform public.set_own_push_subscription_preference(
    v_session, v_device_three, 'winners_claims', true
  );
  v_second_notification_id := public.enqueue_account_notification_event(
    'dev-contract-notification-2', 'winner_claim_required', 'winners_claims',
    v_actor, '/my-profile', true
  );
  v_third_notification_id := public.enqueue_account_notification_event(
    'dev-contract-notification-3', 'winner_claim_required', 'winners_claims',
    v_actor, '/my-profile', true
  );
  v_jobs := public.claim_due_push_deliveries(gen_random_uuid(), 20);
  if jsonb_array_length(v_jobs -> 'items') <> 2 then
    raise exception 'one in-flight job per subscription contract failed: %', v_jobs;
  end if;
  v_job := v_jobs -> 'items' -> 0;
  perform public.fail_push_delivery(
    (v_job ->> 'jobId')::bigint,
    (v_job ->> 'leaseToken')::uuid,
    'provider_410', false, true
  );
  if (select count(*) from public.push_subscriptions
      where owner_discord_user_id = v_actor and is_active) <> 1
    or (select count(*) from public.push_delivery_jobs
        where notification_id = v_second_notification_id
          and status = 'failed_permanent') <> 1
  then
    raise exception 'invalid subscription terminal contract failed';
  end if;
  v_job := v_jobs -> 'items' -> 1;
  perform public.complete_push_delivery(
    (v_job ->> 'jobId')::bigint,
    (v_job ->> 'leaseToken')::uuid
  );
  if (select count(*) from public.push_delivery_jobs
      where notification_id = v_second_notification_id and status = 'delivered') <> 1 then
    raise exception 'push delivery completion failed';
  end if;
  v_jobs := public.claim_due_push_deliveries(gen_random_uuid(), 20);
  if jsonb_array_length(v_jobs -> 'items') <> 1 then
    raise exception 'remaining subscription queue claim failed';
  end if;
  v_job := v_jobs -> 'items' -> 0;
  perform public.fail_push_delivery(
    (v_job ->> 'jobId')::bigint,
    (v_job ->> 'leaseToken')::uuid,
    'provider_503', true, false
  );
  for v_retry_index in 2..5 loop
    update public.push_delivery_jobs
    set available_at = transaction_timestamp()
    where id = (v_job ->> 'jobId')::bigint and status = 'pending';
    v_jobs := public.claim_due_push_deliveries(gen_random_uuid(), 20);
    if jsonb_array_length(v_jobs -> 'items') <> 1 then
      raise exception 'bounded retry claim % failed', v_retry_index;
    end if;
    v_job := v_jobs -> 'items' -> 0;
    perform public.fail_push_delivery(
      (v_job ->> 'jobId')::bigint,
      (v_job ->> 'leaseToken')::uuid,
      'provider_503', true, false
    );
  end loop;
  if not exists (
    select 1 from public.push_delivery_jobs
    where id = (v_job ->> 'jobId')::bigint
      and notification_id = v_third_notification_id
      and status = 'failed_permanent'
      and attempt_count = max_attempts
      and last_error_code = 'provider_503'
  ) then
    raise exception 'bounded terminal retry contract failed';
  end if;
  perform public.deactivate_own_push_subscription(v_session, v_device_two);
  perform public.deactivate_own_push_subscription(v_session, v_device_three);
  if exists (
    select 1 from public.push_subscriptions
    where owner_discord_user_id = v_actor and is_active
  ) then
    raise exception 'current-device deactivation failed';
  end if;

  declare
    v_claim_id uuid;
    v_dq_id uuid;
    v_restore_id uuid;
    v_cycle_event_id uuid;
  begin
    insert into public.winner_claims (
      cycle_id, submission_id, winner_discord_user_id,
      payout_choice, charity, status, version, finalized_at
    )
    select submission.cycle_id, submission.id, submission.discord_user_id,
      'donate', 'DEV Contract Charity', 'not_required', 1, transaction_timestamp()
    from public.submissions submission
    left join public.winner_claims claim on claim.submission_id = submission.id
    where claim.id is null
    order by submission.id
    limit 1
    returning id into v_claim_id;
    if v_claim_id is null or not exists (
      select 1 from public.notification_events
      where producer_key = 'winner_claim:' || v_claim_id::text
        and event_type = 'winner_donation_finalized'
    ) then raise exception 'Winner trigger/atomic event contract failed'; end if;

    insert into public.submission_disqualification_events (
      submission_id, cycle_id, subject_discord_user_id, transition,
      occurred_at, source, provenance, reason_code
    )
    select submission.id, submission.cycle_id, submission.discord_user_id,
      'disqualified', transaction_timestamp(), 'submission_open', 'complete',
      'dev_contract_reason'
    from public.submissions submission order by submission.id limit 1
    returning id into v_dq_id;
    insert into public.submission_disqualification_events (
      submission_id, cycle_id, subject_discord_user_id, transition,
      occurred_at, source, provenance, reason_code
    )
    select submission.id, submission.cycle_id, submission.discord_user_id,
      'reinstated', transaction_timestamp(), 'submission_open', 'complete',
      'dev_contract_reason'
    from public.submissions submission order by submission.id limit 1
    returning id into v_restore_id;
    if not exists (
      select 1 from public.notification_events
      where producer_key = 'submission_disqualification_event:' || v_dq_id::text
        and event_type = 'submission_disqualified'
    ) or not exists (
      select 1 from public.notification_events
      where producer_key = 'submission_disqualification_event:' || v_restore_id::text
        and event_type = 'submission_reinstated'
    ) then raise exception 'DQ/restore trigger atomic events failed'; end if;

    insert into public.cycle_events (cycle_id, event_type, actor_type)
    select id, 'cycle_completed', 'system'
    from public.voting_cycles order by id limit 1
    returning id into v_cycle_event_id;
    if not exists (
      select 1 from public.notification_events event
      join public.notification_broadcast_jobs job on job.event_id = event.id
      where event.producer_key = 'cycle_event:' || v_cycle_event_id::text
        and event.event_type = 'cycle_results_ready'
    ) then raise exception 'Cycle result broadcast event failed'; end if;
  end;

  update public.team_inbox_topic_catalog
  set is_active = true,
      accepts_new_cases = true,
      activated_at = transaction_timestamp()
  where topic_key = 'wallet_issues';
  v_result := public.upsert_team_inbox_case(
    'wallet_issues', 'dev-contract-case-1', 1, v_actor, 'DEV Contract One'
  );
  v_case_one := (v_result ->> 'caseId')::uuid;
  if public.get_team_inbox_overview(v_actor) #>> '{topics,0,newCount}' <> '1'
    or exists (select 1 from public.team_inbox_attention_receipts where case_id = v_case_one)
  then
    raise exception 'initial New contract failed';
  end if;
  perform public.get_team_inbox_cases(
    v_actor, 'wallet_issues', 'new', null, null, null, 25
  );
  if exists (select 1 from public.team_inbox_attention_receipts where case_id = v_case_one) then
    raise exception 'list must not acknowledge New';
  end if;
  perform public.get_team_inbox_case_detail(v_actor, v_case_one);
  if public.get_team_inbox_overview(v_actor) #>> '{topics,0,newCount}' <> '0' then
    raise exception 'detail acknowledgement failed';
  end if;

  v_result := public.upsert_team_inbox_case(
    'wallet_issues', 'dev-contract-case-2', 1, v_actor, 'DEV Contract Two'
  );
  v_case_two := (v_result ->> 'caseId')::uuid;
  v_result := public.mutate_team_inbox_case(
    v_actor, v_case_two, v_idempotency, 'claim', 'open', 1, 1, null
  );
  if v_result ->> 'outcome' <> 'claimed'
    or public.get_team_inbox_overview(v_actor) #>> '{topics,0,newCount}' <> '0'
  then
    raise exception 'claim/global New contract failed';
  end if;
  if public.mutate_team_inbox_case(
      v_actor, v_case_two, v_idempotency, 'claim', 'open', 1, 1, null
    ) <> v_result
    or (select count(*) from public.team_inbox_timeline_events
        where case_id = v_case_two and event_type = 'claimed') <> 1
  then
    raise exception 'claim replay contract failed';
  end if;
  v_result := public.mutate_team_inbox_case(
    v_actor, v_case_two, v_return_key, 'return', 'in_progress', 2, 1, null
  );
  if v_result ->> 'outcome' <> 'returned'
    or v_result ->> 'workVersion' <> '2'
    or public.get_team_inbox_overview(v_actor) #>> '{topics,0,newCount}' <> '1'
  then
    raise exception 'return/New generation contract failed';
  end if;
  perform public.mutate_team_inbox_case(
    v_actor, v_case_two, gen_random_uuid(), 'claim', 'open', 3, 2, null
  );
  v_result := public.solve_team_inbox_case(
    v_actor, v_case_two, 4, 1, 'contract_solved', null
  );
  if v_result ->> 'outcome' <> 'solved'
    or public.get_team_inbox_overview(v_actor) #>> '{topics,0,newCount}' <> '0'
  then
    raise exception 'solved/New contract failed';
  end if;
  v_result := public.upsert_team_inbox_case(
    'wallet_issues', 'dev-contract-case-2', 2, v_actor, 'DEV Contract Two'
  );
  if v_result ->> 'outcome' <> 'reopened'
    or public.get_team_inbox_overview(v_actor) #>> '{topics,0,newCount}' <> '1'
  then
    raise exception 'reopen/New generation contract failed';
  end if;
  perform public.mutate_team_inbox_case(
    v_actor, v_case_two, gen_random_uuid(), 'claim', 'open', 6, 3, null
  );
  v_result := public.mutate_team_inbox_case(
    v_actor, v_case_two, gen_random_uuid(), 'force_release', 'in_progress',
    7, 3, 'Required DEV contract reason'
  );
  if v_result ->> 'outcome' <> 'force_released'
    or v_result ->> 'workVersion' <> '4'
  then
    raise exception 'Admin force release contract failed';
  end if;
  v_result := public.search_team_inbox_by_exact_discord_id(
    v_actor, 'wallet_issues', v_actor, null, null, 25
  );
  if jsonb_array_length(v_result -> 'items') <> 2
    or v_result::text like '%' || v_actor || '%'
  then
    raise exception 'exact Discord ID privacy contract failed';
  end if;
  if (select count(*) from public.team_inbox_timeline_events
      where case_id = v_case_two) <> 8 then
    raise exception 'append-only timeline contract failed';
  end if;
end;
$test$;

do $acl$
declare
  v_name text;
begin
  if exists (
    select 1 from pg_class relation
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'public'
      and relation.relname like any(array['notification_%', 'account_notification%', 'push_%', 'team_inbox_%'])
      and relation.relkind in ('r', 'p')
      and (not relation.relrowsecurity or pg_get_userbyid(relation.relowner) <> 'postgres')
  ) then raise exception 'RLS/owner contract failed'; end if;
  if exists (
    select 1 from pg_class relation
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    cross join lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
    left join pg_roles role on role.oid = acl.grantee
    where namespace_row.nspname = 'public'
      and relation.relname in (
        'notification_events', 'account_notifications', 'push_subscriptions',
        'push_delivery_jobs', 'team_inbox_cases', 'team_inbox_attention_receipts',
        'team_inbox_timeline_events', 'team_inbox_mutation_requests'
      )
      and coalesce(role.rolname, 'PUBLIC') in ('PUBLIC','anon','authenticated','discord_bot','service_role')
  ) then raise exception 'direct table ACL contract failed'; end if;
  foreach v_name in array array[
    'get_own_notifications', 'mark_all_own_notifications_read',
    'upsert_own_push_subscription',
    'claim_due_push_deliveries', 'get_team_inbox_cases',
    'get_team_inbox_case_detail', 'search_team_inbox_by_exact_discord_id',
    'mutate_team_inbox_case', 'solve_team_inbox_case'
  ] loop
    if (select count(*) from pg_proc function_row
        join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
        where namespace_row.nspname = 'public' and function_row.proname = v_name) <> 1
      or exists (
        select 1 from pg_proc function_row
        join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
        where namespace_row.nspname = 'public' and function_row.proname = v_name
          and (not function_row.prosecdef
            or pg_get_userbyid(function_row.proowner) <> 'postgres'
            or function_row.proconfig is distinct from array['search_path=public, pg_temp']::text[])
      )
    then raise exception 'function hardening/overload contract failed: %', v_name; end if;
  end loop;
  if not has_function_privilege(
      'service_role', 'public.mutate_team_inbox_case(text,uuid,uuid,text,text,bigint,bigint,text)', 'EXECUTE'
    )
    or has_function_privilege(
      'authenticated', 'public.mutate_team_inbox_case(text,uuid,uuid,text,text,bigint,bigint,text)', 'EXECUTE'
    )
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key in ('winners.payouts.view','winners.recipient_corrections.manage')
    )
  then raise exception 'function ACL/zero-grant contract failed'; end if;
end;
$acl$;

select 'notification_foundation_contract' as test_name, 'passed' as result;
rollback;

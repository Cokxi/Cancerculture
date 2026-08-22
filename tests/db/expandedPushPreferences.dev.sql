\set ON_ERROR_STOP on
begin;
set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $contract$
declare
  v_admin text;
  v_session uuid;
  v_device uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_poll_public_id uuid;
  v_poll_id uuid;
  v_option_public_id uuid;
  v_result jsonb;
  v_replay jsonb;
begin
  select member.discord_user_id, session_row.id
  into strict v_admin, v_session
  from public.team_members member
  join public.sessions session_row
    on session_row.discord_user_id = member.discord_user_id
   and session_row.revoked_at is null
  where member.role = 'admin'
  order by session_row.created_at desc limit 1;

  perform public.upsert_own_push_subscription(
    v_session, v_device,
    encode(extensions.digest(convert_to(v_device::text, 'UTF8'), 'sha256'), 'hex'),
    repeat('A', 24), repeat('B', 12), repeat('C', 12), 1
  );
  v_result := public.get_own_push_subscription_settings(v_session, v_device);
  if v_result ->> 'active' <> 'true'
    or jsonb_array_length(v_result -> 'categories') <> (
      select count(*) from public.notification_category_catalog
      where is_active and push_available
    )
    or v_result #>> '{cyclePreferences,newCycleStarted}' <> 'false'
  then raise exception 'expanded Push settings projection failed: %', v_result; end if;

  perform public.set_own_push_cycle_preference(
    v_session, v_device, 'submission_phase_ends', true
  );
  perform public.set_own_push_cycle_preference(
    v_session, v_device, 'remind_15_minutes', true
  );
  perform public.set_own_push_cycle_preference(
    v_session, v_device, 'remind_5_minutes', true
  );
  if not public.push_subscription_allows_event(
      (select id from public.push_subscriptions where device_id = v_device),
      'cycle_submission_ending_15m', 'cycles_voting'
    )
    or not public.push_subscription_allows_event(
      (select id from public.push_subscriptions where device_id = v_device),
      'cycle_submission_ending_5m', 'cycles_voting'
    )
    or public.push_subscription_allows_event(
      (select id from public.push_subscriptions where device_id = v_device),
      'cycle_submission_ending_10m', 'cycles_voting'
    )
    or public.push_subscription_allows_event(
      (select id from public.push_subscriptions where device_id = v_device),
      'cycle_submission_ended', 'cycles_voting'
    )
  then raise exception 'combined Cycle lead-time contract failed'; end if;

  perform public.set_own_push_cycle_preference(
    v_session, v_device, 'remind_15_minutes', false
  );
  perform public.set_own_push_cycle_preference(
    v_session, v_device, 'remind_5_minutes', false
  );
  if not public.push_subscription_allows_event(
      (select id from public.push_subscriptions where device_id = v_device),
      'cycle_submission_ended', 'cycles_voting'
    )
  then raise exception 'phase-end fallback Push contract failed'; end if;

  v_result := public.create_community_poll(
    v_admin, gen_random_uuid(),
    'Should this rollback-only Community Vote be announced?',
    'DEV contract fixture.', 24, '["Yes", "No"]'::jsonb
  );
  v_poll_public_id := (v_result ->> 'pollPublicId')::uuid;
  select id into strict v_poll_id from public.community_polls
  where public_id = v_poll_public_id;
  v_result := public.activate_community_poll(
    v_admin, v_poll_public_id, gen_random_uuid(), 1
  );
  if exists (
    select 1 from public.notification_events
    where producer_key = 'community-poll-announcement:' || v_poll_public_id::text
  ) then raise exception 'activation unexpectedly announced the poll'; end if;

  v_result := public.announce_community_poll(
    v_admin, v_poll_public_id, v_request, (v_result ->> 'rowVersion')::bigint
  );
  v_replay := public.announce_community_poll(
    v_admin, v_poll_public_id, v_request, (v_result ->> 'rowVersion')::bigint
  );
  if v_result <> v_replay or v_result ->> 'outcome' <> 'announced'
    or (select count(*) from public.community_poll_announcements where poll_id = v_poll_id) <> 1
    or (select count(*) from public.notification_events
        where producer_key = 'community-poll-announcement:' || v_poll_public_id::text) <> 1
    or (select count(*) from public.notification_broadcast_jobs job
        join public.notification_events event on event.id = job.event_id
        where event.producer_key = 'community-poll-announcement:' || v_poll_public_id::text) <> 1
  then raise exception 'Community announcement idempotency failed'; end if;
  if public.get_current_community_poll_announcement(null) ->> 'outcome' <> 'available'
  then raise exception 'public Community announcement projection failed'; end if;

  select public_id into strict v_option_public_id
  from public.community_poll_options
  where poll_id = v_poll_id order by display_order limit 1;
  v_result := public.cast_community_poll_vote(
    v_session, v_poll_public_id, v_option_public_id, gen_random_uuid(),
    (select row_version from public.community_polls where id = v_poll_id)
  );
  if v_result ->> 'outcome' <> 'voted'
    or public.get_current_community_poll_announcement(v_admin) ->> 'outcome' <> 'none'
  then raise exception 'viewer-voted announcement suppression failed'; end if;

  if has_function_privilege('authenticated',
      'public.set_own_push_cycle_preference(uuid,uuid,text,boolean)', 'EXECUTE')
    or has_function_privilege('authenticated',
      'public.announce_community_poll(text,uuid,uuid,bigint)', 'EXECUTE')
    or not has_function_privilege('service_role',
      'public.produce_due_cycle_push_notifications()', 'EXECUTE')
  then raise exception 'expanded Push ACL contract failed'; end if;
end;
$contract$;

rollback;

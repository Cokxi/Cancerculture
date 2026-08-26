begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

do $preflight$
declare
  v_flag_authorizer text;
  v_notification_projection text;
begin
  if (select count(*) from public.capability_catalog) <> 52
    or (select count(*) from public.capability_catalog where is_active) <> 48
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 48
    or not exists (
      select 1 from public.capability_catalog
      where key = 'users.flag.view'
        and is_active
        and assignable_to_non_admin
        and implementation_version = 2
        and definition_hash = '20f04bf3dc07ce7b0f77a31633f6a90b4ce003ad8e03618d078228236dd4699e'
    )
    or not exists (
      select 1 from public.capability_catalog
      where key = 'users.warnings.overrule'
        and is_active
        and assignable_to_non_admin
        and implementation_version = 1
        and definition_hash = 'ce5849bc151746eddf520ed960002a6f0c7e4a9c7b0c9eac58721d4c40603ece'
    )
    or not exists (
      select 1 from public.notification_category_catalog
      where category_key = 'account_warnings'
        and required_in_product
        and is_active
        and default_in_product_enabled
        and not in_product_available
        and not push_available
    )
    or to_regclass('public.user_warning_auto_flag_cases') is null
    or to_regclass('public.user_warning_auto_flag_events') is null
    or to_regprocedure('public.overrule_user_warning(text,uuid,bigint,text,uuid)') is null
    or to_regprocedure('public.authorize_user_flag_capability(text,text)') is null
    or to_regprocedure('public.enqueue_account_notification_event(text,text,text,text,text,boolean)') is null
    or to_regprocedure(
      'public.get_own_notifications(uuid,timestamp with time zone,uuid,integer)'
    ) is null
    or to_regprocedure('public.get_user_warning_overrule_target(text,text,uuid)') is not null
    or to_regprocedure('public.build_user_warning_auto_flag_case_payload(uuid)') is not null
    or to_regprocedure(
      'public.list_user_warning_auto_flag_cases(text,text,text,integer,integer)'
    ) is not null
    or exists (
      select 1 from pg_trigger
      where tgrelid = 'public.user_warning_events'::regclass
        and tgname = 'user_warning_overrule_notification_after_insert'
        and not tgisinternal
    )
  then
    raise exception using
      errcode = '55000',
      message = 'WARNING_CORRECTION_AUTO_FLAG_BASELINE_MISMATCH';
  end if;

  if not (
    select relrowsecurity
    from pg_class
    where oid = 'public.user_warning_auto_flag_cases'::regclass
  )
    or not (
      select relrowsecurity
      from pg_class
      where oid = 'public.user_warning_auto_flag_events'::regclass
    )
    or exists (
      select 1 from pg_policy
      where polrelid in (
        'public.user_warning_auto_flag_cases'::regclass,
        'public.user_warning_auto_flag_events'::regclass
      )
    )
  then
    raise exception using
      errcode = '55000',
      message = 'WARNING_CORRECTION_AUTO_FLAG_RLS_BASELINE_MISMATCH';
  end if;

  select pg_get_functiondef(
    'public.authorize_user_flag_capability(text,text)'::regprocedure
  ) into v_flag_authorizer;
  select pg_get_functiondef(
    'public.get_own_notifications(uuid,timestamp with time zone,uuid,integer)'::regprocedure
  ) into v_notification_projection;

  if position('20f04bf3dc07ce7b0f77a31633f6a90b4ce003ad8e03618d078228236dd4699e' in v_flag_authorizer) = 0
    or position('implementation_version = 2' in v_flag_authorizer) = 0
    or position('Account Warning' in v_notification_projection) = 0
    or position('user_warning_overruled' in v_notification_projection) > 0
  then
    raise exception using
      errcode = '55000',
      message = 'WARNING_CORRECTION_AUTO_FLAG_DEFINITION_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

update public.capability_catalog
set description =
      'View active manual and automatic Warning-threshold user flag cases plus bounded searchable history without changing case state.',
    included_actions = array[
      'View open and escalated manual user flag cases and their details.',
      'Search bounded manual and automatic closed-case history by Discord ID or username.',
      'View immutable manual actor snapshots and complete manual case event history.',
      'View automatic Warning-threshold trigger combinations, active Warning count, timestamps, and immutable lifecycle history.'
    ]::text[],
    excluded_actions = array[
      'Creating manual user flag cases.',
      'Reviewing or closing manual or automatic flag cases.',
      'Website bans, Participation Holds, or other sanctions.'
    ]::text[],
    implementation_version = 3,
    definition_hash =
      '54e6644753e36c355d69b4ca9aa80ef93d9b4b3040d4103a58e56b2a10f55add'
where key = 'users.flag.view';

create or replace function public.authorize_user_flag_capability(
  p_actor_discord_user_id text,
  p_capability_key text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_actor_role text;
  v_expected_hash text;
  v_expected_version integer;
begin
  select expected.hash, expected.version
  into v_expected_hash, v_expected_version
  from (values
    ('users.flag.create', '284ad15bb26a61110b34d96f51b199ed0223d66bbe81462e7e89fd534972231b', 2),
    ('users.flag.view', '54e6644753e36c355d69b4ca9aa80ef93d9b4b3040d4103a58e56b2a10f55add', 3),
    ('users.flag.review', '8ec44455bd08212cab4cacc64dfcd96b139edd9753862255d68150e702b26869', 2)
  ) as expected(key, hash, version)
  where expected.key = p_capability_key;

  if nullif(v_actor_id, '') is null or v_expected_hash is null then
    raise exception using errcode = '42501', message = 'USER_FLAG_FORBIDDEN';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = p_capability_key
      and is_active
      and assignable_to_non_admin
      and implementation_version = v_expected_version
      and definition_hash = v_expected_hash
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_FLAG_AUTHORIZATION_DEPENDENCY_UNAVAILABLE';
  end if;

  select member_row.role
  into v_actor_role
  from public.team_members as member_row
  join public.team_roles as role_row
    on role_row.key = member_row.role and role_row.is_active
  where member_row.discord_user_id = v_actor_id;

  if not found
    or (
      v_actor_role <> 'admin'
      and not exists (
        select 1
        from public.team_role_capabilities
        where role_key = v_actor_role
          and capability_key = p_capability_key
      )
    )
  then
    raise exception using errcode = '42501', message = 'USER_FLAG_FORBIDDEN';
  end if;

  return v_actor_role;
end;
$function$;

alter table public.notification_events
  drop constraint notification_event_type_check,
  drop constraint notification_event_category_check;

alter table public.notification_events
  add constraint notification_event_type_check check (event_type in (
    'winner_claim_required', 'winner_correction_ready', 'winner_donation_finalized',
    'winner_payout_sent', 'donation_recipient_change_required',
    'submission_disqualified', 'submission_reinstated',
    'cycle_started', 'cycle_submission_ending_15m', 'cycle_submission_ending_10m',
    'cycle_submission_ending_5m', 'cycle_submission_ended',
    'cycle_voting_ending_15m', 'cycle_voting_ending_10m',
    'cycle_voting_ending_5m', 'cycle_voting_ended', 'cycle_results_ready',
    'community_vote_announced',
    'wallet_issue_received', 'wallet_issue_correction_ready', 'wallet_issue_resolved',
    'comment_reply', 'comment_mention',
    'user_warning_issued', 'user_warning_overruled'
  )),
  add constraint notification_event_category_check check (
    (event_type in (
      'winner_claim_required', 'winner_correction_ready', 'winner_donation_finalized',
      'winner_payout_sent', 'donation_recipient_change_required'
    ) and category_key = 'winners_claims')
    or (event_type in ('submission_disqualified', 'submission_reinstated')
      and category_key = 'submission_moderation')
    or (event_type in (
      'cycle_started', 'cycle_submission_ending_15m', 'cycle_submission_ending_10m',
      'cycle_submission_ending_5m', 'cycle_submission_ended',
      'cycle_voting_ending_15m', 'cycle_voting_ending_10m',
      'cycle_voting_ending_5m', 'cycle_voting_ended', 'cycle_results_ready'
    ) and category_key = 'cycles_voting')
    or (event_type = 'community_vote_announced' and category_key = 'community_votes')
    or (event_type in (
      'wallet_issue_received', 'wallet_issue_correction_ready', 'wallet_issue_resolved'
    ) and category_key = 'wallet_issues')
    or (event_type = 'comment_reply' and category_key = 'comment_replies')
    or (event_type = 'comment_mention' and category_key = 'comment_mentions')
    or (event_type in ('user_warning_issued', 'user_warning_overruled')
      and category_key = 'account_warnings')
  );

create function public.produce_user_warning_overrule_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_public_warning_id uuid;
begin
  select warning_row.public_warning_id
  into v_public_warning_id
  from public.user_warnings warning_row
  where warning_row.warning_id = new.warning_id
    and warning_row.target_discord_user_id = new.target_discord_user_id;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_NOTIFICATION_TARGET_UNAVAILABLE';
  end if;

  perform public.enqueue_account_notification_event(
    'user_warning_overruled:' || new.warning_id::text,
    'user_warning_overruled',
    'account_warnings',
    new.target_discord_user_id,
    '/warnings/' || v_public_warning_id::text,
    true
  );
  return new;
end;
$function$;

create trigger user_warning_overrule_notification_after_insert
after insert on public.user_warning_events
for each row
when (new.event_type = 'overruled')
execute function public.produce_user_warning_overrule_notification();

create function public.get_user_warning_overrule_target(
  p_actor_discord_user_id text,
  p_target_discord_user_id text,
  p_public_warning_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_target_id text := btrim(p_target_discord_user_id);
  v_result jsonb;
begin
  if nullif(v_target_id, '') is null
    or char_length(v_target_id) > 100
    or p_public_warning_id is null
  then
    raise exception using
      errcode = '22023',
      message = 'USER_WARNING_OVERRULE_TARGET_INPUT_INVALID';
  end if;

  perform public.authorize_user_warning_capability(
    p_actor_discord_user_id,
    'users.warnings.overrule'
  );

  select jsonb_build_object(
    'outcome', 'found',
    'warningId', warning_row.public_warning_id,
    'targetDiscordUserId', warning_row.target_discord_user_id,
    'rowVersion', current_row.row_version,
    'state', current_row.state
  )
  into v_result
  from public.user_warnings warning_row
  join public.user_warning_current current_row
    on current_row.warning_id = warning_row.warning_id
   and current_row.target_discord_user_id = warning_row.target_discord_user_id
  where warning_row.public_warning_id = p_public_warning_id
    and warning_row.target_discord_user_id = v_target_id;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  return v_result;
end;
$function$;

create function public.build_user_warning_auto_flag_case_payload(
  p_case_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select jsonb_build_object(
    'caseId', flag_case.case_id,
    'discordUserId', flag_case.target_discord_user_id,
    'userDisplayName', coalesce(
      nullif(btrim(target.current_display_name), ''),
      nullif(btrim(target.current_guild_nickname), ''),
      nullif(btrim(target.current_discord_username), ''),
      flag_case.target_discord_user_id
    ),
    'generation', flag_case.generation,
    'status', flag_case.status,
    'activeWarningCount', flag_case.active_warning_count,
    'triggeredByActiveCount', flag_case.triggered_by_active_count,
    'triggeredByFourteenDay', flag_case.triggered_by_fourteen_day,
    'openedAt', flag_case.opened_at,
    'closedAt', flag_case.closed_at,
    'rowVersion', flag_case.row_version,
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'eventId', event_row.event_id::text,
        'eventType', event_row.event_type,
        'activeWarningCount', event_row.active_warning_count,
        'triggeredByActiveCount', event_row.triggered_by_active_count,
        'triggeredByFourteenDay', event_row.triggered_by_fourteen_day,
        'caseVersion', event_row.case_version,
        'occurredAt', event_row.occurred_at,
        'recordedAt', event_row.recorded_at
      ) order by event_row.event_id)
      from public.user_warning_auto_flag_events event_row
      where event_row.case_id = flag_case.case_id
    ), '[]'::jsonb)
  )
  from public.user_warning_auto_flag_cases flag_case
  join public.user_logs target
    on target.discord_user_id = flag_case.target_discord_user_id
  where flag_case.case_id = p_case_id;
$function$;

create function public.list_user_warning_auto_flag_cases(
  p_actor_discord_user_id text,
  p_section text,
  p_query text,
  p_limit integer,
  p_offset integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_section text := btrim(p_section);
  v_query text := nullif(lower(btrim(p_query)), '');
  v_items jsonb;
  v_total bigint;
begin
  if v_section not in ('active', 'history')
    or p_limit is null or p_limit not between 1 and 100
    or p_offset is null or p_offset < 0
    or (v_query is not null and char_length(v_query) > 100)
  then
    raise exception using
      errcode = '22023',
      message = 'USER_WARNING_AUTO_FLAG_LIST_INPUT_INVALID';
  end if;

  perform public.authorize_user_flag_capability(
    p_actor_discord_user_id,
    'users.flag.view'
  );

  with filtered as (
    select flag_case.case_id, flag_case.opened_at
    from public.user_warning_auto_flag_cases flag_case
    join public.user_logs target
      on target.discord_user_id = flag_case.target_discord_user_id
    where (
      (v_section = 'active' and flag_case.status = 'open')
      or (v_section = 'history' and flag_case.status = 'closed')
    )
      and (
        v_query is null
        or lower(flag_case.target_discord_user_id) like '%' || v_query || '%'
        or lower(coalesce(target.current_discord_username, '')) like '%' || v_query || '%'
        or lower(coalesce(target.current_display_name, '')) like '%' || v_query || '%'
        or lower(coalesce(target.current_guild_nickname, '')) like '%' || v_query || '%'
        or exists (
          select 1
          from unnest(coalesce(target.known_discord_usernames, array[]::text[])) known_name
          where lower(known_name) like '%' || v_query || '%'
        )
      )
  ), page as (
    select case_id, opened_at
    from filtered
    order by opened_at desc, case_id
    limit p_limit offset p_offset
  )
  select
    (select count(*) from filtered),
    coalesce((
      select jsonb_agg(
        public.build_user_warning_auto_flag_case_payload(page.case_id)
        order by page.opened_at desc, page.case_id
      )
      from page
    ), '[]'::jsonb)
  into v_total, v_items;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'limit', p_limit,
    'offset', p_offset
  );
end;
$function$;

create or replace function public.get_own_notifications(
  p_session_id uuid,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_items jsonb;
begin
  if p_limit not between 1 and 50
    or ((p_before_created_at is null) <> (p_before_id is null))
  then
    raise exception using errcode = '22023', message = 'NOTIFICATION_PAGE_INPUT_INVALID';
  end if;

  v_owner_id := public.require_account_session(p_session_id);
  select coalesce(
    jsonb_agg(item.payload order by item.created_at desc, item.id desc),
    '[]'::jsonb
  )
  into v_items
  from (
    select
      notification.created_at,
      notification.id,
      jsonb_build_object(
        'id', notification.id,
        'categoryKey', event.category_key,
        'eventType', event.event_type,
        'title', case event.event_type
          when 'winner_claim_required' then 'Winner claim required'
          when 'winner_correction_ready' then 'Winner claim ready'
          when 'winner_donation_finalized' then 'Winner result finalized'
          when 'winner_payout_sent' then 'Prize sent'
          when 'donation_recipient_change_required' then 'Choose another charity'
          when 'submission_disqualified' then 'Submission disqualified'
          when 'submission_reinstated' then 'Submission restored'
          when 'wallet_issue_received' then 'Wallet issue received'
          when 'wallet_issue_correction_ready' then 'Wallet correction ready'
          when 'wallet_issue_resolved' then 'Wallet issue resolved'
          when 'comment_reply' then 'New comment reply'
          when 'comment_mention' then 'New comment mention'
          when 'user_warning_issued' then 'Account Warning'
          when 'user_warning_overruled' then 'Account Warning corrected'
          else 'Cycle results are ready'
        end,
        'body', coalesce(event.public_body, case event.event_type
          when 'winner_claim_required' then 'Review and confirm your winner claim.'
          when 'winner_correction_ready' then 'Review the full recipient and confirm your Claim within 24 hours.'
          when 'winner_donation_finalized' then 'View your finalized winner result.'
          when 'winner_payout_sent' then 'Your prize payout has been recorded as sent.'
          when 'submission_disqualified' then 'View your moderation history for details.'
          when 'submission_reinstated' then 'View your moderation history for details.'
          when 'wallet_issue_received' then 'Your winning-Submission report is ready for Team review.'
          when 'wallet_issue_correction_ready' then 'Review the full recipient and confirm your Claim within 24 hours.'
          when 'wallet_issue_resolved' then 'Review the current recipient and confirm your Claim within 24 hours.'
          when 'comment_reply' then 'You have a new reply.'
          when 'comment_mention' then 'You were mentioned.'
          when 'user_warning_issued' then 'Review a Warning issued by the CancerCulture Team.'
          when 'user_warning_overruled' then 'A Warning for your account was overruled. Review its current effective status.'
          else 'View the finalized Cycle results.'
        end),
        'actionLabel', case event.event_type
          when 'winner_claim_required' then 'Review claim'
          when 'winner_correction_ready' then 'Review claim'
          when 'winner_donation_finalized' then 'View result'
          when 'winner_payout_sent' then 'View payout'
          when 'donation_recipient_change_required' then 'Choose charity'
          when 'submission_disqualified' then 'View details'
          when 'submission_reinstated' then 'View details'
          when 'wallet_issue_received' then 'View claim'
          when 'wallet_issue_correction_ready' then 'Review claim'
          when 'wallet_issue_resolved' then 'View claim'
          when 'comment_reply' then 'View reply'
          when 'comment_mention' then 'View mention'
          when 'user_warning_issued' then 'View warning'
          when 'user_warning_overruled' then 'View warning'
          else 'View results'
        end,
        'createdAt', notification.created_at,
        'readAt', notification.read_at
      ) payload
    from public.account_notifications notification
    join public.notification_events event
      on event.id = notification.event_id
    where notification.owner_discord_user_id = v_owner_id
      and notification.visible_in_product
      and (
        notification.read_at is null
        or notification.read_at > transaction_timestamp() - interval '3 days'
      )
      and (
        p_before_created_at is null
        or (notification.created_at, notification.id)
          < (p_before_created_at, p_before_id)
      )
    order by notification.created_at desc, notification.id desc
    limit p_limit + 1
  ) item;

  return jsonb_build_object('items', v_items);
end;
$function$;

alter function public.authorize_user_flag_capability(text,text) owner to postgres;
alter function public.produce_user_warning_overrule_notification() owner to postgres;
alter function public.get_user_warning_overrule_target(text,text,uuid) owner to postgres;
alter function public.build_user_warning_auto_flag_case_payload(uuid) owner to postgres;
alter function public.list_user_warning_auto_flag_cases(text,text,text,integer,integer)
  owner to postgres;
alter function public.get_own_notifications(uuid,timestamptz,uuid,integer)
  owner to postgres;

revoke all on function public.authorize_user_flag_capability(text,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.produce_user_warning_overrule_notification()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_user_warning_overrule_target(text,text,uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.build_user_warning_auto_flag_case_payload(uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.list_user_warning_auto_flag_cases(text,text,text,integer,integer)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_notifications(uuid,timestamptz,uuid,integer)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_user_warning_overrule_target(text,text,uuid)
  to service_role;
grant execute on function public.list_user_warning_auto_flag_cases(text,text,text,integer,integer)
  to service_role;
grant execute on function public.get_own_notifications(uuid,timestamptz,uuid,integer)
  to service_role;

do $postflight$
declare
  v_flag_definition text;
  v_notification_definition text;
  v_function_count integer;
begin
  if not exists (
    select 1 from public.capability_catalog
    where key = 'users.flag.view'
      and is_active
      and assignable_to_non_admin
      and implementation_version = 3
      and definition_hash = '54e6644753e36c355d69b4ca9aa80ef93d9b4b3040d4103a58e56b2a10f55add'
  )
    or exists (
      select 1 from public.notification_category_catalog
      where category_key = 'account_warnings' and push_available
    )
    or not exists (
      select 1 from pg_trigger
      where tgrelid = 'public.user_warning_events'::regclass
        and tgname = 'user_warning_overrule_notification_after_insert'
        and not tgisinternal
    )
  then
    raise exception using
      errcode = '55000',
      message = 'WARNING_CORRECTION_AUTO_FLAG_FINAL_STATE_MISMATCH';
  end if;

  select pg_get_functiondef(
    'public.authorize_user_flag_capability(text,text)'::regprocedure
  ) into v_flag_definition;
  select pg_get_functiondef(
    'public.get_own_notifications(uuid,timestamp with time zone,uuid,integer)'::regprocedure
  ) into v_notification_definition;

  if position('54e6644753e36c355d69b4ca9aa80ef93d9b4b3040d4103a58e56b2a10f55add' in v_flag_definition) = 0
    or position('user_warning_overruled' in v_notification_definition) = 0
    or position('A Warning for your account was overruled.' in v_notification_definition) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'WARNING_CORRECTION_AUTO_FLAG_FINAL_DEFINITION_MISMATCH';
  end if;

  select count(*)
  into v_function_count
  from pg_proc procedure_row
  join pg_namespace namespace_row
    on namespace_row.oid = procedure_row.pronamespace
  where namespace_row.nspname = 'public'
    and procedure_row.proname in (
      'get_user_warning_overrule_target',
      'build_user_warning_auto_flag_case_payload',
      'list_user_warning_auto_flag_cases'
    );

  if v_function_count <> 3
    or exists (
      select 1
      from pg_proc procedure_row
      join pg_namespace namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      where namespace_row.nspname = 'public'
        and procedure_row.proname in (
          'authorize_user_flag_capability',
          'produce_user_warning_overrule_notification',
          'get_user_warning_overrule_target',
          'build_user_warning_auto_flag_case_payload',
          'list_user_warning_auto_flag_cases',
          'get_own_notifications'
        )
        and (
          procedure_row.proowner <> 'postgres'::regrole
          or not procedure_row.prosecdef
          or procedure_row.proconfig <> array['search_path=public, pg_temp']
        )
    )
    or not has_function_privilege(
      'service_role',
      'public.get_user_warning_overrule_target(text,text,uuid)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.list_user_warning_auto_flag_cases(text,text,text,integer,integer)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'public.get_user_warning_overrule_target(text,text,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.list_user_warning_auto_flag_cases(text,text,text,integer,integer)',
      'EXECUTE'
    )
    or has_function_privilege(
      'service_role',
      'public.build_user_warning_auto_flag_case_payload(uuid)',
      'EXECUTE'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'WARNING_CORRECTION_AUTO_FLAG_FUNCTION_HARDENING_MISMATCH';
  end if;
end;
$postflight$;

commit;

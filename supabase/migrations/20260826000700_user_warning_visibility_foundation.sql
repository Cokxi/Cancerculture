begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 51
    or (select count(*) from public.capability_catalog where is_active) <> 47
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 47
    or exists (
      select 1 from public.capability_catalog
      where key = 'users.warnings.view'
    )
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key = 'users.warnings.view'
    )
    or to_regclass('public.user_warnings') is null
    or to_regclass('public.user_warning_current') is null
    or to_regclass('public.user_warning_events') is null
    or to_regclass('public.notification_category_catalog') is null
    or to_regclass('public.notification_events') is null
    or to_regclass('public.account_notifications') is null
    or to_regprocedure('public.authorize_user_warning_capability(text,text)') is null
    or to_regprocedure('public.issue_user_warning(text,uuid,bigint,bigint,text,text,uuid)') is null
    or to_regprocedure('public.enqueue_account_notification_event(text,text,text,text,text,boolean)') is null
    or to_regprocedure('public.require_account_session(uuid)') is null
    or to_regprocedure('public.get_own_notifications(uuid,timestamp with time zone,uuid,integer)') is null
    or exists (
      select 1 from public.notification_category_catalog
      where category_key = 'account_warnings'
    )
    or to_regprocedure('public.get_user_warning_team_history(text,text)') is not null
    or to_regprocedure('public.get_user_warning_team_summaries(text,text[])') is not null
    or to_regprocedure('public.get_own_user_warning_detail(uuid,uuid)') is not null
    or exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.user_warnings'::regclass
        and tgname = 'user_warning_notification_after_insert'
        and not tgisinternal
    )
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_VISIBILITY_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

insert into public.capability_catalog (
  key,
  display_name,
  description,
  category,
  included_actions,
  excluded_actions,
  risk_level,
  assignable_to_non_admin,
  is_active,
  implementation_version,
  definition_hash
)
values (
  'users.warnings.view',
  'View User Warning History',
  'View canonical active Warning status and immutable Warning history for a selected user.',
  'User Moderation',
  array[
    'View canonical active Warning counts, effective states, tiers, and expiries for a selected user.',
    'View Warning category, reason, source Comment evidence, issuing Team snapshot, and lifecycle events.',
    'Compare immutable original assignment with the current deterministic recalculation projection.'
  ]::text[],
  array[
    'Issuing or overruling Warnings.',
    'Viewing automatic Flag internals, appeals, Reports, Spam signals, or unrelated moderation data.',
    'Banning, holding participation, removing Comments, or applying any other sanction.',
    'Managing roles, grants, Team membership, or Owner access.'
  ]::text[],
  'high',
  true,
  true,
  1,
  'c3a987a6878787bcd56e6e1e9ebbe791419c510c47c768a18bf2354bc81a85d8'
);

insert into public.notification_category_catalog (
  category_key,
  display_name,
  required_in_product,
  is_active,
  description,
  default_in_product_enabled,
  in_product_available,
  push_available
)
values (
  'account_warnings',
  'Account warnings',
  true,
  true,
  'Required private in-app notices for Warnings issued to your account.',
  true,
  false,
  false
);

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
    'user_warning_issued'
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
    or (event_type = 'user_warning_issued' and category_key = 'account_warnings')
  );

create or replace function public.authorize_user_warning_capability(
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
  v_role_key text;
  v_expected_hash text;
begin
  v_expected_hash := case p_capability_key
    when 'users.warnings.issue' then
      '8910867c7eb547473efaf129089bf2e0098d6f471e2057358ddd77f90818811f'
    when 'users.warnings.overrule' then
      'ce5849bc151746eddf520ed960002a6f0c7e4a9c7b0c9eac58721d4c40603ece'
    when 'users.warnings.view' then
      'c3a987a6878787bcd56e6e1e9ebbe791419c510c47c768a18bf2354bc81a85d8'
    else null
  end;

  if nullif(v_actor_id, '') is null or v_expected_hash is null then
    raise exception using errcode = '42501', message = 'USER_WARNING_FORBIDDEN';
  end if;

  if not exists (
    select 1
    from public.capability_catalog capability
    where capability.key = p_capability_key
      and capability.is_active
      and capability.assignable_to_non_admin
      and capability.implementation_version = 1
      and capability.definition_hash = v_expected_hash
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_CAPABILITY_DEPENDENCY_UNAVAILABLE';
  end if;

  select member.role
  into v_role_key
  from public.team_members member
  join public.team_roles role
    on role.key = member.role
   and role.is_active
  where member.discord_user_id = v_actor_id;

  if not found
    or (
      v_role_key <> 'admin'
      and not exists (
        select 1
        from public.team_role_capabilities grant_row
        where grant_row.role_key = v_role_key
          and grant_row.capability_key = p_capability_key
      )
    )
  then
    raise exception using errcode = '42501', message = 'USER_WARNING_FORBIDDEN';
  end if;

  return v_role_key;
end;
$function$;

create function public.produce_user_warning_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  perform public.enqueue_account_notification_event(
    'user_warning_issued:' || new.warning_id::text,
    'user_warning_issued',
    'account_warnings',
    new.target_discord_user_id,
    '/warnings/' || new.public_warning_id::text,
    true
  );
  return new;
end;
$function$;

create trigger user_warning_notification_after_insert
after insert on public.user_warnings
for each row execute function public.produce_user_warning_notification();

create function public.get_own_user_warning_detail(
  p_session_id uuid,
  p_public_warning_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_now timestamptz := clock_timestamp();
  v_result jsonb;
begin
  if p_public_warning_id is null then
    raise exception using
      errcode = '22023',
      message = 'USER_WARNING_DETAIL_INPUT_INVALID';
  end if;

  v_owner_id := public.require_account_session(p_session_id);

  select jsonb_build_object(
    'outcome', 'found',
    'warningId', warning_row.public_warning_id,
    'category', warning_row.category,
    'reason', warning_row.reason,
    'issuedAt', warning_row.issued_at,
    'effectiveStatus', case
      when current_row.state = 'active' and current_row.expires_at <= v_now
        then 'expired'
      else current_row.state
    end,
    'expiresAt', current_row.expires_at
  )
  into v_result
  from public.user_warnings warning_row
  join public.user_warning_current current_row
    on current_row.warning_id = warning_row.warning_id
   and current_row.target_discord_user_id = warning_row.target_discord_user_id
  where warning_row.public_warning_id = p_public_warning_id
    and warning_row.target_discord_user_id = v_owner_id;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  return v_result;
end;
$function$;

create function public.get_user_warning_team_history(
  p_actor_discord_user_id text,
  p_target_discord_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_target_id text := btrim(p_target_discord_user_id);
  v_now timestamptz := clock_timestamp();
  v_items jsonb;
  v_active_count bigint;
  v_latest_active_expiry timestamptz;
  v_has_more boolean;
begin
  perform public.authorize_user_warning_capability(
    p_actor_discord_user_id,
    'users.warnings.view'
  );

  if nullif(v_target_id, '') is null then
    raise exception using
      errcode = '22023',
      message = 'USER_WARNING_HISTORY_INPUT_INVALID';
  end if;

  if not exists (
    select 1 from public.user_logs user_row
    where user_row.discord_user_id = v_target_id
  ) then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select
    count(*) filter (
      where current_row.state = 'active'
        and current_row.expires_at > v_now
    ),
    max(current_row.expires_at) filter (
      where current_row.state = 'active'
        and current_row.expires_at > v_now
    )
  into v_active_count, v_latest_active_expiry
  from public.user_warning_current current_row
  where current_row.target_discord_user_id = v_target_id;

  select coalesce(
    jsonb_agg(item.payload order by item.issued_at desc, item.warning_id desc),
    '[]'::jsonb
  )
  into v_items
  from (
    select
      warning_row.issued_at,
      warning_row.warning_id,
      jsonb_build_object(
        'warningId', warning_row.public_warning_id,
        'category', warning_row.category,
        'reason', warning_row.reason,
        'issuedAt', warning_row.issued_at,
        'issuedByDisplayName', warning_row.issued_by_display_name,
        'issuedByRoleKey', warning_row.issued_by_role_key,
        'sourcePublicCommentId', warning_row.source_public_comment_id,
        'sourceSubmissionId', warning_row.source_submission_id,
        'sourceCommentObjectVersion', warning_row.source_comment_object_version,
        'sourceCommentTextVersion', warning_row.source_comment_text_version,
        'sourceCommentBody', warning_row.source_comment_body,
        'originalTierDays', warning_row.original_tier_days,
        'originalExpiresAt', warning_row.original_expires_at,
        'effectiveTierDays', current_row.effective_tier_days,
        'effectiveStatus', case
          when current_row.state = 'active' and current_row.expires_at <= v_now
            then 'expired'
          else current_row.state
        end,
        'effectiveExpiresAt', current_row.expires_at,
        'rowVersion', current_row.row_version,
        'events', coalesce((
          select jsonb_agg(jsonb_build_object(
            'eventType', event_row.event_type,
            'occurredAt', event_row.occurred_at,
            'actorKind', event_row.actor_kind,
            'actorDisplayName', event_row.actor_display_name,
            'actorRoleKey', event_row.actor_role_key,
            'reason', event_row.reason,
            'previousState', event_row.previous_state,
            'newState', event_row.new_state,
            'previousTierDays', event_row.previous_tier_days,
            'newTierDays', event_row.new_tier_days,
            'previousExpiresAt', event_row.previous_expires_at,
            'newExpiresAt', event_row.new_expires_at,
            'warningRowVersion', event_row.warning_row_version
          ) order by event_row.event_id)
          from public.user_warning_events event_row
          where event_row.warning_id = warning_row.warning_id
        ), '[]'::jsonb)
      ) payload
    from public.user_warnings warning_row
    join public.user_warning_current current_row
      on current_row.warning_id = warning_row.warning_id
     and current_row.target_discord_user_id = warning_row.target_discord_user_id
    where warning_row.target_discord_user_id = v_target_id
    order by warning_row.issued_at desc, warning_row.warning_id desc
    limit 101
  ) item;

  v_has_more := jsonb_array_length(v_items) > 100;
  if v_has_more then
    v_items := v_items - 100;
  end if;

  return jsonb_build_object(
    'outcome', 'found',
    'active', v_active_count > 0,
    'activeCount', v_active_count,
    'latestActiveExpiresAt', v_latest_active_expiry,
    'warnings', v_items,
    'historyHasMore', v_has_more
  );
end;
$function$;

create function public.get_user_warning_team_summaries(
  p_actor_discord_user_id text,
  p_target_discord_user_ids text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_items jsonb;
begin
  perform public.authorize_user_warning_capability(
    p_actor_discord_user_id,
    'users.warnings.view'
  );

  if p_target_discord_user_ids is null
    or cardinality(p_target_discord_user_ids) not between 1 and 200
    or exists (
      select 1
      from unnest(p_target_discord_user_ids) target_id
      where nullif(btrim(target_id), '') is null
    )
    or cardinality(p_target_discord_user_ids) <> (
      select count(distinct btrim(target_id))
      from unnest(p_target_discord_user_ids) target_id
    )
  then
    raise exception using
      errcode = '22023',
      message = 'USER_WARNING_SUMMARY_INPUT_INVALID';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'targetDiscordUserId', target.target_discord_user_id,
    'active', target.active_count > 0,
    'activeCount', target.active_count,
    'latestActiveExpiresAt', target.latest_active_expires_at,
    'historyCount', target.history_count
  ) order by target.target_discord_user_id), '[]'::jsonb)
  into v_items
  from (
    select
      requested.target_discord_user_id,
      count(warning_row.warning_id) as history_count,
      count(warning_row.warning_id) filter (
        where current_row.state = 'active'
          and current_row.expires_at > v_now
      ) as active_count,
      max(current_row.expires_at) filter (
        where current_row.state = 'active'
          and current_row.expires_at > v_now
      ) as latest_active_expires_at
    from (
      select distinct btrim(target_id) as target_discord_user_id
      from unnest(p_target_discord_user_ids) target_id
    ) requested
    join public.user_logs user_row
      on user_row.discord_user_id = requested.target_discord_user_id
    left join public.user_warnings warning_row
      on warning_row.target_discord_user_id = requested.target_discord_user_id
    left join public.user_warning_current current_row
      on current_row.warning_id = warning_row.warning_id
     and current_row.target_discord_user_id = warning_row.target_discord_user_id
    group by requested.target_discord_user_id
  ) target;

  return jsonb_build_object('items', v_items);
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
          when 'user_warning_issued' then 'Account warning issued'
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
          when 'wallet_issue_resolved' then 'Review claim'
          when 'comment_reply' then 'View reply'
          when 'comment_mention' then 'View mention'
          when 'user_warning_issued' then 'View warning'
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

alter function public.authorize_user_warning_capability(text,text) owner to postgres;
alter function public.produce_user_warning_notification() owner to postgres;
alter function public.get_own_user_warning_detail(uuid,uuid) owner to postgres;
alter function public.get_user_warning_team_history(text,text) owner to postgres;
alter function public.get_user_warning_team_summaries(text,text[]) owner to postgres;
alter function public.get_own_notifications(uuid,timestamptz,uuid,integer) owner to postgres;

revoke all on function public.authorize_user_warning_capability(text,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.produce_user_warning_notification()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_user_warning_detail(uuid,uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_user_warning_team_history(text,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_user_warning_team_summaries(text,text[])
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_notifications(uuid,timestamptz,uuid,integer)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_own_user_warning_detail(uuid,uuid)
  to service_role;
grant execute on function public.get_user_warning_team_history(text,text)
  to service_role;
grant execute on function public.get_user_warning_team_summaries(text,text[])
  to service_role;
grant execute on function public.get_own_notifications(uuid,timestamptz,uuid,integer)
  to service_role;

do $postflight$
declare
  v_signature text;
  v_service_signatures text[] := array[
    'public.get_own_user_warning_detail(uuid,uuid)',
    'public.get_user_warning_team_history(text,text)',
    'public.get_user_warning_team_summaries(text,text[])'
  ];
  v_internal_signatures text[] := array[
    'public.authorize_user_warning_capability(text,text)',
    'public.produce_user_warning_notification()'
  ];
begin
  if (select count(*) from public.capability_catalog) <> 52
    or (select count(*) from public.capability_catalog where is_active) <> 48
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 48
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'users.warnings.view'
        and implementation_version = 1
        and definition_hash = 'c3a987a6878787bcd56e6e1e9ebbe791419c510c47c768a18bf2354bc81a85d8'
        and is_active
        and assignable_to_non_admin
    )
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key = 'users.warnings.view'
    )
    or not exists (
      select 1
      from public.notification_category_catalog
      where category_key = 'account_warnings'
        and required_in_product
        and is_active
        and default_in_product_enabled
        and not in_product_available
        and not push_available
    )
    or not exists (
      select 1
      from pg_constraint
      where conrelid = 'public.notification_events'::regclass
        and conname = 'notification_event_type_check'
        and pg_get_constraintdef(oid) like '%user_warning_issued%'
    )
    or not exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.user_warnings'::regclass
        and tgname = 'user_warning_notification_after_insert'
        and not tgisinternal
    )
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_VISIBILITY_FINAL_STATE_MISMATCH';
  end if;

  foreach v_signature in array v_service_signatures loop
    if not exists (
      select 1
      from pg_proc procedure_row
      join pg_namespace namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      where procedure_row.oid = v_signature::regprocedure
        and namespace_row.nspname = 'public'
        and procedure_row.proowner = 'postgres'::regrole
        and procedure_row.prosecdef
        and procedure_row.proconfig = array['search_path=public, pg_temp']
        and has_function_privilege('service_role', procedure_row.oid, 'EXECUTE')
        and not has_function_privilege('anon', procedure_row.oid, 'EXECUTE')
        and not has_function_privilege('authenticated', procedure_row.oid, 'EXECUTE')
        and not has_function_privilege('discord_bot', procedure_row.oid, 'EXECUTE')
    ) then
      raise exception using
        errcode = '55000',
        message = 'USER_WARNING_VISIBILITY_SERVICE_ACL_MISMATCH';
    end if;
  end loop;

  foreach v_signature in array v_internal_signatures loop
    if not exists (
      select 1
      from pg_proc procedure_row
      join pg_namespace namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      where procedure_row.oid = v_signature::regprocedure
        and namespace_row.nspname = 'public'
        and procedure_row.proowner = 'postgres'::regrole
        and procedure_row.prosecdef
        and procedure_row.proconfig = array['search_path=public, pg_temp']
        and not has_function_privilege('service_role', procedure_row.oid, 'EXECUTE')
        and not has_function_privilege('anon', procedure_row.oid, 'EXECUTE')
        and not has_function_privilege('authenticated', procedure_row.oid, 'EXECUTE')
        and not has_function_privilege('discord_bot', procedure_row.oid, 'EXECUTE')
    ) then
      raise exception using
        errcode = '55000',
        message = 'USER_WARNING_VISIBILITY_INTERNAL_ACL_MISMATCH';
    end if;
  end loop;

  if exists (
    select 1
    from pg_proc procedure_row
    join pg_namespace namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'public'
      and procedure_row.proname in (
        'get_own_user_warning_detail',
        'get_user_warning_team_history',
        'get_user_warning_team_summaries',
        'produce_user_warning_notification'
      )
      and procedure_row.oid not in (
        'public.get_own_user_warning_detail(uuid,uuid)'::regprocedure,
        'public.get_user_warning_team_history(text,text)'::regprocedure,
        'public.get_user_warning_team_summaries(text,text[])'::regprocedure,
        'public.produce_user_warning_notification()'::regprocedure
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_VISIBILITY_FUNCTION_OVERLOAD_MISMATCH';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'user_warnings',
        'user_warning_current',
        'user_warning_events',
        'notification_events',
        'account_notifications'
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_VISIBILITY_RLS_POLICY_MISMATCH';
  end if;
end;
$postflight$;

commit;

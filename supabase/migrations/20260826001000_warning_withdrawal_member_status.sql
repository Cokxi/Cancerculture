begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

do $preflight$
declare
  v_detail_definition text;
  v_notification_definition text;
begin
  if (select count(*) from public.capability_catalog) <> 52
    or (select count(*) from public.capability_catalog where is_active) <> 48
    or not exists (
      select 1 from public.capability_catalog
      where key = 'users.flag.view'
        and implementation_version = 3
        and definition_hash = '54e6644753e36c355d69b4ca9aa80ef93d9b4b3040d4103a58e56b2a10f55add'
    )
    or to_regprocedure('public.get_own_user_warning_detail(uuid,uuid)') is null
    or to_regprocedure(
      'public.get_own_notifications(uuid,timestamp with time zone,uuid,integer)'
    ) is null
    or not exists (
      select 1 from public.notification_category_catalog
      where category_key = 'account_warnings'
        and required_in_product
        and is_active
        and not push_available
    )
  then
    raise exception using
      errcode = '55000',
      message = 'WARNING_WITHDRAWAL_MEMBER_STATUS_BASELINE_MISMATCH';
  end if;

  select pg_get_functiondef(
    'public.get_own_user_warning_detail(uuid,uuid)'::regprocedure
  ) into v_detail_definition;
  select pg_get_functiondef(
    'public.get_own_notifications(uuid,timestamp with time zone,uuid,integer)'::regprocedure
  ) into v_notification_definition;

  if position('''expiresAt'', current_row.expires_at' in v_detail_definition) = 0
    or position('accountActiveWarningCount' in v_detail_definition) > 0
    or position('Account Warning corrected' in v_notification_definition) = 0
    or position('A Warning for your account was overruled.' in v_notification_definition) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'WARNING_WITHDRAWAL_MEMBER_STATUS_DEFINITION_MISMATCH';
  end if;
end;
$preflight$;

create or replace function public.get_own_user_warning_detail(
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
      when current_row.state = 'overruled' then 'withdrawn'
      when current_row.state = 'active' and current_row.expires_at <= v_now
        then 'expired'
      else current_row.state
    end,
    'expiresAt', case
      when current_row.state = 'overruled' then null
      else current_row.expires_at
    end,
    'accountActiveWarningCount', account_status.active_warning_count,
    'accountLatestActiveExpiresAt', account_status.latest_active_expires_at
  )
  into v_result
  from public.user_warnings warning_row
  join public.user_warning_current current_row
    on current_row.warning_id = warning_row.warning_id
   and current_row.target_discord_user_id = warning_row.target_discord_user_id
  cross join lateral (
    select
      count(*)::integer as active_warning_count,
      max(account_row.expires_at) as latest_active_expires_at
    from public.user_warning_current account_row
    where account_row.target_discord_user_id = warning_row.target_discord_user_id
      and account_row.state = 'active'
      and account_row.expires_at > v_now
  ) account_status
  where warning_row.public_warning_id = p_public_warning_id
    and warning_row.target_discord_user_id = v_owner_id;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  return v_result;
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
          when 'user_warning_overruled' then 'Account Warning withdrawn'
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
          when 'user_warning_overruled' then 'A Warning for your account was withdrawn. Review your updated account Warning status.'
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
          when 'user_warning_overruled' then 'View updated status'
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

alter function public.get_own_user_warning_detail(uuid,uuid) owner to postgres;
alter function public.get_own_notifications(uuid,timestamptz,uuid,integer)
  owner to postgres;

revoke all on function public.get_own_user_warning_detail(uuid,uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_notifications(uuid,timestamptz,uuid,integer)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_own_user_warning_detail(uuid,uuid)
  to service_role;
grant execute on function public.get_own_notifications(uuid,timestamptz,uuid,integer)
  to service_role;

do $postflight$
declare
  v_detail_definition text;
  v_notification_definition text;
begin
  select pg_get_functiondef(
    'public.get_own_user_warning_detail(uuid,uuid)'::regprocedure
  ) into v_detail_definition;
  select pg_get_functiondef(
    'public.get_own_notifications(uuid,timestamp with time zone,uuid,integer)'::regprocedure
  ) into v_notification_definition;

  if position('accountActiveWarningCount' in v_detail_definition) = 0
    or position('accountLatestActiveExpiresAt' in v_detail_definition) = 0
    or position('then ''withdrawn''' in v_detail_definition) = 0
    or position('Account Warning withdrawn' in v_notification_definition) = 0
    or position('Review your updated account Warning status.' in v_notification_definition) = 0
    or exists (
      select 1
      from pg_proc procedure_row
      join pg_namespace namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      where namespace_row.nspname = 'public'
        and procedure_row.proname in (
          'get_own_user_warning_detail',
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
      'public.get_own_user_warning_detail(uuid,uuid)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.get_own_notifications(uuid,timestamp with time zone,uuid,integer)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.get_own_user_warning_detail(uuid,uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'public.get_own_notifications(uuid,timestamp with time zone,uuid,integer)',
      'EXECUTE'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'WARNING_WITHDRAWAL_MEMBER_STATUS_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;

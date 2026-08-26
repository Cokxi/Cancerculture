begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

do $preflight$
declare
  v_definition text;
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
        and is_active
        and assignable_to_non_admin
        and implementation_version = 1
        and definition_hash = 'c3a987a6878787bcd56e6e1e9ebbe791419c510c47c768a18bf2354bc81a85d8'
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
    or to_regprocedure(
      'public.get_own_notifications(uuid,timestamp with time zone,uuid,integer)'
    ) is null
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_COPY_BASELINE_MISMATCH';
  end if;

  select pg_get_functiondef(
    'public.get_own_notifications(uuid,timestamp with time zone,uuid,integer)'::regprocedure
  ) into v_definition;

  if position('Account warning issued' in v_definition) = 0
    or position('Account Warning' in v_definition) > 0
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_COPY_DEFINITION_MISMATCH';
  end if;
end;
$preflight$;

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
          when 'wallet_issue_resolved' then 'View claim'
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

alter function public.get_own_notifications(uuid,timestamptz,uuid,integer)
  owner to postgres;
revoke all on function public.get_own_notifications(uuid,timestamptz,uuid,integer)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.get_own_notifications(uuid,timestamptz,uuid,integer)
  to service_role;

do $postflight$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.get_own_notifications(uuid,timestamp with time zone,uuid,integer)'::regprocedure
  ) into v_definition;

  if position('Account Warning' in v_definition) = 0
    or position('Account warning issued' in v_definition) > 0
    or not exists (
      select 1
      from pg_proc procedure_row
      join pg_namespace namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      where procedure_row.oid =
        'public.get_own_notifications(uuid,timestamp with time zone,uuid,integer)'::regprocedure
        and namespace_row.nspname = 'public'
        and procedure_row.proowner = 'postgres'::regrole
        and procedure_row.prosecdef
        and procedure_row.proconfig = array['search_path=public, pg_temp']
        and has_function_privilege('service_role', procedure_row.oid, 'EXECUTE')
        and not has_function_privilege('anon', procedure_row.oid, 'EXECUTE')
        and not has_function_privilege('authenticated', procedure_row.oid, 'EXECUTE')
        and not has_function_privilege('discord_bot', procedure_row.oid, 'EXECUTE')
    )
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_COPY_FINAL_STATE_MISMATCH';
  end if;
end;
$postflight$;

commit;

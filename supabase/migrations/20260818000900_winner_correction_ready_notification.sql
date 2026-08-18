begin;

do $baseline$
begin
  if to_regclass('public.notification_events') is null
    or to_regclass('public.winner_claim_events') is null
    or to_regprocedure('public.enqueue_account_notification_event(text,text,text,text,text,boolean)') is null
    or to_regprocedure('public.get_own_notifications(uuid,timestamptz,uuid,integer)') is null
    or to_regprocedure('public.protect_team_correction_profile_wallet_control()') is null
    or to_regprocedure('public.produce_winner_correction_ready_notification()') is not null
    or exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.winner_claim_events'::regclass
        and tgname = 'winner_correction_ready_notification'
        and not tgisinternal
    )
    or position(
      'wallet_issue_correction_ready' in pg_get_functiondef(
        'public.get_own_notifications(uuid,timestamptz,uuid,integer)'::regprocedure
      )
    ) = 0
    or position(
      'winner_correction_ready' in pg_get_functiondef(
        'public.get_own_notifications(uuid,timestamptz,uuid,integer)'::regprocedure
      )
    ) > 0
  then
    raise exception using
      errcode = '55000',
      message = 'WINNER_CORRECTION_NOTIFICATION_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

alter table public.notification_events
  drop constraint notification_event_type_check,
  drop constraint notification_event_category_check;

alter table public.notification_events
  add constraint notification_event_type_check
    check (event_type in (
      'winner_claim_required',
      'winner_correction_ready',
      'winner_donation_finalized',
      'submission_disqualified',
      'submission_reinstated',
      'cycle_results_ready',
      'wallet_issue_received',
      'wallet_issue_correction_ready',
      'wallet_issue_resolved'
    )),
  add constraint notification_event_category_check
    check (
      (event_type in (
          'winner_claim_required',
          'winner_correction_ready',
          'winner_donation_finalized'
        ) and category_key = 'winners_claims')
      or (event_type in ('submission_disqualified', 'submission_reinstated')
        and category_key = 'submission_moderation')
      or (event_type = 'cycle_results_ready'
        and category_key = 'cycles_voting')
      or (event_type in (
          'wallet_issue_received',
          'wallet_issue_correction_ready',
          'wallet_issue_resolved'
        ) and category_key = 'wallet_issues')
    );

create function public.produce_winner_correction_ready_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
begin
  select claim.winner_discord_user_id
  into strict v_owner_id
  from public.winner_claims claim
  where claim.id = new.claim_id;

  perform public.enqueue_account_notification_event(
    'winner-correction-ready:' || new.claim_id::text || ':' || new.correction_version::text,
    'winner_correction_ready',
    'winners_claims',
    v_owner_id,
    '/my-profile/winnings/' || new.claim_id::text,
    public.resolve_account_notification_visibility(v_owner_id, 'winners_claims')
  );

  return new;
end;
$function$;

create trigger winner_correction_ready_notification
after insert on public.winner_claim_events
for each row
when (new.action = 'correction_ready' and new.case_reference is null)
execute function public.produce_winner_correction_ready_notification();

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
  select coalesce(jsonb_agg(item.payload order by item.created_at desc, item.id desc), '[]'::jsonb)
  into v_items
  from (
    select notification.created_at, notification.id,
      jsonb_build_object(
        'id', notification.id,
        'categoryKey', event.category_key,
        'eventType', event.event_type,
        'title', case event.event_type
          when 'winner_claim_required' then 'Winner claim required'
          when 'winner_correction_ready' then 'Winner claim ready'
          when 'winner_donation_finalized' then 'Winner result finalized'
          when 'submission_disqualified' then 'Submission disqualified'
          when 'submission_reinstated' then 'Submission restored'
          when 'wallet_issue_received' then 'Wallet issue received'
          when 'wallet_issue_correction_ready' then 'Wallet correction ready'
          when 'wallet_issue_resolved' then 'Wallet issue resolved'
          else 'Cycle results are ready'
        end,
        'body', case event.event_type
          when 'winner_claim_required' then 'Review and confirm your winner claim.'
          when 'winner_correction_ready' then 'Review the full recipient and confirm your Claim within 24 hours.'
          when 'winner_donation_finalized' then 'View your finalized winner result.'
          when 'submission_disqualified' then 'View your moderation history for details.'
          when 'submission_reinstated' then 'View your moderation history for details.'
          when 'wallet_issue_received' then 'Your winning-Submission report is ready for Team review.'
          when 'wallet_issue_correction_ready' then 'Review the full recipient and confirm your Claim within 24 hours.'
          when 'wallet_issue_resolved' then 'Review the current recipient and confirm your Claim within 24 hours.'
          else 'View the finalized Cycle results.'
        end,
        'actionLabel', case event.event_type
          when 'winner_claim_required' then 'Review claim'
          when 'winner_correction_ready' then 'Review claim'
          when 'winner_donation_finalized' then 'View result'
          when 'submission_disqualified' then 'View details'
          when 'submission_reinstated' then 'View details'
          when 'wallet_issue_received' then 'View claim'
          when 'wallet_issue_correction_ready' then 'Review claim'
          when 'wallet_issue_resolved' then 'Review claim'
          else 'View results'
        end,
        'createdAt', notification.created_at,
        'readAt', notification.read_at
      ) payload
    from public.account_notifications notification
    join public.notification_events event on event.id = notification.event_id
    where notification.owner_discord_user_id = v_owner_id
      and notification.visible_in_product
      and (notification.read_at is null
        or notification.read_at > transaction_timestamp() - interval '3 days')
      and (p_before_created_at is null
        or (notification.created_at, notification.id) < (p_before_created_at, p_before_id))
    order by notification.created_at desc, notification.id desc
    limit p_limit + 1
  ) item;
  return jsonb_build_object('items', v_items);
end;
$function$;

alter function public.produce_winner_correction_ready_notification() owner to postgres;
alter function public.get_own_notifications(uuid,timestamptz,uuid,integer) owner to postgres;

revoke all on function public.produce_winner_correction_ready_notification()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_notifications(uuid,timestamptz,uuid,integer)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.get_own_notifications(uuid,timestamptz,uuid,integer)
  to service_role;

do $postflight$
begin
  if not exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.winner_claim_events'::regclass
        and tgname = 'winner_correction_ready_notification'
        and not tgisinternal
        and tgenabled = 'O'
    )
    or position(
      'winner_correction_ready' in pg_get_constraintdef(
        (select oid from pg_constraint
         where conrelid = 'public.notification_events'::regclass
           and conname = 'notification_event_type_check')
      )
    ) = 0
    or position(
      'winner_correction_ready' in pg_get_functiondef(
        'public.get_own_notifications(uuid,timestamptz,uuid,integer)'::regprocedure
      )
    ) = 0
    or has_function_privilege(
      'service_role',
      'public.produce_winner_correction_ready_notification()',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.get_own_notifications(uuid,timestamptz,uuid,integer)',
      'EXECUTE'
    )
    or (select count(*) from public.capability_catalog) <> 39
    or (select count(*) from public.capability_catalog where is_active) <> 35
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key = 'winners.recipient_corrections.manage'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'WINNER_CORRECTION_NOTIFICATION_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.produce_winner_correction_ready_notification() is
  'Queues one winner-owned Claim notification for each ready general Team recipient correction; Wallet Issue resolutions retain their separate event.';

commit;

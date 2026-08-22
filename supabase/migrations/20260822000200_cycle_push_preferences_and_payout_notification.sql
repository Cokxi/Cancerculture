begin;

do $baseline$
begin
  if to_regclass('public.push_cycle_preferences') is not null
    or to_regprocedure('public.produce_due_cycle_push_notifications()') is not null
    or to_regprocedure('public.set_own_push_cycle_preference(uuid,uuid,text,boolean)') is not null
    or to_regprocedure('public.produce_winner_payout_sent_notification()') is not null
    or to_regprocedure('public.get_own_push_subscription_settings(uuid,uuid)') is null
    or to_regprocedure('public.process_notification_broadcast_batch(integer)') is null
    or to_regprocedure('public.enqueue_account_notification_event(text,text,text,text,text,boolean)') is null
    or not exists (
      select 1 from pg_trigger
      where tgrelid = 'public.cycle_events'::regclass
        and tgname = 'cycle_events_produce_results_notification'
        and not tgisinternal
    )
    or not exists (
      select 1 from public.notification_category_catalog
      where category_key = 'cycles_voting' and push_available and is_active
    )
  then
    raise exception using errcode = '55000',
      message = 'CYCLE_PUSH_PREFERENCES_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

create table public.push_cycle_preferences (
  subscription_id uuid primary key
    references public.push_subscriptions(id) on delete cascade,
  new_cycle_started boolean not null default false,
  submission_phase_ends boolean not null default false,
  voting_phase_ends boolean not null default false,
  cycle_results_ready boolean not null default false,
  remind_15_minutes boolean not null default false,
  remind_10_minutes boolean not null default false,
  remind_5_minutes boolean not null default false,
  updated_at timestamptz not null default transaction_timestamp()
);

alter table public.push_cycle_preferences enable row level security;
alter table public.push_cycle_preferences owner to postgres;
revoke all on table public.push_cycle_preferences
  from public, anon, authenticated, discord_bot, service_role;

insert into public.push_cycle_preferences (
  subscription_id, cycle_results_ready
)
select subscription.id, coalesce(preference.enabled, false)
from public.push_subscriptions subscription
left join public.push_subscription_preferences preference
  on preference.subscription_id = subscription.id
 and preference.category_key = 'cycles_voting';

create or replace function public.get_own_push_subscription_settings(
  p_session_id uuid,
  p_device_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_subscription_id uuid;
  v_categories jsonb;
  v_cycle_preferences jsonb;
begin
  v_owner_id := public.require_account_session(p_session_id);
  select subscription.id into v_subscription_id
  from public.push_subscriptions subscription
  join public.sessions session_row
    on session_row.id = subscription.session_id
   and session_row.revoked_at is null
  where subscription.owner_discord_user_id = v_owner_id
    and subscription.device_id = p_device_id
    and subscription.is_active;

  select coalesce(jsonb_agg(jsonb_build_object(
    'categoryKey', category.category_key,
    'displayName', category.display_name,
    'description', category.description,
    'enabled', coalesce(preference.enabled, false)
  ) order by category.category_key), '[]'::jsonb)
  into v_categories
  from public.notification_category_catalog category
  left join public.push_subscription_preferences preference
    on preference.subscription_id = v_subscription_id
   and preference.category_key = category.category_key
  where category.is_active and category.push_available;

  select jsonb_build_object(
    'newCycleStarted', coalesce(preference.new_cycle_started, false),
    'submissionPhaseEnds', coalesce(preference.submission_phase_ends, false),
    'votingPhaseEnds', coalesce(preference.voting_phase_ends, false),
    'cycleResultsReady', coalesce(preference.cycle_results_ready, false),
    'remind15Minutes', coalesce(preference.remind_15_minutes, false),
    'remind10Minutes', coalesce(preference.remind_10_minutes, false),
    'remind5Minutes', coalesce(preference.remind_5_minutes, false)
  ) into v_cycle_preferences
  from (select 1) seed
  left join public.push_cycle_preferences preference
    on preference.subscription_id = v_subscription_id;

  return jsonb_build_object(
    'active', v_subscription_id is not null,
    'categories', v_categories,
    'cyclePreferences', v_cycle_preferences
  );
end;
$function$;

create function public.set_own_push_cycle_preference(
  p_session_id uuid,
  p_device_id uuid,
  p_preference_key text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_subscription_id uuid;
  v_any_enabled boolean;
begin
  if p_preference_key not in (
    'new_cycle_started', 'submission_phase_ends', 'voting_phase_ends',
    'cycle_results_ready', 'remind_15_minutes', 'remind_10_minutes',
    'remind_5_minutes'
  ) then
    raise exception using errcode = '22023', message = 'PUSH_CYCLE_PREFERENCE_INVALID';
  end if;

  v_owner_id := public.require_account_session(p_session_id);
  select id into v_subscription_id
  from public.push_subscriptions
  where owner_discord_user_id = v_owner_id
    and device_id = p_device_id
    and session_id = p_session_id
    and is_active
  for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;

  insert into public.push_cycle_preferences(subscription_id)
  values (v_subscription_id)
  on conflict (subscription_id) do nothing;

  update public.push_cycle_preferences
  set new_cycle_started = case when p_preference_key = 'new_cycle_started' then p_enabled else new_cycle_started end,
      submission_phase_ends = case when p_preference_key = 'submission_phase_ends' then p_enabled else submission_phase_ends end,
      voting_phase_ends = case when p_preference_key = 'voting_phase_ends' then p_enabled else voting_phase_ends end,
      cycle_results_ready = case when p_preference_key = 'cycle_results_ready' then p_enabled else cycle_results_ready end,
      remind_15_minutes = case when p_preference_key = 'remind_15_minutes' then p_enabled else remind_15_minutes end,
      remind_10_minutes = case when p_preference_key = 'remind_10_minutes' then p_enabled else remind_10_minutes end,
      remind_5_minutes = case when p_preference_key = 'remind_5_minutes' then p_enabled else remind_5_minutes end,
      updated_at = transaction_timestamp()
  where subscription_id = v_subscription_id
  returning (
    new_cycle_started or submission_phase_ends or voting_phase_ends
    or cycle_results_ready
  ) into v_any_enabled;

  insert into public.push_subscription_preferences(
    subscription_id, category_key, enabled
  ) values (v_subscription_id, 'cycles_voting', v_any_enabled)
  on conflict (subscription_id, category_key) do update
  set enabled = excluded.enabled, updated_at = transaction_timestamp();

  return jsonb_build_object('outcome', 'updated', 'enabled', p_enabled);
end;
$function$;

create function public.push_subscription_allows_event(
  p_subscription_id uuid,
  p_event_type text,
  p_category_key text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_cycle public.push_cycle_preferences%rowtype;
  v_category_enabled boolean;
begin
  select preference.enabled into v_category_enabled
  from public.push_subscription_preferences preference
  where preference.subscription_id = p_subscription_id
    and preference.category_key = p_category_key;
  if not coalesce(v_category_enabled, false) then return false; end if;
  if p_category_key <> 'cycles_voting' then return true; end if;

  select * into v_cycle from public.push_cycle_preferences
  where subscription_id = p_subscription_id;
  if not found then return false; end if;

  return case p_event_type
    when 'cycle_started' then v_cycle.new_cycle_started
    when 'cycle_results_ready' then v_cycle.cycle_results_ready
    when 'cycle_submission_ended' then v_cycle.submission_phase_ends
      and not (v_cycle.remind_15_minutes or v_cycle.remind_10_minutes or v_cycle.remind_5_minutes)
    when 'cycle_voting_ended' then v_cycle.voting_phase_ends
      and not (v_cycle.remind_15_minutes or v_cycle.remind_10_minutes or v_cycle.remind_5_minutes)
    when 'cycle_submission_ending_15m' then v_cycle.submission_phase_ends and v_cycle.remind_15_minutes
    when 'cycle_submission_ending_10m' then v_cycle.submission_phase_ends and v_cycle.remind_10_minutes
    when 'cycle_submission_ending_5m' then v_cycle.submission_phase_ends and v_cycle.remind_5_minutes
    when 'cycle_voting_ending_15m' then v_cycle.voting_phase_ends and v_cycle.remind_15_minutes
    when 'cycle_voting_ending_10m' then v_cycle.voting_phase_ends and v_cycle.remind_10_minutes
    when 'cycle_voting_ending_5m' then v_cycle.voting_phase_ends and v_cycle.remind_5_minutes
    else false
  end;
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
    'wallet_issue_received', 'wallet_issue_correction_ready', 'wallet_issue_resolved'
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
    or (event_type in (
      'wallet_issue_received', 'wallet_issue_correction_ready', 'wallet_issue_resolved'
    ) and category_key = 'wallet_issues')
  );

create or replace function public.produce_cycle_results_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_public_number bigint;
  v_notification_event_type text;
  v_deep_link text;
  v_event_id uuid;
begin
  v_notification_event_type := case new.event_type
    when 'submission_phase_opened' then 'cycle_started'
    when 'voting_phase_opened' then 'cycle_submission_ended'
    when 'voting_phase_closed' then 'cycle_voting_ended'
    when 'cycle_completed' then 'cycle_results_ready'
    else null
  end;
  if v_notification_event_type is null then return new; end if;

  select cycle.public_number into v_public_number
  from public.voting_cycles cycle where cycle.id = new.cycle_id;
  if v_public_number is null then
    raise exception using errcode = '55000', message = 'NOTIFICATION_CYCLE_PUBLIC_NUMBER_UNAVAILABLE';
  end if;
  v_deep_link := case v_notification_event_type
    when 'cycle_started' then '/upload'
    when 'cycle_results_ready' then '/community-feed?cycle=' || v_public_number::text
    else '/submissions'
  end;

  insert into public.notification_events(
    producer_key, event_type, category_key, audience_type,
    public_cycle_number, deep_link, occurred_at
  ) values (
    'cycle_event:' || new.id::text, v_notification_event_type,
    'cycles_voting', 'broadcast', v_public_number, v_deep_link, new.created_at
  ) on conflict (producer_key) do nothing returning id into v_event_id;
  if v_event_id is null then
    select id into strict v_event_id from public.notification_events
    where producer_key = 'cycle_event:' || new.id::text;
  end if;
  insert into public.notification_broadcast_jobs(event_id)
  values (v_event_id) on conflict (event_id) do nothing;
  return new;
end;
$function$;

create function public.produce_due_cycle_push_notifications()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_cycle record;
  v_lead integer;
  v_event_type text;
  v_event_id uuid;
  v_count integer := 0;
begin
  for v_cycle in
    select cycle.id, cycle.public_number, cycle.status::text as status,
      case when cycle.status::text = 'submission_open'
        then cycle.submission_ends_at else cycle.voting_ends_at end as deadline_at
    from public.voting_cycles cycle
    where (cycle.status::text = 'submission_open' and cycle.submission_ends_at is not null)
       or (cycle.status::text = 'voting_open' and cycle.voting_ends_at is not null)
  loop
    if v_cycle.deadline_at <= transaction_timestamp() then continue; end if;
    foreach v_lead in array array[15, 10, 5]
    loop
      if transaction_timestamp() >= v_cycle.deadline_at - make_interval(mins => v_lead) then
        v_event_type := 'cycle_' || case when v_cycle.status = 'submission_open'
          then 'submission' else 'voting' end || '_ending_' || v_lead::text || 'm';
        insert into public.notification_events(
          producer_key, event_type, category_key, audience_type,
          public_cycle_number, deep_link, occurred_at
        ) values (
          'cycle-reminder:' || v_cycle.id::text || ':' ||
            extract(epoch from v_cycle.deadline_at)::bigint::text || ':' || v_lead::text,
          v_event_type, 'cycles_voting', 'broadcast', v_cycle.public_number,
          case when v_cycle.status = 'submission_open' then '/upload' else '/submissions' end,
          transaction_timestamp()
        ) on conflict (producer_key) do nothing returning id into v_event_id;
        if v_event_id is not null then
          insert into public.notification_broadcast_jobs(event_id) values (v_event_id);
          v_count := v_count + 1;
        end if;
      end if;
    end loop;
  end loop;
  return jsonb_build_object('outcome', 'processed', 'created', v_count);
end;
$function$;

create function public.produce_winner_payout_sent_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_claim_id uuid;
begin
  select allocation.winner_discord_user_id, claim.id
  into v_owner_id, v_claim_id
  from public.payout_plans plan
  join public.cycle_prize_allocations allocation on allocation.id = plan.allocation_id
  join public.winner_claims claim on claim.id = allocation.claim_id
  where plan.public_id = new.target_public_id
    and allocation.winner_lamports > 0;
  if not found then return new; end if;
  perform public.enqueue_account_notification_event(
    'winner-payout-sent:' || new.id::text,
    'winner_payout_sent', 'winners_claims', v_owner_id,
    '/my-profile/winnings/' || v_claim_id::text,
    public.resolve_account_notification_visibility(v_owner_id, 'winners_claims')
  );
  return new;
end;
$function$;

create trigger payout_events_produce_winner_payout_sent_notification
after insert on public.payout_events
for each row when (new.event_type = 'plan_published' and new.target_type = 'plan')
execute function public.produce_winner_payout_sent_notification();

create or replace function public.process_notification_broadcast_batch(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_job public.notification_broadcast_jobs%rowtype;
  v_event public.notification_events%rowtype;
  v_owner record;
  v_notification_id uuid;
  v_count integer := 0;
begin
  if p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'NOTIFICATION_BROADCAST_LIMIT_INVALID';
  end if;
  select * into v_job from public.notification_broadcast_jobs
  where status = 'pending' order by updated_at, event_id
  for update skip locked limit 1;
  if not found then return jsonb_build_object('outcome', 'idle', 'processed', 0); end if;
  select * into strict v_event from public.notification_events where id = v_job.event_id;

  for v_owner in
    select candidate.owner_discord_user_id,
      bool_or(candidate.in_product_enabled) as in_product_enabled
    from (
      select distinct session_row.discord_user_id as owner_discord_user_id,
        true as in_product_enabled
      from public.sessions session_row
      join public.user_logs user_row on user_row.discord_user_id = session_row.discord_user_id
        and not user_row.is_banned
      left join public.discord_member_state discord_row
        on discord_row.discord_user_id = session_row.discord_user_id
      join public.notification_category_catalog category
        on category.category_key = v_event.category_key and category.is_active
        and category.in_product_available
      left join public.account_notification_preferences preference
        on preference.owner_discord_user_id = session_row.discord_user_id
        and preference.category_key = category.category_key
      where session_row.revoked_at is null
        and not coalesce(discord_row.discord_ban_active, false)
        and coalesce(preference.in_product_enabled, category.default_in_product_enabled)
        and v_event.event_type = 'cycle_results_ready'
      union all
      select subscription.owner_discord_user_id, false
      from public.push_subscriptions subscription
      join public.sessions session_row
        on session_row.id = subscription.session_id and session_row.revoked_at is null
      join public.notification_category_catalog category
        on category.category_key = v_event.category_key
        and category.is_active and category.push_available
      where subscription.is_active
        and public.push_subscription_allows_event(
          subscription.id, v_event.event_type, v_event.category_key
        )
    ) candidate
    where v_job.last_owner_discord_user_id is null
      or candidate.owner_discord_user_id > v_job.last_owner_discord_user_id
    group by candidate.owner_discord_user_id
    order by candidate.owner_discord_user_id
    limit p_limit
  loop
    insert into public.account_notifications(event_id, owner_discord_user_id, visible_in_product)
    values (v_event.id, v_owner.owner_discord_user_id, v_owner.in_product_enabled)
    on conflict (event_id, owner_discord_user_id) do update
    set visible_in_product = public.account_notifications.visible_in_product
      or excluded.visible_in_product
    returning id into v_notification_id;

    insert into public.push_delivery_jobs(event_id, notification_id, subscription_id)
    select v_event.id, v_notification_id, subscription.id
    from public.push_subscriptions subscription
    join public.sessions session_row
      on session_row.id = subscription.session_id and session_row.revoked_at is null
    join public.notification_category_catalog category
      on category.category_key = v_event.category_key
      and category.is_active and category.push_available
    where subscription.owner_discord_user_id = v_owner.owner_discord_user_id
      and subscription.is_active
      and public.push_subscription_allows_event(
        subscription.id, v_event.event_type, v_event.category_key
      )
    on conflict (event_id, subscription_id) do nothing;

    v_job.last_owner_discord_user_id := v_owner.owner_discord_user_id;
    v_count := v_count + 1;
  end loop;

  update public.notification_broadcast_jobs
  set last_owner_discord_user_id = v_job.last_owner_discord_user_id,
      processed_owner_count = processed_owner_count + v_count,
      status = case when v_count < p_limit then 'completed' else 'pending' end,
      completed_at = case when v_count < p_limit then transaction_timestamp() else null end,
      updated_at = transaction_timestamp()
  where event_id = v_job.event_id;
  return jsonb_build_object(
    'outcome', case when v_count < p_limit then 'completed' else 'pending' end,
    'processed', v_count
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
declare v_owner_id text; v_items jsonb;
begin
  if p_limit not between 1 and 50 or ((p_before_created_at is null) <> (p_before_id is null)) then
    raise exception using errcode = '22023', message = 'NOTIFICATION_PAGE_INPUT_INVALID';
  end if;
  v_owner_id := public.require_account_session(p_session_id);
  select coalesce(jsonb_agg(item.payload order by item.created_at desc, item.id desc), '[]'::jsonb)
  into v_items from (
    select notification.created_at, notification.id, jsonb_build_object(
      'id', notification.id, 'categoryKey', event.category_key, 'eventType', event.event_type,
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
        else 'Cycle results are ready' end,
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
        else 'View the finalized Cycle results.' end),
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
        else 'View results' end,
      'createdAt', notification.created_at, 'readAt', notification.read_at
    ) payload
    from public.account_notifications notification
    join public.notification_events event on event.id = notification.event_id
    where notification.owner_discord_user_id = v_owner_id
      and notification.visible_in_product
      and (notification.read_at is null or notification.read_at > transaction_timestamp() - interval '3 days')
      and (p_before_created_at is null
        or (notification.created_at, notification.id) < (p_before_created_at, p_before_id))
    order by notification.created_at desc, notification.id desc limit p_limit + 1
  ) item;
  return jsonb_build_object('items', v_items);
end;
$function$;

alter function public.get_own_push_subscription_settings(uuid,uuid) owner to postgres;
alter function public.set_own_push_cycle_preference(uuid,uuid,text,boolean) owner to postgres;
alter function public.push_subscription_allows_event(uuid,text,text) owner to postgres;
alter function public.produce_cycle_results_notification() owner to postgres;
alter function public.produce_due_cycle_push_notifications() owner to postgres;
alter function public.produce_winner_payout_sent_notification() owner to postgres;
alter function public.process_notification_broadcast_batch(integer) owner to postgres;
alter function public.get_own_notifications(uuid,timestamptz,uuid,integer) owner to postgres;

revoke all on function public.set_own_push_cycle_preference(uuid,uuid,text,boolean)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.push_subscription_allows_event(uuid,text,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.produce_due_cycle_push_notifications()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.produce_winner_payout_sent_notification()
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.set_own_push_cycle_preference(uuid,uuid,text,boolean)
  to service_role;
grant execute on function public.produce_due_cycle_push_notifications()
  to service_role;

comment on table public.push_cycle_preferences is
  'Per-device Web Push choices for Cycle events. Lead times are independently combinable and shared by the enabled phase-end choices.';
comment on function public.produce_due_cycle_push_notifications() is
  'Idempotently queues all crossed 15, 10, and 5 minute Cycle phase reminder events. Per-device filtering happens during broadcast expansion.';

do $postflight$
begin
  if not exists (
      select 1 from pg_trigger where tgrelid = 'public.payout_events'::regclass
        and tgname = 'payout_events_produce_winner_payout_sent_notification'
        and not tgisinternal and tgenabled = 'O'
    )
    or position('winner_payout_sent' in pg_get_constraintdef(
      (select oid from pg_constraint where conrelid = 'public.notification_events'::regclass
        and conname = 'notification_event_type_check')
    )) = 0
    or not has_function_privilege('service_role',
      'public.set_own_push_cycle_preference(uuid,uuid,text,boolean)', 'EXECUTE')
    or has_function_privilege('authenticated',
      'public.set_own_push_cycle_preference(uuid,uuid,text,boolean)', 'EXECUTE')
    or not has_function_privilege('service_role',
      'public.produce_due_cycle_push_notifications()', 'EXECUTE')
    or has_function_privilege('authenticated',
      'public.produce_due_cycle_push_notifications()', 'EXECUTE')
  then
    raise exception using errcode = '55000',
      message = 'CYCLE_PUSH_PREFERENCES_POSTFLIGHT_FAILED';
  end if;
end;
$postflight$;

commit;

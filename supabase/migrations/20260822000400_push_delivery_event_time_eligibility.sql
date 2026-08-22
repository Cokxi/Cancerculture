begin;

do $baseline$
begin
  if to_regprocedure('public.push_subscription_allows_event(uuid,text,text)') is null
    or to_regprocedure('public.push_subscription_allows_event_at(uuid,text,text,timestamp with time zone)') is not null
    or to_regprocedure('public.process_notification_broadcast_batch(integer)') is null
    or to_regprocedure('public.claim_due_push_deliveries(uuid,integer)') is null
  then
    raise exception using errcode = '55000',
      message = 'PUSH_EVENT_TIME_ELIGIBILITY_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

create function public.push_subscription_allows_event_at(
  p_subscription_id uuid,
  p_event_type text,
  p_category_key text,
  p_event_occurred_at timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_timing_eligible boolean;
begin
  if p_event_occurred_at is null
    or not public.push_subscription_allows_event(
      p_subscription_id, p_event_type, p_category_key
    )
  then
    return false;
  end if;

  select subscription.created_at <= p_event_occurred_at
    and preference.updated_at <= p_event_occurred_at
    and (
      p_category_key <> 'cycles_voting'
      or cycle.updated_at <= p_event_occurred_at
    )
  into v_timing_eligible
  from public.push_subscriptions subscription
  join public.push_subscription_preferences preference
    on preference.subscription_id = subscription.id
   and preference.category_key = p_category_key
  left join public.push_cycle_preferences cycle
    on cycle.subscription_id = subscription.id
  where subscription.id = p_subscription_id;

  return coalesce(v_timing_eligible, false);
end;
$function$;

create or replace function public.process_notification_broadcast_batch(
  p_limit integer default 100
)
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
        and public.push_subscription_allows_event_at(
          subscription.id, v_event.event_type, v_event.category_key,
          v_event.occurred_at
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
      and public.push_subscription_allows_event_at(
        subscription.id, v_event.event_type, v_event.category_key,
        v_event.occurred_at
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

create or replace function public.claim_due_push_deliveries(
  p_worker_token uuid,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_items jsonb;
begin
  if p_worker_token is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'PUSH_CLAIM_INPUT_INVALID';
  end if;

  update public.push_delivery_jobs job
  set status = 'failed_permanent', lease_token = null, lease_expires_at = null,
      terminal_at = transaction_timestamp(), last_error_code = 'retry_limit',
      updated_at = transaction_timestamp()
  where job.status = 'processing'
    and job.lease_expires_at <= transaction_timestamp()
    and job.attempt_count >= job.max_attempts;

  update public.push_delivery_jobs job
  set status = 'pending', lease_token = null, lease_expires_at = null,
      available_at = transaction_timestamp(), last_error_code = 'lease_expired',
      updated_at = transaction_timestamp()
  where job.status = 'processing'
    and job.lease_expires_at <= transaction_timestamp()
    and job.attempt_count < job.max_attempts;

  update public.push_delivery_jobs job
  set status = 'failed_permanent', terminal_at = transaction_timestamp(),
      last_error_code = 'subscription_inactive', updated_at = transaction_timestamp()
  where job.status = 'pending'
    and exists (
      select 1
      from public.push_subscriptions subscription
      left join public.sessions session_row on session_row.id = subscription.session_id
      where subscription.id = job.subscription_id
        and (not subscription.is_active or session_row.revoked_at is not null)
    );

  update public.push_delivery_jobs job
  set status = 'failed_permanent', lease_token = null, lease_expires_at = null,
      terminal_at = transaction_timestamp(), last_error_code = 'event_not_eligible',
      updated_at = transaction_timestamp()
  from public.notification_events event
  where job.event_id = event.id
    and job.status = 'pending'
    and not public.push_subscription_allows_event_at(
      job.subscription_id, event.event_type, event.category_key,
      event.occurred_at
    );

  with due as (
    select job.id
    from public.push_delivery_jobs job
    join public.push_subscriptions subscription
      on subscription.id = job.subscription_id and subscription.is_active
    join public.sessions session_row
      on session_row.id = subscription.session_id and session_row.revoked_at is null
    where job.status = 'pending'
      and job.available_at <= transaction_timestamp()
      and not exists (
        select 1 from public.push_delivery_jobs leased
        where leased.subscription_id = job.subscription_id
          and leased.status = 'processing'
      )
      and job.id = (
        select candidate.id
        from public.push_delivery_jobs candidate
        where candidate.subscription_id = job.subscription_id
          and candidate.status = 'pending'
          and candidate.available_at <= transaction_timestamp()
        order by candidate.available_at, candidate.id
        limit 1
      )
    order by job.available_at, job.id
    for update of job skip locked
    limit p_limit
  ), claimed as (
    update public.push_delivery_jobs job
    set status = 'processing',
        attempt_count = attempt_count + 1,
        lease_token = p_worker_token,
        lease_expires_at = transaction_timestamp() + interval '2 minutes',
        updated_at = transaction_timestamp()
    from due
    where job.id = due.id
    returning job.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'jobId', claimed.id,
    'leaseToken', claimed.lease_token,
    'subscriptionId', subscription.id,
    'ciphertext', subscription.subscription_ciphertext,
    'nonce', subscription.subscription_nonce,
    'tag', subscription.subscription_tag,
    'keyVersion', subscription.key_version,
    'categoryKey', event.category_key,
    'eventType', event.event_type,
    'notificationId', claimed.notification_id,
    'attemptCount', claimed.attempt_count,
    'maxAttempts', claimed.max_attempts
  ) order by claimed.id), '[]'::jsonb)
  into v_items
  from claimed
  join public.push_subscriptions subscription on subscription.id = claimed.subscription_id
  join public.notification_events event on event.id = claimed.event_id;
  return jsonb_build_object('items', v_items);
end;
$function$;

alter function public.push_subscription_allows_event_at(uuid,text,text,timestamptz) owner to postgres;
alter function public.process_notification_broadcast_batch(integer) owner to postgres;
alter function public.claim_due_push_deliveries(uuid,integer) owner to postgres;

revoke all on function public.push_subscription_allows_event_at(uuid,text,text,timestamptz)
  from public, anon, authenticated, discord_bot, service_role;

do $postflight$
begin
  if not exists (
      select 1 from pg_proc function_row
      join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
      where namespace_row.nspname = 'public'
        and function_row.oid = 'public.push_subscription_allows_event_at(uuid,text,text,timestamp with time zone)'::regprocedure
        and function_row.prosecdef
        and function_row.proconfig = array['search_path=public, pg_temp']
    )
    or has_function_privilege('service_role',
      'public.push_subscription_allows_event_at(uuid,text,text,timestamp with time zone)', 'EXECUTE')
    or position('event_not_eligible' in pg_get_functiondef(
      'public.claim_due_push_deliveries(uuid,integer)'::regprocedure
    )) = 0
  then
    raise exception using errcode = '55000',
      message = 'PUSH_EVENT_TIME_ELIGIBILITY_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;

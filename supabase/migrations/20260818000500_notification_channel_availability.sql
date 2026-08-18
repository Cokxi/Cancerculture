begin;

do $baseline$
begin
  if to_regclass('public.notification_category_catalog') is null
    or to_regprocedure('public.resolve_account_notification_visibility(text,text)') is null
    or to_regprocedure('public.get_own_notification_settings(uuid)') is null
    or to_regprocedure('public.get_own_push_subscription_settings(uuid,uuid)') is null
    or to_regprocedure('public.set_own_push_subscription_preference(uuid,uuid,text,boolean)') is null
    or to_regprocedure('public.process_notification_broadcast_batch(integer)') is null
    or exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'notification_category_catalog'
        and column_name in ('in_product_available', 'push_available')
    )
    or not exists (
      select 1
      from public.notification_category_catalog
      where category_key = 'cycles_voting'
        and is_active
        and default_in_product_enabled
    )
    or (select count(*) from public.capability_catalog) <> 39
    or (select count(*) from public.capability_catalog where is_active) <> 35
  then
    raise exception using
      errcode = '55000',
      message = 'NOTIFICATION_CHANNEL_AVAILABILITY_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

alter table public.notification_category_catalog
  add column in_product_available boolean not null default true,
  add column push_available boolean not null default true;

update public.notification_category_catalog
set in_product_available = false,
    default_in_product_enabled = false,
    push_available = true,
    description = 'Get Push updates when a Cycle phase changes or results are ready.'
where category_key = 'cycles_voting';

create or replace function public.resolve_account_notification_visibility(
  p_owner_discord_user_id text,
  p_category_key text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select category.in_product_available
    and coalesce(preference.in_product_enabled, category.default_in_product_enabled)
  from public.notification_category_catalog category
  left join public.account_notification_preferences preference
    on preference.owner_discord_user_id = p_owner_discord_user_id
   and preference.category_key = category.category_key
  where category.category_key = p_category_key
    and category.is_active;
$function$;

create or replace function public.get_own_notification_settings(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_categories jsonb;
begin
  v_owner_id := public.require_account_session(p_session_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'categoryKey', category.category_key,
    'displayName', category.display_name,
    'description', category.description,
    'requiredInProduct', false,
    'inProductEnabled', coalesce(
      preference.in_product_enabled,
      category.default_in_product_enabled
    )
  ) order by category.category_key), '[]'::jsonb)
  into v_categories
  from public.notification_category_catalog category
  left join public.account_notification_preferences preference
    on preference.owner_discord_user_id = v_owner_id
   and preference.category_key = category.category_key
  where category.is_active
    and category.in_product_available;
  return jsonb_build_object('categories', v_categories);
end;
$function$;

create or replace function public.set_own_notification_preference(
  p_session_id uuid,
  p_category_key text,
  p_in_product_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
begin
  v_owner_id := public.require_account_session(p_session_id);
  if not exists (
    select 1 from public.notification_category_catalog
    where category_key = p_category_key
      and is_active
      and in_product_available
  ) then
    raise exception using errcode = '22023', message = 'NOTIFICATION_CATEGORY_INVALID';
  end if;
  insert into public.account_notification_preferences (
    owner_discord_user_id, category_key, in_product_enabled
  ) values (v_owner_id, p_category_key, p_in_product_enabled)
  on conflict (owner_discord_user_id, category_key) do update
  set in_product_enabled = excluded.in_product_enabled,
      updated_at = transaction_timestamp();
  return jsonb_build_object(
    'outcome', 'updated',
    'categoryKey', p_category_key,
    'inProductEnabled', p_in_product_enabled
  );
end;
$function$;

create or replace function public.upsert_own_push_subscription(
  p_session_id uuid,
  p_device_id uuid,
  p_endpoint_fingerprint text,
  p_subscription_ciphertext text,
  p_subscription_nonce text,
  p_subscription_tag text,
  p_key_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_subscription_id uuid;
begin
  if p_device_id is null
    or p_endpoint_fingerprint !~ '^[a-f0-9]{64}$'
    or char_length(p_subscription_ciphertext) not between 24 and 16384
    or char_length(p_subscription_nonce) not between 12 and 128
    or char_length(p_subscription_tag) not between 12 and 128
    or p_key_version not between 1 and 1000
  then
    raise exception using errcode = '22023', message = 'PUSH_SUBSCRIPTION_INPUT_INVALID';
  end if;

  v_owner_id := public.require_account_session(p_session_id);
  perform pg_advisory_xact_lock(hashtextextended('push-device:' || p_device_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('push-endpoint:' || p_endpoint_fingerprint, 0));

  select id into v_subscription_id
  from public.push_subscriptions
  where owner_discord_user_id = v_owner_id
    and device_id = p_device_id
    and endpoint_fingerprint = p_endpoint_fingerprint
    and is_active
  for update;

  if found then
    update public.push_subscriptions
    set session_id = p_session_id,
        subscription_ciphertext = p_subscription_ciphertext,
        subscription_nonce = p_subscription_nonce,
        subscription_tag = p_subscription_tag,
        key_version = p_key_version,
        updated_at = transaction_timestamp()
    where id = v_subscription_id;
  else
    update public.push_subscriptions
    set is_active = false,
        deactivated_at = transaction_timestamp(),
        updated_at = transaction_timestamp()
    where is_active
      and (
        (owner_discord_user_id = v_owner_id and device_id = p_device_id)
        or endpoint_fingerprint = p_endpoint_fingerprint
      );

    insert into public.push_subscriptions (
      owner_discord_user_id, session_id, device_id, endpoint_fingerprint,
      subscription_ciphertext, subscription_nonce, subscription_tag, key_version
    ) values (
      v_owner_id, p_session_id, p_device_id, p_endpoint_fingerprint,
      p_subscription_ciphertext, p_subscription_nonce, p_subscription_tag, p_key_version
    ) returning id into v_subscription_id;

    insert into public.push_subscription_preferences (
      subscription_id, category_key, enabled
    )
    select v_subscription_id, category.category_key, false
    from public.notification_category_catalog category
    where category.is_active
      and category.push_available;
  end if;

  return jsonb_build_object('outcome', 'active', 'subscriptionId', v_subscription_id);
end;
$function$;

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

  if v_subscription_id is null then
    return jsonb_build_object('active', false, 'categories', '[]'::jsonb);
  end if;

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
  where category.is_active
    and category.push_available;
  return jsonb_build_object('active', true, 'categories', v_categories);
end;
$function$;

create or replace function public.set_own_push_subscription_preference(
  p_session_id uuid,
  p_device_id uuid,
  p_category_key text,
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
begin
  v_owner_id := public.require_account_session(p_session_id);
  if not exists (
    select 1 from public.notification_category_catalog
    where category_key = p_category_key
      and is_active
      and push_available
  ) then
    raise exception using errcode = '22023', message = 'NOTIFICATION_CATEGORY_INVALID';
  end if;
  select id into v_subscription_id
  from public.push_subscriptions
  where owner_discord_user_id = v_owner_id
    and device_id = p_device_id
    and session_id = p_session_id
    and is_active
  for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  insert into public.push_subscription_preferences (
    subscription_id, category_key, enabled
  ) values (v_subscription_id, p_category_key, p_enabled)
  on conflict (subscription_id, category_key) do update
  set enabled = excluded.enabled, updated_at = transaction_timestamp();
  return jsonb_build_object('outcome', 'updated', 'enabled', p_enabled);
end;
$function$;

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
  select * into v_job
  from public.notification_broadcast_jobs
  where status = 'pending'
  order by updated_at, event_id
  for update skip locked
  limit 1;
  if not found then
    return jsonb_build_object('outcome', 'idle', 'processed', 0);
  end if;
  select * into strict v_event from public.notification_events where id = v_job.event_id;

  for v_owner in
    select candidate.owner_discord_user_id,
      bool_or(candidate.in_product_enabled) as in_product_enabled
    from (
      select distinct session_row.discord_user_id as owner_discord_user_id, true as in_product_enabled
      from public.sessions session_row
      join public.user_logs user_row
        on user_row.discord_user_id = session_row.discord_user_id
       and not user_row.is_banned
      left join public.discord_member_state discord_row
        on discord_row.discord_user_id = session_row.discord_user_id
      join public.notification_category_catalog category
        on category.category_key = v_event.category_key
       and category.is_active
       and category.in_product_available
      left join public.account_notification_preferences preference
        on preference.owner_discord_user_id = session_row.discord_user_id
       and preference.category_key = category.category_key
      where session_row.revoked_at is null
        and not coalesce(discord_row.discord_ban_active, false)
        and coalesce(preference.in_product_enabled, category.default_in_product_enabled)
      union all
      select subscription.owner_discord_user_id, false
      from public.push_subscriptions subscription
      join public.sessions session_row
        on session_row.id = subscription.session_id and session_row.revoked_at is null
      join public.push_subscription_preferences preference
        on preference.subscription_id = subscription.id
       and preference.category_key = v_event.category_key
       and preference.enabled
      join public.notification_category_catalog category
        on category.category_key = preference.category_key
       and category.is_active
       and category.push_available
      where subscription.is_active
    ) candidate
    where v_job.last_owner_discord_user_id is null
      or candidate.owner_discord_user_id > v_job.last_owner_discord_user_id
    group by candidate.owner_discord_user_id
    order by candidate.owner_discord_user_id
    limit p_limit
  loop
    insert into public.account_notifications (
      event_id, owner_discord_user_id, visible_in_product
    ) values (
      v_event.id, v_owner.owner_discord_user_id, v_owner.in_product_enabled
    )
    on conflict (event_id, owner_discord_user_id) do update
    set visible_in_product = public.account_notifications.visible_in_product
      or excluded.visible_in_product
    returning id into v_notification_id;

    insert into public.push_delivery_jobs (event_id, notification_id, subscription_id)
    select v_event.id, v_notification_id, subscription.id
    from public.push_subscriptions subscription
    join public.sessions session_row
      on session_row.id = subscription.session_id and session_row.revoked_at is null
    join public.push_subscription_preferences preference
      on preference.subscription_id = subscription.id
     and preference.category_key = v_event.category_key
     and preference.enabled
    join public.notification_category_catalog category
      on category.category_key = preference.category_key
     and category.is_active
     and category.push_available
    where subscription.owner_discord_user_id = v_owner.owner_discord_user_id
      and subscription.is_active
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

alter function public.resolve_account_notification_visibility(text,text) owner to postgres;
alter function public.get_own_notification_settings(uuid) owner to postgres;
alter function public.set_own_notification_preference(uuid,text,boolean) owner to postgres;
alter function public.upsert_own_push_subscription(uuid,uuid,text,text,text,text,integer) owner to postgres;
alter function public.get_own_push_subscription_settings(uuid,uuid) owner to postgres;
alter function public.set_own_push_subscription_preference(uuid,uuid,text,boolean) owner to postgres;
alter function public.process_notification_broadcast_batch(integer) owner to postgres;

do $postflight$
declare
  v_signature regprocedure;
begin
  if not exists (
      select 1
      from public.notification_category_catalog
      where category_key = 'cycles_voting'
        and is_active
        and not in_product_available
        and not default_in_product_enabled
        and push_available
    )
    or (select count(*) from public.notification_category_catalog where in_product_available) <> 2
    or (select count(*) from public.notification_category_catalog where push_available) <> 3
  then
    raise exception using
      errcode = '55000',
      message = 'NOTIFICATION_CHANNEL_AVAILABILITY_POSTFLIGHT_MISMATCH';
  end if;

  foreach v_signature in array array[
    'public.resolve_account_notification_visibility(text,text)'::regprocedure,
    'public.get_own_notification_settings(uuid)'::regprocedure,
    'public.set_own_notification_preference(uuid,text,boolean)'::regprocedure,
    'public.upsert_own_push_subscription(uuid,uuid,text,text,text,text,integer)'::regprocedure,
    'public.get_own_push_subscription_settings(uuid,uuid)'::regprocedure,
    'public.set_own_push_subscription_preference(uuid,uuid,text,boolean)'::regprocedure,
    'public.process_notification_broadcast_batch(integer)'::regprocedure
  ] loop
    if exists (
      select 1
      from pg_proc function_row
      where function_row.oid = v_signature
        and (
          not function_row.prosecdef
          or pg_get_userbyid(function_row.proowner) <> 'postgres'
          or function_row.proconfig is distinct from array['search_path=public, pg_temp']::text[]
        )
    ) then
      raise exception using
        errcode = '55000',
        message = 'NOTIFICATION_CHANNEL_AVAILABILITY_FUNCTION_HARDENING_MISMATCH';
    end if;
  end loop;
end;
$postflight$;

commit;

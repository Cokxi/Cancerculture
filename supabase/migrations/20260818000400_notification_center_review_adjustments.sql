begin;

do $baseline$
begin
  if to_regclass('public.notification_category_catalog') is null
    or to_regclass('public.account_notifications') is null
    or to_regclass('public.team_inbox_topic_catalog') is null
    or to_regprocedure('public.get_own_notifications(uuid,timestamptz,uuid,integer)') is null
    or to_regprocedure('public.get_own_notification_settings(uuid)') is null
    or to_regprocedure('public.get_own_push_subscription_settings(uuid,uuid)') is null
    or to_regprocedure('public.process_notification_broadcast_batch(integer)') is null
    or to_regprocedure('public.mark_all_own_notifications_read(uuid)') is not null
    or exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'notification_category_catalog'
        and column_name in ('description', 'default_in_product_enabled')
    )
    or (select count(*) from public.notification_category_catalog) <> 3
    or (select count(*) from public.notification_category_catalog where is_active) <> 3
    or (select count(*) from public.capability_catalog) <> 39
    or (select count(*) from public.capability_catalog where is_active) <> 35
  then
    raise exception using
      errcode = '55000',
      message = 'NOTIFICATION_CENTER_REVIEW_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

alter table public.notification_category_catalog
  add column description text,
  add column default_in_product_enabled boolean not null default true;

update public.notification_category_catalog
set required_in_product = false,
    default_in_product_enabled = true,
    description = case category_key
      when 'winners_claims'
        then 'Get updates when a win is finalized or requires your confirmation.'
      when 'submission_moderation'
        then 'Get updates when one of your Submissions is disqualified or restored.'
      when 'cycles_voting'
        then 'Get updates when a Cycle phase changes or results are ready.'
      else null
    end;

alter table public.notification_category_catalog
  alter column description set not null,
  add constraint notification_category_description_check
    check (char_length(description) between 12 and 180);

create function public.resolve_account_notification_visibility(
  p_owner_discord_user_id text,
  p_category_key text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select coalesce(preference.in_product_enabled, category.default_in_product_enabled)
  from public.notification_category_catalog category
  left join public.account_notification_preferences preference
    on preference.owner_discord_user_id = p_owner_discord_user_id
   and preference.category_key = category.category_key
  where category.category_key = p_category_key
    and category.is_active;
$function$;

create or replace function public.produce_winner_claim_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  perform public.enqueue_account_notification_event(
    'winner_claim:' || new.id::text,
    case when new.status = 'not_required'
      then 'winner_donation_finalized'
      else 'winner_claim_required'
    end,
    'winners_claims',
    new.winner_discord_user_id,
    '/my-profile/winnings/' || new.id::text,
    coalesce(public.resolve_account_notification_visibility(
      new.winner_discord_user_id, 'winners_claims'
    ), false)
  );
  return new;
end;
$function$;

create or replace function public.produce_submission_moderation_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  perform public.enqueue_account_notification_event(
    'submission_disqualification_event:' || new.id::text,
    case when new.transition = 'disqualified'
      then 'submission_disqualified'
      else 'submission_reinstated'
    end,
    'submission_moderation',
    new.subject_discord_user_id,
    '/my-profile/disqualifications',
    coalesce(public.resolve_account_notification_visibility(
      new.subject_discord_user_id, 'submission_moderation'
    ), false)
  );
  return new;
end;
$function$;

create or replace function public.get_own_notification_unread_count(p_session_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_count bigint;
begin
  v_owner_id := public.require_account_session(p_session_id);
  select count(*) into v_count
  from public.account_notifications notification
  where notification.owner_discord_user_id = v_owner_id
    and notification.visible_in_product
    and notification.read_at is null;
  return least(v_count, 999);
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
  select coalesce(jsonb_agg(item.payload order by item.created_at desc, item.id desc), '[]'::jsonb)
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
          when 'winner_donation_finalized' then 'Winner result finalized'
          when 'submission_disqualified' then 'Submission disqualified'
          when 'submission_reinstated' then 'Submission restored'
          else 'Cycle results are ready'
        end,
        'body', case event.event_type
          when 'winner_claim_required' then 'Review and confirm your winner claim.'
          when 'winner_donation_finalized' then 'View your finalized winner result.'
          when 'submission_disqualified' then 'View your moderation history for details.'
          when 'submission_reinstated' then 'View your moderation history for details.'
          else 'View the finalized Cycle results.'
        end,
        'actionLabel', case event.event_type
          when 'winner_claim_required' then 'Review claim'
          when 'winner_donation_finalized' then 'View result'
          when 'submission_disqualified' then 'View details'
          when 'submission_reinstated' then 'View details'
          else 'View results'
        end,
        'createdAt', notification.created_at,
        'readAt', notification.read_at
      ) as payload
    from public.account_notifications notification
    join public.notification_events event on event.id = notification.event_id
    where notification.owner_discord_user_id = v_owner_id
      and notification.visible_in_product
      and (
        notification.read_at is null
        or notification.read_at > transaction_timestamp() - interval '3 days'
      )
      and (
        p_before_created_at is null
        or (notification.created_at, notification.id) < (p_before_created_at, p_before_id)
      )
    order by notification.created_at desc, notification.id desc
    limit p_limit + 1
  ) item;
  return jsonb_build_object('items', v_items);
end;
$function$;

create function public.mark_all_own_notifications_read(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_read_at timestamptz := transaction_timestamp();
  v_updated integer;
begin
  v_owner_id := public.require_account_session(p_session_id);
  update public.account_notifications notification
  set read_at = v_read_at
  where notification.owner_discord_user_id = v_owner_id
    and notification.visible_in_product
    and notification.read_at is null;
  get diagnostics v_updated = row_count;
  return jsonb_build_object(
    'outcome', 'read',
    'updatedCount', v_updated,
    'readAt', v_read_at
  );
end;
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
  where category.is_active;
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
    where category_key = p_category_key and is_active
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
  where category.is_active;
  return jsonb_build_object('active', true, 'categories', v_categories);
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
alter function public.produce_winner_claim_notification() owner to postgres;
alter function public.produce_submission_moderation_notification() owner to postgres;
alter function public.get_own_notification_unread_count(uuid) owner to postgres;
alter function public.get_own_notifications(uuid,timestamptz,uuid,integer) owner to postgres;
alter function public.mark_all_own_notifications_read(uuid) owner to postgres;
alter function public.get_own_notification_settings(uuid) owner to postgres;
alter function public.set_own_notification_preference(uuid,text,boolean) owner to postgres;
alter function public.get_own_push_subscription_settings(uuid,uuid) owner to postgres;
alter function public.process_notification_broadcast_batch(integer) owner to postgres;

revoke all on function public.resolve_account_notification_visibility(text,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.mark_all_own_notifications_read(uuid)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.mark_all_own_notifications_read(uuid) to service_role;

do $postflight$
declare
  v_signature regprocedure;
begin
  if not exists (
      select 1
      from public.notification_category_catalog
      where category_key = 'winners_claims'
        and not required_in_product
        and default_in_product_enabled
        and description = 'Get updates when a win is finalized or requires your confirmation.'
    )
    or not exists (
      select 1
      from public.notification_category_catalog
      where category_key = 'submission_moderation'
        and not required_in_product
        and default_in_product_enabled
    )
    or not exists (
      select 1
      from public.notification_category_catalog
      where category_key = 'cycles_voting'
        and not required_in_product
        and default_in_product_enabled
    )
    or to_regprocedure('public.mark_all_own_notifications_read(uuid)') is null
  then
    raise exception using
      errcode = '55000',
      message = 'NOTIFICATION_CENTER_REVIEW_POSTFLIGHT_MISMATCH';
  end if;

  foreach v_signature in array array[
    'public.resolve_account_notification_visibility(text,text)'::regprocedure,
    'public.produce_winner_claim_notification()'::regprocedure,
    'public.produce_submission_moderation_notification()'::regprocedure,
    'public.get_own_notification_unread_count(uuid)'::regprocedure,
    'public.get_own_notifications(uuid,timestamptz,uuid,integer)'::regprocedure,
    'public.mark_all_own_notifications_read(uuid)'::regprocedure,
    'public.get_own_notification_settings(uuid)'::regprocedure,
    'public.set_own_notification_preference(uuid,text,boolean)'::regprocedure,
    'public.get_own_push_subscription_settings(uuid,uuid)'::regprocedure,
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
        message = 'NOTIFICATION_CENTER_REVIEW_FUNCTION_HARDENING_MISMATCH';
    end if;
  end loop;

  if (
    select count(*)
    from pg_proc function_row
    join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname = 'mark_all_own_notifications_read'
  ) <> 1
    or exists (
      select 1
      from aclexplode(coalesce(
        (select function_row.proacl from pg_proc function_row
         where function_row.oid = 'public.mark_all_own_notifications_read(uuid)'::regprocedure),
        acldefault('f', (select function_row.proowner from pg_proc function_row
          where function_row.oid = 'public.mark_all_own_notifications_read(uuid)'::regprocedure))
      )) acl_row
      left join pg_roles role_row on role_row.oid = acl_row.grantee
      where acl_row.privilege_type = 'EXECUTE'
        and coalesce(role_row.rolname, 'PUBLIC') not in ('postgres', 'service_role')
    )
  then
    raise exception using
      errcode = '55000',
      message = 'NOTIFICATION_CENTER_REVIEW_ACL_MISMATCH';
  end if;
end;
$postflight$;

commit;

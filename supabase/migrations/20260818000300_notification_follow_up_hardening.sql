begin;

do $baseline$
begin
  if to_regclass('public.team_inbox_cases') is null
    or to_regclass('public.push_delivery_jobs') is null
    or to_regprocedure('public.claim_due_push_deliveries(uuid,integer)') is null
    or to_regprocedure('public.search_team_inbox_by_exact_discord_id(text,text,text,integer)') is null
    or exists (
      select 1 from pg_trigger
      where tgrelid = 'public.team_inbox_cases'::regclass
        and tgname = 'team_inbox_cases_no_delete'
        and not tgisinternal
    )
    or (select count(*) from public.capability_catalog) <> 39
    or (select count(*) from public.capability_catalog where is_active) <> 35
  then
    raise exception using
      errcode = '55000',
      message = 'NOTIFICATION_FOLLOW_UP_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

create function public.protect_team_inbox_case_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  raise exception using errcode = '55000', message = 'TEAM_INBOX_CASE_IS_PERMANENT';
end;
$function$;

create trigger team_inbox_cases_no_delete
before delete on public.team_inbox_cases
for each row execute function public.protect_team_inbox_case_delete();

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

revoke all on function public.search_team_inbox_by_exact_discord_id(text,text,text,integer)
  from public, anon, authenticated, discord_bot, service_role;
drop function public.search_team_inbox_by_exact_discord_id(text,text,text,integer);

create function public.search_team_inbox_by_exact_discord_id(
  p_actor_discord_user_id text,
  p_topic_key text,
  p_exact_discord_user_id text,
  p_before_updated_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_items jsonb;
begin
  perform public.assert_team_inbox_topic_access(
    p_actor_discord_user_id, p_topic_key, false
  );
  if p_exact_discord_user_id !~ '^[0-9]{1,100}$'
    or p_limit not between 1 and 50
    or ((p_before_updated_at is null) <> (p_before_id is null))
  then
    raise exception using errcode = '22023', message = 'TEAM_INBOX_EXACT_SEARCH_INVALID';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', case_row.id,
    'topicKey', case_row.topic_key,
    'username', case_row.subject_username_snapshot,
    'status', case_row.status,
    'assignedToMe', case_row.assignee_discord_user_id = p_actor_discord_user_id,
    'assigneeDisplayName', case_row.assignee_display_snapshot,
    'workVersion', case_row.work_version,
    'rowVersion', case_row.row_version,
    'updatedAt', case_row.updated_at
  ) order by case_row.updated_at desc, case_row.id desc), '[]'::jsonb)
  into v_items
  from (
    select * from public.team_inbox_cases
    where topic_key = p_topic_key
      and subject_discord_user_id = p_exact_discord_user_id
      and (p_before_updated_at is null
        or (updated_at, id) < (p_before_updated_at, p_before_id))
    order by updated_at desc, id desc
    limit p_limit + 1
  ) case_row;
  return jsonb_build_object('items', v_items);
end;
$function$;

alter function public.protect_team_inbox_case_delete() owner to postgres;
alter function public.claim_due_push_deliveries(uuid,integer) owner to postgres;
alter function public.search_team_inbox_by_exact_discord_id(text,text,text,timestamptz,uuid,integer) owner to postgres;

revoke all on function public.protect_team_inbox_case_delete()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.claim_due_push_deliveries(uuid,integer)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.search_team_inbox_by_exact_discord_id(text,text,text,timestamptz,uuid,integer)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.claim_due_push_deliveries(uuid,integer) to service_role;
grant execute on function public.search_team_inbox_by_exact_discord_id(text,text,text,timestamptz,uuid,integer)
  to service_role;

do $postflight$
begin
  if to_regprocedure('public.search_team_inbox_by_exact_discord_id(text,text,text,integer)') is not null
    or to_regprocedure('public.search_team_inbox_by_exact_discord_id(text,text,text,timestamp with time zone,uuid,integer)') is null
    or (select count(*) from pg_proc function_row
        join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
        where namespace_row.nspname = 'public'
          and function_row.proname = 'search_team_inbox_by_exact_discord_id') <> 1
    or not exists (
      select 1 from pg_trigger
      where tgrelid = 'public.team_inbox_cases'::regclass
        and tgname = 'team_inbox_cases_no_delete'
        and not tgisinternal
    )
    or exists (
      select 1 from pg_proc function_row
      join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
      where namespace_row.nspname = 'public'
        and function_row.proname in (
          'protect_team_inbox_case_delete',
          'claim_due_push_deliveries',
          'search_team_inbox_by_exact_discord_id'
        )
        and (not function_row.prosecdef
          or pg_get_userbyid(function_row.proowner) <> 'postgres'
          or function_row.proconfig is distinct from array['search_path=public, pg_temp']::text[])
    )
  then
    raise exception using errcode = '55000', message = 'NOTIFICATION_FOLLOW_UP_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;

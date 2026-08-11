begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
declare
  v_function regprocedure :=
    to_regprocedure('public.get_submission_upload_quota(bigint,text)');
  v_definition text;
begin
  if v_function is null
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'voting_cycles'
        and column_name = 'submissions_per_user'
        and data_type = 'integer'
        and is_nullable = 'NO'
    )
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'voting_cycles'
        and column_name = 'upload_success_cooldown_seconds'
        and data_type = 'integer'
        and is_nullable = 'NO'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'DYNAMIC_QUOTA_PROJECTION_STARTING_SCHEMA_MISMATCH';
  end if;

  select pg_get_functiondef(v_function)
  into v_definition;

  if position(
    '''cooldownRemainingSeconds'', v_cooldown_remaining'
    in v_definition
  ) = 0
    or position(
      '''nextUploadAllowedAt'', v_next_allowed_at'
      in v_definition
    ) = 0
    or position(
      'if v_used >= v_cycle.submissions_per_user then'
      in v_definition
    ) > 0
  then
    raise exception using
      errcode = '55000',
      message = 'DYNAMIC_QUOTA_PROJECTION_STARTING_FUNCTION_MISMATCH';
  end if;
end;
$preflight$;

create or replace function public.get_submission_upload_quota(
  p_cycle_id bigint,
  p_discord_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_cycle public.voting_cycles%rowtype;
  v_now timestamptz := clock_timestamp();
  v_used integer;
  v_last_completed_at timestamptz;
  v_next_allowed_at timestamptz;
  v_cooldown_remaining integer := 0;
begin
  if p_cycle_id is null
    or p_cycle_id <= 0
    or p_discord_user_id is null
    or btrim(p_discord_user_id) = ''
  then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  select cycle.*
  into v_cycle
  from public.voting_cycles cycle
  where cycle.id = p_cycle_id;

  if not found then
    return jsonb_build_object('outcome', 'cycle_not_found');
  end if;

  select count(*)::integer
  into v_used
  from public.submissions submission
  where submission.cycle_id = p_cycle_id
    and submission.discord_user_id = p_discord_user_id;

  select max(operation.completed_at)
  into v_last_completed_at
  from public.submission_upload_operations operation
  where operation.cycle_id = p_cycle_id
    and operation.discord_user_id = p_discord_user_id
    and operation.status = 'completed';

  if v_used >= v_cycle.submissions_per_user then
    v_cooldown_remaining := 0;
    v_next_allowed_at := null;
  elsif v_last_completed_at is not null then
    v_next_allowed_at := v_last_completed_at
      + make_interval(secs => v_cycle.upload_success_cooldown_seconds);
    v_cooldown_remaining := greatest(
      0,
      ceil(extract(epoch from (v_next_allowed_at - v_now)))::integer
    );
    if v_cooldown_remaining = 0 then
      v_next_allowed_at := null;
    end if;
  end if;

  return jsonb_build_object(
    'outcome', 'status',
    'cycleId', v_cycle.id,
    'cycleStatus', v_cycle.status::text,
    'used', v_used,
    'limit', v_cycle.submissions_per_user,
    'remaining', greatest(v_cycle.submissions_per_user - v_used, 0),
    'cooldownSeconds', v_cycle.upload_success_cooldown_seconds,
    'cooldownRemainingSeconds', v_cooldown_remaining,
    'nextUploadAllowedAt', v_next_allowed_at
  );
end;
$function$;

alter function public.get_submission_upload_quota(bigint, text)
  owner to postgres;
revoke all on function public.get_submission_upload_quota(bigint, text)
  from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.get_submission_upload_quota(bigint, text)
  to service_role;

do $postflight$
declare
  v_function oid;
  v_definition text;
begin
  select function_row.oid, pg_get_functiondef(function_row.oid)
  into v_function, v_definition
  from pg_proc function_row
  join pg_namespace namespace_row
    on namespace_row.oid = function_row.pronamespace
  where namespace_row.nspname = 'public'
    and function_row.proname = 'get_submission_upload_quota'
    and function_row.oid =
      'public.get_submission_upload_quota(bigint,text)'::regprocedure;

  if v_function is null
    or position(
      'if v_used >= v_cycle.submissions_per_user then'
      in v_definition
    ) = 0
    or pg_get_userbyid((
      select proowner from pg_proc where oid = v_function
    )) <> 'postgres'
    or not (
      select prosecdef from pg_proc where oid = v_function
    )
    or coalesce((
      select array_to_string(proconfig, ';')
      from pg_proc
      where oid = v_function
    ), '') <> 'search_path=public, pg_temp'
    or has_function_privilege('anon', v_function, 'execute')
    or has_function_privilege('authenticated', v_function, 'execute')
    or has_function_privilege('discord_bot', v_function, 'execute')
    or not has_function_privilege('service_role', v_function, 'execute')
  then
    raise exception using
      errcode = '55000',
      message = 'DYNAMIC_QUOTA_PROJECTION_POSTFLIGHT_FAILED';
  end if;

  if (
    select count(*)
    from pg_proc function_row
    join pg_namespace namespace_row
      on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname = 'get_submission_upload_quota'
  ) <> 1
  then
    raise exception using
      errcode = '55000',
      message = 'DYNAMIC_QUOTA_PROJECTION_OVERLOAD_POSTFLIGHT_FAILED';
  end if;
end;
$postflight$;

commit;

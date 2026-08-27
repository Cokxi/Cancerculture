begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
declare
  v_signature regprocedure :=
    to_regprocedure('public.get_own_user_warning_appeal_status(uuid,uuid)');
begin
  if v_signature is null
    or (
      select function_row.provolatile <> 's'
        or not function_row.prosecdef
        or pg_get_userbyid(function_row.proowner) <> 'postgres'
        or md5(pg_get_functiondef(function_row.oid)) <>
          '792759acf8a49abefe4b4bbbb65e97de'
      from pg_proc function_row
      where function_row.oid = v_signature
    )
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_APPEAL_STATUS_VOLATILITY_PREFLIGHT_MISMATCH';
  end if;
end;
$preflight$;

create or replace function public.get_own_user_warning_appeal_status(
  p_session_id uuid,
  p_public_warning_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_result jsonb;
begin
  if p_public_warning_id is null then
    raise exception using errcode = '22023', message = 'USER_WARNING_APPEAL_STATUS_INPUT_INVALID';
  end if;
  v_owner_id := public.require_account_session(p_session_id);
  select jsonb_build_object(
    'outcome', 'found',
    'warningId', warning_row.public_warning_id,
    'appealable', appeal.appeal_id is null and current_row.state <> 'overruled',
    'status', case appeal_current.status
      when 'overruled' then 'withdrawn'
      else appeal_current.status end,
    'submittedAt', appeal.submitted_at,
    'reviewedAt', appeal_current.reviewed_at
  ) into v_result
  from public.user_warnings warning_row
  join public.user_warning_current current_row on current_row.warning_id = warning_row.warning_id
  left join public.user_warning_appeals appeal on appeal.warning_id = warning_row.warning_id
  left join public.user_warning_appeal_current appeal_current on appeal_current.appeal_id = appeal.appeal_id
  where warning_row.public_warning_id = p_public_warning_id
    and warning_row.target_discord_user_id = v_owner_id;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  return v_result;
end;
$function$;

alter function public.get_own_user_warning_appeal_status(uuid,uuid)
  owner to postgres;

revoke all on function public.get_own_user_warning_appeal_status(uuid,uuid)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.get_own_user_warning_appeal_status(uuid,uuid)
  to service_role;

do $postflight$
declare
  v_signature regprocedure :=
    to_regprocedure('public.get_own_user_warning_appeal_status(uuid,uuid)');
begin
  if v_signature is null
    or (
      select function_row.provolatile <> 'v'
        or not function_row.prosecdef
        or pg_get_userbyid(function_row.proowner) <> 'postgres'
        or coalesce(array_to_string(function_row.proconfig, ';'), '') <>
          'search_path=public, pg_temp'
      from pg_proc function_row
      where function_row.oid = v_signature
    )
    or (
      select coalesce(array_agg(distinct case
        when privilege_row.grantee = 0 then 'PUBLIC'
        else role_row.rolname
      end order by case
        when privilege_row.grantee = 0 then 'PUBLIC'
        else role_row.rolname
      end), array[]::name[])
      from pg_proc function_row
      cross join lateral aclexplode(coalesce(
        function_row.proacl,
        acldefault('f', function_row.proowner)
      )) privilege_row
      left join pg_roles role_row on role_row.oid = privilege_row.grantee
      where function_row.oid = v_signature
        and privilege_row.privilege_type = 'EXECUTE'
    ) <> array['postgres', 'service_role']::name[]
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_APPEAL_STATUS_VOLATILITY_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;

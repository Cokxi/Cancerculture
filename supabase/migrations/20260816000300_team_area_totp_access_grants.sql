begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if to_regclass('public.sessions') is null
    or to_regclass('public.team_members') is null
    or to_regclass('public.team_roles') is null
    or to_regclass('public.account_totp_factors') is null
    or to_regclass('public.account_totp_attempt_limits') is null
    or to_regclass('public.account_two_factor_audit') is null
    or to_regprocedure('public.require_account_session(uuid)') is null
    or to_regprocedure('public.account_totp_register_failure(text,text,timestamptz)') is null
    or to_regprocedure('public.account_totp_reset_failures(text,text,timestamptz)') is null
    or to_regclass('public.account_team_access_grants') is not null
    or to_regprocedure('public.verify_account_team_access(uuid,text,text)') is not null
    or to_regprocedure('public.grant_account_team_access(uuid,uuid,uuid,text,text,bigint)') is not null
  then
    raise exception using
      errcode = '55000',
      message = 'TEAM_ACCESS_GRANT_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

alter table public.account_two_factor_audit
  drop constraint account_two_factor_audit_event_type_check;

alter table public.account_two_factor_audit
  add constraint account_two_factor_audit_event_type_check check (event_type in (
    'enrollment_started',
    'factor_activated',
    'factor_replaced',
    'factor_recovery_requested',
    'factor_recovery_started',
    'factor_recovered',
    'factor_deactivated',
    'step_up_succeeded',
    'step_up_failed',
    'step_up_replayed',
    'step_up_consumed',
    'recovery_code_used',
    'recovery_codes_replaced',
    'recovery_email_change_requested',
    'recovery_email_verified',
    'recovery_email_removed',
    'email_token_failed',
    'email_delivery_failed',
    'team_access_granted',
    'team_access_context_changed'
  ));

create table public.account_team_access_grants (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  session_id uuid not null unique
    references public.sessions(id) on delete cascade,
  factor_id uuid not null
    references public.account_totp_factors(id) on delete cascade,
  token_digest text not null unique
    check (token_digest ~ '^[0-9a-f]{64}$'),
  context_digest text not null
    check (context_digest ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null default transaction_timestamp(),
  expires_at timestamptz not null,
  constraint account_team_access_grants_expiry_check check (
    expires_at = issued_at + interval '12 hours'
  )
);

create index account_team_access_grants_user_expiry_idx
  on public.account_team_access_grants(discord_user_id, expires_at);

alter table public.account_team_access_grants enable row level security;
revoke all on table public.account_team_access_grants
  from public, anon, authenticated, discord_bot, service_role;

create function public.delete_account_team_access_on_session_revocation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    delete from public.account_team_access_grants
    where session_id = new.id;
  end if;
  return new;
end;
$function$;

create trigger sessions_delete_team_access_on_revocation
after update of revoked_at on public.sessions
for each row
when (old.revoked_at is null and new.revoked_at is not null)
execute function public.delete_account_team_access_on_session_revocation();

create function public.verify_account_team_access(
  p_session_id uuid,
  p_token_digest text,
  p_context_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_factor_id uuid;
  v_grant public.account_team_access_grants%rowtype;
  v_now timestamptz := transaction_timestamp();
begin
  if p_token_digest !~ '^[0-9a-f]{64}$'
    or p_context_digest !~ '^[0-9a-f]{64}$'
  then
    raise exception using errcode = '22023', message = 'TEAM_ACCESS_INPUT_INVALID';
  end if;

  v_user_id := public.require_account_session(p_session_id);

  delete from public.account_team_access_grants
  where expires_at <= v_now;

  perform 1
  from public.team_members member
  join public.team_roles role on role.key = member.role
  where member.discord_user_id = v_user_id
    and role.is_active;
  if not found then
    delete from public.account_team_access_grants
    where discord_user_id = v_user_id;
    return jsonb_build_object('outcome', 'not_team_member');
  end if;

  select factor.id into v_factor_id
  from public.account_totp_factors factor
  where factor.discord_user_id = v_user_id;
  if not found then
    delete from public.account_team_access_grants
    where discord_user_id = v_user_id;
    return jsonb_build_object('outcome', 'totp_required');
  end if;

  select * into v_grant
  from public.account_team_access_grants grant_row
  where grant_row.discord_user_id = v_user_id
    and grant_row.session_id = p_session_id
    and grant_row.token_digest = p_token_digest
  for update;
  if not found then
    return jsonb_build_object('outcome', 'missing');
  end if;

  if v_grant.factor_id <> v_factor_id then
    delete from public.account_team_access_grants where id = v_grant.id;
    return jsonb_build_object('outcome', 'totp_required');
  end if;

  if v_grant.context_digest <> p_context_digest then
    delete from public.account_team_access_grants where id = v_grant.id;
    insert into public.account_two_factor_audit (
      discord_user_id, event_type, factor_id
    ) values (
      v_user_id, 'team_access_context_changed', v_factor_id
    );
    return jsonb_build_object('outcome', 'context_changed');
  end if;

  return jsonb_build_object(
    'outcome', 'allowed',
    'expiresAt', v_grant.expires_at
  );
end;
$function$;

create function public.grant_account_team_access(
  p_session_id uuid,
  p_new_session_id uuid,
  p_factor_id uuid,
  p_token_digest text,
  p_context_digest text,
  p_accepted_step bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_factor public.account_totp_factors%rowtype;
  v_limit public.account_totp_attempt_limits%rowtype;
  v_now timestamptz := transaction_timestamp();
  v_expires_at timestamptz := v_now + interval '12 hours';
begin
  if p_new_session_id is null
    or p_new_session_id = p_session_id
    or p_factor_id is null
    or p_token_digest !~ '^[0-9a-f]{64}$'
    or p_context_digest !~ '^[0-9a-f]{64}$'
    or p_accepted_step is null
    or p_accepted_step < 0
  then
    raise exception using errcode = '22023', message = 'TEAM_ACCESS_INPUT_INVALID';
  end if;

  v_user_id := public.require_account_session(p_session_id);
  perform pg_advisory_xact_lock(hashtextextended('account-2fa:' || v_user_id, 0));

  perform 1
  from public.team_members member
  join public.team_roles role on role.key = member.role
  where member.discord_user_id = v_user_id
    and role.is_active;
  if not found then
    return jsonb_build_object('outcome', 'not_team_member');
  end if;

  select * into v_limit
  from public.account_totp_attempt_limits
  where discord_user_id = v_user_id and scope = 'totp'
  for update;
  if found and v_limit.locked_until is not null and v_limit.locked_until > v_now then
    return jsonb_build_object('outcome', 'rate_limited', 'retryAt', v_limit.locked_until);
  end if;

  select * into v_factor
  from public.account_totp_factors
  where id = p_factor_id and discord_user_id = v_user_id
  for update;
  if not found then
    return jsonb_build_object('outcome', 'not_enrolled');
  end if;

  if p_accepted_step <= v_factor.last_accepted_step then
    perform public.account_totp_register_failure(v_user_id, 'totp', v_now);
    insert into public.account_two_factor_audit (
      discord_user_id, event_type, factor_id, method
    ) values (
      v_user_id, 'step_up_replayed', v_factor.id, 'totp'
    );
    return jsonb_build_object('outcome', 'replayed');
  end if;

  update public.account_totp_factors
  set last_accepted_step = p_accepted_step,
      updated_at = v_now
  where id = v_factor.id;
  perform public.account_totp_reset_failures(v_user_id, 'totp', v_now);

  delete from public.account_team_access_grants
  where expires_at <= v_now or session_id = p_session_id;
  delete from public.account_step_up_grants
  where session_id = p_session_id;

  insert into public.sessions (
    id, discord_user_id, created_at, last_seen_at
  ) values (
    p_new_session_id, v_user_id, v_now, v_now
  );

  update public.sessions
  set revoked_at = v_now
  where id = p_session_id and revoked_at is null;
  if not found then
    raise exception using errcode = '28000', message = 'ACCOUNT_SESSION_INVALID';
  end if;

  insert into public.account_team_access_grants (
    discord_user_id, session_id, factor_id, token_digest,
    context_digest, issued_at, expires_at
  ) values (
    v_user_id, p_new_session_id, v_factor.id, p_token_digest,
    p_context_digest, v_now, v_expires_at
  );

  insert into public.account_two_factor_audit (
    discord_user_id, event_type, factor_id, method
  ) values (
    v_user_id, 'team_access_granted', v_factor.id, 'totp'
  );

  return jsonb_build_object(
    'outcome', 'granted',
    'sessionId', p_new_session_id,
    'expiresAt', v_expires_at
  );
end;
$function$;

alter function public.delete_account_team_access_on_session_revocation() owner to postgres;
alter function public.verify_account_team_access(uuid,text,text) owner to postgres;
alter function public.grant_account_team_access(uuid,uuid,uuid,text,text,bigint) owner to postgres;

revoke all on function public.delete_account_team_access_on_session_revocation()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.verify_account_team_access(uuid,text,text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.grant_account_team_access(uuid,uuid,uuid,text,text,bigint)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.verify_account_team_access(uuid,text,text)
  to service_role;
grant execute on function public.grant_account_team_access(uuid,uuid,uuid,text,text,bigint)
  to service_role;

do $signature_check$
begin
  if (
    select count(*)
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in (
        'delete_account_team_access_on_session_revocation',
        'verify_account_team_access',
        'grant_account_team_access'
      )
  ) <> 3 then
    raise exception using
      errcode = '55000',
      message = 'TEAM_ACCESS_FUNCTION_SIGNATURE_MISMATCH';
  end if;
end;
$signature_check$;

comment on table public.account_team_access_grants is
  'Short-lived opaque Team Area grants. Stores only keyed token and coarse-context digests; no raw device, browser, or network data.';
comment on function public.verify_account_team_access(uuid,text,text) is
  'Fail-closed Team Area gate bound to the active website session, factor, opaque token, 12-hour expiry, and short-lived coarse-context HMAC.';
comment on function public.grant_account_team_access(uuid,uuid,uuid,text,text,bigint) is
  'Atomically consumes a fresh TOTP step, rotates the website session, and issues a 12-hour Team Area grant.';

commit;

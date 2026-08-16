begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if to_regclass('public.sessions') is null
    or to_regclass('public.user_logs') is null
    or to_regclass('public.discord_member_state') is null
    or to_regclass('public.account_totp_factors') is not null
    or to_regclass('public.account_totp_enrollments') is not null
    or to_regclass('public.account_totp_recovery_codes') is not null
    or to_regclass('public.account_step_up_grants') is not null
    or to_regclass('public.account_recovery_contacts') is not null
    or to_regclass('public.account_email_challenges') is not null
    or to_regclass('public.account_totp_attempt_limits') is not null
    or to_regclass('public.account_two_factor_audit') is not null
    or to_regprocedure('public.get_account_two_factor_status(uuid)') is not null
    or to_regprocedure('public.begin_account_totp_enrollment(uuid,uuid,text,text,text,text,integer,boolean,text)') is not null
  then
    raise exception using
      errcode = '55000',
      message = 'ACCOUNT_TOTP_FOUNDATION_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

create table public.account_totp_factors (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text not null unique
    references public.user_logs(discord_user_id) on delete restrict,
  secret_ciphertext text not null check (length(secret_ciphertext) between 16 and 4096),
  secret_nonce text not null check (length(secret_nonce) between 16 and 64),
  secret_tag text not null check (length(secret_tag) between 16 and 64),
  key_version integer not null check (key_version > 0),
  last_accepted_step bigint not null default -1 check (last_accepted_step >= -1),
  activated_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp()
);

create table public.account_totp_enrollments (
  id uuid primary key,
  discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  session_id uuid not null references public.sessions(id) on delete restrict,
  intent text not null check (intent in ('initial', 'replacement', 'email_recovery')),
  status text not null default 'pending'
    check (status in ('pending', 'activated', 'cancelled', 'expired')),
  expected_factor_id uuid,
  secret_ciphertext text,
  secret_nonce text,
  secret_tag text,
  key_version integer check (key_version is null or key_version > 0),
  no_backup_acknowledged boolean not null,
  created_at timestamptz not null default transaction_timestamp(),
  expires_at timestamptz not null,
  activated_at timestamptz,
  constraint account_totp_enrollments_secret_state_check check (
    (
      status = 'pending'
      and secret_ciphertext is not null
      and secret_nonce is not null
      and secret_tag is not null
      and key_version is not null
      and activated_at is null
    )
    or (
      status <> 'pending'
      and secret_ciphertext is null
      and secret_nonce is null
      and secret_tag is null
      and key_version is null
    )
  ),
  constraint account_totp_enrollments_expiry_check check (expires_at > created_at)
);

create unique index account_totp_enrollments_pending_user_uidx
  on public.account_totp_enrollments(discord_user_id)
  where status = 'pending';

create index account_totp_enrollments_expiry_idx
  on public.account_totp_enrollments(expires_at)
  where status = 'pending';

create table public.account_totp_recovery_codes (
  id bigint generated always as identity primary key,
  factor_id uuid not null references public.account_totp_factors(id) on delete cascade,
  code_digest text not null check (code_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default transaction_timestamp(),
  used_at timestamptz,
  unique (factor_id, code_digest)
);

create index account_totp_recovery_codes_unused_idx
  on public.account_totp_recovery_codes(factor_id, code_digest)
  where used_at is null;

create table public.account_step_up_grants (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  session_id uuid not null references public.sessions(id) on delete cascade,
  factor_id uuid not null references public.account_totp_factors(id) on delete cascade,
  method text not null check (method in ('totp', 'recovery_code')),
  purpose text not null check (purpose in (
    'factor_change',
    'factor_deactivation',
    'recovery_codes_replace',
    'backup_email_change',
    'sol_wallet_change'
  )),
  issued_at timestamptz not null default transaction_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  request_id uuid,
  constraint account_step_up_grants_expiry_check check (expires_at > issued_at),
  constraint account_step_up_grants_consumption_check check (
    (consumed_at is null and request_id is null)
    or (consumed_at is not null and request_id is not null)
  )
);

create index account_step_up_grants_lookup_idx
  on public.account_step_up_grants(discord_user_id, session_id, purpose, expires_at desc)
  where consumed_at is null;

create table public.account_recovery_contacts (
  discord_user_id text primary key
    references public.user_logs(discord_user_id) on delete restrict,
  email_ciphertext text not null check (length(email_ciphertext) between 16 and 4096),
  email_nonce text not null check (length(email_nonce) between 16 and 64),
  email_tag text not null check (length(email_tag) between 16 and 64),
  email_fingerprint text not null check (email_fingerprint ~ '^[0-9a-f]{64}$'),
  key_version integer not null check (key_version > 0),
  verified_at timestamptz not null,
  updated_at timestamptz not null default transaction_timestamp()
);

create table public.account_email_challenges (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  session_id uuid not null references public.sessions(id) on delete cascade,
  challenge_type text not null check (challenge_type in ('verify_contact', 'factor_recovery')),
  token_digest text not null unique check (token_digest ~ '^[0-9a-f]{64}$'),
  pending_email_ciphertext text,
  pending_email_nonce text,
  pending_email_tag text,
  pending_email_fingerprint text,
  pending_key_version integer,
  delivery_status text not null default 'pending'
    check (delivery_status in ('pending', 'sent', 'failed')),
  requested_at timestamptz not null default transaction_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint account_email_challenges_pending_email_check check (
    (
      challenge_type = 'verify_contact'
      and pending_email_ciphertext is not null
      and pending_email_nonce is not null
      and pending_email_tag is not null
      and pending_email_fingerprint ~ '^[0-9a-f]{64}$'
      and pending_key_version > 0
    )
    or (
      challenge_type = 'factor_recovery'
      and pending_email_ciphertext is null
      and pending_email_nonce is null
      and pending_email_tag is null
      and pending_email_fingerprint is null
      and pending_key_version is null
    )
  ),
  constraint account_email_challenges_expiry_check check (expires_at > requested_at)
);

create index account_email_challenges_user_request_idx
  on public.account_email_challenges(discord_user_id, challenge_type, requested_at desc);

create index account_email_challenges_active_idx
  on public.account_email_challenges(discord_user_id, token_digest, expires_at)
  where consumed_at is null and delivery_status = 'sent';

create table public.account_totp_attempt_limits (
  discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  scope text not null check (scope in ('totp', 'recovery_code', 'email_token')),
  window_started_at timestamptz not null,
  failure_count integer not null default 0 check (failure_count between 0 and 1000),
  locked_until timestamptz,
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (discord_user_id, scope)
);

create table public.account_two_factor_audit (
  id bigint generated always as identity primary key,
  discord_user_id text not null,
  event_type text not null check (event_type in (
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
    'email_delivery_failed'
  )),
  factor_id uuid,
  enrollment_id uuid,
  method text check (method is null or method in ('totp', 'recovery_code', 'email_recovery')),
  purpose text check (purpose is null or purpose in (
    'factor_change',
    'factor_deactivation',
    'recovery_codes_replace',
    'backup_email_change',
    'sol_wallet_change'
  )),
  occurred_at timestamptz not null default transaction_timestamp()
);

create index account_two_factor_audit_user_idx
  on public.account_two_factor_audit(discord_user_id, occurred_at desc, id desc);

alter table public.account_totp_factors enable row level security;
alter table public.account_totp_enrollments enable row level security;
alter table public.account_totp_recovery_codes enable row level security;
alter table public.account_step_up_grants enable row level security;
alter table public.account_recovery_contacts enable row level security;
alter table public.account_email_challenges enable row level security;
alter table public.account_totp_attempt_limits enable row level security;
alter table public.account_two_factor_audit enable row level security;

revoke all on table public.account_totp_factors from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.account_totp_enrollments from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.account_totp_recovery_codes from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.account_step_up_grants from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.account_recovery_contacts from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.account_email_challenges from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.account_totp_attempt_limits from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.account_two_factor_audit from public, anon, authenticated, discord_bot, service_role;

create function public.protect_account_two_factor_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'ACCOUNT_TWO_FACTOR_AUDIT_IS_APPEND_ONLY';
end;
$function$;

create trigger account_two_factor_audit_no_update
before update on public.account_two_factor_audit
for each row execute function public.protect_account_two_factor_audit();

create trigger account_two_factor_audit_no_delete
before delete on public.account_two_factor_audit
for each row execute function public.protect_account_two_factor_audit();

create function public.require_account_session(p_session_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_discord_user_id text;
begin
  select s.discord_user_id
  into v_discord_user_id
  from public.sessions s
  join public.user_logs u on u.discord_user_id = s.discord_user_id
  left join public.discord_member_state d
    on d.discord_user_id = s.discord_user_id
  where s.id = p_session_id
    and s.revoked_at is null
    and not u.is_banned
    and not coalesce(d.discord_ban_active, false)
  for update of s;

  if not found then
    raise exception using errcode = '28000', message = 'ACCOUNT_SESSION_INVALID';
  end if;

  return v_discord_user_id;
end;
$function$;

create function public.account_totp_register_failure(
  p_discord_user_id text,
  p_scope text,
  p_now timestamptz
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_limit public.account_totp_attempt_limits%rowtype;
  v_count integer;
  v_locked_until timestamptz;
begin
  if p_scope not in ('totp', 'recovery_code', 'email_token') then
    raise exception using errcode = '22023', message = 'ACCOUNT_TOTP_SCOPE_INVALID';
  end if;

  insert into public.account_totp_attempt_limits (
    discord_user_id, scope, window_started_at, failure_count, updated_at
  ) values (
    p_discord_user_id, p_scope, p_now, 0, p_now
  ) on conflict (discord_user_id, scope) do nothing;

  select * into v_limit
  from public.account_totp_attempt_limits
  where discord_user_id = p_discord_user_id and scope = p_scope
  for update;

  if v_limit.window_started_at <= p_now - interval '10 minutes' then
    v_count := 1;
    v_locked_until := null;
  else
    v_count := v_limit.failure_count + 1;
    v_locked_until := case
      when v_count >= 5 then p_now + interval '15 minutes'
      else v_limit.locked_until
    end;
  end if;

  update public.account_totp_attempt_limits
  set window_started_at = case
        when v_limit.window_started_at <= p_now - interval '10 minutes' then p_now
        else window_started_at
      end,
      failure_count = v_count,
      locked_until = v_locked_until,
      updated_at = p_now
  where discord_user_id = p_discord_user_id and scope = p_scope;

  return v_locked_until;
end;
$function$;

create function public.account_totp_reset_failures(
  p_discord_user_id text,
  p_scope text,
  p_now timestamptz
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $function$
  update public.account_totp_attempt_limits
  set failure_count = 0,
      window_started_at = p_now,
      locked_until = null,
      updated_at = p_now
  where discord_user_id = p_discord_user_id and scope = p_scope;
$function$;

create function public.account_consume_step_up(
  p_discord_user_id text,
  p_session_id uuid,
  p_purpose text,
  p_request_id uuid,
  p_totp_only boolean default false
)
returns public.account_step_up_grants
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_grant public.account_step_up_grants%rowtype;
  v_now timestamptz := transaction_timestamp();
begin
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'STEP_UP_REQUEST_ID_REQUIRED';
  end if;

  select * into v_grant
  from public.account_step_up_grants
  where discord_user_id = p_discord_user_id
    and session_id = p_session_id
    and purpose = p_purpose
    and consumed_at is null
    and expires_at > v_now
    and (not p_totp_only or method = 'totp')
  order by issued_at desc
  limit 1
  for update;

  if not found then
    raise exception using errcode = '28000', message = 'FRESH_STEP_UP_REQUIRED';
  end if;

  update public.account_step_up_grants
  set consumed_at = v_now, request_id = p_request_id
  where id = v_grant.id;

  insert into public.account_two_factor_audit (
    discord_user_id, event_type, factor_id, method, purpose
  ) values (
    p_discord_user_id, 'step_up_consumed', v_grant.factor_id,
    v_grant.method, p_purpose
  );

  v_grant.consumed_at := v_now;
  v_grant.request_id := p_request_id;
  return v_grant;
end;
$function$;

create function public.get_account_two_factor_status(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_factor public.account_totp_factors%rowtype;
  v_enrollment public.account_totp_enrollments%rowtype;
  v_contact public.account_recovery_contacts%rowtype;
  v_remaining integer := 0;
  v_now timestamptz := transaction_timestamp();
begin
  v_user_id := public.require_account_session(p_session_id);

  update public.account_totp_enrollments
  set status = 'expired',
      secret_ciphertext = null,
      secret_nonce = null,
      secret_tag = null,
      key_version = null
  where discord_user_id = v_user_id
    and status = 'pending'
    and expires_at <= v_now;

  select * into v_factor
  from public.account_totp_factors
  where discord_user_id = v_user_id;

  if found then
    select count(*)::integer into v_remaining
    from public.account_totp_recovery_codes
    where factor_id = v_factor.id and used_at is null;
  end if;

  select * into v_enrollment
  from public.account_totp_enrollments
  where discord_user_id = v_user_id and status = 'pending';

  select * into v_contact
  from public.account_recovery_contacts
  where discord_user_id = v_user_id;

  return jsonb_strip_nulls(jsonb_build_object(
    'outcome', 'ok',
    'active', v_factor.id is not null,
    'factorId', v_factor.id,
    'activatedAt', v_factor.activated_at,
    'recoveryCodesRemaining', v_remaining,
    'pendingEnrollment', case when v_enrollment.id is null then null else
      jsonb_build_object('id', v_enrollment.id, 'intent', v_enrollment.intent, 'expiresAt', v_enrollment.expires_at)
    end,
    'recoveryContact', case when v_contact.discord_user_id is null then null else
      jsonb_build_object(
        'ciphertext', v_contact.email_ciphertext,
        'nonce', v_contact.email_nonce,
        'tag', v_contact.email_tag,
        'keyVersion', v_contact.key_version,
        'verifiedAt', v_contact.verified_at
      )
    end
  ));
end;
$function$;

create function public.get_account_totp_factor_material(p_session_id uuid)
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
begin
  v_user_id := public.require_account_session(p_session_id);
  select * into v_factor
  from public.account_totp_factors
  where discord_user_id = v_user_id;

  if not found then
    return jsonb_build_object('outcome', 'not_enrolled');
  end if;

  select * into v_limit
  from public.account_totp_attempt_limits
  where discord_user_id = v_user_id and scope = 'totp';

  if v_limit.locked_until is not null and v_limit.locked_until > v_now then
    return jsonb_build_object('outcome', 'rate_limited', 'retryAt', v_limit.locked_until);
  end if;

  return jsonb_build_object(
    'outcome', 'ok',
    'factorId', v_factor.id,
    'ciphertext', v_factor.secret_ciphertext,
    'nonce', v_factor.secret_nonce,
    'tag', v_factor.secret_tag,
    'keyVersion', v_factor.key_version,
    'lastAcceptedStep', v_factor.last_accepted_step
  );
end;
$function$;

create function public.get_account_totp_enrollment_material(
  p_session_id uuid,
  p_enrollment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_enrollment public.account_totp_enrollments%rowtype;
  v_limit public.account_totp_attempt_limits%rowtype;
  v_now timestamptz := transaction_timestamp();
begin
  v_user_id := public.require_account_session(p_session_id);
  select * into v_limit
  from public.account_totp_attempt_limits
  where discord_user_id = v_user_id and scope = 'totp';
  if found and v_limit.locked_until is not null and v_limit.locked_until > v_now then
    return jsonb_build_object('outcome', 'rate_limited', 'retryAt', v_limit.locked_until);
  end if;
  select * into v_enrollment
  from public.account_totp_enrollments
  where id = p_enrollment_id
    and discord_user_id = v_user_id
    and session_id = p_session_id
  for update;

  if not found or v_enrollment.status <> 'pending' then
    return jsonb_build_object('outcome', 'not_pending');
  end if;

  if v_enrollment.expires_at <= v_now then
    update public.account_totp_enrollments
    set status = 'expired', secret_ciphertext = null, secret_nonce = null,
        secret_tag = null, key_version = null
    where id = p_enrollment_id;
    return jsonb_build_object('outcome', 'expired');
  end if;

  return jsonb_build_object(
    'outcome', 'ok',
    'intent', v_enrollment.intent,
    'ciphertext', v_enrollment.secret_ciphertext,
    'nonce', v_enrollment.secret_nonce,
    'tag', v_enrollment.secret_tag,
    'keyVersion', v_enrollment.key_version
  );
end;
$function$;

create function public.begin_account_totp_enrollment(
  p_session_id uuid,
  p_enrollment_id uuid,
  p_intent text,
  p_secret_ciphertext text,
  p_secret_nonce text,
  p_secret_tag text,
  p_key_version integer,
  p_no_backup_acknowledged boolean,
  p_recovery_token_digest text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_factor public.account_totp_factors%rowtype;
  v_challenge public.account_email_challenges%rowtype;
  v_limit public.account_totp_attempt_limits%rowtype;
  v_locked_until timestamptz;
  v_now timestamptz := transaction_timestamp();
begin
  v_user_id := public.require_account_session(p_session_id);
  if p_enrollment_id is null
    or p_intent not in ('initial', 'replacement', 'email_recovery')
    or p_secret_ciphertext is null or length(p_secret_ciphertext) not between 16 and 4096
    or p_secret_nonce is null or length(p_secret_nonce) not between 16 and 64
    or p_secret_tag is null or length(p_secret_tag) not between 16 and 64
    or p_key_version is null or p_key_version <= 0
    or (
      p_intent in ('initial', 'email_recovery')
      and not p_no_backup_acknowledged
    )
  then
    raise exception using errcode = '22023', message = 'TOTP_ENROLLMENT_INPUT_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('account-2fa:' || v_user_id, 0));
  select * into v_factor
  from public.account_totp_factors
  where discord_user_id = v_user_id
  for update;

  if p_intent = 'initial' then
    if found then
      raise exception using errcode = '55000', message = 'TOTP_FACTOR_ALREADY_ACTIVE';
    end if;
  elsif p_intent = 'replacement' then
    if not found then
      raise exception using errcode = '55000', message = 'TOTP_FACTOR_NOT_ACTIVE';
    end if;
    perform public.account_consume_step_up(
      v_user_id, p_session_id, 'factor_change', p_enrollment_id, false
    );
  else
    if not found then
      raise exception using errcode = '55000', message = 'TOTP_FACTOR_NOT_ACTIVE';
    end if;
    select * into v_limit
    from public.account_totp_attempt_limits
    where discord_user_id = v_user_id and scope = 'email_token'
    for update;
    if found and v_limit.locked_until is not null and v_limit.locked_until > v_now then
      return jsonb_build_object('outcome', 'rate_limited', 'retryAt', v_limit.locked_until);
    end if;
    if p_recovery_token_digest is null
      or p_recovery_token_digest !~ '^[0-9a-f]{64}$'
    then
      v_locked_until := public.account_totp_register_failure(v_user_id, 'email_token', v_now);
      insert into public.account_two_factor_audit (
        discord_user_id, event_type, factor_id, method
      ) values (v_user_id, 'email_token_failed', v_factor.id, 'email_recovery');
      return jsonb_strip_nulls(jsonb_build_object(
        'outcome', case when v_locked_until is null then 'rejected' else 'rate_limited' end,
        'retryAt', v_locked_until
      ));
    end if;
    select * into v_challenge
    from public.account_email_challenges
    where discord_user_id = v_user_id
      and session_id = p_session_id
      and challenge_type = 'factor_recovery'
      and token_digest = p_recovery_token_digest
      and delivery_status = 'sent'
      and consumed_at is null
      and expires_at > v_now
    for update;
    if not found then
      v_locked_until := public.account_totp_register_failure(v_user_id, 'email_token', v_now);
      insert into public.account_two_factor_audit (
        discord_user_id, event_type, factor_id, method
      ) values (v_user_id, 'email_token_failed', v_factor.id, 'email_recovery');
      return jsonb_strip_nulls(jsonb_build_object(
        'outcome', case when v_locked_until is null then 'rejected' else 'rate_limited' end,
        'retryAt', v_locked_until
      ));
    end if;
    update public.account_email_challenges set consumed_at = v_now where id = v_challenge.id;
    perform public.account_totp_reset_failures(v_user_id, 'email_token', v_now);
    insert into public.account_two_factor_audit (
      discord_user_id, event_type, factor_id, method
    ) values (
      v_user_id, 'factor_recovery_started', v_factor.id, 'email_recovery'
    );
  end if;

  update public.account_totp_enrollments
  set status = 'cancelled', secret_ciphertext = null, secret_nonce = null,
      secret_tag = null, key_version = null
  where discord_user_id = v_user_id and status = 'pending';

  insert into public.account_totp_enrollments (
    id, discord_user_id, session_id, intent, expected_factor_id,
    secret_ciphertext, secret_nonce, secret_tag, key_version,
    no_backup_acknowledged, expires_at
  ) values (
    p_enrollment_id, v_user_id, p_session_id, p_intent, v_factor.id,
    p_secret_ciphertext, p_secret_nonce, p_secret_tag, p_key_version,
    p_no_backup_acknowledged, v_now + interval '10 minutes'
  );

  insert into public.account_two_factor_audit (
    discord_user_id, event_type, factor_id, enrollment_id,
    method, purpose
  ) values (
    v_user_id, 'enrollment_started', v_factor.id, p_enrollment_id,
    case when p_intent = 'email_recovery' then 'email_recovery' else null end,
    case when p_intent = 'replacement' then 'factor_change' else null end
  );

  return jsonb_build_object(
    'outcome', 'pending', 'enrollmentId', p_enrollment_id,
    'expiresAt', v_now + interval '10 minutes'
  );
end;
$function$;

create function public.activate_account_totp_enrollment(
  p_session_id uuid,
  p_enrollment_id uuid,
  p_accepted_step bigint,
  p_recovery_code_digests text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_enrollment public.account_totp_enrollments%rowtype;
  v_old_factor public.account_totp_factors%rowtype;
  v_new_factor_id uuid := gen_random_uuid();
  v_digest text;
  v_now timestamptz := transaction_timestamp();
begin
  v_user_id := public.require_account_session(p_session_id);
  if p_accepted_step is null or p_accepted_step < 0
    or cardinality(p_recovery_code_digests) <> 10
    or (select count(distinct value) from unnest(p_recovery_code_digests) value) <> 10
    or exists (select 1 from unnest(p_recovery_code_digests) value where value !~ '^[0-9a-f]{64}$')
  then
    raise exception using errcode = '22023', message = 'TOTP_ACTIVATION_INPUT_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('account-2fa:' || v_user_id, 0));
  select * into v_enrollment
  from public.account_totp_enrollments
  where id = p_enrollment_id
    and discord_user_id = v_user_id
    and session_id = p_session_id
  for update;

  if not found or v_enrollment.status <> 'pending' then
    raise exception using errcode = '55000', message = 'TOTP_ENROLLMENT_NOT_PENDING';
  end if;
  if v_enrollment.expires_at <= v_now then
    update public.account_totp_enrollments
    set status = 'expired', secret_ciphertext = null, secret_nonce = null,
        secret_tag = null, key_version = null
    where id = p_enrollment_id;
    raise exception using errcode = '55000', message = 'TOTP_ENROLLMENT_EXPIRED';
  end if;

  select * into v_old_factor
  from public.account_totp_factors
  where discord_user_id = v_user_id
  for update;

  if v_enrollment.intent = 'initial' and found then
    raise exception using errcode = '55000', message = 'TOTP_FACTOR_ALREADY_ACTIVE';
  end if;
  if v_enrollment.intent <> 'initial'
    and (not found or v_old_factor.id is distinct from v_enrollment.expected_factor_id)
  then
    raise exception using errcode = '55000', message = 'TOTP_FACTOR_STATE_CHANGED';
  end if;

  if v_enrollment.intent <> 'initial' then
    delete from public.account_totp_factors where id = v_old_factor.id;
  end if;

  insert into public.account_totp_factors (
    id, discord_user_id, secret_ciphertext, secret_nonce, secret_tag,
    key_version, last_accepted_step, activated_at, updated_at
  ) values (
    v_new_factor_id, v_user_id, v_enrollment.secret_ciphertext,
    v_enrollment.secret_nonce, v_enrollment.secret_tag,
    v_enrollment.key_version, p_accepted_step, v_now, v_now
  );

  foreach v_digest in array p_recovery_code_digests loop
    insert into public.account_totp_recovery_codes(factor_id, code_digest, created_at)
    values (v_new_factor_id, v_digest, v_now);
  end loop;

  update public.account_totp_enrollments
  set status = 'activated', activated_at = v_now,
      secret_ciphertext = null, secret_nonce = null, secret_tag = null,
      key_version = null
  where id = p_enrollment_id;

  delete from public.account_step_up_grants where discord_user_id = v_user_id;
  update public.account_email_challenges
  set consumed_at = coalesce(consumed_at, v_now)
  where discord_user_id = v_user_id and consumed_at is null;

  if v_enrollment.intent = 'email_recovery' then
    update public.sessions
    set revoked_at = coalesce(revoked_at, v_now)
    where discord_user_id = v_user_id
      and id <> p_session_id
      and revoked_at is null;
  end if;

  insert into public.account_two_factor_audit (
    discord_user_id, event_type, factor_id, enrollment_id, method
  ) values (
    v_user_id,
    case v_enrollment.intent
      when 'initial' then 'factor_activated'
      when 'replacement' then 'factor_replaced'
      else 'factor_recovered'
    end,
    v_new_factor_id,
    p_enrollment_id,
    case when v_enrollment.intent = 'email_recovery' then 'email_recovery' else 'totp' end
  );

  return jsonb_build_object(
    'outcome', 'activated', 'factorId', v_new_factor_id,
    'intent', v_enrollment.intent, 'activatedAt', v_now
  );
end;
$function$;

create function public.record_account_totp_failure(
  p_session_id uuid,
  p_scope text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_locked_until timestamptz;
  v_now timestamptz := transaction_timestamp();
begin
  v_user_id := public.require_account_session(p_session_id);
  v_locked_until := public.account_totp_register_failure(v_user_id, p_scope, v_now);
  insert into public.account_two_factor_audit (
    discord_user_id, event_type, method
  ) values (
    v_user_id, 'step_up_failed',
    case when p_scope = 'recovery_code' then 'recovery_code' else 'totp' end
  );
  return jsonb_build_object('outcome', 'rejected', 'retryAt', v_locked_until);
end;
$function$;

create function public.accept_account_totp_step_up(
  p_session_id uuid,
  p_factor_id uuid,
  p_accepted_step bigint,
  p_purpose text
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
  v_grant_id uuid := gen_random_uuid();
  v_now timestamptz := transaction_timestamp();
begin
  v_user_id := public.require_account_session(p_session_id);
  if p_factor_id is null or p_accepted_step is null or p_accepted_step < 0
    or p_purpose not in (
      'factor_change', 'factor_deactivation', 'recovery_codes_replace',
      'backup_email_change', 'sol_wallet_change'
    )
  then
    raise exception using errcode = '22023', message = 'TOTP_STEP_UP_INPUT_INVALID';
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
      discord_user_id, event_type, factor_id, method, purpose
    ) values (
      v_user_id, 'step_up_replayed', v_factor.id, 'totp', p_purpose
    );
    return jsonb_build_object('outcome', 'replayed');
  end if;

  update public.account_totp_factors
  set last_accepted_step = p_accepted_step, updated_at = v_now
  where id = v_factor.id;
  perform public.account_totp_reset_failures(v_user_id, 'totp', v_now);

  insert into public.account_step_up_grants (
    id, discord_user_id, session_id, factor_id, method, purpose,
    issued_at, expires_at
  ) values (
    v_grant_id, v_user_id, p_session_id, v_factor.id, 'totp', p_purpose,
    v_now, v_now + interval '5 minutes'
  );
  insert into public.account_two_factor_audit (
    discord_user_id, event_type, factor_id, method, purpose
  ) values (
    v_user_id, 'step_up_succeeded', v_factor.id, 'totp', p_purpose
  );

  return jsonb_build_object(
    'outcome', 'accepted', 'expiresAt', v_now + interval '5 minutes'
  );
end;
$function$;

create function public.accept_account_recovery_code_step_up(
  p_session_id uuid,
  p_code_digest text,
  p_purpose text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_factor public.account_totp_factors%rowtype;
  v_code public.account_totp_recovery_codes%rowtype;
  v_limit public.account_totp_attempt_limits%rowtype;
  v_now timestamptz := transaction_timestamp();
begin
  v_user_id := public.require_account_session(p_session_id);
  if p_code_digest !~ '^[0-9a-f]{64}$'
    or p_purpose not in ('factor_change', 'factor_deactivation', 'recovery_codes_replace', 'sol_wallet_change')
  then
    raise exception using errcode = '22023', message = 'RECOVERY_CODE_INPUT_INVALID';
  end if;

  select * into v_limit
  from public.account_totp_attempt_limits
  where discord_user_id = v_user_id and scope = 'recovery_code'
  for update;
  if found and v_limit.locked_until is not null and v_limit.locked_until > v_now then
    return jsonb_build_object('outcome', 'rate_limited', 'retryAt', v_limit.locked_until);
  end if;

  select * into v_factor
  from public.account_totp_factors
  where discord_user_id = v_user_id
  for update;
  if not found then
    return jsonb_build_object('outcome', 'not_enrolled');
  end if;

  select * into v_code
  from public.account_totp_recovery_codes
  where factor_id = v_factor.id
    and code_digest = p_code_digest
    and used_at is null
  for update;

  if not found then
    perform public.account_totp_register_failure(v_user_id, 'recovery_code', v_now);
    insert into public.account_two_factor_audit (
      discord_user_id, event_type, factor_id, method, purpose
    ) values (
      v_user_id, 'step_up_failed', v_factor.id, 'recovery_code', p_purpose
    );
    return jsonb_build_object('outcome', 'rejected');
  end if;

  update public.account_totp_recovery_codes set used_at = v_now where id = v_code.id;
  perform public.account_totp_reset_failures(v_user_id, 'recovery_code', v_now);
  insert into public.account_step_up_grants (
    discord_user_id, session_id, factor_id, method, purpose, issued_at, expires_at
  ) values (
    v_user_id, p_session_id, v_factor.id, 'recovery_code', p_purpose,
    v_now, v_now + interval '5 minutes'
  );
  insert into public.account_two_factor_audit (
    discord_user_id, event_type, factor_id, method, purpose
  ) values
    (v_user_id, 'recovery_code_used', v_factor.id, 'recovery_code', p_purpose),
    (v_user_id, 'step_up_succeeded', v_factor.id, 'recovery_code', p_purpose);

  return jsonb_build_object(
    'outcome', 'accepted', 'expiresAt', v_now + interval '5 minutes'
  );
end;
$function$;

create function public.replace_account_totp_recovery_codes(
  p_session_id uuid,
  p_request_id uuid,
  p_recovery_code_digests text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_factor_id uuid;
  v_digest text;
  v_now timestamptz := transaction_timestamp();
begin
  v_user_id := public.require_account_session(p_session_id);
  if cardinality(p_recovery_code_digests) <> 10
    or (select count(distinct value) from unnest(p_recovery_code_digests) value) <> 10
    or exists (select 1 from unnest(p_recovery_code_digests) value where value !~ '^[0-9a-f]{64}$')
  then
    raise exception using errcode = '22023', message = 'RECOVERY_CODE_SET_INVALID';
  end if;
  perform public.account_consume_step_up(
    v_user_id, p_session_id, 'recovery_codes_replace', p_request_id, false
  );
  select id into v_factor_id
  from public.account_totp_factors
  where discord_user_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'TOTP_FACTOR_NOT_ACTIVE';
  end if;

  delete from public.account_totp_recovery_codes where factor_id = v_factor_id;
  foreach v_digest in array p_recovery_code_digests loop
    insert into public.account_totp_recovery_codes(factor_id, code_digest, created_at)
    values (v_factor_id, v_digest, v_now);
  end loop;
  insert into public.account_two_factor_audit (
    discord_user_id, event_type, factor_id
  ) values (v_user_id, 'recovery_codes_replaced', v_factor_id);
  return jsonb_build_object('outcome', 'replaced');
end;
$function$;

create function public.deactivate_account_totp_factor(
  p_session_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_factor_id uuid;
  v_now timestamptz := transaction_timestamp();
begin
  v_user_id := public.require_account_session(p_session_id);
  perform public.account_consume_step_up(
    v_user_id, p_session_id, 'factor_deactivation', p_request_id, false
  );
  select id into v_factor_id
  from public.account_totp_factors
  where discord_user_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'TOTP_FACTOR_NOT_ACTIVE';
  end if;

  update public.account_totp_enrollments
  set status = 'cancelled', secret_ciphertext = null, secret_nonce = null,
      secret_tag = null, key_version = null
  where discord_user_id = v_user_id and status = 'pending';
  delete from public.account_recovery_contacts where discord_user_id = v_user_id;
  delete from public.account_email_challenges where discord_user_id = v_user_id;
  delete from public.account_totp_factors where id = v_factor_id;
  update public.sessions
  set revoked_at = coalesce(revoked_at, v_now)
  where discord_user_id = v_user_id and id <> p_session_id and revoked_at is null;
  insert into public.account_two_factor_audit (
    discord_user_id, event_type, factor_id
  ) values (v_user_id, 'factor_deactivated', v_factor_id);
  return jsonb_build_object('outcome', 'deactivated');
end;
$function$;

create function public.begin_account_recovery_email_change(
  p_session_id uuid,
  p_request_id uuid,
  p_token_digest text,
  p_email_ciphertext text,
  p_email_nonce text,
  p_email_tag text,
  p_email_fingerprint text,
  p_key_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_challenge_id uuid := gen_random_uuid();
  v_now timestamptz := transaction_timestamp();
begin
  v_user_id := public.require_account_session(p_session_id);
  if p_token_digest !~ '^[0-9a-f]{64}$'
    or p_email_fingerprint !~ '^[0-9a-f]{64}$'
    or length(p_email_ciphertext) not between 16 and 4096
    or length(p_email_nonce) not between 16 and 64
    or length(p_email_tag) not between 16 and 64
    or p_key_version is null or p_key_version <= 0
  then
    raise exception using errcode = '22023', message = 'RECOVERY_EMAIL_INPUT_INVALID';
  end if;
  perform public.account_consume_step_up(
    v_user_id, p_session_id, 'backup_email_change', p_request_id, true
  );
  if exists (
    select 1 from public.account_email_challenges
    where discord_user_id = v_user_id
      and challenge_type = 'verify_contact'
      and requested_at > v_now - interval '1 minute'
  ) then
    raise exception using errcode = '55000', message = 'RECOVERY_EMAIL_COOLDOWN';
  end if;

  insert into public.account_email_challenges (
    id, discord_user_id, session_id, challenge_type, token_digest,
    pending_email_ciphertext, pending_email_nonce, pending_email_tag,
    pending_email_fingerprint, pending_key_version, expires_at
  ) values (
    v_challenge_id, v_user_id, p_session_id, 'verify_contact', p_token_digest,
    p_email_ciphertext, p_email_nonce, p_email_tag,
    p_email_fingerprint, p_key_version, v_now + interval '15 minutes'
  );
  insert into public.account_two_factor_audit (
    discord_user_id, event_type, purpose
  ) values (v_user_id, 'recovery_email_change_requested', 'backup_email_change');
  return jsonb_build_object(
    'outcome', 'pending_delivery', 'challengeId', v_challenge_id,
    'expiresAt', v_now + interval '15 minutes'
  );
end;
$function$;

create function public.reserve_account_factor_recovery_email(
  p_session_id uuid,
  p_token_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_factor_id uuid;
  v_contact public.account_recovery_contacts%rowtype;
  v_challenge_id uuid := gen_random_uuid();
  v_last_request timestamptz;
  v_daily_count integer;
  v_now timestamptz := transaction_timestamp();
begin
  v_user_id := public.require_account_session(p_session_id);
  if p_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'RECOVERY_TOKEN_INVALID';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('account-recovery-email:' || v_user_id, 0)
  );
  select id into v_factor_id from public.account_totp_factors
  where discord_user_id = v_user_id for update;
  select * into v_contact from public.account_recovery_contacts
  where discord_user_id = v_user_id;
  if v_factor_id is null or v_contact.discord_user_id is null then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  select max(requested_at), count(*)::integer
  into v_last_request, v_daily_count
  from public.account_email_challenges
  where discord_user_id = v_user_id
    and challenge_type = 'factor_recovery'
    and requested_at > v_now - interval '24 hours';
  if v_daily_count >= 3
    or (v_last_request is not null and v_last_request > v_now - interval '15 minutes')
  then
    return jsonb_build_object('outcome', 'rate_limited');
  end if;

  insert into public.account_email_challenges (
    id, discord_user_id, session_id, challenge_type, token_digest, expires_at
  ) values (
    v_challenge_id, v_user_id, p_session_id, 'factor_recovery',
    p_token_digest, v_now + interval '15 minutes'
  );
  insert into public.account_two_factor_audit (
    discord_user_id, event_type, factor_id, method
  ) values (
    v_user_id, 'factor_recovery_requested', v_factor_id, 'email_recovery'
  );
  return jsonb_build_object(
    'outcome', 'pending_delivery', 'challengeId', v_challenge_id,
    'expiresAt', v_now + interval '15 minutes',
    'contact', jsonb_build_object(
      'ciphertext', v_contact.email_ciphertext,
      'nonce', v_contact.email_nonce,
      'tag', v_contact.email_tag,
      'keyVersion', v_contact.key_version
    )
  );
end;
$function$;

create function public.mark_account_email_challenge_delivery(
  p_session_id uuid,
  p_challenge_id uuid,
  p_delivery_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_challenge public.account_email_challenges%rowtype;
begin
  v_user_id := public.require_account_session(p_session_id);
  if p_delivery_status not in ('sent', 'failed') then
    raise exception using errcode = '22023', message = 'EMAIL_DELIVERY_STATUS_INVALID';
  end if;
  select * into v_challenge from public.account_email_challenges
  where id = p_challenge_id
    and discord_user_id = v_user_id
    and session_id = p_session_id
    and delivery_status = 'pending'
  for update;
  if not found then
    raise exception using errcode = '55000', message = 'EMAIL_CHALLENGE_STATE_CHANGED';
  end if;
  update public.account_email_challenges
  set delivery_status = p_delivery_status
  where id = p_challenge_id;
  if p_delivery_status = 'failed' then
    insert into public.account_two_factor_audit (
      discord_user_id, event_type, method
    ) values (
      v_user_id, 'email_delivery_failed',
      case when v_challenge.challenge_type = 'factor_recovery' then 'email_recovery' else null end
    );
  end if;
  return jsonb_build_object('outcome', p_delivery_status);
end;
$function$;

create function public.confirm_account_recovery_email(
  p_session_id uuid,
  p_token_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_challenge public.account_email_challenges%rowtype;
  v_limit public.account_totp_attempt_limits%rowtype;
  v_locked_until timestamptz;
  v_now timestamptz := transaction_timestamp();
begin
  v_user_id := public.require_account_session(p_session_id);
  if p_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'RECOVERY_TOKEN_INVALID';
  end if;
  select * into v_limit
  from public.account_totp_attempt_limits
  where discord_user_id = v_user_id and scope = 'email_token'
  for update;
  if found and v_limit.locked_until is not null and v_limit.locked_until > v_now then
    return jsonb_build_object('outcome', 'rate_limited', 'retryAt', v_limit.locked_until);
  end if;
  select * into v_challenge
  from public.account_email_challenges
  where discord_user_id = v_user_id
    and session_id = p_session_id
    and challenge_type = 'verify_contact'
    and token_digest = p_token_digest
    and delivery_status = 'sent'
    and consumed_at is null
    and expires_at > v_now
  for update;
  if not found then
    v_locked_until := public.account_totp_register_failure(v_user_id, 'email_token', v_now);
    insert into public.account_two_factor_audit (
      discord_user_id, event_type
    ) values (v_user_id, 'email_token_failed');
    return jsonb_strip_nulls(jsonb_build_object(
      'outcome', case when v_locked_until is null then 'rejected' else 'rate_limited' end,
      'retryAt', v_locked_until
    ));
  end if;

  insert into public.account_recovery_contacts (
    discord_user_id, email_ciphertext, email_nonce, email_tag,
    email_fingerprint, key_version, verified_at, updated_at
  ) values (
    v_user_id, v_challenge.pending_email_ciphertext,
    v_challenge.pending_email_nonce, v_challenge.pending_email_tag,
    v_challenge.pending_email_fingerprint, v_challenge.pending_key_version,
    v_now, v_now
  ) on conflict (discord_user_id) do update set
    email_ciphertext = excluded.email_ciphertext,
    email_nonce = excluded.email_nonce,
    email_tag = excluded.email_tag,
    email_fingerprint = excluded.email_fingerprint,
    key_version = excluded.key_version,
    verified_at = excluded.verified_at,
    updated_at = excluded.updated_at;
  update public.account_email_challenges set consumed_at = v_now where id = v_challenge.id;
  perform public.account_totp_reset_failures(v_user_id, 'email_token', v_now);
  insert into public.account_two_factor_audit (
    discord_user_id, event_type, purpose
  ) values (v_user_id, 'recovery_email_verified', 'backup_email_change');
  return jsonb_build_object('outcome', 'verified', 'verifiedAt', v_now);
end;
$function$;

create function public.remove_account_recovery_email(
  p_session_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
begin
  v_user_id := public.require_account_session(p_session_id);
  perform public.account_consume_step_up(
    v_user_id, p_session_id, 'backup_email_change', p_request_id, true
  );
  if not exists (
    select 1 from public.account_recovery_contacts
    where discord_user_id = v_user_id
    for update
  ) then
    return jsonb_build_object('outcome', 'not_configured');
  end if;
  delete from public.account_email_challenges where discord_user_id = v_user_id;
  delete from public.account_recovery_contacts where discord_user_id = v_user_id;
  insert into public.account_two_factor_audit (
    discord_user_id, event_type, purpose
  ) values (v_user_id, 'recovery_email_removed', 'backup_email_change');
  return jsonb_build_object('outcome', 'removed');
end;
$function$;

create function public.consume_account_step_up_grant(
  p_session_id uuid,
  p_purpose text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_grant public.account_step_up_grants%rowtype;
begin
  v_user_id := public.require_account_session(p_session_id);
  if p_purpose not in (
    'factor_change', 'factor_deactivation', 'recovery_codes_replace',
    'backup_email_change', 'sol_wallet_change'
  ) then
    raise exception using errcode = '22023', message = 'STEP_UP_PURPOSE_INVALID';
  end if;
  v_grant := public.account_consume_step_up(
    v_user_id, p_session_id, p_purpose, p_request_id,
    p_purpose = 'backup_email_change'
  );
  return jsonb_build_object(
    'outcome', 'consumed', 'method', v_grant.method,
    'verifiedAt', v_grant.issued_at
  );
end;
$function$;

alter function public.protect_account_two_factor_audit() owner to postgres;
alter function public.require_account_session(uuid) owner to postgres;
alter function public.account_totp_register_failure(text,text,timestamptz) owner to postgres;
alter function public.account_totp_reset_failures(text,text,timestamptz) owner to postgres;
alter function public.account_consume_step_up(text,uuid,text,uuid,boolean) owner to postgres;
alter function public.get_account_two_factor_status(uuid) owner to postgres;
alter function public.get_account_totp_factor_material(uuid) owner to postgres;
alter function public.get_account_totp_enrollment_material(uuid,uuid) owner to postgres;
alter function public.begin_account_totp_enrollment(uuid,uuid,text,text,text,text,integer,boolean,text) owner to postgres;
alter function public.activate_account_totp_enrollment(uuid,uuid,bigint,text[]) owner to postgres;
alter function public.record_account_totp_failure(uuid,text) owner to postgres;
alter function public.accept_account_totp_step_up(uuid,uuid,bigint,text) owner to postgres;
alter function public.accept_account_recovery_code_step_up(uuid,text,text) owner to postgres;
alter function public.replace_account_totp_recovery_codes(uuid,uuid,text[]) owner to postgres;
alter function public.deactivate_account_totp_factor(uuid,uuid) owner to postgres;
alter function public.begin_account_recovery_email_change(uuid,uuid,text,text,text,text,text,integer) owner to postgres;
alter function public.reserve_account_factor_recovery_email(uuid,text) owner to postgres;
alter function public.mark_account_email_challenge_delivery(uuid,uuid,text) owner to postgres;
alter function public.confirm_account_recovery_email(uuid,text) owner to postgres;
alter function public.remove_account_recovery_email(uuid,uuid) owner to postgres;
alter function public.consume_account_step_up_grant(uuid,text,uuid) owner to postgres;

revoke all on function public.protect_account_two_factor_audit() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.require_account_session(uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.account_totp_register_failure(text,text,timestamptz) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.account_totp_reset_failures(text,text,timestamptz) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.account_consume_step_up(text,uuid,text,uuid,boolean) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_account_two_factor_status(uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_account_totp_factor_material(uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_account_totp_enrollment_material(uuid,uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.begin_account_totp_enrollment(uuid,uuid,text,text,text,text,integer,boolean,text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.activate_account_totp_enrollment(uuid,uuid,bigint,text[]) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.record_account_totp_failure(uuid,text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.accept_account_totp_step_up(uuid,uuid,bigint,text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.accept_account_recovery_code_step_up(uuid,text,text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.replace_account_totp_recovery_codes(uuid,uuid,text[]) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.deactivate_account_totp_factor(uuid,uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.begin_account_recovery_email_change(uuid,uuid,text,text,text,text,text,integer) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.reserve_account_factor_recovery_email(uuid,text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.mark_account_email_challenge_delivery(uuid,uuid,text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.confirm_account_recovery_email(uuid,text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.remove_account_recovery_email(uuid,uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.consume_account_step_up_grant(uuid,text,uuid) from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_account_two_factor_status(uuid) to service_role;
grant execute on function public.get_account_totp_factor_material(uuid) to service_role;
grant execute on function public.get_account_totp_enrollment_material(uuid,uuid) to service_role;
grant execute on function public.begin_account_totp_enrollment(uuid,uuid,text,text,text,text,integer,boolean,text) to service_role;
grant execute on function public.activate_account_totp_enrollment(uuid,uuid,bigint,text[]) to service_role;
grant execute on function public.record_account_totp_failure(uuid,text) to service_role;
grant execute on function public.accept_account_totp_step_up(uuid,uuid,bigint,text) to service_role;
grant execute on function public.accept_account_recovery_code_step_up(uuid,text,text) to service_role;
grant execute on function public.replace_account_totp_recovery_codes(uuid,uuid,text[]) to service_role;
grant execute on function public.deactivate_account_totp_factor(uuid,uuid) to service_role;
grant execute on function public.begin_account_recovery_email_change(uuid,uuid,text,text,text,text,text,integer) to service_role;
grant execute on function public.reserve_account_factor_recovery_email(uuid,text) to service_role;
grant execute on function public.mark_account_email_challenge_delivery(uuid,uuid,text) to service_role;
grant execute on function public.confirm_account_recovery_email(uuid,text) to service_role;
grant execute on function public.remove_account_recovery_email(uuid,uuid) to service_role;
grant execute on function public.consume_account_step_up_grant(uuid,text,uuid) to service_role;

do $security_postflight$
declare
  v_signature text;
  v_signatures text[] := array[
    'public.get_account_two_factor_status(uuid)',
    'public.get_account_totp_factor_material(uuid)',
    'public.get_account_totp_enrollment_material(uuid,uuid)',
    'public.begin_account_totp_enrollment(uuid,uuid,text,text,text,text,integer,boolean,text)',
    'public.activate_account_totp_enrollment(uuid,uuid,bigint,text[])',
    'public.record_account_totp_failure(uuid,text)',
    'public.accept_account_totp_step_up(uuid,uuid,bigint,text)',
    'public.accept_account_recovery_code_step_up(uuid,text,text)',
    'public.replace_account_totp_recovery_codes(uuid,uuid,text[])',
    'public.deactivate_account_totp_factor(uuid,uuid)',
    'public.begin_account_recovery_email_change(uuid,uuid,text,text,text,text,text,integer)',
    'public.reserve_account_factor_recovery_email(uuid,text)',
    'public.mark_account_email_challenge_delivery(uuid,uuid,text)',
    'public.confirm_account_recovery_email(uuid,text)',
    'public.remove_account_recovery_email(uuid,uuid)',
    'public.consume_account_step_up_grant(uuid,text,uuid)'
  ];
  v_internal_signatures text[] := array[
    'public.protect_account_two_factor_audit()',
    'public.require_account_session(uuid)',
    'public.account_totp_register_failure(text,text,timestamptz)',
    'public.account_totp_reset_failures(text,text,timestamptz)',
    'public.account_consume_step_up(text,uuid,text,uuid,boolean)'
  ];
begin
  foreach v_signature in array v_signatures loop
    if to_regprocedure(v_signature) is null
      or not exists (
        select 1
        from pg_proc p
        where p.oid = to_regprocedure(v_signature)
          and pg_get_userbyid(p.proowner) = 'postgres'
          and p.prosecdef
          and p.proconfig @> array['search_path=public, pg_temp']
      )
      or exists (
        select 1
        from pg_proc p
        cross join lateral aclexplode(
          coalesce(p.proacl, acldefault('f', p.proowner))
        ) acl
        where p.oid = to_regprocedure(v_signature)
          and acl.grantee = 0
          and acl.privilege_type = 'EXECUTE'
      )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or not has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'ACCOUNT_TOTP_FUNCTION_SECURITY_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  foreach v_signature in array v_internal_signatures loop
    if to_regprocedure(v_signature) is null
      or not exists (
        select 1
        from pg_proc p
        where p.oid = to_regprocedure(v_signature)
          and pg_get_userbyid(p.proowner) = 'postgres'
          and p.prosecdef
          and p.proconfig @> array['search_path=public, pg_temp']
      )
      or exists (
        select 1
        from pg_proc p
        cross join lateral aclexplode(
          coalesce(p.proacl, acldefault('f', p.proowner))
        ) acl
        where p.oid = to_regprocedure(v_signature)
          and acl.grantee = 0
          and acl.privilege_type = 'EXECUTE'
      )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'ACCOUNT_TOTP_INTERNAL_FUNCTION_SECURITY_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'get_account_two_factor_status',
        'get_account_totp_factor_material',
        'get_account_totp_enrollment_material',
        'begin_account_totp_enrollment',
        'activate_account_totp_enrollment',
        'record_account_totp_failure',
        'accept_account_totp_step_up',
        'accept_account_recovery_code_step_up',
        'replace_account_totp_recovery_codes',
        'deactivate_account_totp_factor',
        'begin_account_recovery_email_change',
        'reserve_account_factor_recovery_email',
        'mark_account_email_challenge_delivery',
        'confirm_account_recovery_email',
        'remove_account_recovery_email',
        'consume_account_step_up_grant'
        ,'protect_account_two_factor_audit'
        ,'require_account_session'
        ,'account_totp_register_failure'
        ,'account_totp_reset_failures'
        ,'account_consume_step_up'
      )
      and p.oid <> all((v_signatures || v_internal_signatures)::regprocedure[])
  ) then
    raise exception using
      errcode = '55000',
      message = 'ACCOUNT_TOTP_FUNCTION_OVERLOAD_MISMATCH';
  end if;
end;
$security_postflight$;

comment on table public.account_totp_factors is
  'Server-only active TOTP factor material. Secrets are application-encrypted; accepted TOTP steps are monotonic replay guards.';
comment on table public.account_totp_recovery_codes is
  'One-time account recovery codes stored only as keyed digests.';
comment on table public.account_two_factor_audit is
  'Append-only redacted two-factor security audit. It contains no secret, recovery code, email address, authenticator URI, IP address, or free text.';
comment on function public.consume_account_step_up_grant(uuid,text,uuid) is
  'Consumes one fresh session-bound step-up exactly once. The future SOL Profile Wallet mutation must call this with sol_wallet_change inside its atomic server contract.';

commit;

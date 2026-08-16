begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if to_regclass('public.sessions') is null
    or to_regclass('public.user_logs') is null
    or to_regclass('public.discord_member_state') is null
    or to_regclass('public.account_totp_factors') is null
    or to_regclass('public.account_step_up_grants') is null
    or to_regclass('public.account_two_factor_audit') is null
    or to_regprocedure('public.require_account_session(uuid)') is null
    or to_regprocedure('public.account_consume_step_up(text,uuid,text,uuid,boolean)') is null
    or to_regclass('public.account_sol_profile_wallets') is not null
    or to_regclass('public.account_sol_profile_wallet_audit') is not null
    or to_regprocedure('public.is_valid_sol_recipient_address(text)') is not null
    or to_regprocedure('public.protect_account_sol_profile_wallet_audit()') is not null
    or to_regprocedure('public.get_account_sol_profile_wallet(uuid)') is not null
    or to_regprocedure('public.change_account_sol_profile_wallet(uuid,uuid,bigint,text)') is not null
    or not exists (
      select 1
      from pg_constraint c
      where c.conrelid = 'public.account_step_up_grants'::regclass
        and pg_get_constraintdef(c.oid) like '%sol_wallet_change%'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'ACCOUNT_SOL_PROFILE_WALLET_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

create function public.is_valid_sol_recipient_address(p_address text)
returns boolean
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_alphabet constant text := '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  v_bytes integer[] := array[0];
  v_carry integer;
  v_digit integer;
  v_character_index integer;
  v_byte_index integer;
  v_leading_zeroes integer := 0;
  v_significant_length integer;
begin
  if p_address is null
    or p_address <> btrim(p_address)
    or length(p_address) not between 32 and 44
    or p_address !~ '^[1-9A-HJ-NP-Za-km-z]+$'
  then
    return false;
  end if;

  while v_leading_zeroes < length(p_address)
    and substr(p_address, v_leading_zeroes + 1, 1) = '1'
  loop
    v_leading_zeroes := v_leading_zeroes + 1;
  end loop;

  for v_character_index in 1..length(p_address) loop
    v_digit := strpos(
      v_alphabet,
      substr(p_address, v_character_index, 1)
    ) - 1;
    if v_digit < 0 then
      return false;
    end if;

    v_carry := v_digit;
    for v_byte_index in 1..coalesce(array_length(v_bytes, 1), 0) loop
      v_carry := v_carry + v_bytes[v_byte_index] * 58;
      v_bytes[v_byte_index] := v_carry % 256;
      v_carry := v_carry / 256;
    end loop;
    while v_carry > 0 loop
      v_bytes := array_append(v_bytes, v_carry % 256);
      v_carry := v_carry / 256;
    end loop;
  end loop;

  v_significant_length := case
    when array_length(v_bytes, 1) = 1 and v_bytes[1] = 0 then 0
    else array_length(v_bytes, 1)
  end;

  return v_leading_zeroes + v_significant_length = 32
    and p_address <> repeat('1', 32);
end;
$function$;

create table public.account_sol_profile_wallets (
  discord_user_id text primary key
    references public.user_logs(discord_user_id) on delete restrict,
  wallet_address text,
  version bigint not null check (version > 0),
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  constraint account_sol_profile_wallet_address_check check (
    wallet_address is null
    or public.is_valid_sol_recipient_address(wallet_address)
  )
);

create table public.account_sol_profile_wallet_audit (
  id bigint generated always as identity primary key,
  discord_user_id text not null,
  session_id uuid not null,
  request_id uuid not null,
  action text not null check (action in ('set', 'remove')),
  outcome text not null check (outcome in ('applied', 'rejected')),
  reason text not null check (reason in (
    'created',
    'replaced',
    'removed',
    'stale_version',
    'no_change',
    'address_invalid',
    'membership_pending',
    'not_member'
  )),
  expected_version bigint not null check (expected_version >= 0),
  resulting_version bigint not null check (resulting_version >= 0),
  occurred_at timestamptz not null default transaction_timestamp(),
  unique (discord_user_id, request_id)
);

create index account_sol_profile_wallet_audit_user_idx
  on public.account_sol_profile_wallet_audit(
    discord_user_id, occurred_at desc, id desc
  );

alter table public.account_sol_profile_wallets enable row level security;
alter table public.account_sol_profile_wallet_audit enable row level security;

revoke all on table public.account_sol_profile_wallets
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.account_sol_profile_wallet_audit
  from public, anon, authenticated, discord_bot, service_role;
revoke all on sequence public.account_sol_profile_wallet_audit_id_seq
  from public, anon, authenticated, discord_bot, service_role;

create function public.protect_account_sol_profile_wallet_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'ACCOUNT_SOL_PROFILE_WALLET_AUDIT_IS_APPEND_ONLY';
end;
$function$;

create trigger account_sol_profile_wallet_audit_no_update
before update on public.account_sol_profile_wallet_audit
for each row execute function public.protect_account_sol_profile_wallet_audit();

create trigger account_sol_profile_wallet_audit_no_delete
before delete on public.account_sol_profile_wallet_audit
for each row execute function public.protect_account_sol_profile_wallet_audit();

create function public.get_account_sol_profile_wallet(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_membership public.discord_member_state%rowtype;
  v_factor_active boolean;
  v_wallet public.account_sol_profile_wallets%rowtype;
begin
  v_user_id := public.require_account_session(p_session_id);

  select * into v_membership
  from public.discord_member_state
  where discord_user_id = v_user_id;
  if not found or v_membership.discord_membership_observed_at is null then
    return jsonb_build_object('outcome', 'membership_pending');
  end if;
  if not v_membership.is_in_discord then
    return jsonb_build_object('outcome', 'not_member');
  end if;

  select exists (
    select 1
    from public.account_totp_factors
    where discord_user_id = v_user_id
  ) into v_factor_active;
  if not v_factor_active then
    return jsonb_build_object(
      'outcome', 'ok',
      'factorActive', false,
      'walletAddress', null,
      'version', null,
      'updatedAt', null
    );
  end if;

  select * into v_wallet
  from public.account_sol_profile_wallets
  where discord_user_id = v_user_id;

  return jsonb_build_object(
    'outcome', 'ok',
    'factorActive', true,
    'walletAddress', case when found then v_wallet.wallet_address else null end,
    'version', case when found then v_wallet.version else 0 end,
    'updatedAt', case when found then v_wallet.updated_at else null end
  );
end;
$function$;

create function public.change_account_sol_profile_wallet(
  p_session_id uuid,
  p_request_id uuid,
  p_expected_version bigint,
  p_wallet_address text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id text;
  v_membership public.discord_member_state%rowtype;
  v_membership_found boolean := false;
  v_wallet public.account_sol_profile_wallets%rowtype;
  v_wallet_found boolean := false;
  v_audit public.account_sol_profile_wallet_audit%rowtype;
  v_current_address text;
  v_current_version bigint := 0;
  v_resulting_version bigint := 0;
  v_action text;
  v_outcome text;
  v_reason text;
  v_now timestamptz := transaction_timestamp();
begin
  if p_request_id is null
    or p_expected_version is null
    or p_expected_version < 0
  then
    raise exception using
      errcode = '22023',
      message = 'SOL_WALLET_INPUT_INVALID';
  end if;

  v_user_id := public.require_account_session(p_session_id);
  perform pg_advisory_xact_lock(
    hashtextextended('sol-profile-wallet:' || v_user_id, 0)
  );

  select * into v_audit
  from public.account_sol_profile_wallet_audit
  where discord_user_id = v_user_id
    and request_id = p_request_id;
  if found then
    if v_audit.session_id <> p_session_id then
      raise exception using
        errcode = '22023',
        message = 'SOL_WALLET_REQUEST_ID_REUSED';
    end if;
    return jsonb_build_object(
      'outcome', v_audit.outcome,
      'reason', v_audit.reason,
      'version', v_audit.resulting_version,
      'updatedAt', v_audit.occurred_at,
      'idempotentReplay', true
    );
  end if;

  perform public.account_consume_step_up(
    v_user_id,
    p_session_id,
    'sol_wallet_change',
    p_request_id,
    false
  );

  select * into v_membership
  from public.discord_member_state
  where discord_user_id = v_user_id
  for update;
  v_membership_found := found;

  select * into v_wallet
  from public.account_sol_profile_wallets
  where discord_user_id = v_user_id
  for update;
  v_wallet_found := found;
  if v_wallet_found then
    v_current_address := v_wallet.wallet_address;
    v_current_version := v_wallet.version;
  end if;
  v_resulting_version := v_current_version;
  v_action := case when p_wallet_address is null then 'remove' else 'set' end;

  if not v_membership_found
    or v_membership.discord_membership_observed_at is null
  then
    v_outcome := 'rejected';
    v_reason := 'membership_pending';
  elsif not v_membership.is_in_discord then
    v_outcome := 'rejected';
    v_reason := 'not_member';
  elsif p_expected_version <> v_current_version then
    v_outcome := 'rejected';
    v_reason := 'stale_version';
  elsif p_wallet_address is not null
    and not public.is_valid_sol_recipient_address(p_wallet_address)
  then
    v_outcome := 'rejected';
    v_reason := 'address_invalid';
  elsif p_wallet_address is not distinct from v_current_address then
    v_outcome := 'rejected';
    v_reason := 'no_change';
  else
    v_outcome := 'applied';
    v_resulting_version := v_current_version + 1;
    v_reason := case
      when p_wallet_address is null then 'removed'
      when v_current_address is null then 'created'
      else 'replaced'
    end;

    insert into public.account_sol_profile_wallets (
      discord_user_id, wallet_address, version, created_at, updated_at
    ) values (
      v_user_id, p_wallet_address, v_resulting_version, v_now, v_now
    )
    on conflict (discord_user_id) do update
    set wallet_address = excluded.wallet_address,
        version = excluded.version,
        updated_at = excluded.updated_at;
  end if;

  insert into public.account_sol_profile_wallet_audit (
    discord_user_id,
    session_id,
    request_id,
    action,
    outcome,
    reason,
    expected_version,
    resulting_version,
    occurred_at
  ) values (
    v_user_id,
    p_session_id,
    p_request_id,
    v_action,
    v_outcome,
    v_reason,
    p_expected_version,
    v_resulting_version,
    v_now
  );

  return jsonb_build_object(
    'outcome', v_outcome,
    'reason', v_reason,
    'version', v_resulting_version,
    'updatedAt', v_now,
    'idempotentReplay', false
  );
end;
$function$;

alter table public.account_sol_profile_wallets owner to postgres;
alter table public.account_sol_profile_wallet_audit owner to postgres;
alter sequence public.account_sol_profile_wallet_audit_id_seq owner to postgres;
alter function public.is_valid_sol_recipient_address(text) owner to postgres;
alter function public.protect_account_sol_profile_wallet_audit() owner to postgres;
alter function public.get_account_sol_profile_wallet(uuid) owner to postgres;
alter function public.change_account_sol_profile_wallet(uuid,uuid,bigint,text) owner to postgres;

revoke all on function public.is_valid_sol_recipient_address(text)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.protect_account_sol_profile_wallet_audit()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_account_sol_profile_wallet(uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.change_account_sol_profile_wallet(uuid,uuid,bigint,text)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_account_sol_profile_wallet(uuid)
  to service_role;
grant execute on function public.change_account_sol_profile_wallet(uuid,uuid,bigint,text)
  to service_role;

do $security_postflight$
declare
  v_signature text;
  v_service_signatures text[] := array[
    'public.get_account_sol_profile_wallet(uuid)',
    'public.change_account_sol_profile_wallet(uuid,uuid,bigint,text)'
  ];
  v_internal_signatures text[] := array[
    'public.is_valid_sol_recipient_address(text)',
    'public.protect_account_sol_profile_wallet_audit()'
  ];
begin
  foreach v_signature in array v_service_signatures loop
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
        message = 'ACCOUNT_SOL_PROFILE_WALLET_FUNCTION_SECURITY_MISMATCH',
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
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'ACCOUNT_SOL_PROFILE_WALLET_INTERNAL_FUNCTION_SECURITY_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'is_valid_sol_recipient_address',
        'protect_account_sol_profile_wallet_audit',
        'get_account_sol_profile_wallet',
        'change_account_sol_profile_wallet'
      )
      and p.oid <> all(
        (v_service_signatures || v_internal_signatures)::regprocedure[]
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'ACCOUNT_SOL_PROFILE_WALLET_FUNCTION_OVERLOAD_MISMATCH';
  end if;

  if not exists (
    select 1
    from pg_class c
    where c.oid in (
      'public.account_sol_profile_wallets'::regclass,
      'public.account_sol_profile_wallet_audit'::regclass
    )
      and c.relrowsecurity
    group by c.relrowsecurity
    having count(*) = 2
  )
    or exists (
      select 1
      from pg_policy p
      where p.polrelid in (
        'public.account_sol_profile_wallets'::regclass,
        'public.account_sol_profile_wallet_audit'::regclass
      )
    )
  then
    raise exception using
      errcode = '55000',
      message = 'ACCOUNT_SOL_PROFILE_WALLET_RLS_MISMATCH';
  end if;

  if has_table_privilege('anon', 'public.account_sol_profile_wallets', 'SELECT')
    or has_table_privilege('authenticated', 'public.account_sol_profile_wallets', 'SELECT')
    or has_table_privilege('discord_bot', 'public.account_sol_profile_wallets', 'SELECT')
    or has_table_privilege('service_role', 'public.account_sol_profile_wallets', 'SELECT')
    or has_table_privilege('service_role', 'public.account_sol_profile_wallets', 'INSERT')
    or has_table_privilege('service_role', 'public.account_sol_profile_wallets', 'UPDATE')
    or has_table_privilege('service_role', 'public.account_sol_profile_wallets', 'DELETE')
    or has_table_privilege('service_role', 'public.account_sol_profile_wallet_audit', 'SELECT')
    or has_table_privilege('service_role', 'public.account_sol_profile_wallet_audit', 'INSERT')
    or has_sequence_privilege(
      'service_role',
      'public.account_sol_profile_wallet_audit_id_seq',
      'USAGE'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'ACCOUNT_SOL_PROFILE_WALLET_TABLE_ACL_MISMATCH';
  end if;

  if (
    select count(*)
    from pg_trigger t
    where t.tgrelid = 'public.account_sol_profile_wallet_audit'::regclass
      and not t.tgisinternal
      and t.tgname in (
        'account_sol_profile_wallet_audit_no_update',
        'account_sol_profile_wallet_audit_no_delete'
      )
  ) <> 2 then
    raise exception using
      errcode = '55000',
      message = 'ACCOUNT_SOL_PROFILE_WALLET_AUDIT_TRIGGER_MISMATCH';
  end if;
end;
$security_postflight$;

comment on table public.account_sol_profile_wallets is
  'One optional private account-wide SOL recipient per member. Direct browser and service-role table access is forbidden; owner reads and changes use hardened RPCs.';
comment on table public.account_sol_profile_wallet_audit is
  'Append-only redacted SOL profile-wallet audit. It contains no wallet address, TOTP or recovery material, email, IP address, raw user agent, analytics identifier, or free text.';
comment on function public.change_account_sol_profile_wallet(uuid,uuid,bigint,text) is
  'Atomically serializes an optimistic wallet change, consumes one current-session sol_wallet_change grant, and writes a redacted idempotent audit result.';

commit;

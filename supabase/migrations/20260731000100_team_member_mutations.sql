begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $preflight$
begin
  if to_regclass('public.team_members') is null
    or to_regclass('public.team_roles') is null
    or to_regclass('public.team_authorization_audit') is null
    or to_regclass('public.user_logs') is null
    or to_regclass('public.discord_member_state') is null
  then
    raise exception using
      errcode = '42P01',
      message = 'TEAM_MEMBER_MUTATION_DEPENDENCY_MISSING';
  end if;

  if to_regprocedure(
    'public.set_team_member_non_admin_role(text,text,text,text,text,uuid)'
  ) is null
    or to_regprocedure(
      'public.set_team_member_admin_role(text,text,boolean,text,text,text,uuid)'
    ) is null
  then
    raise exception using
      errcode = '42883',
      message = 'TEAM_AUTHORIZATION_MUTATION_LAYER_MISSING';
  end if;

  if to_regprocedure('extensions.digest(bytea,text)') is null then
    raise exception using
      errcode = '42883',
      message = 'SHA256_DIGEST_FUNCTION_MISSING';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'team_authorization_audit'
      and column_name = 'request_hash'
      and is_nullable = 'NO'
  ) then
    raise exception using
      errcode = '42703',
      message = 'TEAM_AUTHORIZATION_REQUEST_HASH_MISSING';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_logs'
      and column_name = 'discord_user_id'
      and data_type = 'text'
  )
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'discord_member_state'
        and column_name = 'discord_user_id'
        and data_type = 'text'
    )
  then
    raise exception using
      errcode = '42703',
      message = 'DISCORD_IDENTITY_COLUMN_MISSING';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
        'public.team_authorization_audit'::regclass
      and constraint_row.conname =
        'team_authorization_audit_event_type_check'
      and constraint_row.contype = 'c'
  )
    or not exists (
      select 1
      from pg_constraint constraint_row
      where constraint_row.conrelid =
          'public.team_authorization_audit'::regclass
        and constraint_row.conname =
          'team_authorization_audit_target_check'
        and constraint_row.contype = 'c'
    )
  then
    raise exception using
      errcode = '42704',
      message = 'TEAM_AUTHORIZATION_AUDIT_CONTRACT_MISSING';
  end if;

  if exists (
    select 1
    from pg_proc function_row
    join pg_namespace namespace_row
      on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname in (
        'add_team_member',
        'remove_team_member'
      )
  ) then
    raise exception using
      errcode = '42723',
      message = 'TEAM_MEMBER_MUTATION_RPC_ALREADY_EXISTS';
  end if;
end;
$preflight$;

alter table public.team_authorization_audit
  drop constraint team_authorization_audit_event_type_check;

alter table public.team_authorization_audit
  add constraint team_authorization_audit_event_type_check
  check (
    event_type in (
      'role_created',
      'role_updated',
      'role_activated',
      'role_deactivated',
      'capability_granted',
      'capability_revoked',
      'member_role_changed',
      'admin_role_changed',
      'member_added',
      'member_removed'
    )
  ) not valid;

alter table public.team_authorization_audit
  validate constraint team_authorization_audit_event_type_check;

alter table public.team_authorization_audit
  drop constraint team_authorization_audit_target_check;

alter table public.team_authorization_audit
  add constraint team_authorization_audit_target_check
  check (
    (
      event_type in (
        'role_created',
        'role_updated',
        'role_activated',
        'role_deactivated'
      )
      and target_role_key is not null
    )
    or (
      event_type in (
        'capability_granted',
        'capability_revoked'
      )
      and target_role_key is not null
      and capability_key is not null
    )
    or (
      event_type in (
        'member_role_changed',
        'admin_role_changed',
        'member_added',
        'member_removed'
      )
      and nullif(btrim(target_discord_user_id), '') is not null
    )
  ) not valid;

alter table public.team_authorization_audit
  validate constraint team_authorization_audit_target_check;

create function public.add_team_member(
  p_actor_discord_user_id text,
  p_target_discord_user_id text,
  p_initial_role_key text,
  p_expected_absent boolean,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_target_id text := btrim(p_target_discord_user_id);
  v_initial_role_key text := btrim(p_initial_role_key);
  v_reason text := btrim(p_reason);
  v_actor_role text;
  v_existing_role text;
  v_target_username text;
  v_initial_role public.team_roles%rowtype;
  v_payload jsonb;
  v_request_hash text;
  v_existing_event text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_result jsonb;
begin
  if p_idempotency_key is null then
    raise exception using
      errcode = '22023',
      message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;

  if nullif(v_actor_id, '') is null
    or v_actor_id !~ '^[0-9]{5,32}$' then
    raise exception using
      errcode = '42501',
      message = 'ACTOR_NOT_ADMIN';
  end if;

  if nullif(v_target_id, '') is null
    or v_target_id !~ '^[0-9]{5,32}$'
    or nullif(v_initial_role_key, '') is null
    or v_initial_role_key !~ '^[a-z][a-z0-9_]{2,63}$'
    or p_expected_absent is null
  then
    raise exception using
      errcode = '22023',
      message = 'INVALID_TEAM_MEMBER_ADD_REQUEST';
  end if;

  if not p_expected_absent then
    raise exception using
      errcode = '22023',
      message = 'TEAM_MEMBER_EXPECTED_ABSENT_REQUIRED';
  end if;

  if v_initial_role_key = 'admin' then
    raise exception using
      errcode = '42501',
      message = 'ADMIN_ROLE_REQUIRES_OWNER_RPC';
  end if;

  if v_reason is null
    or char_length(v_reason) not between 3 and 1000 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_REASON';
  end if;

  v_payload := jsonb_build_object(
    'actorDiscordUserId', v_actor_id,
    'expectedAbsent', p_expected_absent,
    'initialRoleKey', v_initial_role_key,
    'operation', 'add_team_member',
    'reason', v_reason,
    'targetDiscordUserId', v_target_id
  );
  v_request_hash := encode(
    extensions.digest(
      convert_to(v_payload::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(p_idempotency_key::text, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'public.team_authorization.mutations',
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'public.team_authorization.member:' || v_target_id,
      0
    )
  );

  select role
  into v_actor_role
  from public.team_members
  where discord_user_id = v_actor_id
  for update;

  if v_actor_role is distinct from 'admin' then
    raise exception using
      errcode = '42501',
      message = 'ACTOR_NOT_ADMIN';
  end if;

  select event_type, request_hash, after_state
  into v_existing_event, v_existing_hash, v_existing_result
  from public.team_authorization_audit
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing_event = 'member_added'
      and v_existing_hash = v_request_hash then
      return v_existing_result;
    end if;

    raise exception using
      errcode = '22023',
      message = 'TEAM_AUTH_IDEMPOTENCY_CONFLICT';
  end if;

  select role
  into v_existing_role
  from public.team_members
  where discord_user_id = v_target_id
  for update;

  if found then
    raise exception using
      errcode = '23505',
      message = 'TEAM_MEMBER_ALREADY_EXISTS';
  end if;

  select current_discord_username
  into v_target_username
  from public.user_logs
  where discord_user_id = v_target_id
  for key share;

  if not found then
    select current_discord_username
    into v_target_username
    from public.discord_member_state
    where discord_user_id = v_target_id
    for key share;

    if not found then
      raise exception using
        errcode = 'P0002',
        message = 'TARGET_IDENTITY_UNKNOWN';
    end if;
  end if;

  select *
  into v_initial_role
  from public.team_roles
  where key = v_initial_role_key
  for share;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'TEAM_ROLE_NOT_FOUND';
  end if;

  if v_initial_role.key = 'admin' then
    raise exception using
      errcode = '42501',
      message = 'ADMIN_ROLE_REQUIRES_OWNER_RPC';
  end if;

  if not v_initial_role.is_active then
    raise exception using
      errcode = '55000',
      message = 'TEAM_ROLE_INACTIVE';
  end if;

  insert into public.team_members (
    discord_user_id,
    discord_username,
    role
  )
  values (
    v_target_id,
    v_target_username,
    v_initial_role_key
  );

  v_result := jsonb_build_object(
    'changed', true,
    'newRole', v_initial_role_key,
    'operation', 'add_team_member',
    'previousRole', null,
    'targetDiscordUserId', v_target_id
  );

  insert into public.team_authorization_audit (
    idempotency_key,
    request_hash,
    actor_discord_user_id,
    actor_role_key,
    event_type,
    target_role_key,
    target_discord_user_id,
    before_state,
    after_state,
    reason
  )
  values (
    p_idempotency_key,
    v_request_hash,
    v_actor_id,
    'admin',
    'member_added',
    v_initial_role_key,
    v_target_id,
    jsonb_build_object('teamMembership', null),
    v_result,
    v_reason
  );

  return v_result;
end;
$function$;

create function public.remove_team_member(
  p_actor_discord_user_id text,
  p_target_discord_user_id text,
  p_expected_previous_role_key text,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_target_id text := btrim(p_target_discord_user_id);
  v_expected_role text := btrim(p_expected_previous_role_key);
  v_reason text := btrim(p_reason);
  v_actor_role text;
  v_previous_role text;
  v_payload jsonb;
  v_request_hash text;
  v_existing_event text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_result jsonb;
begin
  if p_idempotency_key is null then
    raise exception using
      errcode = '22023',
      message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;

  if nullif(v_actor_id, '') is null
    or v_actor_id !~ '^[0-9]{5,32}$' then
    raise exception using
      errcode = '42501',
      message = 'ACTOR_NOT_ADMIN';
  end if;

  if nullif(v_target_id, '') is null
    or v_target_id !~ '^[0-9]{5,32}$'
    or nullif(v_expected_role, '') is null
    or v_expected_role !~ '^[a-z][a-z0-9_]{2,63}$'
  then
    raise exception using
      errcode = '22023',
      message = 'INVALID_TEAM_MEMBER_REMOVE_REQUEST';
  end if;

  if v_expected_role = 'admin' then
    raise exception using
      errcode = '42501',
      message = 'ADMIN_MEMBER_REMOVE_FORBIDDEN';
  end if;

  if v_reason is null
    or char_length(v_reason) not between 3 and 1000 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_REASON';
  end if;

  v_payload := jsonb_build_object(
    'actorDiscordUserId', v_actor_id,
    'expectedPreviousRoleKey', v_expected_role,
    'operation', 'remove_team_member',
    'reason', v_reason,
    'targetDiscordUserId', v_target_id
  );
  v_request_hash := encode(
    extensions.digest(
      convert_to(v_payload::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(p_idempotency_key::text, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'public.team_authorization.mutations',
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'public.team_authorization.member:' || v_target_id,
      0
    )
  );

  select role
  into v_actor_role
  from public.team_members
  where discord_user_id = v_actor_id
  for update;

  if v_actor_role is distinct from 'admin' then
    raise exception using
      errcode = '42501',
      message = 'ACTOR_NOT_ADMIN';
  end if;

  select event_type, request_hash, after_state
  into v_existing_event, v_existing_hash, v_existing_result
  from public.team_authorization_audit
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing_event = 'member_removed'
      and v_existing_hash = v_request_hash then
      return v_existing_result;
    end if;

    raise exception using
      errcode = '22023',
      message = 'TEAM_AUTH_IDEMPOTENCY_CONFLICT';
  end if;

  select role
  into v_previous_role
  from public.team_members
  where discord_user_id = v_target_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'TEAM_MEMBER_NOT_FOUND';
  end if;

  if v_previous_role = 'admin' then
    raise exception using
      errcode = '42501',
      message = 'ADMIN_MEMBER_REMOVE_FORBIDDEN';
  end if;

  if v_previous_role <> v_expected_role then
    raise exception using
      errcode = '40001',
      message = 'TEAM_MEMBER_ROLE_CONFLICT';
  end if;

  delete from public.team_members
  where discord_user_id = v_target_id;

  v_result := jsonb_build_object(
    'changed', true,
    'newRole', null,
    'operation', 'remove_team_member',
    'previousRole', v_previous_role,
    'targetDiscordUserId', v_target_id
  );

  insert into public.team_authorization_audit (
    idempotency_key,
    request_hash,
    actor_discord_user_id,
    actor_role_key,
    event_type,
    target_role_key,
    target_discord_user_id,
    before_state,
    after_state,
    reason
  )
  values (
    p_idempotency_key,
    v_request_hash,
    v_actor_id,
    'admin',
    'member_removed',
    v_previous_role,
    v_target_id,
    jsonb_build_object(
      'previousRole', v_previous_role,
      'targetDiscordUserId', v_target_id
    ),
    v_result,
    v_reason
  );

  return v_result;
end;
$function$;

alter function public.add_team_member(
  text, text, text, boolean, text, uuid
) owner to postgres;

alter function public.remove_team_member(
  text, text, text, text, uuid
) owner to postgres;

revoke all on function public.add_team_member(
  text, text, text, boolean, text, uuid
) from public, anon, authenticated, discord_bot, service_role;

revoke all on function public.remove_team_member(
  text, text, text, text, uuid
) from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.add_team_member(
  text, text, text, boolean, text, uuid
) to service_role;

grant execute on function public.remove_team_member(
  text, text, text, text, uuid
) to service_role;

comment on function public.add_team_member(
  text, text, text, boolean, text, uuid
) is
  'Adds one known Discord identity to one active non-admin team role with explicit absent-state, idempotency, and append-only authorization audit; service role only.';

comment on function public.remove_team_member(
  text, text, text, text, uuid
) is
  'Physically removes one current non-admin team member with expected-role, idempotency, and append-only authorization audit; service role only.';

commit;

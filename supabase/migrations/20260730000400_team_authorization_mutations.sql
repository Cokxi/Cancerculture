begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $preflight$
begin
  if to_regclass('public.team_roles') is null
    or to_regclass('public.capability_catalog') is null
    or to_regclass('public.team_role_capabilities') is null
    or to_regclass('public.team_authorization_audit') is null
    or to_regclass('public.team_members') is null
  then
    raise exception using
      errcode = '42P01',
      message = 'TEAM_AUTHORIZATION_FOUNDATION_MISSING';
  end if;

  if to_regprocedure(
    'public.set_team_member_role(text,text,text,text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = 'LEGACY_TEAM_ROLE_RPC_MISSING';
  end if;

  if (
    select count(*)
    from pg_proc function_row
    join pg_namespace namespace_row
      on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname = 'set_team_member_role'
  ) <> 1 then
    raise exception using
      errcode = '42725',
      message = 'LEGACY_TEAM_ROLE_RPC_OVERLOAD_DRIFT';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'team_authorization_audit'
      and column_name = 'request_hash'
  ) then
    raise exception using
      errcode = '42701',
      message = 'TEAM_AUTHORIZATION_REQUEST_HASH_ALREADY_EXISTS';
  end if;

  if exists (
    select 1
    from pg_proc function_row
    join pg_namespace namespace_row
      on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname in (
        'create_team_role',
        'update_team_role',
        'set_team_role_active',
        'set_team_role_capability',
        'set_team_member_non_admin_role',
        'set_team_member_admin_role'
      )
  ) then
    raise exception using
      errcode = '42723',
      message = 'TEAM_AUTHORIZATION_MUTATION_RPC_ALREADY_EXISTS';
  end if;

  if to_regprocedure('extensions.digest(bytea,text)') is null then
    raise exception using
      errcode = '42883',
      message = 'SHA256_DIGEST_FUNCTION_MISSING';
  end if;

  if to_regprocedure('gen_random_uuid()') is null then
    raise exception using
      errcode = '42883',
      message = 'UUID_GENERATOR_MISSING';
  end if;

  if (
    select count(*)
    from public.team_roles
  ) <> 4
    or (
      select count(*)
      from public.capability_catalog
    ) <> 3
    or (
      select count(*)
      from public.team_role_capabilities
    ) <> 9
    or exists (
      select 1
      from public.team_role_capabilities
      where role_key = 'admin'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'TEAM_AUTHORIZATION_FOUNDATION_DATA_DRIFT';
  end if;

  if exists (
    select 1
    from public.team_authorization_audit
  ) then
    raise exception using
      errcode = '55000',
      message = 'TEAM_AUTHORIZATION_AUDIT_NOT_EMPTY';
  end if;
end;
$preflight$;

lock table public.team_authorization_audit
  in share row exclusive mode;

alter table public.team_authorization_audit
  add column request_hash text not null;

alter table public.team_authorization_audit
  add constraint team_authorization_audit_request_hash_check
  check (request_hash ~ '^[0-9a-f]{64}$');

comment on column public.team_authorization_audit.request_hash is
  'Lowercase SHA-256 of the canonical jsonb request payload. Canonicalization is jsonb_build_object(... )::text after input normalization; jsonb provides deterministic key ordering and explicit JSON scalar/null encoding.';

create function public.create_team_role(
  p_actor_discord_user_id text,
  p_display_name text,
  p_description text,
  p_sort_order integer,
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
  v_display_name text := btrim(p_display_name);
  v_description text := btrim(coalesce(p_description, ''));
  v_reason text := btrim(p_reason);
  v_actor_role text;
  v_role_key text;
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
    or char_length(v_actor_id) > 100 then
    raise exception using
      errcode = '42501',
      message = 'ACTOR_NOT_ADMIN';
  end if;

  if nullif(v_display_name, '') is null
    or char_length(v_display_name) > 100 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_ROLE_DISPLAY_NAME';
  end if;

  if char_length(v_description) > 1000
    or p_sort_order is null
    or p_sort_order not between -100000 and 100000 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_ROLE_METADATA';
  end if;

  if v_reason is null
    or char_length(v_reason) not between 3 and 1000 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_REASON';
  end if;

  v_role_key :=
    'custom_' || replace(p_idempotency_key::text, '-', '');
  v_payload := jsonb_build_object(
    'actorDiscordUserId', v_actor_id,
    'description', v_description,
    'displayName', v_display_name,
    'operation', 'create_team_role',
    'reason', v_reason,
    'sortOrder', p_sort_order
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
    if v_existing_event = 'role_created'
      and v_existing_hash = v_request_hash then
      return v_existing_result;
    end if;

    raise exception using
      errcode = '22023',
      message = 'TEAM_AUTH_IDEMPOTENCY_CONFLICT';
  end if;

  if exists (
    select 1
    from public.team_roles
    where key = v_role_key
  ) then
    raise exception using
      errcode = '23505',
      message = 'TEAM_ROLE_KEY_COLLISION';
  end if;

  insert into public.team_roles (
    key,
    display_name,
    description,
    is_system,
    is_active,
    sort_order,
    row_version,
    created_by_discord_user_id,
    updated_by_discord_user_id
  )
  values (
    v_role_key,
    v_display_name,
    v_description,
    false,
    true,
    p_sort_order,
    1,
    v_actor_id,
    v_actor_id
  );

  v_result := jsonb_build_object(
    'changed', true,
    'role', jsonb_build_object(
      'description', v_description,
      'displayName', v_display_name,
      'isActive', true,
      'isSystem', false,
      'key', v_role_key,
      'rowVersion', 1,
      'sortOrder', p_sort_order
    )
  );

  insert into public.team_authorization_audit (
    idempotency_key,
    request_hash,
    actor_discord_user_id,
    actor_role_key,
    event_type,
    target_role_key,
    before_state,
    after_state,
    reason
  )
  values (
    p_idempotency_key,
    v_request_hash,
    v_actor_id,
    'admin',
    'role_created',
    v_role_key,
    '{}'::jsonb,
    v_result,
    v_reason
  );

  return v_result;
end;
$function$;

create function public.update_team_role(
  p_actor_discord_user_id text,
  p_role_key text,
  p_display_name text,
  p_description text,
  p_sort_order integer,
  p_expected_row_version bigint,
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
  v_role_key text := btrim(p_role_key);
  v_display_name text := btrim(p_display_name);
  v_description text := btrim(coalesce(p_description, ''));
  v_reason text := btrim(p_reason);
  v_actor_role text;
  v_role public.team_roles%rowtype;
  v_payload jsonb;
  v_request_hash text;
  v_existing_event text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_before jsonb;
  v_result jsonb;
begin
  if p_idempotency_key is null then
    raise exception using
      errcode = '22023',
      message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;

  if nullif(v_actor_id, '') is null
    or char_length(v_actor_id) > 100 then
    raise exception using
      errcode = '42501',
      message = 'ACTOR_NOT_ADMIN';
  end if;

  if v_role_key = 'admin' then
    raise exception using
      errcode = '42501',
      message = 'ADMIN_ROLE_IMMUTABLE';
  end if;

  if nullif(v_role_key, '') is null
    or nullif(v_display_name, '') is null
    or char_length(v_display_name) > 100
    or char_length(v_description) > 1000
    or p_sort_order is null
    or p_sort_order not between -100000 and 100000
    or p_expected_row_version is null
    or p_expected_row_version < 1 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_ROLE_UPDATE';
  end if;

  if v_reason is null
    or char_length(v_reason) not between 3 and 1000 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_REASON';
  end if;

  v_payload := jsonb_build_object(
    'actorDiscordUserId', v_actor_id,
    'description', v_description,
    'displayName', v_display_name,
    'expectedRowVersion', p_expected_row_version,
    'operation', 'update_team_role',
    'reason', v_reason,
    'roleKey', v_role_key,
    'sortOrder', p_sort_order
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
    if v_existing_event = 'role_updated'
      and v_existing_hash = v_request_hash then
      return v_existing_result;
    end if;

    raise exception using
      errcode = '22023',
      message = 'TEAM_AUTH_IDEMPOTENCY_CONFLICT';
  end if;

  select *
  into v_role
  from public.team_roles
  where key = v_role_key
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'TEAM_ROLE_NOT_FOUND';
  end if;

  if v_role.row_version <> p_expected_row_version then
    raise exception using
      errcode = '40001',
      message = 'TEAM_ROLE_VERSION_CONFLICT';
  end if;

  if v_role.display_name = v_display_name
    and v_role.description = v_description
    and v_role.sort_order = p_sort_order then
    return jsonb_build_object(
      'changed', false,
      'role', jsonb_build_object(
        'description', v_role.description,
        'displayName', v_role.display_name,
        'isActive', v_role.is_active,
        'isSystem', v_role.is_system,
        'key', v_role.key,
        'rowVersion', v_role.row_version,
        'sortOrder', v_role.sort_order
      )
    );
  end if;

  v_before := jsonb_build_object(
    'description', v_role.description,
    'displayName', v_role.display_name,
    'isActive', v_role.is_active,
    'isSystem', v_role.is_system,
    'key', v_role.key,
    'rowVersion', v_role.row_version,
    'sortOrder', v_role.sort_order
  );

  update public.team_roles
  set display_name = v_display_name,
      description = v_description,
      sort_order = p_sort_order,
      row_version = row_version + 1,
      updated_at = now(),
      updated_by_discord_user_id = v_actor_id
  where key = v_role_key
  returning * into v_role;

  v_result := jsonb_build_object(
    'changed', true,
    'role', jsonb_build_object(
      'description', v_role.description,
      'displayName', v_role.display_name,
      'isActive', v_role.is_active,
      'isSystem', v_role.is_system,
      'key', v_role.key,
      'rowVersion', v_role.row_version,
      'sortOrder', v_role.sort_order
    )
  );

  insert into public.team_authorization_audit (
    idempotency_key,
    request_hash,
    actor_discord_user_id,
    actor_role_key,
    event_type,
    target_role_key,
    before_state,
    after_state,
    reason
  )
  values (
    p_idempotency_key,
    v_request_hash,
    v_actor_id,
    'admin',
    'role_updated',
    v_role_key,
    v_before,
    v_result,
    v_reason
  );

  return v_result;
end;
$function$;

create function public.set_team_role_active(
  p_actor_discord_user_id text,
  p_role_key text,
  p_is_active boolean,
  p_expected_row_version bigint,
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
  v_role_key text := btrim(p_role_key);
  v_reason text := btrim(p_reason);
  v_actor_role text;
  v_role public.team_roles%rowtype;
  v_event_type text;
  v_payload jsonb;
  v_request_hash text;
  v_existing_event text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_before jsonb;
  v_result jsonb;
begin
  if p_idempotency_key is null or p_is_active is null then
    raise exception using
      errcode = '22023',
      message = 'INVALID_ROLE_ACTIVATION_REQUEST';
  end if;

  if nullif(v_actor_id, '') is null
    or char_length(v_actor_id) > 100 then
    raise exception using
      errcode = '42501',
      message = 'ACTOR_NOT_ADMIN';
  end if;

  if v_role_key = 'admin' then
    raise exception using
      errcode = '42501',
      message = 'ADMIN_ROLE_IMMUTABLE';
  end if;

  if nullif(v_role_key, '') is null
    or p_expected_row_version is null
    or p_expected_row_version < 1 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_ROLE_ACTIVATION_REQUEST';
  end if;

  if v_reason is null
    or char_length(v_reason) not between 3 and 1000 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_REASON';
  end if;

  v_event_type := case
    when p_is_active then 'role_activated'
    else 'role_deactivated'
  end;
  v_payload := jsonb_build_object(
    'actorDiscordUserId', v_actor_id,
    'expectedRowVersion', p_expected_row_version,
    'isActive', p_is_active,
    'operation', 'set_team_role_active',
    'reason', v_reason,
    'roleKey', v_role_key
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
    if v_existing_event = v_event_type
      and v_existing_hash = v_request_hash then
      return v_existing_result;
    end if;

    raise exception using
      errcode = '22023',
      message = 'TEAM_AUTH_IDEMPOTENCY_CONFLICT';
  end if;

  select *
  into v_role
  from public.team_roles
  where key = v_role_key
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'TEAM_ROLE_NOT_FOUND';
  end if;

  if v_role.row_version <> p_expected_row_version then
    raise exception using
      errcode = '40001',
      message = 'TEAM_ROLE_VERSION_CONFLICT';
  end if;

  if v_role.is_active = p_is_active then
    return jsonb_build_object(
      'changed', false,
      'isActive', v_role.is_active,
      'roleKey', v_role.key,
      'rowVersion', v_role.row_version
    );
  end if;

  if not p_is_active then
    perform 1
    from public.team_members
    where role = v_role_key
    for update;

    if found then
      raise exception using
        errcode = '23514',
        message = 'TEAM_ROLE_HAS_ASSIGNED_MEMBERS';
    end if;
  end if;

  v_before := jsonb_build_object(
    'isActive', v_role.is_active,
    'roleKey', v_role.key,
    'rowVersion', v_role.row_version
  );

  update public.team_roles
  set is_active = p_is_active,
      row_version = row_version + 1,
      updated_at = now(),
      updated_by_discord_user_id = v_actor_id
  where key = v_role_key
  returning * into v_role;

  v_result := jsonb_build_object(
    'changed', true,
    'isActive', v_role.is_active,
    'roleKey', v_role.key,
    'rowVersion', v_role.row_version
  );

  insert into public.team_authorization_audit (
    idempotency_key,
    request_hash,
    actor_discord_user_id,
    actor_role_key,
    event_type,
    target_role_key,
    before_state,
    after_state,
    reason
  )
  values (
    p_idempotency_key,
    v_request_hash,
    v_actor_id,
    'admin',
    v_event_type,
    v_role_key,
    v_before,
    v_result,
    v_reason
  );

  return v_result;
end;
$function$;

create function public.set_team_role_capability(
  p_actor_discord_user_id text,
  p_role_key text,
  p_capability_key text,
  p_granted boolean,
  p_expected_role_row_version bigint,
  p_expected_capability_implementation_version integer,
  p_expected_capability_definition_hash text,
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
  v_role_key text := btrim(p_role_key);
  v_capability_key text := btrim(p_capability_key);
  v_expected_hash text :=
    btrim(p_expected_capability_definition_hash);
  v_reason text := btrim(p_reason);
  v_actor_role text;
  v_role public.team_roles%rowtype;
  v_capability public.capability_catalog%rowtype;
  v_grant public.team_role_capabilities%rowtype;
  v_has_grant boolean;
  v_event_type text;
  v_payload jsonb;
  v_request_hash text;
  v_existing_event text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_before jsonb;
  v_result jsonb;
begin
  if p_idempotency_key is null or p_granted is null then
    raise exception using
      errcode = '22023',
      message = 'INVALID_CAPABILITY_MUTATION_REQUEST';
  end if;

  if nullif(v_actor_id, '') is null
    or char_length(v_actor_id) > 100 then
    raise exception using
      errcode = '42501',
      message = 'ACTOR_NOT_ADMIN';
  end if;

  if v_role_key = 'admin' then
    raise exception using
      errcode = '42501',
      message = 'ADMIN_CAPABILITY_GRANT_FORBIDDEN';
  end if;

  if nullif(v_role_key, '') is null
    or nullif(v_capability_key, '') is null
    or position('*' in v_capability_key) > 0
    or p_expected_role_row_version is null
    or p_expected_role_row_version < 1
    or p_expected_capability_implementation_version is null
    or p_expected_capability_implementation_version < 1
    or v_expected_hash is null
    or v_expected_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'INVALID_CAPABILITY_MUTATION_REQUEST';
  end if;

  if v_reason is null
    or char_length(v_reason) not between 3 and 1000 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_REASON';
  end if;

  v_event_type := case
    when p_granted then 'capability_granted'
    else 'capability_revoked'
  end;
  v_payload := jsonb_build_object(
    'actorDiscordUserId', v_actor_id,
    'capabilityKey', v_capability_key,
    'expectedCapabilityDefinitionHash', v_expected_hash,
    'expectedCapabilityImplementationVersion',
      p_expected_capability_implementation_version,
    'expectedRoleRowVersion', p_expected_role_row_version,
    'granted', p_granted,
    'operation', 'set_team_role_capability',
    'reason', v_reason,
    'roleKey', v_role_key
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
    if v_existing_event = v_event_type
      and v_existing_hash = v_request_hash then
      return v_existing_result;
    end if;

    raise exception using
      errcode = '22023',
      message = 'TEAM_AUTH_IDEMPOTENCY_CONFLICT';
  end if;

  select *
  into v_role
  from public.team_roles
  where key = v_role_key
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'TEAM_ROLE_NOT_FOUND';
  end if;

  if v_role.row_version <> p_expected_role_row_version then
    raise exception using
      errcode = '40001',
      message = 'TEAM_ROLE_VERSION_CONFLICT';
  end if;

  select *
  into v_capability
  from public.capability_catalog
  where key = v_capability_key
  for share;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'CAPABILITY_NOT_FOUND';
  end if;

  if not v_capability.is_active then
    raise exception using
      errcode = '55000',
      message = 'CAPABILITY_INACTIVE';
  end if;

  if not v_capability.assignable_to_non_admin then
    raise exception using
      errcode = '42501',
      message = 'CAPABILITY_NOT_ASSIGNABLE';
  end if;

  if v_capability.implementation_version <>
      p_expected_capability_implementation_version
    or v_capability.definition_hash <> v_expected_hash then
    raise exception using
      errcode = '40001',
      message = 'CAPABILITY_DEFINITION_CONFLICT';
  end if;

  select *
  into v_grant
  from public.team_role_capabilities
  where role_key = v_role_key
    and capability_key = v_capability_key
  for update;
  v_has_grant := found;

  if v_has_grant = p_granted then
    return jsonb_build_object(
      'capabilityKey', v_capability_key,
      'changed', false,
      'granted', v_has_grant,
      'roleKey', v_role_key,
      'rowVersion', v_role.row_version
    );
  end if;

  v_before := jsonb_build_object(
    'capabilityKey', v_capability_key,
    'granted', v_has_grant,
    'roleKey', v_role_key,
    'rowVersion', v_role.row_version
  );

  if p_granted then
    insert into public.team_role_capabilities (
      role_key,
      capability_key,
      granted_by_discord_user_id,
      grant_reason
    )
    values (
      v_role_key,
      v_capability_key,
      v_actor_id,
      v_reason
    );
  else
    delete from public.team_role_capabilities
    where role_key = v_role_key
      and capability_key = v_capability_key;
  end if;

  update public.team_roles
  set row_version = row_version + 1,
      updated_at = now(),
      updated_by_discord_user_id = v_actor_id
  where key = v_role_key
  returning * into v_role;

  v_result := jsonb_build_object(
    'capabilityKey', v_capability_key,
    'changed', true,
    'granted', p_granted,
    'roleKey', v_role_key,
    'rowVersion', v_role.row_version
  );

  insert into public.team_authorization_audit (
    idempotency_key,
    request_hash,
    actor_discord_user_id,
    actor_role_key,
    event_type,
    target_role_key,
    capability_key,
    before_state,
    after_state,
    reason
  )
  values (
    p_idempotency_key,
    v_request_hash,
    v_actor_id,
    'admin',
    v_event_type,
    v_role_key,
    v_capability_key,
    v_before,
    v_result,
    v_reason
  );

  return v_result;
end;
$function$;

create function public.set_team_member_non_admin_role(
  p_actor_discord_user_id text,
  p_target_discord_user_id text,
  p_new_role_key text,
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
  v_new_role_key text := btrim(p_new_role_key);
  v_expected_role text := btrim(p_expected_previous_role_key);
  v_reason text := btrim(p_reason);
  v_actor_role text;
  v_previous_role text;
  v_new_role public.team_roles%rowtype;
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
    or char_length(v_actor_id) > 100 then
    raise exception using
      errcode = '42501',
      message = 'ACTOR_NOT_ADMIN';
  end if;

  if nullif(v_target_id, '') is null
    or char_length(v_target_id) > 100
    or nullif(v_new_role_key, '') is null
    or nullif(v_expected_role, '') is null then
    raise exception using
      errcode = '22023',
      message = 'INVALID_MEMBER_ROLE_REQUEST';
  end if;

  if v_new_role_key = 'admin'
    or v_expected_role = 'admin' then
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
    'expectedPreviousRoleKey', v_expected_role,
    'newRoleKey', v_new_role_key,
    'operation', 'set_team_member_non_admin_role',
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
    if v_existing_event = 'member_role_changed'
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
      message = 'ADMIN_ROLE_REQUIRES_OWNER_RPC';
  end if;

  if v_previous_role <> v_expected_role then
    raise exception using
      errcode = '40001',
      message = 'TEAM_MEMBER_ROLE_CONFLICT';
  end if;

  select *
  into v_new_role
  from public.team_roles
  where key = v_new_role_key
  for share;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'TEAM_ROLE_NOT_FOUND';
  end if;

  if v_new_role.key = 'admin' then
    raise exception using
      errcode = '42501',
      message = 'ADMIN_ROLE_REQUIRES_OWNER_RPC';
  end if;

  if not v_new_role.is_active then
    raise exception using
      errcode = '55000',
      message = 'TEAM_ROLE_INACTIVE';
  end if;

  if v_previous_role = v_new_role_key then
    return jsonb_build_object(
      'changed', false,
      'newRole', v_previous_role,
      'previousRole', v_previous_role
    );
  end if;

  update public.team_members
  set role = v_new_role_key
  where discord_user_id = v_target_id;

  v_result := jsonb_build_object(
    'changed', true,
    'newRole', v_new_role_key,
    'previousRole', v_previous_role
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
    'member_role_changed',
    v_new_role_key,
    v_target_id,
    jsonb_build_object('previousRole', v_previous_role),
    v_result,
    v_reason
  );

  return v_result;
end;
$function$;

create function public.set_team_member_admin_role(
  p_actor_discord_user_id text,
  p_target_discord_user_id text,
  p_is_admin boolean,
  p_expected_previous_role_key text,
  p_fallback_role_key text,
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
  v_fallback_role text :=
    nullif(btrim(p_fallback_role_key), '');
  v_reason text := btrim(p_reason);
  v_actor_role text;
  v_previous_role text;
  v_new_role text;
  v_fallback public.team_roles%rowtype;
  v_payload jsonb;
  v_request_hash text;
  v_existing_event text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_result jsonb;
begin
  if p_idempotency_key is null or p_is_admin is null then
    raise exception using
      errcode = '22023',
      message = 'INVALID_ADMIN_ROLE_REQUEST';
  end if;

  if nullif(v_actor_id, '') is null
    or char_length(v_actor_id) > 100 then
    raise exception using
      errcode = '42501',
      message = 'ACTOR_NOT_ADMIN';
  end if;

  if nullif(v_target_id, '') is null
    or char_length(v_target_id) > 100
    or nullif(v_expected_role, '') is null then
    raise exception using
      errcode = '22023',
      message = 'INVALID_ADMIN_ROLE_REQUEST';
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
    'fallbackRoleKey', v_fallback_role,
    'isAdmin', p_is_admin,
    'operation', 'set_team_member_admin_role',
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
      'public.team_authorization.admin_population',
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
    if v_existing_event = 'admin_role_changed'
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

  if v_previous_role <> v_expected_role then
    raise exception using
      errcode = '40001',
      message = 'TEAM_MEMBER_ROLE_CONFLICT';
  end if;

  if p_is_admin then
    if v_previous_role = 'admin' then
      raise exception using
        errcode = '40001',
        message = 'TARGET_ALREADY_ADMIN';
    end if;

    v_new_role := 'admin';
  else
    if v_previous_role <> 'admin' then
      raise exception using
        errcode = '40001',
        message = 'TARGET_NOT_ADMIN';
    end if;

    if (
      select count(*)
      from public.team_members
      where role = 'admin'
    ) <= 1 then
      raise exception using
        errcode = '23514',
        message = 'LAST_ADMIN_PROTECTED';
    end if;

    if v_actor_id = v_target_id then
      raise exception using
        errcode = '42501',
        message = 'ADMIN_SELF_DEMOTION_FORBIDDEN';
    end if;

    if v_fallback_role is null
      or v_fallback_role = 'admin' then
      raise exception using
        errcode = '22023',
        message = 'ADMIN_DEMOTION_FALLBACK_REQUIRED';
    end if;

    select *
    into v_fallback
    from public.team_roles
    where key = v_fallback_role
    for share;

    if not found then
      raise exception using
        errcode = 'P0002',
        message = 'TEAM_ROLE_NOT_FOUND';
    end if;

    if not v_fallback.is_active then
      raise exception using
        errcode = '55000',
        message = 'TEAM_ROLE_INACTIVE';
    end if;

    v_new_role := v_fallback_role;
  end if;

  update public.team_members
  set role = v_new_role
  where discord_user_id = v_target_id;

  v_result := jsonb_build_object(
    'changed', true,
    'isAdmin', p_is_admin,
    'newRole', v_new_role,
    'previousRole', v_previous_role
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
    'admin_role_changed',
    v_new_role,
    v_target_id,
    jsonb_build_object(
      'isAdmin', v_previous_role = 'admin',
      'previousRole', v_previous_role
    ),
    v_result,
    v_reason
  );

  return v_result;
end;
$function$;

create or replace function public.set_team_member_role(
  p_actor_discord_user_id text,
  p_target_discord_user_id text,
  p_new_role text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_target_id text := btrim(p_target_discord_user_id);
  v_new_role text := nullif(btrim(p_new_role), '');
  v_reason text := btrim(p_reason);
  v_actor_role text;
  v_previous_role text;
  v_target_username text;
  v_target_user_exists boolean;
  v_member_exists boolean;
  v_idempotency_key uuid := gen_random_uuid();
  v_event_type text;
  v_payload jsonb;
  v_request_hash text;
  v_result jsonb;
begin
  if nullif(v_actor_id, '') is null
    or char_length(v_actor_id) > 100 then
    raise exception using
      errcode = '42501',
      message = 'ACTOR_NOT_ADMIN';
  end if;

  if nullif(v_target_id, '') is null
    or char_length(v_target_id) > 100 then
    raise exception using
      errcode = '22023',
      message = 'TARGET_USER_NOT_FOUND';
  end if;

  if v_reason is null
    or char_length(v_reason) not between 3 and 1000 then
    raise exception using
      errcode = '22023',
      message = 'REASON_REQUIRED';
  end if;

  if p_new_role is not null
    and v_new_role is null then
    raise exception using
      errcode = '22023',
      message = 'INVALID_TEAM_ROLE';
  end if;

  if v_new_role is not null
    and v_new_role not in (
      'trial_moderator',
      'moderator',
      'super_moderator',
      'admin'
    ) then
    raise exception using
      errcode = '22023',
      message = 'INVALID_TEAM_ROLE';
  end if;

  v_payload := jsonb_build_object(
    'actorDiscordUserId', v_actor_id,
    'newRole', v_new_role,
    'operation', 'set_team_member_role_compatibility',
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
    hashtextextended(v_idempotency_key::text, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'public.team_authorization.mutations',
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'public.team_authorization.admin_population',
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

  select role
  into v_previous_role
  from public.team_members
  where discord_user_id = v_target_id
  for update;
  v_member_exists := found;

  select current_discord_username
  into v_target_username
  from public.user_logs
  where discord_user_id = v_target_id;
  v_target_user_exists := found;

  if not v_member_exists and not v_target_user_exists then
    raise exception using
      errcode = 'P0002',
      message = 'TARGET_USER_NOT_FOUND';
  end if;

  if v_new_role is not null
    and not exists (
      select 1
      from public.team_roles
      where key = v_new_role
        and is_active = true
    ) then
    raise exception using
      errcode = '22023',
      message = 'INVALID_TEAM_ROLE';
  end if;

  if v_member_exists
    and v_previous_role = 'admin'
    and v_new_role is distinct from 'admin' then
    if (
      select count(*)
      from public.team_members
      where role = 'admin'
    ) <= 1 then
      raise exception using
        errcode = '23514',
        message = 'LAST_ADMIN_PROTECTED';
    end if;

    if v_actor_id = v_target_id then
      raise exception using
        errcode = '42501',
        message = 'ADMIN_SELF_DEMOTION_FORBIDDEN';
    end if;
  end if;

  if v_new_role is null then
    if not v_member_exists then
      return jsonb_build_object(
        'changed', false,
        'previousRole', null,
        'newRole', null
      );
    end if;

    delete from public.team_members
    where discord_user_id = v_target_id;
  else
    if v_member_exists and v_previous_role = v_new_role then
      return jsonb_build_object(
        'changed', false,
        'previousRole', v_previous_role,
        'newRole', v_previous_role
      );
    end if;

    insert into public.team_members (
      discord_user_id,
      discord_username,
      role
    )
    values (
      v_target_id,
      v_target_username,
      v_new_role
    )
    on conflict (discord_user_id)
    do update set
      role = excluded.role,
      discord_username = coalesce(
        excluded.discord_username,
        public.team_members.discord_username
      );
  end if;

  v_event_type := case
    when v_previous_role = 'admin'
      or v_new_role = 'admin'
      then 'admin_role_changed'
    else 'member_role_changed'
  end;
  v_result := jsonb_build_object(
    'changed', true,
    'previousRole', v_previous_role,
    'newRole', v_new_role
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
    v_idempotency_key,
    v_request_hash,
    v_actor_id,
    'admin',
    v_event_type,
    coalesce(v_new_role, v_previous_role),
    v_target_id,
    jsonb_build_object('previousRole', v_previous_role),
    v_result,
    v_reason
  );

  insert into public.admin_action_logs (
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    meta
  )
  values (
    'admin',
    v_actor_id,
    case
      when v_new_role is null then 'team_member_removed'
      else 'team_member_role_changed'
    end,
    'team_member',
    v_target_id,
    jsonb_build_object(
      'previousRole', v_previous_role,
      'newRole', v_new_role,
      'reason', v_reason
    )
  );

  return v_result;
end;
$function$;

alter function public.create_team_role(
  text, text, text, integer, text, uuid
) owner to postgres;
alter function public.update_team_role(
  text, text, text, text, integer, bigint, text, uuid
) owner to postgres;
alter function public.set_team_role_active(
  text, text, boolean, bigint, text, uuid
) owner to postgres;
alter function public.set_team_role_capability(
  text, text, text, boolean, bigint, integer, text, text, uuid
) owner to postgres;
alter function public.set_team_member_non_admin_role(
  text, text, text, text, text, uuid
) owner to postgres;
alter function public.set_team_member_admin_role(
  text, text, boolean, text, text, text, uuid
) owner to postgres;
alter function public.set_team_member_role(
  text, text, text, text
) owner to postgres;

revoke all on function public.create_team_role(
  text, text, text, integer, text, uuid
) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.update_team_role(
  text, text, text, text, integer, bigint, text, uuid
) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.set_team_role_active(
  text, text, boolean, bigint, text, uuid
) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.set_team_role_capability(
  text, text, text, boolean, bigint, integer, text, text, uuid
) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.set_team_member_non_admin_role(
  text, text, text, text, text, uuid
) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.set_team_member_admin_role(
  text, text, boolean, text, text, text, uuid
) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.set_team_member_role(
  text, text, text, text
) from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.create_team_role(
  text, text, text, integer, text, uuid
) to service_role;
grant execute on function public.update_team_role(
  text, text, text, text, integer, bigint, text, uuid
) to service_role;
grant execute on function public.set_team_role_active(
  text, text, boolean, bigint, text, uuid
) to service_role;
grant execute on function public.set_team_role_capability(
  text, text, text, boolean, bigint, integer, text, text, uuid
) to service_role;
grant execute on function public.set_team_member_non_admin_role(
  text, text, text, text, text, uuid
) to service_role;
grant execute on function public.set_team_member_admin_role(
  text, text, boolean, text, text, text, uuid
) to service_role;
grant execute on function public.set_team_member_role(
  text, text, text, text
) to service_role;

revoke all on table public.team_roles
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.capability_catalog
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.team_role_capabilities
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.team_authorization_audit
  from public, anon, authenticated, discord_bot, service_role;

grant select on table public.team_roles to service_role;
grant select on table public.capability_catalog to service_role;
grant select on table public.team_role_capabilities to service_role;
grant select on table public.team_authorization_audit to service_role;

comment on function public.create_team_role(
  text, text, text, integer, text, uuid
) is
  'Creates an active non-admin role with an immutable custom_<uuid hex> key; service role only.';
comment on function public.update_team_role(
  text, text, text, text, integer, bigint, text, uuid
) is
  'Updates non-admin role metadata with optimistic row-version enforcement and append-only authorization audit; service role only.';
comment on function public.set_team_role_active(
  text, text, boolean, bigint, text, uuid
) is
  'Activates or deactivates an unassigned non-admin role without deleting its capability grants; service role only.';
comment on function public.set_team_role_capability(
  text, text, text, boolean, bigint, integer, text, text, uuid
) is
  'Atomically grants or revokes one registered positive non-admin capability with catalog drift checks; service role only.';
comment on function public.set_team_member_non_admin_role(
  text, text, text, text, text, uuid
) is
  'Changes an existing non-admin team member between active non-admin roles; service role only.';
comment on function public.set_team_member_admin_role(
  text, text, boolean, text, text, text, uuid
) is
  'Dedicated admin promotion/demotion RPC with self-demotion and last-admin protection; service role only.';
comment on function public.set_team_member_role(
  text, text, text, text
) is
  'Deprecated compatibility wrapper preserving the existing four-argument role-management contract while adding hardened locks and append-only authorization audit; service role only.';

commit;

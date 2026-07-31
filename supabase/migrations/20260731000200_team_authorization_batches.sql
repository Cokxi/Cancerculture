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
      message = 'TEAM_AUTHORIZATION_BATCH_DEPENDENCY_MISSING';
  end if;

  if to_regclass('public.team_authorization_batches') is not null
    or exists (
      select 1
      from pg_proc function_row
      join pg_namespace namespace_row
        on namespace_row.oid = function_row.pronamespace
      where namespace_row.nspname = 'public'
        and function_row.proname in (
          'apply_team_role_capability_changes',
          'protect_team_authorization_batches'
        )
    )
  then
    raise exception using
      errcode = '42P07',
      message = 'TEAM_AUTHORIZATION_BATCH_OBJECT_ALREADY_EXISTS';
  end if;

  if to_regprocedure(
    'public.set_team_role_capability(text,text,text,boolean,bigint,integer,text,text,uuid)'
  ) is null
    or to_regprocedure(
      'public.set_team_role_active(text,text,boolean,bigint,text,uuid)'
    ) is null
    or to_regprocedure(
      'public.update_team_role(text,text,text,text,integer,bigint,text,uuid)'
    ) is null
  then
    raise exception using
      errcode = '42883',
      message = 'TEAM_AUTHORIZATION_BATCH_MUTATION_DEPENDENCY_MISSING';
  end if;

  if to_regprocedure(
    'public.protect_team_authorization_audit()'
  ) is null
    or to_regprocedure('extensions.digest(bytea,text)') is null
    or to_regprocedure('gen_random_uuid()') is null
  then
    raise exception using
      errcode = '42883',
      message = 'TEAM_AUTHORIZATION_BATCH_HELPER_MISSING';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'team_authorization_audit'
      and column_name = 'request_id'
      and data_type = 'text'
      and is_nullable = 'YES'
  )
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'team_authorization_audit'
        and column_name = 'request_hash'
        and data_type = 'text'
        and is_nullable = 'NO'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'TEAM_AUTHORIZATION_AUDIT_CORRELATION_DRIFT';
  end if;

  if exists (
    select 1
    from public.team_role_capabilities
    where role_key = 'admin'
  ) then
    raise exception using
      errcode = '55000',
      message = 'ADMIN_CAPABILITY_GRANT_PRESENT';
  end if;
end;
$preflight$;

create table public.team_authorization_batches (
  batch_id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  actor_discord_user_id text not null,
  request_hash text not null,
  request_payload jsonb not null,
  result jsonb not null,
  reason text not null,
  operation_version integer not null default 1,
  submitted_pair_count integer not null,
  changed_pair_count integer not null,
  noop_pair_count integer not null,
  grant_count integer not null,
  revoke_count integer not null,
  affected_role_count integer not null,
  created_at timestamptz not null default now(),
  constraint team_authorization_batches_actor_check
    check (
      char_length(btrim(actor_discord_user_id)) between 1 and 100
    ),
  constraint team_authorization_batches_request_hash_check
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint team_authorization_batches_request_payload_check
    check (jsonb_typeof(request_payload) = 'object'),
  constraint team_authorization_batches_result_check
    check (jsonb_typeof(result) = 'object'),
  constraint team_authorization_batches_reason_check
    check (char_length(btrim(reason)) between 3 and 1000),
  constraint team_authorization_batches_operation_version_check
    check (operation_version = 1),
  constraint team_authorization_batches_counts_check
    check (
      submitted_pair_count between 1 and 500
      and changed_pair_count >= 0
      and noop_pair_count >= 0
      and grant_count >= 0
      and revoke_count >= 0
      and affected_role_count >= 0
      and submitted_pair_count =
        changed_pair_count + noop_pair_count
      and changed_pair_count = grant_count + revoke_count
      and affected_role_count <= changed_pair_count
    )
);

alter table public.team_authorization_batches owner to postgres;

create function public.protect_team_authorization_batches()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'TEAM_AUTHORIZATION_BATCH_IMMUTABLE';
end;
$function$;

alter function public.protect_team_authorization_batches()
  owner to postgres;

create trigger protect_team_authorization_batches
before update or delete on public.team_authorization_batches
for each row
execute function public.protect_team_authorization_batches();

create index team_authorization_audit_request_id_idx
  on public.team_authorization_audit (request_id)
  where request_id is not null;

create function public.apply_team_role_capability_changes(
  p_actor_discord_user_id text,
  p_role_snapshots jsonb,
  p_capability_snapshots jsonb,
  p_changes jsonb,
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
  v_reason text := btrim(p_reason);
  v_item jsonb;
  v_canonical_roles jsonb;
  v_canonical_capabilities jsonb;
  v_canonical_changes jsonb;
  v_role_keys text[];
  v_change_role_keys text[];
  v_capability_keys text[];
  v_change_capability_keys text[];
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_batch_id uuid;
  v_actor_role text;
  v_role public.team_roles%rowtype;
  v_capability public.capability_catalog%rowtype;
  v_locked_count integer;
  v_change_plan jsonb;
  v_submitted_count integer;
  v_changed_count integer;
  v_noop_count integer;
  v_grant_count integer;
  v_revoke_count integer;
  v_affected_roles jsonb;
  v_affected_role_count integer;
  v_result jsonb;
  v_plan_item jsonb;
  v_role_key text;
  v_capability_key text;
  v_desired_granted boolean;
  v_had_grant boolean;
  v_row_version_before bigint;
  v_row_version_after bigint;
begin
  if p_idempotency_key is null then
    raise exception using
      errcode = '22023',
      message = 'INVALID_CAPABILITY_BATCH_REQUEST';
  end if;

  if nullif(v_actor_id, '') is null
    or char_length(v_actor_id) > 100 then
    raise exception using
      errcode = '42501',
      message = 'ACTOR_NOT_ADMIN';
  end if;

  if v_reason is null
    or char_length(v_reason) not between 3 and 1000 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_REASON';
  end if;

  if jsonb_typeof(p_role_snapshots) is distinct from 'array'
    or jsonb_typeof(p_capability_snapshots) is distinct from 'array'
    or jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception using
      errcode = '22023',
      message = 'INVALID_CAPABILITY_BATCH_SHAPE';
  end if;

  v_submitted_count := jsonb_array_length(p_changes);

  if v_submitted_count = 0 then
    raise exception using
      errcode = '22023',
      message = 'CAPABILITY_BATCH_EMPTY';
  end if;

  if v_submitted_count > 500
    or jsonb_array_length(p_role_snapshots) > 500
    or jsonb_array_length(p_capability_snapshots) > 500 then
    raise exception using
      errcode = '22023',
      message = 'CAPABILITY_BATCH_TOO_LARGE';
  end if;

  for v_item in
    select item.value
    from jsonb_array_elements(p_role_snapshots) as item(value)
  loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or not (
        v_item ?& array['role_key', 'expected_row_version']
      )
      or exists (
        select 1
        from jsonb_object_keys(v_item) as object_key(key_name)
        where key_name <> all (
          array['role_key', 'expected_row_version']::text[]
        )
      )
      or jsonb_typeof(v_item -> 'role_key') is distinct from 'string'
      or btrim(v_item ->> 'role_key')
        !~ '^[a-z][a-z0-9_]{2,63}$'
      or jsonb_typeof(v_item -> 'expected_row_version')
        is distinct from 'number'
      or (v_item ->> 'expected_row_version')
        !~ '^[1-9][0-9]{0,17}$' then
      raise exception using
        errcode = '22023',
        message = 'INVALID_ROLE_SNAPSHOT_SHAPE';
    end if;
  end loop;

  for v_item in
    select item.value
    from jsonb_array_elements(p_capability_snapshots)
      as item(value)
  loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or not (
        v_item ?& array[
          'capability_key',
          'expected_implementation_version',
          'expected_definition_hash'
        ]
      )
      or exists (
        select 1
        from jsonb_object_keys(v_item) as object_key(key_name)
        where key_name <> all (
          array[
            'capability_key',
            'expected_implementation_version',
            'expected_definition_hash'
          ]::text[]
        )
      )
      or jsonb_typeof(v_item -> 'capability_key')
        is distinct from 'string'
      or btrim(v_item ->> 'capability_key')
        !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
      or char_length(btrim(v_item ->> 'capability_key')) > 128
      or jsonb_typeof(
        v_item -> 'expected_implementation_version'
      ) is distinct from 'number'
      or (v_item ->> 'expected_implementation_version')
        !~ '^[1-9][0-9]{0,8}$'
      or jsonb_typeof(v_item -> 'expected_definition_hash')
        is distinct from 'string'
      or btrim(v_item ->> 'expected_definition_hash')
        !~ '^[0-9a-f]{64}$' then
      raise exception using
        errcode = '22023',
        message = 'INVALID_CAPABILITY_SNAPSHOT_SHAPE';
    end if;
  end loop;

  for v_item in
    select item.value
    from jsonb_array_elements(p_changes) as item(value)
  loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or not (
        v_item ?& array[
          'role_key',
          'capability_key',
          'desired_granted'
        ]
      )
      or exists (
        select 1
        from jsonb_object_keys(v_item) as object_key(key_name)
        where key_name <> all (
          array[
            'role_key',
            'capability_key',
            'desired_granted'
          ]::text[]
        )
      )
      or jsonb_typeof(v_item -> 'role_key') is distinct from 'string'
      or btrim(v_item ->> 'role_key')
        !~ '^[a-z][a-z0-9_]{2,63}$'
      or jsonb_typeof(v_item -> 'capability_key')
        is distinct from 'string'
      or btrim(v_item ->> 'capability_key')
        !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
      or char_length(btrim(v_item ->> 'capability_key')) > 128
      or jsonb_typeof(v_item -> 'desired_granted')
        is distinct from 'boolean' then
      raise exception using
        errcode = '22023',
        message = 'INVALID_CAPABILITY_CHANGE_SHAPE';
    end if;
  end loop;

  select jsonb_agg(
    jsonb_build_object(
      'role_key', btrim(item.value ->> 'role_key'),
      'expected_row_version',
        (item.value ->> 'expected_row_version')::bigint
    )
    order by btrim(item.value ->> 'role_key')
  )
  into v_canonical_roles
  from jsonb_array_elements(p_role_snapshots) as item(value);

  select jsonb_agg(
    jsonb_build_object(
      'capability_key',
        btrim(item.value ->> 'capability_key'),
      'expected_implementation_version',
        (
          item.value ->> 'expected_implementation_version'
        )::integer,
      'expected_definition_hash',
        btrim(item.value ->> 'expected_definition_hash')
    )
    order by btrim(item.value ->> 'capability_key')
  )
  into v_canonical_capabilities
  from jsonb_array_elements(p_capability_snapshots) as item(value);

  select jsonb_agg(
    jsonb_build_object(
      'role_key', btrim(item.value ->> 'role_key'),
      'capability_key',
        btrim(item.value ->> 'capability_key'),
      'desired_granted',
        (item.value ->> 'desired_granted')::boolean
    )
    order by
      btrim(item.value ->> 'role_key'),
      btrim(item.value ->> 'capability_key')
  )
  into v_canonical_changes
  from jsonb_array_elements(p_changes) as item(value);

  if jsonb_array_length(v_canonical_roles) <> (
    select count(distinct snapshot.role_key)
    from jsonb_to_recordset(v_canonical_roles)
      as snapshot(role_key text, expected_row_version bigint)
  ) then
    raise exception using
      errcode = '22023',
      message = 'DUPLICATE_ROLE_SNAPSHOT';
  end if;

  if jsonb_array_length(v_canonical_capabilities) <> (
    select count(distinct snapshot.capability_key)
    from jsonb_to_recordset(v_canonical_capabilities)
      as snapshot(
        capability_key text,
        expected_implementation_version integer,
        expected_definition_hash text
      )
  ) then
    raise exception using
      errcode = '22023',
      message = 'DUPLICATE_CAPABILITY_SNAPSHOT';
  end if;

  if jsonb_array_length(v_canonical_changes) <> (
    select count(
      distinct (change_row.role_key, change_row.capability_key)
    )
    from jsonb_to_recordset(v_canonical_changes)
      as change_row(
        role_key text,
        capability_key text,
        desired_granted boolean
      )
  ) then
    raise exception using
      errcode = '22023',
      message = 'DUPLICATE_CAPABILITY_CHANGE';
  end if;

  select coalesce(
    array_agg(snapshot.role_key order by snapshot.role_key),
    '{}'::text[]
  )
  into v_role_keys
  from jsonb_to_recordset(v_canonical_roles)
    as snapshot(role_key text, expected_row_version bigint);

  select coalesce(
    array_agg(change_roles.role_key order by change_roles.role_key),
    '{}'::text[]
  )
  into v_change_role_keys
  from (
    select distinct change_row.role_key
    from jsonb_to_recordset(v_canonical_changes)
      as change_row(
        role_key text,
        capability_key text,
        desired_granted boolean
      )
  ) as change_roles;

  select coalesce(
    array_agg(
      snapshot.capability_key
      order by snapshot.capability_key
    ),
    '{}'::text[]
  )
  into v_capability_keys
  from jsonb_to_recordset(v_canonical_capabilities)
    as snapshot(
      capability_key text,
      expected_implementation_version integer,
      expected_definition_hash text
    );

  select coalesce(
    array_agg(
      change_capabilities.capability_key
      order by change_capabilities.capability_key
    ),
    '{}'::text[]
  )
  into v_change_capability_keys
  from (
    select distinct change_row.capability_key
    from jsonb_to_recordset(v_canonical_changes)
      as change_row(
        role_key text,
        capability_key text,
        desired_granted boolean
      )
  ) as change_capabilities;

  if v_role_keys <> v_change_role_keys then
    raise exception using
      errcode = '22023',
      message = 'CAPABILITY_BATCH_ROLE_SNAPSHOT_MISMATCH';
  end if;

  if v_capability_keys <> v_change_capability_keys then
    raise exception using
      errcode = '22023',
      message = 'CAPABILITY_BATCH_CAPABILITY_SNAPSHOT_MISMATCH';
  end if;

  if 'admin' = any(v_change_role_keys) then
    raise exception using
      errcode = '42501',
      message = 'ADMIN_CAPABILITY_GRANT_FORBIDDEN';
  end if;

  v_request_payload := jsonb_build_object(
    'operation', 'apply_team_role_capability_changes',
    'operationVersion', 1,
    'actorDiscordUserId', v_actor_id,
    'roleSnapshots', v_canonical_roles,
    'capabilitySnapshots', v_canonical_capabilities,
    'changes', v_canonical_changes,
    'reason', v_reason
  );
  v_request_hash := encode(
    extensions.digest(
      convert_to(v_request_payload::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(p_idempotency_key::text, 0)
  );

  select request_hash, result
  into v_existing_hash, v_existing_result
  from public.team_authorization_batches
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(
        v_existing_result,
        '{replayed}',
        'true'::jsonb
      );
    end if;

    raise exception using
      errcode = '22023',
      message = 'TEAM_AUTH_IDEMPOTENCY_CONFLICT';
  end if;

  if exists (
    select 1
    from public.team_authorization_audit
    where idempotency_key = p_idempotency_key
  ) then
    raise exception using
      errcode = '22023',
      message = 'TEAM_AUTH_IDEMPOTENCY_CONFLICT';
  end if;

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

  v_locked_count := 0;
  for v_role in
    select role_row.*
    from public.team_roles as role_row
    join jsonb_to_recordset(v_canonical_roles)
      as snapshot(role_key text, expected_row_version bigint)
      on snapshot.role_key = role_row.key
    order by role_row.key
    for update of role_row
  loop
    v_locked_count := v_locked_count + 1;

    if not v_role.is_active then
      raise exception using
        errcode = '55000',
        message = 'TEAM_ROLE_INACTIVE';
    end if;

    if v_role.row_version <> (
      select snapshot.expected_row_version
      from jsonb_to_recordset(v_canonical_roles)
        as snapshot(role_key text, expected_row_version bigint)
      where snapshot.role_key = v_role.key
    ) then
      raise exception using
        errcode = '40001',
        message = 'TEAM_ROLE_VERSION_CONFLICT';
    end if;
  end loop;

  if v_locked_count <> jsonb_array_length(v_canonical_roles) then
    raise exception using
      errcode = 'P0002',
      message = 'TEAM_ROLE_NOT_FOUND';
  end if;

  v_locked_count := 0;
  for v_capability in
    select capability_row.*
    from public.capability_catalog as capability_row
    join jsonb_to_recordset(v_canonical_capabilities)
      as snapshot(
        capability_key text,
        expected_implementation_version integer,
        expected_definition_hash text
      )
      on snapshot.capability_key = capability_row.key
    order by capability_row.key
    for share of capability_row
  loop
    v_locked_count := v_locked_count + 1;

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

    if (
      select snapshot.expected_implementation_version
      from jsonb_to_recordset(v_canonical_capabilities)
        as snapshot(
          capability_key text,
          expected_implementation_version integer,
          expected_definition_hash text
        )
      where snapshot.capability_key = v_capability.key
    ) <> v_capability.implementation_version then
      raise exception using
        errcode = '40001',
        message = 'CAPABILITY_IMPLEMENTATION_VERSION_CONFLICT';
    end if;

    if (
      select snapshot.expected_definition_hash
      from jsonb_to_recordset(v_canonical_capabilities)
        as snapshot(
          capability_key text,
          expected_implementation_version integer,
          expected_definition_hash text
        )
      where snapshot.capability_key = v_capability.key
    ) <> v_capability.definition_hash then
      raise exception using
        errcode = '40001',
        message = 'CAPABILITY_DEFINITION_CONFLICT';
    end if;
  end loop;

  if v_locked_count <>
      jsonb_array_length(v_canonical_capabilities) then
    raise exception using
      errcode = 'P0002',
      message = 'CAPABILITY_NOT_FOUND';
  end if;

  perform grant_row.role_key
  from public.team_role_capabilities as grant_row
  join jsonb_to_recordset(v_canonical_changes)
    as change_row(
      role_key text,
      capability_key text,
      desired_granted boolean
    )
    on change_row.role_key = grant_row.role_key
    and change_row.capability_key = grant_row.capability_key
  order by grant_row.role_key, grant_row.capability_key
  for update of grant_row;

  select jsonb_agg(
    jsonb_build_object(
      'role_key', change_row.role_key,
      'capability_key', change_row.capability_key,
      'desired_granted', change_row.desired_granted,
      'had_grant', exists (
        select 1
        from public.team_role_capabilities as grant_row
        where grant_row.role_key = change_row.role_key
          and grant_row.capability_key =
            change_row.capability_key
      )
    )
    order by change_row.role_key, change_row.capability_key
  )
  into v_change_plan
  from jsonb_to_recordset(v_canonical_changes)
    as change_row(
      role_key text,
      capability_key text,
      desired_granted boolean
    );

  select
    count(*) filter (
      where plan.had_grant is distinct from plan.desired_granted
    ),
    count(*) filter (
      where plan.had_grant is not distinct from plan.desired_granted
    ),
    count(*) filter (
      where not plan.had_grant and plan.desired_granted
    ),
    count(*) filter (
      where plan.had_grant and not plan.desired_granted
    )
  into
    v_changed_count,
    v_noop_count,
    v_grant_count,
    v_revoke_count
  from jsonb_to_recordset(v_change_plan)
    as plan(
      role_key text,
      capability_key text,
      desired_granted boolean,
      had_grant boolean
    );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'roleKey', changed_role.role_key,
        'rowVersion', changed_role.expected_row_version + 1
      )
      order by changed_role.role_key
    ),
    '[]'::jsonb
  )
  into v_affected_roles
  from (
    select distinct
      plan.role_key,
      snapshot.expected_row_version
    from jsonb_to_recordset(v_change_plan)
      as plan(
        role_key text,
        capability_key text,
        desired_granted boolean,
        had_grant boolean
      )
    join jsonb_to_recordset(v_canonical_roles)
      as snapshot(role_key text, expected_row_version bigint)
      on snapshot.role_key = plan.role_key
    where plan.had_grant is distinct from plan.desired_granted
  ) as changed_role;

  v_affected_role_count := jsonb_array_length(v_affected_roles);
  v_batch_id := gen_random_uuid();
  v_result := jsonb_build_object(
    'operation', 'apply_team_role_capability_changes',
    'batchId', v_batch_id,
    'replayed', false,
    'submittedCount', v_submitted_count,
    'changedCount', v_changed_count,
    'noopCount', v_noop_count,
    'grantCount', v_grant_count,
    'revokeCount', v_revoke_count,
    'affectedRoles', v_affected_roles
  );

  insert into public.team_authorization_batches (
    batch_id,
    idempotency_key,
    actor_discord_user_id,
    request_hash,
    request_payload,
    result,
    reason,
    operation_version,
    submitted_pair_count,
    changed_pair_count,
    noop_pair_count,
    grant_count,
    revoke_count,
    affected_role_count
  )
  values (
    v_batch_id,
    p_idempotency_key,
    v_actor_id,
    v_request_hash,
    v_request_payload,
    v_result,
    v_reason,
    1,
    v_submitted_count,
    v_changed_count,
    v_noop_count,
    v_grant_count,
    v_revoke_count,
    v_affected_role_count
  );

  update public.team_roles as role_row
  set row_version = role_row.row_version + 1,
      updated_at = now(),
      updated_by_discord_user_id = v_actor_id
  where exists (
    select 1
    from jsonb_to_recordset(v_change_plan)
      as plan(
        role_key text,
        capability_key text,
        desired_granted boolean,
        had_grant boolean
      )
    where plan.role_key = role_row.key
      and plan.had_grant is distinct from plan.desired_granted
  );

  for v_plan_item in
    select item.value
    from jsonb_array_elements(v_change_plan) as item(value)
    where (item.value ->> 'had_grant')::boolean
      is distinct from
      (item.value ->> 'desired_granted')::boolean
    order by
      item.value ->> 'role_key',
      item.value ->> 'capability_key'
  loop
    v_role_key := v_plan_item ->> 'role_key';
    v_capability_key := v_plan_item ->> 'capability_key';
    v_desired_granted :=
      (v_plan_item ->> 'desired_granted')::boolean;
    v_had_grant := (v_plan_item ->> 'had_grant')::boolean;

    select snapshot.expected_row_version
    into v_row_version_before
    from jsonb_to_recordset(v_canonical_roles)
      as snapshot(role_key text, expected_row_version bigint)
    where snapshot.role_key = v_role_key;
    v_row_version_after := v_row_version_before + 1;

    if v_desired_granted then
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
      reason,
      request_id
    )
    values (
      gen_random_uuid(),
      v_request_hash,
      v_actor_id,
      'admin',
      case
        when v_desired_granted then 'capability_granted'
        else 'capability_revoked'
      end,
      v_role_key,
      v_capability_key,
      jsonb_build_object(
        'roleKey', v_role_key,
        'capabilityKey', v_capability_key,
        'granted', v_had_grant,
        'rowVersion', v_row_version_before,
        'batchId', v_batch_id
      ),
      jsonb_build_object(
        'roleKey', v_role_key,
        'capabilityKey', v_capability_key,
        'changed', true,
        'granted', v_desired_granted,
        'rowVersion', v_row_version_after,
        'batchId', v_batch_id
      ),
      v_reason,
      v_batch_id::text
    );
  end loop;

  return v_result;
end;
$function$;

alter function public.apply_team_role_capability_changes(
  text, jsonb, jsonb, jsonb, text, uuid
) owner to postgres;

revoke all on function public.apply_team_role_capability_changes(
  text, jsonb, jsonb, jsonb, text, uuid
) from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.apply_team_role_capability_changes(
  text, jsonb, jsonb, jsonb, text, uuid
) to service_role;

revoke all on function public.protect_team_authorization_batches()
  from public, anon, authenticated, discord_bot, service_role;

alter table public.team_authorization_batches enable row level security;
revoke all on table public.team_authorization_batches
  from public, anon, authenticated, discord_bot, service_role;
grant select on table public.team_authorization_batches
  to service_role;

comment on table public.team_authorization_batches is
  'Append-only idempotency and replay ledger for atomic non-admin role capability batches.';
comment on column public.team_authorization_batches.request_hash is
  'Lowercase SHA-256 of the normalized, order-independent canonical jsonb batch request.';
comment on column public.team_authorization_audit.request_id is
  'Optional request correlation identifier. Capability batch audit rows store their shared batch UUID as text.';
comment on function public.apply_team_role_capability_changes(
  text, jsonb, jsonb, jsonb, text, uuid
) is
  'Atomically applies a bounded, snapshot-checked capability grant/revoke batch for active non-admin roles; service role only.';

commit;

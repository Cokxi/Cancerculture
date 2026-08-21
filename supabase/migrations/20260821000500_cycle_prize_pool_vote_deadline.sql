begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 43
    or (select count(*) from public.capability_catalog where is_active) <> 39
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'cycles.manage'
        and is_active
        and implementation_version = 1
        and definition_hash =
          '4f3e07f01bc453f594994689c3049e698ca2bd1d1c99e75927d161056033f710'
    )
    or to_regprocedure('public.assert_cycle_manager(text)') is null
    or to_regprocedure('public.manage_cycle_prize_pool(text,uuid,bigint,bigint,text,bigint,text,uuid,text)') is null
    or to_regprocedure('public.finalize_cycle_without_prize_pool(bigint,text)') is null
    or to_regprocedure('public.finalize_cycle(bigint,text)') is null
    or to_regclass('public.cycle_prize_pools') is null
    or to_regclass('public.cycle_prize_pool_components') is null
  then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_PRIZE_POOL_DEADLINE_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

create function public.is_cycle_prize_pool_editable(
  p_cycle_id bigint,
  p_database_time timestamptz default transaction_timestamp()
)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $function$
  select exists (
    select 1
    from public.voting_cycles cycle
    where cycle.id = p_cycle_id
      and cycle.id = (select max(current_cycle.id) from public.voting_cycles current_cycle)
      and (
        cycle.status::text in (
          'submission_open',
          'submission_closed',
          'voting_open'
        )
        or (
          cycle.status::text = 'paused'
          and cycle.paused_from_status::text = 'submission_open'
        )
        or (
          cycle.status::text = 'paused'
          and cycle.paused_from_status::text = 'voting_open'
          and (
            cycle.phase_paused_remaining_seconds is null
            or cycle.phase_paused_remaining_seconds > 0
          )
        )
      )
      and (
        cycle.status::text <> 'voting_open'
        or cycle.voting_ends_at is null
        or cycle.voting_ends_at > p_database_time
      )
  );
$function$;

create function public.guard_cycle_prize_pool_lifecycle()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_cycle_status text;
begin
  select cycle.status::text
  into v_cycle_status
  from public.voting_cycles cycle
  where cycle.id = new.cycle_id;

  if tg_op = 'INSERT' then
    if new.state <> 'running'
      or not public.is_cycle_prize_pool_editable(
        new.cycle_id,
        transaction_timestamp()
      ) then
      raise exception using
        errcode = 'PT409',
        message = 'CYCLE_PRIZE_POOL_RETROACTIVE_CHANGE_FORBIDDEN';
    end if;
  elsif new.announced_lamports is distinct from old.announced_lamports then
    if not public.is_cycle_prize_pool_editable(
      new.cycle_id,
      transaction_timestamp()
    ) then
      raise exception using
        errcode = 'PT409',
        message = 'CYCLE_PRIZE_POOL_RETROACTIVE_CHANGE_FORBIDDEN';
    end if;
  end if;

  if new.state = 'amount_pending' and old.state is distinct from new.state then
    raise exception using
      errcode = 'PT409',
      message = 'CYCLE_PRIZE_POOL_AMOUNT_PENDING_FORBIDDEN';
  end if;

  if tg_op = 'UPDATE'
    and old.state = 'running'
    and new.state = 'locked'
    and v_cycle_status <> 'finished' then
    raise exception using
      errcode = 'PT409',
      message = 'CYCLE_PRIZE_POOL_EARLY_LOCK_FORBIDDEN';
  end if;

  return new;
end;
$function$;

create trigger cycle_prize_pool_lifecycle_guard
before insert or update on public.cycle_prize_pools
for each row execute function public.guard_cycle_prize_pool_lifecycle();

alter table public.cycle_prize_pool_components
  drop constraint cycle_prize_pool_component_shape_check;

alter table public.cycle_prize_pool_components
  add constraint cycle_prize_pool_component_shape_check check (
    (component_kind = 'base' and replaces_component_id is null and source_payout_line_id is null)
    or (component_kind = 'determination' and replaces_component_id is null and source_payout_line_id is null)
    or (component_kind = 'supplement' and replaces_component_id is null and source_payout_line_id is null)
    or (component_kind = 'replacement' and replaces_component_id is not null and source_payout_line_id is null)
    or (component_kind = 'rollover' and replaces_component_id is null and source_payout_line_id is not null)
  );

create function public.guard_cycle_prize_pool_component_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if new.component_kind in ('determination', 'supplement', 'replacement') then
    raise exception using
      errcode = 'PT409',
      message = 'CYCLE_PRIZE_POOL_RETROACTIVE_CHANGE_FORBIDDEN';
  end if;

  if new.component_kind = 'base' then
    if not exists (
      select 1
      from public.voting_cycles cycle
      join public.cycle_prize_pools pool on pool.cycle_id = cycle.id
      where cycle.id = new.cycle_id
        and cycle.status::text = 'finished'
        and pool.state = 'locked'
        and pool.announced_lamports is not null
        and pool.finalized_at is not null
    ) then
      raise exception using
        errcode = 'PT409',
        message = 'CYCLE_PRIZE_POOL_BASE_COMPONENT_INVALID';
    end if;
  elsif new.component_kind = 'rollover' then
    if not public.is_cycle_prize_pool_editable(
      new.cycle_id,
      transaction_timestamp()
    ) then
      raise exception using
        errcode = 'PT409',
        message = 'PAYOUT_ROLLOVER_TARGET_INVALID';
    end if;
  end if;

  return new;
end;
$function$;

create trigger cycle_prize_pool_component_insert_guard
before insert on public.cycle_prize_pool_components
for each row execute function public.guard_cycle_prize_pool_component_insert();

revoke all on function
  public.manage_cycle_prize_pool(text,uuid,bigint,bigint,text,bigint,text,uuid,text)
  from public, anon, authenticated, discord_bot, service_role;

drop function public.manage_cycle_prize_pool(
  text,
  uuid,
  bigint,
  bigint,
  text,
  bigint,
  text,
  uuid,
  text
);

create function public.manage_current_cycle_prize_pool(
  p_actor_discord_user_id text,
  p_request_id uuid,
  p_cycle_id bigint,
  p_expected_version bigint,
  p_amount_lamports bigint,
  p_confirmed_amount_lamports bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_actor_role text;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_cycle public.voting_cycles%rowtype;
  v_pool public.cycle_prize_pools%rowtype;
  v_result jsonb;
  v_event_type text;
begin
  if p_request_id is null
    or p_cycle_id is null
    or p_cycle_id <= 0
    or p_expected_version is null
    or p_expected_version < 0
    or p_amount_lamports is null
    or p_amount_lamports <= 0
    or p_confirmed_amount_lamports is null
    or p_confirmed_amount_lamports <> p_amount_lamports then
    raise exception using
      errcode = '22023',
      message = 'CYCLE_PRIZE_POOL_CONFIRMATION_INVALID';
  end if;

  v_actor_role := public.assert_cycle_manager(v_actor_id);
  v_request_payload := jsonb_build_object(
    'operationVersion', 2,
    'operation', 'set_current_cycle_prize_pool',
    'actorDiscordUserId', v_actor_id,
    'cycleId', p_cycle_id,
    'expectedVersion', p_expected_version,
    'amountLamports', p_amount_lamports::text,
    'confirmedAmountLamports', p_confirmed_amount_lamports::text
  );
  v_request_hash := encode(
    extensions.digest(
      convert_to(v_request_payload::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  select request_hash, result
  into v_existing_hash, v_existing_result
  from public.cycle_management_requests
  where idempotency_key = p_request_id;

  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_result, '{replayed}', 'true'::jsonb);
    end if;
    raise exception using
      errcode = 'PT409',
      message = 'CYCLE_PRIZE_POOL_REQUEST_REUSED';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cycle-phase-automation-global', 0)
  );
  select cycle.*
  into v_cycle
  from public.voting_cycles cycle
  where cycle.id = p_cycle_id
  for update;

  if not found then
    raise exception using
      errcode = 'PT409',
      message = 'CYCLE_PRIZE_POOL_CYCLE_NOT_FOUND';
  end if;

  if not public.is_cycle_prize_pool_editable(
    p_cycle_id,
    transaction_timestamp()
  ) then
    raise exception using
      errcode = 'PT409',
      message = 'CYCLE_PRIZE_POOL_DEADLINE_PASSED';
  end if;

  select pool.*
  into v_pool
  from public.cycle_prize_pools pool
  where pool.cycle_id = p_cycle_id
  for update;

  if found then
    if v_pool.state <> 'running'
      or v_pool.row_version <> p_expected_version then
      raise exception using
        errcode = 'PT409',
        message = 'CYCLE_PRIZE_POOL_STATE_CHANGED';
    end if;
    update public.cycle_prize_pools
    set announced_lamports = p_amount_lamports,
        row_version = row_version + 1,
        updated_at = transaction_timestamp()
    where cycle_id = p_cycle_id
    returning * into v_pool;
    v_event_type := 'pool_changed';
  else
    if p_expected_version <> 0 then
      raise exception using
        errcode = 'PT409',
        message = 'CYCLE_PRIZE_POOL_STATE_CHANGED';
    end if;
    insert into public.cycle_prize_pools(
      cycle_id,
      announced_lamports,
      state
    ) values (
      p_cycle_id,
      p_amount_lamports,
      'running'
    )
    returning * into v_pool;
    v_event_type := 'pool_created';
  end if;

  insert into public.payout_events(
    event_type,
    actor_discord_user_id,
    target_type,
    target_public_id,
    target_version,
    request_id,
    details
  ) values (
    v_event_type,
    v_actor_id,
    'pool',
    v_pool.public_id,
    v_pool.row_version,
    p_request_id,
    jsonb_build_object(
      'cycleId', p_cycle_id,
      'amountLamports', v_pool.announced_lamports::text,
      'authorizationRole', v_actor_role
    )
  );

  v_result := jsonb_build_object(
    'outcome', 'saved',
    'requestId', p_request_id,
    'cycleId', p_cycle_id,
    'rowVersion', v_pool.row_version,
    'amountLamports', v_pool.announced_lamports::text,
    'replayed', false
  );
  insert into public.cycle_management_requests(
    idempotency_key,
    actor_discord_user_id,
    request_hash,
    request_payload,
    result
  ) values (
    p_request_id,
    v_actor_id,
    v_request_hash,
    v_request_payload,
    v_result
  );

  return v_result;
end;
$function$;

create function public.get_cycle_prize_pool_management_context(
  p_actor_discord_user_id text,
  p_cycle_id bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_role text;
  v_context jsonb;
begin
  v_actor_role := public.assert_cycle_manager(p_actor_discord_user_id);
  select jsonb_build_object(
    'outcome', 'ok',
    'cycleId', cycle.id,
    'cycleNumber', cycle.public_number,
    'cycleStatus', cycle.status::text,
    'pausedFromStatus', cycle.paused_from_status::text,
    'votingEndsAt', cycle.voting_ends_at,
    'databaseTime', transaction_timestamp(),
    'editable', public.is_cycle_prize_pool_editable(
      cycle.id,
      transaction_timestamp()
    ),
    'rowVersion', coalesce(pool.row_version, 0),
    'amountLamports', pool.announced_lamports::text
  )
  into v_context
  from public.voting_cycles cycle
  left join public.cycle_prize_pools pool on pool.cycle_id = cycle.id
  where cycle.id = p_cycle_id;

  return coalesce(v_context, jsonb_build_object('outcome', 'not_found'));
end;
$function$;

create or replace function public.finalize_cycle(
  p_cycle_id bigint,
  p_actor_discord_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_result jsonb;
  v_pool public.cycle_prize_pools%rowtype;
  v_component public.cycle_prize_pool_components%rowtype;
  v_finalized_at timestamptz;
  v_allocations integer := 0;
  v_has_component boolean := false;
begin
  v_result := public.finalize_cycle_without_prize_pool(
    p_cycle_id,
    p_actor_discord_user_id
  );
  select cycle.finalized_at
  into v_finalized_at
  from public.voting_cycles cycle
  where cycle.id = p_cycle_id
  for update;
  if v_finalized_at is null then
    raise exception using message = 'PAYOUT_FINALIZATION_TIME_MISSING';
  end if;

  select pool.*
  into v_pool
  from public.cycle_prize_pools pool
  where pool.cycle_id = p_cycle_id
  for update;
  if not found then
    return v_result || jsonb_build_object(
      'prizePoolState', 'none',
      'prizePoolLamports', null,
      'prizeAllocationCount', 0
    );
  end if;

  select exists (
    select 1
    from public.cycle_prize_pool_components component
    where component.cycle_id = p_cycle_id
  ) into v_has_component;

  if v_pool.state = 'running' then
    update public.cycle_prize_pools
    set state = 'locked',
        finalized_at = v_finalized_at,
        row_version = row_version + 1,
        updated_at = v_finalized_at
    where cycle_id = p_cycle_id
    returning * into v_pool;

    if v_pool.announced_lamports is not null
      and not exists (
        select 1
        from public.cycle_prize_pool_components component
        where component.cycle_id = p_cycle_id
          and component.component_kind = 'base'
      ) then
      insert into public.cycle_prize_pool_components(
        cycle_id,
        component_version,
        component_kind,
        amount_lamports,
        actor_discord_user_id,
        locked_at
      ) values (
        p_cycle_id,
        coalesce((
          select max(component.component_version) + 1
          from public.cycle_prize_pool_components component
          where component.cycle_id = p_cycle_id
        ), 1),
        'base',
        v_pool.announced_lamports,
        p_actor_discord_user_id,
        v_finalized_at
      )
      returning * into v_component;
      v_has_component := true;
      insert into public.payout_events(
        event_type,
        actor_discord_user_id,
        target_type,
        target_public_id,
        target_version,
        details
      ) values (
        'pool_locked',
        p_actor_discord_user_id,
        'component',
        v_component.public_id,
        v_component.component_version,
        jsonb_build_object(
          'amountLamports', v_component.amount_lamports::text,
          'cycleId', p_cycle_id
        )
      );
    end if;
  end if;

  if v_pool.state = 'amount_pending' or not v_has_component then
    return v_result || jsonb_build_object(
      'prizePoolState', 'none',
      'prizePoolLamports', null,
      'prizeAllocationCount', 0
    );
  end if;

  for v_component in
    select component.*
    from public.cycle_prize_pool_components component
    where component.cycle_id = p_cycle_id
    order by component.component_version
  loop
    v_allocations := v_allocations
      + public.allocate_cycle_prize_component(v_component.id);
  end loop;

  return v_result || jsonb_build_object(
    'prizePoolState', 'locked',
    'prizePoolLamports', v_pool.announced_lamports::text,
    'prizeAllocationCount', v_allocations
  );
end;
$function$;

alter function public.is_cycle_prize_pool_editable(bigint,timestamptz)
  owner to postgres;
alter function public.guard_cycle_prize_pool_lifecycle()
  owner to postgres;
alter function public.guard_cycle_prize_pool_component_insert()
  owner to postgres;
alter function public.manage_current_cycle_prize_pool(text,uuid,bigint,bigint,bigint,bigint)
  owner to postgres;
alter function public.get_cycle_prize_pool_management_context(text,bigint)
  owner to postgres;
alter function public.finalize_cycle(bigint,text)
  owner to postgres;

revoke all on function
  public.is_cycle_prize_pool_editable(bigint,timestamptz),
  public.guard_cycle_prize_pool_lifecycle(),
  public.guard_cycle_prize_pool_component_insert(),
  public.manage_current_cycle_prize_pool(text,uuid,bigint,bigint,bigint,bigint),
  public.get_cycle_prize_pool_management_context(text,bigint),
  public.finalize_cycle(bigint,text)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function
  public.manage_current_cycle_prize_pool(text,uuid,bigint,bigint,bigint,bigint),
  public.get_cycle_prize_pool_management_context(text,bigint)
  to service_role;

do $postflight$
begin
  if to_regprocedure('public.manage_cycle_prize_pool(text,uuid,bigint,bigint,text,bigint,text,uuid,text)') is not null
    or to_regprocedure('public.manage_current_cycle_prize_pool(text,uuid,bigint,bigint,bigint,bigint)') is null
    or to_regprocedure('public.get_cycle_prize_pool_management_context(text,bigint)') is null
    or to_regprocedure('public.is_cycle_prize_pool_editable(bigint,timestamptz)') is null
    or to_regprocedure('public.finalize_cycle(bigint,text)') is null
    or not exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.cycle_prize_pools'::regclass
        and tgname = 'cycle_prize_pool_lifecycle_guard'
        and not tgisinternal
    )
    or not exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.cycle_prize_pool_components'::regclass
        and tgname = 'cycle_prize_pool_component_insert_guard'
        and not tgisinternal
    )
  then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_PRIZE_POOL_DEADLINE_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.manage_current_cycle_prize_pool(text,uuid,bigint,bigint,bigint,bigint) is
  'Sets or changes the current Cycle prize pool before voting ends. The exact Lamport amount must be confirmed twice; completed Cycles are immutable.';
comment on function public.get_cycle_prize_pool_management_context(text,bigint) is
  'Cycle-management-only projection for the current Cycle prize-pool editor.';
comment on function public.finalize_cycle(bigint,text) is
  'Finalizes canonical Cycle results and allocates only a prize pool fixed before voting ended. Missing pools remain absent.';

commit;

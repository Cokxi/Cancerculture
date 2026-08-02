begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 22
    or (select count(*) from public.capability_catalog where is_active) <> 20
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 20
    or exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_MANAGEMENT_CAPABILITY_BASELINE_MISMATCH';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = 'cycles.logs.view'
      and implementation_version = 1
      and definition_hash = '915c24cf6a167040c8637e59ca27a28510c6299b2ea417ae770f86e992924beb'
      and is_active
      and assignable_to_non_admin
  ) then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_MANAGEMENT_PREVIOUS_CUTOVER_MISMATCH';
  end if;

  if exists (
    select 1 from public.capability_catalog where key = 'cycles.manage'
  )
    or to_regclass('public.cycle_management_requests') is not null
    or to_regprocedure('public.assert_cycle_manager(text)') is not null
    or to_regprocedure(
      'public.manage_cycle_phase(text,bigint,text,text,integer,integer,text,uuid)'
    ) is not null
    or to_regprocedure(
      'public.start_cycle_managed(bigint,text,jsonb)'
    ) is not null
    or to_regprocedure(
      'public.finalize_cycle_managed(bigint,text)'
    ) is not null
    or to_regprocedure(
      'public.reset_cycle_managed(bigint,text,text)'
    ) is not null
    or to_regprocedure(
      'public.moderate_cycle_end_submission(text,bigint,bigint,text,text,boolean,text,text,text,uuid)'
    ) is not null
    or to_regprocedure(
      'public.claim_media_cleanup_jobs_by_ids(bigint[],integer)'
    ) is not null then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_MANAGEMENT_TARGET_ALREADY_PRESENT';
  end if;

  if to_regprocedure('public.start_cycle(bigint,text,jsonb)') is null
    or to_regprocedure('public.finalize_cycle(bigint,text)') is null
    or to_regprocedure('public.reset_cycle(bigint,text,text)') is null
    or to_regprocedure('public.process_due_cycle_transitions(bigint)') is null
    or to_regprocedure(
      'public.moderate_submission(text,bigint,bigint,text,text,boolean,text,text,text,uuid)'
    ) is null
    or to_regprocedure(
      'public.claim_media_cleanup_jobs(integer,integer)'
    ) is null
    or to_regclass('public.voting_cycles') is null
    or to_regclass('public.cycle_events') is null
    or to_regclass('public.cycle_reminders') is null
    or to_regclass('public.admin_action_logs') is null
    or to_regclass('public.submission_moderation_requests') is null
    or to_regclass('public.moderation_action_logs') is null then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_MANAGEMENT_DEPENDENCY_MISMATCH';
  end if;
end;
$preflight$;

insert into public.capability_catalog (
  key,
  display_name,
  description,
  category,
  included_actions,
  excluded_actions,
  risk_level,
  assignable_to_non_admin,
  is_active,
  implementation_version,
  definition_hash
)
values (
  'cycles.manage',
  'Manage Cycles',
  'Operate the current cycle through hardened start, scheduling, phase, sponsorship, end-review, finalization, pause, and reset workflows.',
  'Cycles',
  array[
    'Create or reuse a clean draft and start normal or sponsored cycles.',
    'Set or clear current-phase timers, configure votes per user, pause or resume, and advance submission or voting phases.',
    'Perform exceptional submission disqualification or reinstatement after voting closes and before finalization.',
    'Finalize or reset the current cycle through confirmed auditable workflows.',
    'Manage the current and next cycle theme plus the sponsored-cycle draft.'
  ]::text[],
  array[
    'Viewing Cycle Logs or unrelated logs without their separate capabilities.',
    'Managing roles, permissions, team membership, Owner access, or other administrative domains.',
    'Managing winner payouts, refunding votes, editing individual votes, repairing finalized history, or moderating open phases without their separate capabilities.',
    'Accessing raw secrets, storage credentials, scheduler credentials, or arbitrary media-cleanup work.'
  ]::text[],
  'critical',
  true,
  true,
  1,
  '4f3e07f01bc453f594994689c3049e698ca2bd1d1c99e75927d161056033f710'
);

create or replace function public.assert_cycle_manager(
  p_actor_discord_user_id text
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_actor_role text;
begin
  if nullif(v_actor_id, '') is null
    or char_length(v_actor_id) > 100
    or v_actor_id !~ '^[0-9]+$' then
    raise exception using
      errcode = '42501',
      message = 'CYCLE_MANAGEMENT_FORBIDDEN';
  end if;

  if not exists (
    select 1
    from public.capability_catalog capability_row
    where capability_row.key = 'cycles.manage'
      and capability_row.is_active
      and capability_row.assignable_to_non_admin
      and capability_row.implementation_version = 1
      and capability_row.definition_hash =
        '4f3e07f01bc453f594994689c3049e698ca2bd1d1c99e75927d161056033f710'
  ) then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_MANAGEMENT_AUTHORIZATION_DEPENDENCY_UNAVAILABLE';
  end if;

  select member_row.role
  into v_actor_role
  from public.team_members member_row
  join public.team_roles role_row
    on role_row.key = member_row.role
   and role_row.is_active
  where member_row.discord_user_id = v_actor_id;

  if not found
    or (
      v_actor_role <> 'admin'
      and not exists (
        select 1
        from public.team_role_capabilities grant_row
        where grant_row.role_key = v_actor_role
          and grant_row.capability_key = 'cycles.manage'
      )
    ) then
    raise exception using
      errcode = '42501',
      message = 'CYCLE_MANAGEMENT_FORBIDDEN';
  end if;

  return v_actor_role;
end;
$function$;

alter function public.assert_cycle_manager(text) owner to postgres;
revoke all on function public.assert_cycle_manager(text)
  from public, anon, authenticated, service_role;

create table public.cycle_management_requests (
  idempotency_key uuid primary key,
  actor_discord_user_id text not null,
  request_hash text not null,
  request_payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint cycle_management_requests_actor_check
    check (
      char_length(btrim(actor_discord_user_id)) between 1 and 100
      and actor_discord_user_id ~ '^[0-9]+$'
    ),
  constraint cycle_management_requests_hash_check
    check (request_hash ~ '^[0-9a-f]{64}$')
);

alter table public.cycle_management_requests owner to postgres;
alter table public.cycle_management_requests enable row level security;
revoke all on table public.cycle_management_requests
  from public, anon, authenticated, service_role;

create or replace function public.prevent_cycle_management_request_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'CYCLE_MANAGEMENT_REQUEST_HISTORY_IS_APPEND_ONLY';
end;
$function$;

alter function public.prevent_cycle_management_request_mutation()
  owner to postgres;
revoke all on function public.prevent_cycle_management_request_mutation()
  from public, anon, authenticated, service_role;

create trigger cycle_management_requests_append_only
before update or delete on public.cycle_management_requests
for each row execute function
  public.prevent_cycle_management_request_mutation();

create or replace function public.manage_cycle_phase(
  p_actor_discord_user_id text,
  p_cycle_id bigint,
  p_operation text,
  p_expected_status text,
  p_duration_minutes integer,
  p_votes_per_user integer,
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
  v_actor_role text;
  v_actor_type text;
  v_operation text := lower(btrim(p_operation));
  v_expected_status text := lower(btrim(p_expected_status));
  v_reason text := nullif(btrim(p_reason), '');
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_cycle public.voting_cycles%rowtype;
  v_previous_status text;
  v_now timestamptz := transaction_timestamp();
  v_phase text;
  v_end_at timestamptz;
  v_remaining_seconds integer;
  v_duration integer;
  v_offsets integer[] := '{}'::integer[];
  v_offset integer;
  v_result jsonb;
begin
  if p_idempotency_key is null
    or p_cycle_id is null
    or p_cycle_id <= 0
    or nullif(v_actor_id, '') is null
    or char_length(v_actor_id) > 100
    or v_operation not in (
      'end_submission_start_voting',
      'start_voting',
      'end_voting',
      'set_timer',
      'clear_timer',
      'set_votes_per_user',
      'pause',
      'resume'
    )
    or v_expected_status not in (
      'submission_open',
      'submission_closed',
      'voting_open',
      'paused'
    )
    or (v_reason is not null and char_length(v_reason) > 1000)
    or (
      v_operation = 'set_timer'
      and (
        p_duration_minutes is null
        or p_duration_minutes < 1
        or p_duration_minutes > 5256000
      )
    )
    or (v_operation <> 'set_timer' and p_duration_minutes is not null)
    or (
      v_operation = 'set_votes_per_user'
      and (
        p_votes_per_user is null
        or p_votes_per_user < 1
        or p_votes_per_user > 10
      )
    )
    or (
      v_operation <> 'set_votes_per_user'
      and p_votes_per_user is not null
    )
    or (v_operation <> 'pause' and v_reason is not null)
    or (
      (v_operation = 'end_submission_start_voting'
        and v_expected_status <> 'submission_open')
      or (v_operation = 'start_voting'
        and v_expected_status <> 'submission_closed')
      or (v_operation = 'end_voting'
        and v_expected_status <> 'voting_open')
      or (v_operation in ('set_timer', 'clear_timer', 'pause')
        and v_expected_status not in ('submission_open', 'voting_open'))
      or (v_operation = 'set_votes_per_user'
        and v_expected_status <> 'submission_open')
      or (v_operation = 'resume' and v_expected_status <> 'paused')
    ) then
    raise exception using
      errcode = '22023',
      message = 'INVALID_CYCLE_MANAGEMENT_REQUEST';
  end if;

  v_actor_role := public.assert_cycle_manager(v_actor_id);
  v_actor_type := case
    when v_actor_role = 'admin' then 'admin'
    else 'moderator'
  end;

  v_request_payload := jsonb_build_object(
    'operationVersion', 1,
    'actorDiscordUserId', v_actor_id,
    'cycleId', p_cycle_id,
    'operation', v_operation,
    'expectedStatus', v_expected_status,
    'durationMinutes', p_duration_minutes,
    'votesPerUser', p_votes_per_user,
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
  from public.cycle_management_requests
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_result, '{replayed}', 'true'::jsonb);
    end if;

    raise exception using
      errcode = 'PT409',
      message = 'CYCLE_MANAGEMENT_IDEMPOTENCY_CONFLICT';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cycle-phase-automation-global', 0)
  );

  select cycle_row.*
  into v_cycle
  from public.voting_cycles cycle_row
  where cycle_row.id = p_cycle_id
  for update;

  if not found then
    raise exception using
      errcode = 'PT409',
      message = 'CYCLE_MANAGEMENT_CYCLE_NOT_FOUND';
  end if;

  v_previous_status := v_cycle.status::text;
  if v_previous_status <> v_expected_status then
    raise exception using
      errcode = 'PT409',
      message = 'CYCLE_MANAGEMENT_STATE_CONFLICT';
  end if;

  if v_operation = 'end_submission_start_voting' then
    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = p_cycle_id
      and phase = 'submission_open'
      and status = 'pending';

    update public.voting_cycles
    set status = 'voting_open',
        submission_ends_at = coalesce(submission_ends_at, v_now),
        voting_starts_at = v_now,
        voting_ends_at = null,
        paused_from_status = null,
        phase_paused_at = null,
        phase_paused_remaining_seconds = null,
        phase_pause_reason = null
    where id = p_cycle_id;

    insert into public.cycle_events (
      cycle_id, event_type, actor_type, actor_discord_user_id, payload
    ) values
      (
        p_cycle_id,
        'submission_phase_closed',
        v_actor_type,
        v_actor_id,
        jsonb_build_object(
          'phase', 'submission_closed',
          'manual', true,
          'authorizationRole', v_actor_role
        )
      ),
      (
        p_cycle_id,
        'voting_phase_opened',
        v_actor_type,
        v_actor_id,
        jsonb_build_object(
          'phase', 'voting_open',
          'votes_per_user', coalesce(v_cycle.votes_per_user, 2),
          'manual', true,
          'authorizationRole', v_actor_role
        )
      );
  elsif v_operation = 'start_voting' then
    update public.voting_cycles
    set status = 'voting_open',
        voting_starts_at = v_now,
        voting_ends_at = null,
        paused_from_status = null,
        phase_paused_at = null,
        phase_paused_remaining_seconds = null,
        phase_pause_reason = null
    where id = p_cycle_id;

    insert into public.cycle_events (
      cycle_id, event_type, actor_type, actor_discord_user_id, payload
    ) values (
      p_cycle_id,
      'voting_phase_opened',
      v_actor_type,
      v_actor_id,
      jsonb_build_object(
        'phase', 'voting_open',
        'votes_per_user', coalesce(v_cycle.votes_per_user, 2),
        'manual', true,
        'authorizationRole', v_actor_role
      )
    );
  elsif v_operation = 'end_voting' then
    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = p_cycle_id
      and phase = 'voting_open'
      and status = 'pending';

    update public.voting_cycles
    set status = 'voting_closed',
        voting_ends_at = coalesce(voting_ends_at, v_now)
    where id = p_cycle_id;

    insert into public.cycle_events (
      cycle_id, event_type, actor_type, actor_discord_user_id, payload
    ) values (
      p_cycle_id,
      'voting_phase_closed',
      v_actor_type,
      v_actor_id,
      jsonb_build_object(
        'phase', 'voting_closed',
        'manual', true,
        'authorizationRole', v_actor_role
      )
    );
  elsif v_operation = 'set_timer' then
    v_phase := v_previous_status;
    v_end_at := v_now + make_interval(mins => p_duration_minutes);

    if v_phase = 'submission_open' then
      update public.voting_cycles
      set submission_ends_at = v_end_at
      where id = p_cycle_id;
    else
      update public.voting_cycles
      set voting_ends_at = v_end_at
      where id = p_cycle_id;
    end if;

    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = p_cycle_id
      and phase = v_phase
      and status = 'pending';

    v_offsets := case
      when p_duration_minutes >= 120 then array[60, 30, 15, 10, 5, 1]
      when p_duration_minutes >= 60 then array[30, 15, 10, 5, 1]
      when p_duration_minutes >= 30 then array[20, 10, 5, 1]
      when p_duration_minutes >= 15 then array[10, 5, 1]
      when p_duration_minutes >= 10 then array[5, 1]
      when p_duration_minutes > 1 then array[1]
      else '{}'::integer[]
    end;

    foreach v_offset in array v_offsets loop
      insert into public.cycle_reminders (
        cycle_id, phase, reminder_type, due_at, message_payload, status
      ) values (
        p_cycle_id,
        v_phase,
        'phase_ends_in_' || v_offset::text || 'm',
        v_end_at - make_interval(mins => v_offset),
        jsonb_build_object(
          'phase', v_phase,
          'remaining_minutes', v_offset,
          'starts_at', v_now,
          'ends_at', v_end_at
        ),
        'pending'
      );
    end loop;

    insert into public.cycle_reminders (
      cycle_id, phase, reminder_type, due_at, message_payload, status
    ) values (
      p_cycle_id,
      v_phase,
      'phase_end_due',
      v_end_at,
      jsonb_build_object(
        'phase', v_phase,
        'remaining_minutes', 0,
        'starts_at', v_now,
        'ends_at', v_end_at
      ),
      'pending'
    );

    insert into public.cycle_events (
      cycle_id, event_type, actor_type, actor_discord_user_id, payload
    ) values (
      p_cycle_id,
      v_phase || '_timer_set',
      v_actor_type,
      v_actor_id,
      jsonb_build_object(
        'phase', v_phase,
        'duration_minutes', p_duration_minutes,
        'ends_at', v_end_at,
        'authorizationRole', v_actor_role
      )
    );
  elsif v_operation = 'clear_timer' then
    v_phase := v_previous_status;
    if v_phase = 'submission_open' then
      update public.voting_cycles
      set submission_ends_at = null
      where id = p_cycle_id;
    else
      update public.voting_cycles
      set voting_ends_at = null
      where id = p_cycle_id;
    end if;

    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = p_cycle_id
      and phase = v_phase
      and status = 'pending';

    insert into public.cycle_events (
      cycle_id, event_type, actor_type, actor_discord_user_id, payload
    ) values (
      p_cycle_id,
      v_phase || '_timer_cleared',
      v_actor_type,
      v_actor_id,
      jsonb_build_object(
        'phase', v_phase,
        'authorizationRole', v_actor_role
      )
    );
  elsif v_operation = 'set_votes_per_user' then
    update public.voting_cycles
    set votes_per_user = p_votes_per_user
    where id = p_cycle_id;

    insert into public.cycle_events (
      cycle_id, event_type, actor_type, actor_discord_user_id, payload
    ) values (
      p_cycle_id,
      'voting_rule_updated',
      v_actor_type,
      v_actor_id,
      jsonb_build_object(
        'phase', 'submission_open',
        'votes_per_user', p_votes_per_user,
        'authorizationRole', v_actor_role
      )
    );
  elsif v_operation = 'pause' then
    v_phase := v_previous_status;
    v_end_at := case
      when v_phase = 'submission_open' then v_cycle.submission_ends_at
      else v_cycle.voting_ends_at
    end;
    v_remaining_seconds := case
      when v_end_at is null then null
      else greatest(
        0,
        ceil(extract(epoch from (v_end_at - v_now)))::integer
      )
    end;

    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = p_cycle_id
      and phase = v_phase
      and status = 'pending';

    update public.voting_cycles
    set status = 'paused',
        paused_from_status = v_phase,
        phase_paused_at = v_now,
        phase_paused_remaining_seconds = v_remaining_seconds,
        phase_pause_reason = v_reason
    where id = p_cycle_id;

    insert into public.cycle_events (
      cycle_id, event_type, actor_type, actor_discord_user_id, payload
    ) values (
      p_cycle_id,
      'cycle_phase_paused',
      v_actor_type,
      v_actor_id,
      jsonb_build_object(
        'phase', v_phase,
        'paused_at', v_now,
        'remaining_seconds', v_remaining_seconds,
        'reason', v_reason,
        'authorizationRole', v_actor_role
      )
    );
  else
    v_phase := v_cycle.paused_from_status::text;
    v_remaining_seconds := v_cycle.phase_paused_remaining_seconds;
    if v_phase not in ('submission_open', 'voting_open') then
      raise exception using
        errcode = 'PT409',
        message = 'CYCLE_MANAGEMENT_STATE_CONFLICT';
    end if;

    v_end_at := case
      when v_remaining_seconds is null then null
      else v_now + make_interval(secs => v_remaining_seconds)
    end;

    if v_phase = 'submission_open' then
      update public.voting_cycles
      set status = 'submission_open',
          submission_ends_at = v_end_at,
          paused_from_status = null,
          phase_paused_at = null,
          phase_paused_remaining_seconds = null,
          phase_pause_reason = null
      where id = p_cycle_id;
    else
      update public.voting_cycles
      set status = 'voting_open',
          voting_ends_at = v_end_at,
          paused_from_status = null,
          phase_paused_at = null,
          phase_paused_remaining_seconds = null,
          phase_pause_reason = null
      where id = p_cycle_id;
    end if;

    if v_end_at is not null and v_remaining_seconds > 0 then
      v_duration := greatest(1, ceil(v_remaining_seconds / 60.0)::integer);
      v_offsets := case
        when v_duration >= 120 then array[60, 30, 15, 10, 5, 1]
        when v_duration >= 60 then array[30, 15, 10, 5, 1]
        when v_duration >= 30 then array[20, 10, 5, 1]
        when v_duration >= 15 then array[10, 5, 1]
        when v_duration >= 10 then array[5, 1]
        when v_duration > 1 then array[1]
        else '{}'::integer[]
      end;

      foreach v_offset in array v_offsets loop
        if v_end_at - make_interval(mins => v_offset) > v_now then
          insert into public.cycle_reminders (
            cycle_id, phase, reminder_type, due_at, message_payload, status
          ) values (
            p_cycle_id,
            v_phase,
            'phase_ends_in_' || v_offset::text || 'm',
            v_end_at - make_interval(mins => v_offset),
            jsonb_build_object(
              'phase', v_phase,
              'remaining_minutes', v_offset,
              'resumed', true,
              'starts_at', v_now,
              'ends_at', v_end_at
            ),
            'pending'
          );
        end if;
      end loop;

      insert into public.cycle_reminders (
        cycle_id, phase, reminder_type, due_at, message_payload, status
      ) values (
        p_cycle_id,
        v_phase,
        'phase_end_due',
        v_end_at,
        jsonb_build_object(
          'phase', v_phase,
          'remaining_minutes', 0,
          'resumed', true,
          'starts_at', v_now,
          'ends_at', v_end_at
        ),
        'pending'
      );
    end if;

    insert into public.cycle_events (
      cycle_id, event_type, actor_type, actor_discord_user_id, payload
    ) values (
      p_cycle_id,
      'cycle_phase_resumed',
      v_actor_type,
      v_actor_id,
      jsonb_build_object(
        'phase', v_phase,
        'resumed_at', v_now,
        'ends_at', v_end_at,
        'remaining_seconds', v_remaining_seconds,
        'authorizationRole', v_actor_role
      )
    );
  end if;

  select status::text
  into v_phase
  from public.voting_cycles
  where id = p_cycle_id;

  insert into public.admin_action_logs (
    actor_type, actor_id, action, target_type, target_id, meta
  ) values (
    v_actor_type,
    v_actor_id,
    'cycle_phase_managed',
    'cycle',
    p_cycle_id::text,
    jsonb_build_object(
      'operation', v_operation,
      'previous_status', v_previous_status,
      'status', v_phase,
      'authorization_capability', 'cycles.manage',
      'authorization_role', v_actor_role,
      'request_id', p_idempotency_key
    )
  );

  v_result := jsonb_build_object(
    'operation', v_operation,
    'requestId', p_idempotency_key,
    'cycleId', p_cycle_id,
    'previousStatus', v_previous_status,
    'status', v_phase,
    'replayed', false
  );

  insert into public.cycle_management_requests (
    idempotency_key,
    actor_discord_user_id,
    request_hash,
    request_payload,
    result
  ) values (
    p_idempotency_key,
    v_actor_id,
    v_request_hash,
    v_request_payload,
    v_result
  );

  return v_result;
end;
$function$;

alter function public.manage_cycle_phase(
  text, bigint, text, text, integer, integer, text, uuid
) owner to postgres;
revoke all on function public.manage_cycle_phase(
  text, bigint, text, text, integer, integer, text, uuid
) from public, anon, authenticated;
grant execute on function public.manage_cycle_phase(
  text, bigint, text, text, integer, integer, text, uuid
) to service_role;

comment on function public.manage_cycle_phase(
  text, bigint, text, text, integer, integer, text, uuid
) is
  'Authorizes cycles.manage and atomically performs idempotent manual timer, phase, pause, resume, and voting-rule operations under the same global lock used by automatic transitions.';

create or replace function public.start_cycle_managed(
  p_cycle_id bigint,
  p_actor_discord_user_id text,
  p_settings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_actor_role text;
  v_actor_type text;
  v_started_at timestamptz := transaction_timestamp();
  v_result jsonb;
  v_result_cycle_id bigint;
  v_sponsor_link text;
  v_banner_key text;
begin
  v_actor_role := public.assert_cycle_manager(v_actor_id);
  v_actor_type := case
    when v_actor_role = 'admin' then 'admin'
    else 'moderator'
  end;

  if coalesce((p_settings #>> '{sponsored,enabled}')::boolean, false) then
    v_sponsor_link := nullif(
      btrim(p_settings #>> '{sponsored,sponsorLink}'),
      ''
    );
    v_banner_key := nullif(
      btrim(p_settings #>> '{sponsored,bannerR2Key}'),
      ''
    );

    if v_sponsor_link is null
      or v_sponsor_link !~* '^https://[^[:space:]]+$'
      or v_banner_key is null
      or v_banner_key !~ '^sponsored-cycles/drafts/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$' then
      raise exception using
        errcode = '22023',
        message = 'INVALID_SPONSOR_SETTINGS';
    end if;
  end if;

  v_result := public.start_cycle(
    p_cycle_id,
    v_actor_id,
    p_settings
  );
  v_result_cycle_id := (v_result ->> 'cycleId')::bigint;

  update public.cycle_events
  set actor_type = v_actor_type,
      payload = payload || jsonb_build_object(
        'authorizationCapability', 'cycles.manage',
        'authorizationRole', v_actor_role
      )
  where cycle_id = v_result_cycle_id
    and actor_discord_user_id = v_actor_id
    and created_at = v_started_at
    and event_type = 'submission_phase_opened';

  update public.admin_action_logs
  set actor_type = v_actor_type,
      meta = meta || jsonb_build_object(
        'authorization_capability', 'cycles.manage',
        'authorization_role', v_actor_role
      )
  where actor_id = v_actor_id
    and target_type = 'cycle'
    and target_id = v_result_cycle_id::text
    and action = 'cycle_started'
    and created_at = v_started_at;

  return v_result;
end;
$function$;

alter function public.start_cycle_managed(bigint, text, jsonb)
  owner to postgres;
revoke all on function public.start_cycle_managed(bigint, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.start_cycle_managed(bigint, text, jsonb)
  to service_role;
revoke execute on function public.start_cycle(bigint, text, jsonb)
  from service_role;

create or replace function public.finalize_cycle_managed(
  p_cycle_id bigint,
  p_actor_discord_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_actor_role text;
  v_actor_type text;
  v_started_at timestamptz := transaction_timestamp();
  v_result jsonb;
begin
  v_actor_role := public.assert_cycle_manager(v_actor_id);
  v_actor_type := case
    when v_actor_role = 'admin' then 'admin'
    else 'moderator'
  end;

  v_result := public.finalize_cycle(p_cycle_id, v_actor_id);

  update public.cycle_events
  set actor_type = v_actor_type,
      payload = payload || jsonb_build_object(
        'authorizationCapability', 'cycles.manage',
        'authorizationRole', v_actor_role
      )
  where cycle_id = p_cycle_id
    and actor_discord_user_id = v_actor_id
    and created_at = v_started_at
    and event_type in ('cycle_finalizing', 'cycle_completed');

  update public.admin_action_logs
  set actor_type = v_actor_type,
      meta = meta || jsonb_build_object(
        'authorization_capability', 'cycles.manage',
        'authorization_role', v_actor_role
      )
  where actor_id = v_actor_id
    and target_type = 'cycle'
    and target_id = p_cycle_id::text
    and action = 'cycle_finalized'
    and created_at = v_started_at;

  return v_result;
end;
$function$;

alter function public.finalize_cycle_managed(bigint, text)
  owner to postgres;
revoke all on function public.finalize_cycle_managed(bigint, text)
  from public, anon, authenticated;
grant execute on function public.finalize_cycle_managed(bigint, text)
  to service_role;
revoke execute on function public.finalize_cycle(bigint, text)
  from service_role;

create or replace function public.reset_cycle_managed(
  p_cycle_id bigint,
  p_actor_discord_user_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_actor_role text;
  v_actor_type text;
  v_started_at timestamptz := transaction_timestamp();
  v_result jsonb;
begin
  v_actor_role := public.assert_cycle_manager(v_actor_id);
  v_actor_type := case
    when v_actor_role = 'admin' then 'admin'
    else 'moderator'
  end;

  v_result := public.reset_cycle(p_cycle_id, v_actor_id, p_reason);

  update public.admin_action_logs
  set actor_type = v_actor_type,
      meta = meta || jsonb_build_object(
        'authorization_capability', 'cycles.manage',
        'authorization_role', v_actor_role
      )
  where actor_id = v_actor_id
    and target_type = 'cycle'
    and target_id = p_cycle_id::text
    and action = 'cycle_reset'
    and created_at = v_started_at;

  return v_result;
end;
$function$;

alter function public.reset_cycle_managed(bigint, text, text)
  owner to postgres;
revoke all on function public.reset_cycle_managed(bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.reset_cycle_managed(bigint, text, text)
  to service_role;
revoke execute on function public.reset_cycle(bigint, text, text)
  from service_role;

comment on function public.start_cycle_managed(bigint, text, jsonb) is
  'Capability-authorized wrapper around the atomic Cycle Start primitive. The primitive is no longer directly executable by service_role.';
comment on function public.finalize_cycle_managed(bigint, text) is
  'Capability-authorized wrapper around the atomic manual Cycle Finalization primitive. The primitive is no longer directly executable by service_role.';
comment on function public.reset_cycle_managed(bigint, text, text) is
  'Capability-authorized wrapper around the atomic Cycle Reset primitive. The primitive is no longer directly executable by service_role.';

create or replace function public.moderate_cycle_end_submission(
  p_actor_discord_user_id text,
  p_cycle_id bigint,
  p_submission_id bigint,
  p_operation text,
  p_expected_phase text,
  p_expected_is_disqualified boolean,
  p_disqualification_type text,
  p_reason_code text,
  p_reason_text text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_actor_role text;
  v_actor_username text;
  v_operation text := lower(btrim(p_operation));
  v_expected_phase text := lower(btrim(p_expected_phase));
  v_disqualification_type text := nullif(btrim(p_disqualification_type), '');
  v_reason_code text := nullif(lower(btrim(p_reason_code)), '');
  v_reason_text text := nullif(btrim(p_reason_text), '');
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_cycle public.voting_cycles%rowtype;
  v_submission public.submissions%rowtype;
  v_current_is_disqualified boolean;
  v_target_is_disqualified boolean;
  v_before_state jsonb;
  v_after_state jsonb;
  v_result jsonb;
begin
  if p_idempotency_key is null
    or nullif(v_actor_id, '') is null
    or char_length(v_actor_id) > 100
    or p_cycle_id is null
    or p_cycle_id <= 0
    or p_submission_id is null
    or p_submission_id <= 0
    or p_expected_is_disqualified is null
    or v_operation not in ('disqualify', 'reinstate')
    or v_expected_phase <> 'voting_closed'
    or v_reason_code is null
    or char_length(v_reason_code) > 100
    or v_reason_code !~ '^[a-z0-9][a-z0-9_:-]*$'
    or (v_reason_text is not null and char_length(v_reason_text) > 1000)
    or (
      v_operation = 'disqualify'
      and (
        v_disqualification_type is null
        or char_length(v_disqualification_type) > 100
        or v_disqualification_type !~ '^[a-z0-9][a-z0-9_:-]*$'
      )
    )
    or (
      v_operation = 'reinstate'
      and (
        v_disqualification_type is not null
        or v_reason_text is null
        or char_length(v_reason_text) < 3
      )
    ) then
    raise exception using
      errcode = '22023',
      message = 'INVALID_SUBMISSION_MODERATION_REQUEST';
  end if;

  v_actor_role := public.assert_cycle_manager(v_actor_id);

  select coalesce(
    nullif(btrim(actor_log.current_discord_username), ''),
    nullif(btrim(member_row.discord_username), ''),
    v_actor_id
  )
  into v_actor_username
  from public.team_members member_row
  left join public.user_logs actor_log
    on actor_log.discord_user_id = member_row.discord_user_id
  where member_row.discord_user_id = v_actor_id;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'SUBMISSION_MODERATION_FORBIDDEN';
  end if;

  v_request_payload := jsonb_build_object(
    'operationVersion', 1,
    'actorDiscordUserId', v_actor_id,
    'cycleId', p_cycle_id,
    'submissionId', p_submission_id,
    'operation', v_operation,
    'expectedPhase', v_expected_phase,
    'expectedIsDisqualified', p_expected_is_disqualified,
    'disqualificationType', v_disqualification_type,
    'reasonCode', v_reason_code,
    'reasonText', v_reason_text
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
  from public.submission_moderation_requests
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_result, '{replayed}', 'true'::jsonb);
    end if;

    raise exception using
      errcode = 'PT409',
      message = 'SUBMISSION_MODERATION_IDEMPOTENCY_CONFLICT';
  end if;

  select cycle_row.*
  into v_cycle
  from public.voting_cycles cycle_row
  where cycle_row.id = p_cycle_id
  for update;

  if not found then
    raise exception using
      errcode = 'PT409',
      message = 'MODERATION_CYCLE_NOT_FOUND';
  end if;

  if v_cycle.status::text <> 'voting_closed' then
    raise exception using
      errcode = 'PT409',
      message = 'MODERATION_PHASE_CLOSED';
  end if;

  select submission_row.*
  into v_submission
  from public.submissions submission_row
  where submission_row.id = p_submission_id
  for update;

  if not found then
    raise exception using
      errcode = 'PT409',
      message = 'MODERATION_SUBMISSION_NOT_FOUND';
  end if;

  if v_submission.cycle_id is distinct from p_cycle_id then
    raise exception using
      errcode = 'PT409',
      message = 'MODERATION_SUBMISSION_CYCLE_CONFLICT';
  end if;

  v_current_is_disqualified := coalesce(
    v_submission.is_disqualified,
    false
  );
  v_target_is_disqualified := v_operation = 'disqualify';

  if v_current_is_disqualified is distinct from
    p_expected_is_disqualified then
    raise exception using
      errcode = 'PT409',
      message = 'MODERATION_EXPECTED_STATE_CONFLICT';
  end if;

  v_before_state := jsonb_build_object(
    'isDisqualified', v_current_is_disqualified,
    'disqualificationType', v_submission.disqualification_type,
    'reasonCode', v_submission.disqualification_reason_code,
    'reasonText', v_submission.disqualification_reason_text,
    'disqualifiedAt', v_submission.disqualified_at,
    'actorDiscordUserId', v_submission.disqualified_by_discord_user_id,
    'actorDisplayName', v_submission.disqualified_by_discord_username
  );

  if v_current_is_disqualified is distinct from
    v_target_is_disqualified then
    if v_operation = 'disqualify' then
      update public.submissions
      set is_disqualified = true,
          disqualification_type = v_disqualification_type,
          disqualification_reason_code = v_reason_code,
          disqualification_reason_text = v_reason_text,
          disqualified_at = transaction_timestamp(),
          disqualified_by_discord_user_id = v_actor_id,
          disqualified_by_discord_username = v_actor_username
      where id = p_submission_id;
    else
      update public.submissions
      set is_disqualified = false,
          disqualification_type = null,
          disqualification_reason_code = null,
          disqualification_reason_text = null,
          disqualified_at = null,
          disqualified_by_discord_user_id = null,
          disqualified_by_discord_username = null
      where id = p_submission_id;
    end if;

    select jsonb_build_object(
      'isDisqualified', coalesce(is_disqualified, false),
      'disqualificationType', disqualification_type,
      'reasonCode', disqualification_reason_code,
      'reasonText', disqualification_reason_text,
      'disqualifiedAt', disqualified_at,
      'actorDiscordUserId', disqualified_by_discord_user_id,
      'actorDisplayName', disqualified_by_discord_username
    )
    into v_after_state
    from public.submissions
    where id = p_submission_id;

    insert into public.moderation_action_logs (
      actor_role,
      actor_id,
      actor_discord_username,
      action,
      target_type,
      target_id,
      target_discord_user_id,
      reason_code,
      reason_text,
      evidence,
      cycle_id,
      moderation_request_id,
      moderation_phase,
      moderation_operation,
      before_state,
      after_state
    ) values (
      v_actor_role,
      v_actor_id,
      v_actor_username,
      case v_operation
        when 'disqualify' then 'disqualify_submission'
        else 'reinstate_submission'
      end,
      'submission',
      p_submission_id::text,
      v_submission.discord_user_id,
      v_reason_code,
      v_reason_text,
      jsonb_build_object(
        'requestId', p_idempotency_key,
        'phase', 'voting_closed',
        'operation', v_operation,
        'requiredCapability', 'cycles.manage',
        'before', v_before_state,
        'after', v_after_state,
        'r2_key', v_submission.r2_key
      ),
      p_cycle_id::integer,
      p_idempotency_key,
      'voting_closed',
      v_operation,
      v_before_state,
      v_after_state
    );
  else
    v_after_state := v_before_state;
  end if;

  v_result := jsonb_build_object(
    'operation', v_operation,
    'requestId', p_idempotency_key,
    'cycleId', p_cycle_id,
    'submissionId', p_submission_id,
    'phase', 'voting_closed',
    'requiredCapability', 'cycles.manage',
    'changed',
      v_current_is_disqualified is distinct from v_target_is_disqualified,
    'isDisqualified', v_target_is_disqualified,
    'replayed', false
  );

  insert into public.submission_moderation_requests (
    idempotency_key,
    actor_discord_user_id,
    request_hash,
    request_payload,
    result
  ) values (
    p_idempotency_key,
    v_actor_id,
    v_request_hash,
    v_request_payload,
    v_result
  );

  return v_result;
end;
$function$;

alter function public.moderate_cycle_end_submission(
  text, bigint, bigint, text, text, boolean, text, text, text, uuid
) owner to postgres;
revoke all on function public.moderate_cycle_end_submission(
  text, bigint, bigint, text, text, boolean, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.moderate_cycle_end_submission(
  text, bigint, bigint, text, text, boolean, text, text, text, uuid
) to service_role;

comment on function public.moderate_cycle_end_submission(
  text, bigint, bigint, text, text, boolean, text, text, text, uuid
) is
  'Allows only cycles.manage to atomically disqualify or reinstate submissions after voting closes and before manual finalization, with deterministic idempotency and append-only audit.';

create or replace function public.claim_media_cleanup_jobs_by_ids(
  p_job_ids bigint[],
  p_lease_seconds integer default 120
)
returns table (
  job_id bigint,
  storage_provider text,
  storage_key text,
  lease_token uuid,
  attempt_count integer,
  locked_until timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := transaction_timestamp();
begin
  if p_job_ids is null
    or cardinality(p_job_ids) < 1
    or cardinality(p_job_ids) > 20
    or exists (
      select 1
      from unnest(p_job_ids) as requested(job_id)
      where requested.job_id is null or requested.job_id <= 0
    )
    or (
      select count(*)
      from unnest(p_job_ids) as requested(job_id)
    ) <> (
      select count(distinct requested.job_id)
      from unnest(p_job_ids) as requested(job_id)
    ) then
    raise exception using message = 'INVALID_MEDIA_CLEANUP_JOB_IDS';
  end if;

  if p_lease_seconds is null
    or p_lease_seconds < 30
    or p_lease_seconds > 300 then
    raise exception using message = 'INVALID_MEDIA_CLEANUP_LEASE_SECONDS';
  end if;

  update public.media_cleanup_queue queue
  set status = 'dead',
      next_attempt_at = null,
      locked_at = null,
      locked_until = null,
      lease_token = null,
      processed_at = null,
      last_error_code = coalesce(
        nullif(queue.last_error_code, ''),
        'MAX_ATTEMPTS_EXCEEDED'
      ),
      updated_at = v_now
  where queue.id = any(p_job_ids)
    and queue.attempts >= 7
    and (
      queue.status in ('pending', 'failed')
      or (queue.status = 'processing' and queue.locked_until <= v_now)
    );

  return query
  with candidates as (
    select queue.id
    from public.media_cleanup_queue queue
    where queue.id = any(p_job_ids)
      and queue.attempts < 7
      and (
        (
          queue.status in ('pending', 'failed')
          and queue.next_attempt_at <= v_now
        )
        or (
          queue.status = 'processing'
          and queue.locked_until <= v_now
        )
      )
    order by queue.created_at, queue.id
    for update skip locked
  ), claimed as (
    update public.media_cleanup_queue queue
    set status = 'processing',
        attempts = queue.attempts + 1,
        next_attempt_at = null,
        locked_at = v_now,
        locked_until = v_now + make_interval(secs => p_lease_seconds),
        lease_token = gen_random_uuid(),
        last_attempt_at = v_now,
        processed_at = null,
        updated_at = v_now
    from candidates
    where queue.id = candidates.id
    returning queue.*
  )
  select
    claimed.id,
    claimed.storage_provider,
    claimed.storage_key,
    claimed.lease_token,
    claimed.attempts,
    claimed.locked_until
  from claimed
  order by claimed.created_at, claimed.id;
end;
$function$;

alter function public.claim_media_cleanup_jobs_by_ids(bigint[], integer)
  owner to postgres;
revoke all on function public.claim_media_cleanup_jobs_by_ids(bigint[], integer)
  from public, anon, authenticated;
grant execute on function public.claim_media_cleanup_jobs_by_ids(bigint[], integer)
  to service_role;

comment on function public.claim_media_cleanup_jobs_by_ids(bigint[], integer) is
  'Claims only the explicitly named due cleanup jobs, preserving the canonical lease contract without recovering uploads or claiming unrelated work.';

do $postflight$
declare
  v_bad_function_count integer;
begin
  if (select count(*) from public.capability_catalog) <> 23
    or (select count(*) from public.capability_catalog where is_active) <> 21
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 21
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'cycles.manage'
        and display_name = 'Manage Cycles'
        and risk_level = 'critical'
        and assignable_to_non_admin
        and is_active
        and implementation_version = 1
        and definition_hash =
          '4f3e07f01bc453f594994689c3049e698ca2bd1d1c99e75927d161056033f710'
    )
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key = 'cycles.manage'
    ) then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_MANAGEMENT_CAPABILITY_POSTFLIGHT_MISMATCH';
  end if;

  select count(*)
  into v_bad_function_count
  from pg_proc function_row
  join pg_namespace namespace_row
    on namespace_row.oid = function_row.pronamespace
  where namespace_row.nspname = 'public'
    and function_row.oid in (
      'public.assert_cycle_manager(text)'::regprocedure,
      'public.manage_cycle_phase(text,bigint,text,text,integer,integer,text,uuid)'::regprocedure,
      'public.start_cycle_managed(bigint,text,jsonb)'::regprocedure,
      'public.finalize_cycle_managed(bigint,text)'::regprocedure,
      'public.reset_cycle_managed(bigint,text,text)'::regprocedure,
      'public.moderate_cycle_end_submission(text,bigint,bigint,text,text,boolean,text,text,text,uuid)'::regprocedure,
      'public.claim_media_cleanup_jobs_by_ids(bigint[],integer)'::regprocedure
    )
    and (
      pg_get_userbyid(function_row.proowner) <> 'postgres'
      or not function_row.prosecdef
      or function_row.proconfig is distinct from
        array['search_path=public, pg_temp']::text[]
    );

  if v_bad_function_count <> 0
    or not coalesce((
      select relation_row.relrowsecurity
      from pg_class relation_row
      join pg_namespace namespace_row
        on namespace_row.oid = relation_row.relnamespace
      where namespace_row.nspname = 'public'
        and relation_row.relname = 'cycle_management_requests'
    ), false)
    or has_table_privilege(
      'anon', 'public.cycle_management_requests', 'select'
    )
    or has_table_privilege(
      'authenticated', 'public.cycle_management_requests', 'select'
    )
    or has_table_privilege(
      'service_role', 'public.cycle_management_requests', 'select'
    )
    or has_function_privilege(
      'anon',
      'public.manage_cycle_phase(text,bigint,text,text,integer,integer,text,uuid)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.manage_cycle_phase(text,bigint,text,text,integer,integer,text,uuid)',
      'execute'
    )
    or has_function_privilege(
      'service_role', 'public.start_cycle(bigint,text,jsonb)', 'execute'
    )
    or has_function_privilege(
      'service_role', 'public.finalize_cycle(bigint,text)', 'execute'
    )
    or has_function_privilege(
      'service_role', 'public.reset_cycle(bigint,text,text)', 'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.manage_cycle_phase(text,bigint,text,text,integer,integer,text,uuid)',
      'execute'
    )
    or not has_function_privilege(
      'service_role', 'public.start_cycle_managed(bigint,text,jsonb)', 'execute'
    )
    or not has_function_privilege(
      'service_role', 'public.finalize_cycle_managed(bigint,text)', 'execute'
    )
    or not has_function_privilege(
      'service_role', 'public.reset_cycle_managed(bigint,text,text)', 'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.moderate_cycle_end_submission(text,bigint,bigint,text,text,boolean,text,text,text,uuid)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.claim_media_cleanup_jobs_by_ids(bigint[],integer)',
      'execute'
    ) then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_MANAGEMENT_SECURITY_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;

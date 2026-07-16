\set ON_ERROR_STOP on

begin;

-- Isolate synthetic current-Cycle fixtures without changing persisted DEV state.
update public.voting_cycles
set status = 'archived'
where status::text in (
  'draft', 'active', 'submission_open', 'submission_closed', 'voting_open',
  'voting_closed', 'paused', 'finalizing'
);

create function pg_temp.fail_selected_admin_audit_writes()
returns trigger
language plpgsql
as $$
begin
  if new.actor_id = '900000000000000099' then
    raise exception using message = 'FORCED_START_AUDIT_FAILURE';
  end if;

  return new;
end;
$$;

create function pg_temp.fail_selected_cycle_event_writes()
returns trigger
language plpgsql
as $$
begin
  if new.cycle_id = 2000010099 then
    raise exception using message = 'FORCED_AUTOMATION_EVENT_FAILURE';
  end if;

  return new;
end;
$$;

create trigger cycle_start_forced_audit_failure
before insert on public.admin_action_logs
for each row execute function pg_temp.fail_selected_admin_audit_writes();

create trigger cycle_automation_forced_event_failure
before insert on public.cycle_events
for each row execute function pg_temp.fail_selected_cycle_event_writes();

do $$
declare
  v_settings constant jsonb := jsonb_build_object(
    'theme', 'DEV transactional test',
    'themeSource', 'manual',
    'rewardDescription', 'DEV test reward',
    'sponsored', jsonb_build_object(
      'enabled', false,
      'companyName', '',
      'sponsorLink', '',
      'bannerR2Key', '',
      'bannerUrl', null
    )
  );
  v_result jsonb;
  v_event_count integer;
  v_audit_count integer;
  v_cycle public.voting_cycles%rowtype;
begin
  if exists (
    select 1
    from public.voting_cycles
    where id between 2000010000 and 2000010200
  ) then
    raise exception 'CYCLE_AUTOMATION_TEST_ID_COLLISION';
  end if;

  -- Start 1/2/9: normal draft, exact once, repeated request, invalid status.
  insert into public.voting_cycles (id, status)
  values (2000010001, 'draft');

  v_result := public.start_cycle(
    2000010001,
    '900000000000000001',
    v_settings
  );

  if (v_result ->> 'cycleId')::bigint <> 2000010001
    or (v_result ->> 'status') <> 'submission_open'
    or (v_result ->> 'alreadyStarted')::boolean
    or not (v_result ->> 'reusedDraft')::boolean
  then
    raise exception 'START_NORMAL_DRAFT_FAILED: %', v_result;
  end if;

  select count(*)::integer
  into v_event_count
  from public.cycle_events
  where cycle_id = 2000010001
    and event_type = 'submission_phase_opened';

  select count(*)::integer
  into v_audit_count
  from public.admin_action_logs
  where target_id = '2000010001'
    and action = 'cycle_started';

  if v_event_count <> 1 or v_audit_count <> 1 then
    raise exception 'START_EVENT_AUDIT_NOT_EXACTLY_ONCE';
  end if;

  v_result := public.start_cycle(
    2000010001,
    '900000000000000001',
    v_settings
  );

  if not (v_result ->> 'alreadyStarted')::boolean then
    raise exception 'START_REPEAT_NOT_IDEMPOTENT: %', v_result;
  end if;

  if (select count(*) from public.cycle_events where cycle_id = 2000010001) <> 1
    or (select count(*) from public.admin_action_logs where target_id = '2000010001' and action = 'cycle_started') <> 1
  then
    raise exception 'START_REPEAT_DUPLICATED_SIDE_EFFECTS';
  end if;

  update public.voting_cycles
  set status = 'finished'
  where id = 2000010001;

  begin
    perform public.start_cycle(
      2000010001,
      '900000000000000001',
      v_settings
    );
    raise exception 'FINISHED_CYCLE_WAS_STARTED';
  exception
    when others then
      if sqlerrm <> 'CYCLE_NOT_STARTABLE' then
        raise;
      end if;
  end;

  -- Start 6/7/8 + Reset regression: same row, reset marker cleared/history kept.
  insert into public.voting_cycles (
    id,
    status,
    reset_count,
    reset_at
  ) values (
    2000010002,
    'draft',
    7,
    transaction_timestamp()
  );

  v_result := public.start_cycle(
    2000010002,
    '900000000000000002',
    v_settings
  );

  select *
  into v_cycle
  from public.voting_cycles
  where id = 2000010002;

  if (v_result ->> 'cycleId')::bigint <> 2000010002
    or not (v_result ->> 'reusedResetDraft')::boolean
    or v_cycle.reset_at is not null
    or v_cycle.reset_count <> 7
  then
    raise exception 'RESET_DRAFT_RESTART_FAILED: %', v_result;
  end if;

  v_result := public.reset_cycle(
    2000010002,
    '900000000000000002',
    'Transactional start reset regression'
  );

  if (v_result ->> 'status') <> 'draft'
    or (v_result ->> 'cycleId')::bigint <> 2000010002
  then
    raise exception 'RESET_REGRESSION_FAILED: %', v_result;
  end if;

  v_result := public.start_cycle(
    2000010002,
    '900000000000000002',
    v_settings
  );

  if (v_result ->> 'cycleId')::bigint <> 2000010002
    or (v_result ->> 'resetCount')::integer <> 8
  then
    raise exception 'RESET_DRAFT_SECOND_RESTART_FAILED: %', v_result;
  end if;

  update public.voting_cycles
  set status = 'finished'
  where id = 2000010002;

  -- Start 10: forced audit failure rolls cycle, event and config back.
  insert into public.voting_cycles (id, status)
  values (2000010003, 'draft');

  begin
    perform public.start_cycle(
      2000010003,
      '900000000000000099',
      v_settings
    );
    raise exception 'FORCED_START_FAILURE_DID_NOT_FAIL';
  exception
    when others then
      if sqlerrm <> 'FORCED_START_AUDIT_FAILURE' then
        raise;
      end if;
  end;

  if not exists (
    select 1
    from public.voting_cycles
    where id = 2000010003
      and status = 'draft'
      and submission_starts_at is null
  )
    or exists (select 1 from public.cycle_events where cycle_id = 2000010003)
    or exists (
      select 1
      from public.admin_action_logs
      where target_id = '2000010003'
    )
  then
    raise exception 'START_FAILURE_LEFT_PARTIAL_STATE';
  end if;

  delete from public.voting_cycles where id = 2000010003;

  -- Unique-index defense in depth: two current rows cannot coexist.
  insert into public.voting_cycles (id, status)
  values (2000010004, 'submission_open');

  begin
    insert into public.voting_cycles (id, status)
    values (2000010005, 'voting_open');
    raise exception 'CURRENT_CYCLE_UNIQUE_INDEX_DID_NOT_BLOCK';
  exception
    when unique_violation then
      null;
  end;

  delete from public.voting_cycles where id = 2000010004;

  -- Transition 1: future submission deadline is a stable no-op.
  insert into public.voting_cycles (
    id,
    status,
    submission_starts_at,
    submission_ends_at
  ) values (
    2000010010,
    'submission_open',
    transaction_timestamp(),
    transaction_timestamp() + interval '1 hour'
  );

  v_result := public.process_due_cycle_transitions(2000010010);

  if (v_result ->> 'outcome') <> 'noop'
    or (v_result ->> 'reason') <> 'submission_not_due'
  then
    raise exception 'SUBMISSION_NOT_DUE_CHANGED: %', v_result;
  end if;

  -- Transition 2/3/9: due transition exactly once, voting has no timer, replay no-op.
  update public.voting_cycles
  set submission_ends_at = transaction_timestamp() - interval '1 minute'
  where id = 2000010010;

  insert into public.cycle_reminders (
    cycle_id,
    phase,
    reminder_type,
    due_at
  ) values (
    2000010010,
    'submission_open',
    'phase_end_due',
    transaction_timestamp() - interval '1 minute'
  );

  v_result := public.process_due_cycle_transitions(2000010010);

  if (v_result ->> 'transition') <> 'submission_open_to_voting_open'
    or (v_result ->> 'outcome') <> 'transitioned'
    or not (v_result ->> 'eventCreated')::boolean
    or not exists (
      select 1
      from public.voting_cycles
      where id = 2000010010
        and status = 'voting_open'
        and voting_starts_at is not null
        and voting_ends_at is null
    )
    or not exists (
      select 1
      from public.cycle_reminders
      where cycle_id = 2000010010
        and status = 'cancelled'
    )
  then
    raise exception 'SUBMISSION_DUE_TRANSITION_FAILED: %', v_result;
  end if;

  v_result := public.process_due_cycle_transitions(2000010010);

  if (v_result ->> 'outcome') <> 'noop'
    or (v_result ->> 'reason') <> 'voting_timer_not_set'
    or (select count(*) from public.cycle_events where cycle_id = 2000010010 and event_type = 'voting_phase_opened') <> 1
  then
    raise exception 'SUBMISSION_TRANSITION_REPLAY_FAILED: %', v_result;
  end if;

  -- Transition 5/6/7: voting future no-op, due closes without finalization.
  update public.voting_cycles
  set voting_ends_at = transaction_timestamp() + interval '1 hour'
  where id = 2000010010;

  v_result := public.process_due_cycle_transitions(2000010010);

  if (v_result ->> 'reason') <> 'voting_not_due' then
    raise exception 'VOTING_NOT_DUE_CHANGED: %', v_result;
  end if;

  update public.voting_cycles
  set voting_ends_at = transaction_timestamp() - interval '1 minute'
  where id = 2000010010;

  v_result := public.process_due_cycle_transitions(2000010010);

  if (v_result ->> 'transition') <> 'voting_open_to_voting_closed'
    or not exists (
      select 1
      from public.voting_cycles
      where id = 2000010010
        and status = 'voting_closed'
        and finalized_at is null
        and winners_published = false
    )
    or exists (select 1 from public.cycle_results where cycle_id = 2000010010)
    or exists (select 1 from public.winner_public_profiles where cycle_id = 2000010010)
  then
    raise exception 'VOTING_DUE_TRANSITION_FAILED: %', v_result;
  end if;

  delete from public.voting_cycles where id = 2000010010;

  -- Transition 8: paused Cycle is never changed.
  insert into public.voting_cycles (
    id,
    status,
    paused_from_status,
    phase_paused_at,
    phase_paused_remaining_seconds
  ) values (
    2000010011,
    'paused',
    'submission_open',
    transaction_timestamp(),
    0
  );

  v_result := public.process_due_cycle_transitions(2000010011);

  if (v_result ->> 'reason') <> 'paused'
    or not exists (
      select 1 from public.voting_cycles where id = 2000010011 and status = 'paused'
    )
  then
    raise exception 'PAUSED_CYCLE_CHANGED: %', v_result;
  end if;

  delete from public.voting_cycles where id = 2000010011;

  -- Transition 10: stranded submission_closed is recovered canonically.
  insert into public.voting_cycles (id, status, submission_ends_at)
  values (
    2000010012,
    'submission_closed',
    transaction_timestamp() - interval '2 minutes'
  );

  v_result := public.process_due_cycle_transitions(2000010012);

  if (v_result ->> 'transition') <> 'submission_closed_to_voting_open'
    or not exists (
      select 1
      from public.voting_cycles
      where id = 2000010012
        and status = 'voting_open'
        and voting_starts_at is not null
        and voting_ends_at is null
    )
  then
    raise exception 'STRANDED_SUBMISSION_CLOSE_NOT_RECOVERED: %', v_result;
  end if;

  update public.voting_cycles
  set status = 'finished'
  where id = 2000010012;

  -- Transition 10: voting_open missing submission end is safely normalized.
  insert into public.voting_cycles (
    id,
    status,
    voting_starts_at,
    voting_ends_at,
    ends_at
  ) values (
    2000010013,
    'voting_open',
    transaction_timestamp() - interval '5 minutes',
    null,
    transaction_timestamp() + interval '1 hour'
  );

  v_result := public.process_due_cycle_transitions(2000010013);

  if (v_result ->> 'outcome') <> 'repaired'
    or not exists (
      select 1
      from public.voting_cycles
      where id = 2000010013
        and status = 'voting_open'
        and submission_ends_at = voting_starts_at
        and ends_at is null
    )
  then
    raise exception 'VOTING_OPEN_NOT_NORMALIZED: %', v_result;
  end if;

  update public.voting_cycles
  set status = 'finished'
  where id = 2000010013;

  -- Transition 11: ambiguous legacy/contradictory states are diagnostics only.
  insert into public.voting_cycles (id, status, ends_at)
  values (
    2000010014,
    'active',
    transaction_timestamp() - interval '1 minute'
  );

  v_result := public.process_due_cycle_transitions(2000010014);

  if (v_result ->> 'outcome') <> 'diagnostic'
    or (v_result ->> 'reason') <> 'legacy_active_phase_is_ambiguous'
  then
    raise exception 'LEGACY_ACTIVE_WAS_GUESSED: %', v_result;
  end if;

  delete from public.voting_cycles where id = 2000010014;

  insert into public.voting_cycles (
    id,
    status,
    submission_ends_at,
    voting_ends_at
  ) values (
    2000010015,
    'submission_open',
    transaction_timestamp() - interval '1 minute',
    transaction_timestamp() + interval '1 hour'
  );

  v_result := public.process_due_cycle_transitions(2000010015);

  if (v_result ->> 'outcome') <> 'diagnostic'
    or (v_result ->> 'reason') <> 'submission_open_has_voting_end'
    or not exists (
      select 1 from public.voting_cycles where id = 2000010015 and status = 'submission_open'
    )
  then
    raise exception 'CONTRADICTORY_SUBMISSION_STATE_WAS_GUESSED: %', v_result;
  end if;

  delete from public.voting_cycles where id = 2000010015;

  insert into public.voting_cycles (
    id,
    status,
    voting_ends_at
  ) values (
    2000010016,
    'voting_open',
    transaction_timestamp() - interval '1 minute'
  );

  v_result := public.process_due_cycle_transitions(2000010016);

  if (v_result ->> 'outcome') <> 'diagnostic'
    or (v_result ->> 'reason') <> 'voting_open_missing_voting_start'
    or not exists (
      select 1 from public.voting_cycles where id = 2000010016 and status = 'voting_open'
    )
  then
    raise exception 'MISSING_VOTING_START_WAS_GUESSED: %', v_result;
  end if;

  delete from public.voting_cycles where id = 2000010016;

  -- Transition 12: forced event failure rolls state and reminder back together.
  insert into public.voting_cycles (
    id,
    status,
    submission_starts_at,
    submission_ends_at
  ) values (
    2000010099,
    'submission_open',
    transaction_timestamp() - interval '1 hour',
    transaction_timestamp() - interval '1 minute'
  );

  insert into public.cycle_reminders (
    cycle_id,
    phase,
    reminder_type,
    due_at
  ) values (
    2000010099,
    'submission_open',
    'phase_end_due',
    transaction_timestamp() - interval '1 minute'
  );

  begin
    perform public.process_due_cycle_transitions(2000010099);
    raise exception 'FORCED_AUTOMATION_FAILURE_DID_NOT_FAIL';
  exception
    when others then
      if sqlerrm <> 'FORCED_AUTOMATION_EVENT_FAILURE' then
        raise;
      end if;
  end;

  if not exists (
    select 1
    from public.voting_cycles
    where id = 2000010099
      and status = 'submission_open'
  )
    or not exists (
      select 1
      from public.cycle_reminders
      where cycle_id = 2000010099
        and status = 'pending'
    )
    or exists (select 1 from public.cycle_events where cycle_id = 2000010099)
  then
    raise exception 'AUTOMATION_FAILURE_LEFT_PARTIAL_STATE';
  end if;
end;
$$;

rollback;

\set ON_ERROR_STOP on

begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

create temporary table atomic_moderation_fixture (
  cycle_id bigint not null,
  submission_id bigint not null,
  admin_id text not null,
  vote_id bigint not null
) on commit drop;

insert into atomic_moderation_fixture (
  cycle_id,
  submission_id,
  admin_id,
  vote_id
)
select
  cycle_row.id,
  submission_row.id,
  admin_row.discord_user_id,
  coalesce((select max(id) from public.votes), 0) + 1000000000
from public.voting_cycles as cycle_row
join lateral (
  select id
  from public.submissions
  where cycle_id = cycle_row.id
  order by id
  limit 1
) as submission_row on true
cross join lateral (
  select discord_user_id
  from public.team_members
  where role = 'admin'
  order by discord_user_id
  limit 1
) as admin_row
where cycle_row.status::text in ('submission_open', 'voting_open')
order by cycle_row.id
limit 1;

do $preflight$
begin
  if (select count(*) from atomic_moderation_fixture) <> 1
    or (select count(*) from public.capability_catalog) <> 7
    or (select count(*) from public.capability_catalog where is_active) <> 6
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 6
    or exists (select 1 from public.team_role_capabilities)
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'submissions.submission_phase.moderate'
        and not is_active
        and not assignable_to_non_admin
    )
  then
    raise exception 'ATOMIC_MODERATION_DEV_PREFLIGHT_DRIFT';
  end if;
end;
$preflight$;

update public.submissions
set is_disqualified = false,
    disqualification_type = null,
    disqualification_reason_code = null,
    disqualification_reason_text = null,
    disqualified_at = null,
    disqualified_by_discord_user_id = null,
    disqualified_by_discord_username = null
where id = (select submission_id from atomic_moderation_fixture);

update public.voting_cycles
set status = 'submission_open'
where id = (select cycle_id from atomic_moderation_fixture);

insert into public.votes (
  id,
  cycle_id,
  submission_id,
  discord_user_id
)
select vote_id, cycle_id, submission_id, 'atomic-mod-test-voter'
from atomic_moderation_fixture;

do $admin_submission_phase$
declare
  v_fixture atomic_moderation_fixture%rowtype;
  v_first jsonb;
  v_retry jsonb;
  v_noop jsonb;
  v_reinstate jsonb;
begin
  select * into strict v_fixture from atomic_moderation_fixture;

  v_first := public.moderate_submission(
    v_fixture.admin_id,
    v_fixture.cycle_id,
    v_fixture.submission_id,
    'disqualify',
    'submission_open',
    false,
    'manual',
    'policy_violation',
    'Rollback-only admin submission-phase DQ.',
    '51000000-0000-0000-0000-000000000001'::uuid
  );
  v_retry := public.moderate_submission(
    v_fixture.admin_id,
    v_fixture.cycle_id,
    v_fixture.submission_id,
    'disqualify',
    'submission_open',
    false,
    'manual',
    'policy_violation',
    'Rollback-only admin submission-phase DQ.',
    '51000000-0000-0000-0000-000000000001'::uuid
  );

  if v_first #>> '{changed}' <> 'true'
    or v_first #>> '{requiredCapability}' <>
      'submissions.submission_phase.disqualify'
    or v_retry #>> '{replayed}' <> 'true'
    or (
      select count(*)
      from public.moderation_action_logs
      where moderation_request_id =
        '51000000-0000-0000-0000-000000000001'::uuid
    ) <> 1
    or (
      select count(*)
      from public.submission_moderation_requests
      where idempotency_key =
        '51000000-0000-0000-0000-000000000001'::uuid
    ) <> 1
    or not exists (
      select 1
      from public.submissions
      where id = v_fixture.submission_id
        and is_disqualified
        and disqualification_type = 'manual'
        and disqualification_reason_code = 'policy_violation'
        and disqualified_by_discord_user_id = v_fixture.admin_id
        and disqualified_by_discord_username is not null
        and disqualified_at is not null
    )
  then
    raise exception 'ADMIN_SUBMISSION_DQ_OR_RETRY_FAILED';
  end if;

  begin
    perform public.moderate_submission(
      v_fixture.admin_id,
      v_fixture.cycle_id,
      v_fixture.submission_id,
      'disqualify',
      'submission_open',
      true,
      'manual',
      'different_payload',
      'Different payload.',
      '51000000-0000-0000-0000-000000000001'::uuid
    );
    raise exception 'IDEMPOTENCY_CONFLICT_NOT_REJECTED';
  exception
    when sqlstate '40001' then
      if sqlerrm <> 'SUBMISSION_MODERATION_IDEMPOTENCY_CONFLICT' then
        raise;
      end if;
  end;

  v_noop := public.moderate_submission(
    v_fixture.admin_id,
    v_fixture.cycle_id,
    v_fixture.submission_id,
    'disqualify',
    'submission_open',
    true,
    'manual',
    'confirmed_noop',
    'Already disqualified.',
    '51000000-0000-0000-0000-000000000002'::uuid
  );

  if v_noop #>> '{changed}' <> 'false'
    or exists (
      select 1
      from public.moderation_action_logs
      where moderation_request_id =
        '51000000-0000-0000-0000-000000000002'::uuid
    )
    or not exists (
      select 1
      from public.submission_moderation_requests
      where idempotency_key =
        '51000000-0000-0000-0000-000000000002'::uuid
    )
  then
    raise exception 'CONTROLLED_NOOP_FAILED';
  end if;

  begin
    perform public.moderate_submission(
      v_fixture.admin_id,
      v_fixture.cycle_id,
      v_fixture.submission_id,
      'reinstate',
      'submission_open',
      false,
      null,
      'manual_review',
      'Stale expected state.',
      '51000000-0000-0000-0000-000000000003'::uuid
    );
    raise exception 'STALE_EXPECTED_STATE_NOT_REJECTED';
  exception
    when sqlstate '40001' then
      if sqlerrm <> 'MODERATION_EXPECTED_STATE_CONFLICT' then
        raise;
      end if;
  end;

  v_reinstate := public.moderate_submission(
    v_fixture.admin_id,
    v_fixture.cycle_id,
    v_fixture.submission_id,
    'reinstate',
    'submission_open',
    true,
    null,
    'manual_review',
    'Rollback-only reinstatement rationale.',
    '51000000-0000-0000-0000-000000000004'::uuid
  );

  if v_reinstate #>> '{changed}' <> 'true'
    or v_reinstate #>> '{requiredCapability}' <>
      'submissions.submission_phase.reinstate'
    or not exists (
      select 1
      from public.submissions
      where id = v_fixture.submission_id
        and not coalesce(is_disqualified, false)
        and disqualification_type is null
        and disqualification_reason_code is null
        and disqualification_reason_text is null
        and disqualified_at is null
        and disqualified_by_discord_user_id is null
        and disqualified_by_discord_username is null
    )
    or not exists (
      select 1
      from public.votes
      where id = v_fixture.vote_id
        and cycle_id = v_fixture.cycle_id
        and submission_id = v_fixture.submission_id
    )
  then
    raise exception 'ADMIN_SUBMISSION_REINSTATE_OR_VOTE_PRESERVATION_FAILED';
  end if;
end;
$admin_submission_phase$;

do $phase_cycle_and_submission_conflicts$
declare
  v_fixture atomic_moderation_fixture%rowtype;
  v_other_submission_id bigint;
begin
  select * into strict v_fixture from atomic_moderation_fixture;

  update public.voting_cycles
  set status = 'voting_open'
  where id = v_fixture.cycle_id;

  perform public.moderate_submission(
    v_fixture.admin_id, v_fixture.cycle_id, v_fixture.submission_id,
    'disqualify', 'voting_open', false, 'manual', 'voting_review',
    'Rollback-only voting DQ.',
    '51000000-0000-0000-0000-000000000005'::uuid
  );
  perform public.moderate_submission(
    v_fixture.admin_id, v_fixture.cycle_id, v_fixture.submission_id,
    'reinstate', 'voting_open', true, null, 'voting_review',
    'Rollback-only voting reinstatement.',
    '51000000-0000-0000-0000-000000000006'::uuid
  );

  if (
    select count(*)
    from public.moderation_action_logs
    where moderation_request_id in (
      '51000000-0000-0000-0000-000000000005'::uuid,
      '51000000-0000-0000-0000-000000000006'::uuid
    )
  ) <> 2 then
    raise exception 'ADMIN_VOTING_PHASE_ACTIONS_FAILED';
  end if;

  begin
    perform public.moderate_submission(
      v_fixture.admin_id, v_fixture.cycle_id, v_fixture.submission_id,
      'disqualify', 'submission_open', false, 'manual', 'stale_phase',
      'Stale phase.', '51000000-0000-0000-0000-000000000007'::uuid
    );
    raise exception 'STALE_PHASE_NOT_REJECTED';
  exception
    when sqlstate '40001' then
      if sqlerrm <> 'MODERATION_PHASE_CONFLICT' then raise; end if;
  end;

  update public.voting_cycles
  set status = 'voting_closed'
  where id = v_fixture.cycle_id;

  begin
    perform public.moderate_submission(
      v_fixture.admin_id, v_fixture.cycle_id, v_fixture.submission_id,
      'disqualify', 'voting_open', false, 'manual', 'closed_phase',
      'Closed phase.', '51000000-0000-0000-0000-000000000008'::uuid
    );
    raise exception 'CLOSED_PHASE_NOT_REJECTED';
  exception
    when sqlstate '40001' then
      if sqlerrm <> 'MODERATION_PHASE_CLOSED' then raise; end if;
  end;

  update public.voting_cycles
  set status = 'submission_open'
  where id = v_fixture.cycle_id;

  begin
    perform public.moderate_submission(
      v_fixture.admin_id, 8999999999, v_fixture.submission_id,
      'disqualify', 'submission_open', false, 'manual', 'wrong_cycle',
      'Unknown cycle.', '51000000-0000-0000-0000-000000000009'::uuid
    );
    raise exception 'UNKNOWN_CYCLE_NOT_REJECTED';
  exception
    when sqlstate '40001' then
      if sqlerrm <> 'MODERATION_CYCLE_NOT_FOUND' then raise; end if;
  end;

  select id
  into v_other_submission_id
  from public.submissions
  where cycle_id is distinct from v_fixture.cycle_id
  order by id
  limit 1;

  if v_other_submission_id is not null then
    begin
      perform public.moderate_submission(
        v_fixture.admin_id, v_fixture.cycle_id, v_other_submission_id,
        'disqualify', 'submission_open', false, 'manual', 'wrong_submission',
        'Wrong-cycle submission.',
        '51000000-0000-0000-0000-000000000010'::uuid
      );
      raise exception 'WRONG_CYCLE_SUBMISSION_NOT_REJECTED';
    exception
      when sqlstate '40001' then
        if sqlerrm <> 'MODERATION_SUBMISSION_CYCLE_CONFLICT' then raise; end if;
    end;
  end if;

  begin
    perform public.moderate_submission(
      v_fixture.admin_id, v_fixture.cycle_id, 8999999999,
      'disqualify', 'submission_open', false, 'manual', 'missing_submission',
      'Unknown submission.',
      '51000000-0000-0000-0000-000000000011'::uuid
    );
    raise exception 'UNKNOWN_SUBMISSION_NOT_REJECTED';
  exception
    when sqlstate '40001' then
      if sqlerrm <> 'MODERATION_SUBMISSION_NOT_FOUND' then raise; end if;
  end;
end;
$phase_cycle_and_submission_conflicts$;

insert into public.team_members (
  discord_user_id,
  discord_username,
  role
) values (
  'atomic-mod-test-member',
  'atomic-mod-test-member',
  'trial_moderator'
);

do $authorization_failures$
declare
  v_fixture atomic_moderation_fixture%rowtype;
begin
  select * into strict v_fixture from atomic_moderation_fixture;

  for v_fixture in select * from atomic_moderation_fixture loop
    begin
      perform public.moderate_submission(
        'atomic-mod-test-no-member', v_fixture.cycle_id,
        v_fixture.submission_id, 'disqualify', 'submission_open', false,
        'manual', 'authorization', 'No team member.',
        '51000000-0000-0000-0000-000000000012'::uuid
      );
      raise exception 'NON_MEMBER_NOT_REJECTED';
    exception
      when sqlstate '42501' then
        if sqlerrm <> 'SUBMISSION_MODERATION_FORBIDDEN' then raise; end if;
    end;

    begin
      perform public.moderate_submission(
        'atomic-mod-test-member', v_fixture.cycle_id,
        v_fixture.submission_id, 'disqualify', 'submission_open', false,
        'manual', 'authorization', 'No grant.',
        '51000000-0000-0000-0000-000000000013'::uuid
      );
      raise exception 'MISSING_GRANT_NOT_REJECTED';
    exception
      when sqlstate '42501' then
        if sqlerrm <> 'SUBMISSION_MODERATION_FORBIDDEN' then raise; end if;
    end;

    update public.team_roles set is_active = false
    where key = 'trial_moderator';
    begin
      perform public.moderate_submission(
        'atomic-mod-test-member', v_fixture.cycle_id,
        v_fixture.submission_id, 'disqualify', 'submission_open', false,
        'manual', 'authorization', 'Inactive role.',
        '51000000-0000-0000-0000-000000000014'::uuid
      );
      raise exception 'INACTIVE_ROLE_NOT_REJECTED';
    exception
      when sqlstate '42501' then
        if sqlerrm <> 'SUBMISSION_MODERATION_FORBIDDEN' then raise; end if;
    end;
    update public.team_roles set is_active = true
    where key = 'trial_moderator';
  end loop;
end;
$authorization_failures$;

do $four_rights_are_separate$
declare
  v_fixture atomic_moderation_fixture%rowtype;
  v_case record;
  v_result jsonb;
  v_request uuid;
  v_denied_request uuid;
begin
  select * into strict v_fixture from atomic_moderation_fixture;

  for v_case in
    select * from (values
      ('submission_open', 'disqualify', false,
       'submissions.submission_phase.disqualify'),
      ('submission_open', 'reinstate', true,
       'submissions.submission_phase.reinstate'),
      ('voting_open', 'disqualify', false,
       'submissions.voting_phase.disqualify'),
      ('voting_open', 'reinstate', true,
       'submissions.voting_phase.reinstate')
    ) as cases(phase, operation, expected_state, capability_key)
  loop
    delete from public.team_role_capabilities
    where role_key = 'trial_moderator';
    insert into public.team_role_capabilities (
      role_key, capability_key, granted_by_discord_user_id, grant_reason
    ) values (
      'trial_moderator', v_case.capability_key, v_fixture.admin_id,
      'Rollback-only exact-right test'
    );

    update public.voting_cycles set status = v_case.phase::public.voting_cycle_status
    where id = v_fixture.cycle_id;
    update public.submissions
    set is_disqualified = v_case.expected_state,
        disqualification_type = case when v_case.expected_state then 'manual' end,
        disqualification_reason_code = case when v_case.expected_state then 'seed' end,
        disqualification_reason_text = case when v_case.expected_state then 'Seed state.' end,
        disqualified_at = case when v_case.expected_state then transaction_timestamp() end,
        disqualified_by_discord_user_id = case when v_case.expected_state then v_fixture.admin_id end,
        disqualified_by_discord_username = case when v_case.expected_state then 'Trusted seed' end
    where id = v_fixture.submission_id;

    v_denied_request := gen_random_uuid();
    begin
      perform public.moderate_submission(
        'atomic-mod-test-member', v_fixture.cycle_id,
        v_fixture.submission_id,
        case v_case.operation when 'disqualify' then 'reinstate' else 'disqualify' end,
        v_case.phase,
        v_case.expected_state,
        case v_case.operation when 'reinstate' then 'manual' else null end,
        'wrong_operation', 'Wrong operation right.', v_denied_request
      );
      raise exception 'CROSS_OPERATION_GRANT_ACCEPTED';
    exception
      when sqlstate '42501' then
        if sqlerrm <> 'SUBMISSION_MODERATION_FORBIDDEN' then raise; end if;
    end;

    v_request := gen_random_uuid();
    v_result := public.moderate_submission(
      'atomic-mod-test-member', v_fixture.cycle_id,
      v_fixture.submission_id, v_case.operation, v_case.phase,
      v_case.expected_state,
      case when v_case.operation = 'disqualify' then 'manual' else null end,
      'exact_right', 'Exact granular right.', v_request
    );

    if v_result #>> '{requiredCapability}' <> v_case.capability_key
      or v_result #>> '{changed}' <> 'true'
      or (
        select count(*)
        from public.moderation_action_logs
        where moderation_request_id = v_request
      ) <> 1
    then
      raise exception 'EXACT_GRANULAR_RIGHT_FAILED: %', v_case.capability_key;
    end if;
  end loop;

  delete from public.team_role_capabilities
  where role_key = 'trial_moderator';
end;
$four_rights_are_separate$;

create function pg_temp.fail_atomic_moderation_audit()
returns trigger
language plpgsql
as $trigger$
begin
  raise exception 'ATOMIC_MODERATION_TEST_AUDIT_FAILURE';
end;
$trigger$;

create trigger atomic_moderation_test_audit_failure
before insert on public.moderation_action_logs
for each row
when (new.moderation_request_id =
  '51000000-0000-0000-0000-000000000099'::uuid)
execute function pg_temp.fail_atomic_moderation_audit();

do $atomic_rollback$
declare
  v_fixture atomic_moderation_fixture%rowtype;
begin
  select * into strict v_fixture from atomic_moderation_fixture;
  update public.voting_cycles set status = 'submission_open'
  where id = v_fixture.cycle_id;
  update public.submissions
  set is_disqualified = false,
      disqualification_type = null,
      disqualification_reason_code = null,
      disqualification_reason_text = null,
      disqualified_at = null,
      disqualified_by_discord_user_id = null,
      disqualified_by_discord_username = null
  where id = v_fixture.submission_id;

  begin
    perform public.moderate_submission(
      v_fixture.admin_id, v_fixture.cycle_id, v_fixture.submission_id,
      'disqualify', 'submission_open', false, 'manual', 'audit_failure',
      'The forced audit failure must roll back.',
      '51000000-0000-0000-0000-000000000099'::uuid
    );
    raise exception 'FORCED_AUDIT_FAILURE_NOT_PROPAGATED';
  exception
    when others then
      if sqlerrm <> 'ATOMIC_MODERATION_TEST_AUDIT_FAILURE' then raise; end if;
  end;

  if exists (
    select 1 from public.submissions
    where id = v_fixture.submission_id and is_disqualified
  ) or exists (
    select 1 from public.moderation_action_logs
    where moderation_request_id =
      '51000000-0000-0000-0000-000000000099'::uuid
  ) or exists (
    select 1 from public.submission_moderation_requests
    where idempotency_key =
      '51000000-0000-0000-0000-000000000099'::uuid
  ) then
    raise exception 'AUDIT_FAILURE_DID_NOT_ROLL_BACK_ATOMICALLY';
  end if;
end;
$atomic_rollback$;

drop trigger atomic_moderation_test_audit_failure
  on public.moderation_action_logs;

do $postflight$
declare
  v_fixture atomic_moderation_fixture%rowtype;
begin
  select * into strict v_fixture from atomic_moderation_fixture;
  if not exists (
    select 1 from public.votes where id = v_fixture.vote_id
  ) or exists (
    select 1
    from public.moderation_action_logs
    where moderation_request_id in (
      '51000000-0000-0000-0000-000000000002'::uuid,
      '51000000-0000-0000-0000-000000000003'::uuid,
      '51000000-0000-0000-0000-000000000007'::uuid,
      '51000000-0000-0000-0000-000000000008'::uuid,
      '51000000-0000-0000-0000-000000000009'::uuid,
      '51000000-0000-0000-0000-000000000010'::uuid,
      '51000000-0000-0000-0000-000000000011'::uuid,
      '51000000-0000-0000-0000-000000000012'::uuid,
      '51000000-0000-0000-0000-000000000013'::uuid,
      '51000000-0000-0000-0000-000000000014'::uuid
    )
  ) then
    raise exception 'ATOMIC_MODERATION_POSTFLIGHT_FAILED';
  end if;
end;
$postflight$;

rollback;

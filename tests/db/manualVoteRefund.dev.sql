\set ON_ERROR_STOP on

begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

create temporary table manual_vote_refund_fixture (
  cycle_id bigint not null,
  selected_a_id bigint not null,
  selected_b_id bigint not null,
  untouched_id bigint not null,
  stale_dq_id bigint not null,
  reinstated_id bigint not null,
  admin_id text not null,
  delegated_id text not null,
  baseline_event_count bigint not null,
  baseline_item_count bigint not null
) on commit drop;

insert into manual_vote_refund_fixture
select
  8800000001,
  8800000011,
  8800000012,
  8800000013,
  8800000014,
  8800000015,
  admin_member.discord_user_id,
  delegated_member.discord_user_id,
  (select count(*) from public.vote_refund_events),
  (select count(*) from public.vote_refund_items)
from lateral (
  select discord_user_id
  from public.team_members
  where role = 'admin'
  order by discord_user_id
  limit 1
) admin_member
cross join lateral (
  select discord_user_id
  from public.team_members
  where role <> 'admin'
  order by role, discord_user_id
  limit 1
) delegated_member;

do $preflight$
begin
  if (select count(*) from manual_vote_refund_fixture) <> 1
    or (select count(*) from public.capability_catalog) <> 30
    or (select count(*) from public.capability_catalog where is_active) <> 28
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 28
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key in (
        'votes.refund_disqualified',
        'logs.vote_refunds.view'
      )
    )
    or to_regprocedure(
      'public.refund_disqualified_votes(text,bigint,integer,integer,jsonb,text,uuid)'
    ) is null
    or exists (
      select 1
      from public.voting_cycles
      where id = 8800000001
    )
    or exists (
      select 1
      from public.submissions
      where id between 8800000011 and 8800000015
    )
    or exists (
      select 1
      from public.votes
      where id between 8800000101 and 8800000109
    ) then
    raise exception 'MANUAL_VOTE_REFUND_DEV_PREFLIGHT_DRIFT';
  end if;
end;
$preflight$;

update public.voting_cycles
set status = 'draft'
where status::text in (
  'active',
  'submission_open',
  'submission_closed',
  'voting_open',
  'voting_closed',
  'paused',
  'finalizing'
);

insert into public.voting_cycles (
  id,
  status,
  votes_per_user,
  reset_count,
  theme
) values (
  8800000001,
  'voting_open',
  3,
  7,
  'Rollback-only manual vote refund contract'
);

insert into public.submissions (
  id,
  cycle_id,
  discord_user_id,
  is_disqualified,
  disqualification_type,
  disqualified_at
) values
  (8800000011, 8800000001, 'refund-test-submitter-a', true, 'manual', '2026-08-08T08:01:00Z'),
  (8800000012, 8800000001, 'refund-test-submitter-b', true, 'manual', '2026-08-08T08:02:00Z'),
  (8800000013, 8800000001, 'refund-test-submitter-c', true, 'manual', '2026-08-08T08:03:00Z'),
  (8800000014, 8800000001, 'refund-test-submitter-d', true, 'manual', '2026-08-08T08:04:00Z'),
  (8800000015, 8800000001, 'refund-test-submitter-e', true, 'manual', '2026-08-08T08:05:00Z');

insert into public.votes (
  id,
  cycle_id,
  submission_id,
  discord_user_id
) values
  (8800000101, 8800000001, 8800000011, 'refund-test-voter-1'),
  (8800000102, 8800000001, 8800000011, 'refund-test-voter-2'),
  (8800000103, 8800000001, 8800000011, 'refund-test-voter-3'),
  (8800000104, 8800000001, 8800000012, 'refund-test-voter-2'),
  (8800000105, 8800000001, 8800000012, 'refund-test-voter-4'),
  (8800000106, 8800000001, 8800000013, 'refund-test-voter-5'),
  (8800000107, 8800000001, 8800000013, 'refund-test-voter-6'),
  (8800000108, 8800000001, 8800000014, 'refund-test-voter-7'),
  (8800000109, 8800000001, 8800000015, 'refund-test-voter-8');

do $contract$
declare
  v_fixture manual_vote_refund_fixture%rowtype;
  v_selected_a_at timestamptz;
  v_selected_b_at timestamptz;
  v_untouched_at timestamptz;
  v_stale_at timestamptz;
  v_reinstated_at timestamptz;
  v_result jsonb;
  v_replay jsonb;
begin
  select * into strict v_fixture from manual_vote_refund_fixture;
  select disqualified_at into strict v_selected_a_at
    from public.submissions where id = v_fixture.selected_a_id;
  select disqualified_at into strict v_selected_b_at
    from public.submissions where id = v_fixture.selected_b_id;
  select disqualified_at into strict v_untouched_at
    from public.submissions where id = v_fixture.untouched_id;
  select disqualified_at into strict v_stale_at
    from public.submissions where id = v_fixture.stale_dq_id;
  select disqualified_at into strict v_reinstated_at
    from public.submissions where id = v_fixture.reinstated_id;

  v_result := public.refund_disqualified_votes(
    v_fixture.admin_id,
    v_fixture.cycle_id,
    7,
    3,
    jsonb_build_array(
      jsonb_build_object(
        'submissionId', v_fixture.selected_b_id,
        'expectedVoteCount', 2,
        'expectedDisqualifiedAt', v_selected_b_at
      ),
      jsonb_build_object(
        'submissionId', v_fixture.selected_a_id,
        'expectedVoteCount', 3,
        'expectedDisqualifiedAt', v_selected_a_at
      )
    ),
    null,
    '88000000-0000-4000-8000-000000000001'::uuid
  );

  v_replay := public.refund_disqualified_votes(
    v_fixture.admin_id,
    v_fixture.cycle_id,
    7,
    3,
    jsonb_build_array(
      jsonb_build_object(
        'submissionId', v_fixture.selected_a_id,
        'expectedVoteCount', 3,
        'expectedDisqualifiedAt', v_selected_a_at
      ),
      jsonb_build_object(
        'submissionId', v_fixture.selected_b_id,
        'expectedVoteCount', 2,
        'expectedDisqualifiedAt', v_selected_b_at
      )
    ),
    null,
    '88000000-0000-4000-8000-000000000001'::uuid
  );

  if v_result #>> '{selectionCount}' <> '2'
    or v_result #>> '{refundedVoteCount}' <> '5'
    or v_result #>> '{affectedVoterCount}' <> '4'
    or v_result #>> '{votesPerUser}' <> '3'
    or v_result #>> '{replayed}' <> 'false'
    or v_replay #>> '{replayed}' <> 'true'
    or (v_result #>> '{submissionRefunds,0,submissionId}')::bigint <>
      v_fixture.selected_a_id
    or (v_result #>> '{submissionRefunds,1,submissionId}')::bigint <>
      v_fixture.selected_b_id
    or exists (
      select 1 from public.votes
      where submission_id in (v_fixture.selected_a_id, v_fixture.selected_b_id)
    )
    or (select count(*) from public.votes where submission_id = v_fixture.untouched_id) <> 2
    or (select count(*) from public.vote_refund_events where idempotency_key = '88000000-0000-4000-8000-000000000001') <> 1
    or (select reason_text is not null from public.vote_refund_events where idempotency_key = '88000000-0000-4000-8000-000000000001')
    or (select count(*) from public.vote_refund_items where refund_id = '88000000-0000-4000-8000-000000000001') <> 5
    or exists (
      select 1 from public.submissions
      where id in (v_fixture.selected_a_id, v_fixture.selected_b_id)
        and (
          vote_refund_id is distinct from '88000000-0000-4000-8000-000000000001'::uuid
          or vote_refunded_at is null
          or not is_disqualified
        )
    )
    or exists (
      select 1
      from public.vote_refund_items
      where refund_id = '88000000-0000-4000-8000-000000000001'
        and original_vote_id not between 8800000101 and 8800000105
    ) then
    raise exception 'MANUAL_VOTE_REFUND_SELECTIVE_REPLAY_AUDIT_FAILED';
  end if;

  begin
    perform public.refund_disqualified_votes(
      v_fixture.admin_id,
      v_fixture.cycle_id,
      7,
      3,
      jsonb_build_array(jsonb_build_object(
        'submissionId', v_fixture.selected_a_id,
        'expectedVoteCount', 3,
        'expectedDisqualifiedAt', v_selected_a_at
      )),
      'Different payload for the same key.',
      '88000000-0000-4000-8000-000000000001'::uuid
    );
    raise exception 'MANUAL_VOTE_REFUND_IDEMPOTENCY_CONFLICT_ACCEPTED';
  exception when sqlstate 'PT409' then
    if sqlerrm <> 'VOTE_REFUND_IDEMPOTENCY_CONFLICT' then raise; end if;
  end;

  begin
    update public.submissions
    set is_disqualified = false,
        disqualification_type = null,
        disqualified_at = null
    where id = v_fixture.selected_a_id;
    raise exception 'MANUAL_VOTE_REFUND_REINSTATEMENT_ACCEPTED';
  exception when sqlstate 'PT409' then
    if sqlerrm <> 'VOTE_REFUNDED_SUBMISSION_REINSTATEMENT_BLOCKED' then raise; end if;
  end;
  if exists (select 1 from public.votes where submission_id = v_fixture.selected_a_id) then
    raise exception 'MANUAL_VOTE_REFUND_REINSTATEMENT_RESTORED_VOTES';
  end if;

  begin
    perform public.refund_disqualified_votes(
      v_fixture.admin_id, v_fixture.cycle_id, 7, 3,
      jsonb_build_array(jsonb_build_object(
        'submissionId', v_fixture.untouched_id,
        'expectedVoteCount', 1,
        'expectedDisqualifiedAt', v_untouched_at
      )),
      'Rollback-only stale count.',
      '88000000-0000-4000-8000-000000000002'::uuid
    );
    raise exception 'MANUAL_VOTE_REFUND_COUNT_CONFLICT_ACCEPTED';
  exception when sqlstate 'PT409' then
    if sqlerrm <> 'VOTE_REFUND_COUNT_CONFLICT' then raise; end if;
  end;

  update public.submissions
  set disqualified_at = v_stale_at + interval '1 second'
  where id = v_fixture.stale_dq_id;
  begin
    perform public.refund_disqualified_votes(
      v_fixture.admin_id, v_fixture.cycle_id, 7, 3,
      jsonb_build_array(jsonb_build_object(
        'submissionId', v_fixture.stale_dq_id,
        'expectedVoteCount', 1,
        'expectedDisqualifiedAt', v_stale_at
      )),
      'Rollback-only stale DQ timestamp.',
      '88000000-0000-4000-8000-000000000003'::uuid
    );
    raise exception 'MANUAL_VOTE_REFUND_DQ_CONFLICT_ACCEPTED';
  exception when sqlstate 'PT409' then
    if sqlerrm <> 'VOTE_REFUND_DISQUALIFICATION_CONFLICT' then raise; end if;
  end;

  update public.submissions set is_disqualified = false
  where id = v_fixture.reinstated_id;
  begin
    perform public.refund_disqualified_votes(
      v_fixture.admin_id, v_fixture.cycle_id, 7, 3,
      jsonb_build_array(jsonb_build_object(
        'submissionId', v_fixture.reinstated_id,
        'expectedVoteCount', 1,
        'expectedDisqualifiedAt', v_reinstated_at
      )),
      'Rollback-only reinstated selection.',
      '88000000-0000-4000-8000-000000000004'::uuid
    );
    raise exception 'MANUAL_VOTE_REFUND_REINSTATED_SELECTION_ACCEPTED';
  exception when sqlstate 'PT409' then
    if sqlerrm <> 'VOTE_REFUND_SUBMISSION_NOT_DISQUALIFIED' then raise; end if;
  end;

  begin
    perform public.refund_disqualified_votes(
      v_fixture.delegated_id, v_fixture.cycle_id, 7, 3,
      jsonb_build_array(jsonb_build_object(
        'submissionId', v_fixture.untouched_id,
        'expectedVoteCount', 2,
        'expectedDisqualifiedAt', v_untouched_at
      )),
      'Rollback-only zero-grant authorization.',
      '88000000-0000-4000-8000-000000000005'::uuid
    );
    raise exception 'MANUAL_VOTE_REFUND_ZERO_GRANT_ACCEPTED';
  exception when sqlstate '42501' then
    if sqlerrm <> 'VOTE_REFUND_FORBIDDEN' then raise; end if;
  end;

  begin
    perform public.refund_disqualified_votes(
      v_fixture.admin_id, v_fixture.cycle_id, 8, 3,
      jsonb_build_array(jsonb_build_object(
        'submissionId', v_fixture.untouched_id,
        'expectedVoteCount', 2,
        'expectedDisqualifiedAt', v_untouched_at
      )),
      'Rollback-only stale cycle attempt.',
      '88000000-0000-4000-8000-000000000006'::uuid
    );
    raise exception 'MANUAL_VOTE_REFUND_RESET_CONFLICT_ACCEPTED';
  exception when sqlstate 'PT409' then
    if sqlerrm <> 'VOTE_REFUND_CYCLE_ATTEMPT_CONFLICT' then raise; end if;
  end;

  begin
    perform public.refund_disqualified_votes(
      v_fixture.admin_id, v_fixture.cycle_id, 7, 2,
      jsonb_build_array(jsonb_build_object(
        'submissionId', v_fixture.untouched_id,
        'expectedVoteCount', 2,
        'expectedDisqualifiedAt', v_untouched_at
      )),
      'Rollback-only dynamic vote limit conflict.',
      '88000000-0000-4000-8000-000000000007'::uuid
    );
    raise exception 'MANUAL_VOTE_REFUND_LIMIT_CONFLICT_ACCEPTED';
  exception when sqlstate 'PT409' then
    if sqlerrm <> 'VOTE_REFUND_VOTE_LIMIT_CONFLICT' then raise; end if;
  end;

  update public.voting_cycles set status = 'voting_closed'
  where id = v_fixture.cycle_id;
  begin
    perform public.refund_disqualified_votes(
      v_fixture.admin_id, v_fixture.cycle_id, 7, 3,
      jsonb_build_array(jsonb_build_object(
        'submissionId', v_fixture.untouched_id,
        'expectedVoteCount', 2,
        'expectedDisqualifiedAt', v_untouched_at
      )),
      'Rollback-only closed phase.',
      '88000000-0000-4000-8000-000000000008'::uuid
    );
    raise exception 'MANUAL_VOTE_REFUND_CLOSED_PHASE_ACCEPTED';
  exception when sqlstate 'PT409' then
    if sqlerrm <> 'VOTE_REFUND_PHASE_CLOSED' then raise; end if;
  end;
  begin
    update public.vote_refund_events
    set reason_text = 'Forbidden audit rewrite.'
    where idempotency_key = '88000000-0000-4000-8000-000000000001';
    raise exception 'MANUAL_VOTE_REFUND_EVENT_REWRITE_ACCEPTED';
  exception when sqlstate '55000' then
    if sqlerrm <> 'VOTE_REFUND_AUDIT_IS_APPEND_ONLY' then raise; end if;
  end;

  begin
    delete from public.vote_refund_items
    where refund_id = '88000000-0000-4000-8000-000000000001';
    raise exception 'MANUAL_VOTE_REFUND_ITEM_DELETE_ACCEPTED';
  exception when sqlstate '55000' then
    if sqlerrm <> 'VOTE_REFUND_AUDIT_IS_APPEND_ONLY' then raise; end if;
  end;

  if (select count(*) from public.votes where submission_id = v_fixture.untouched_id) <> 2
    or (select count(*) from public.votes where submission_id = v_fixture.stale_dq_id) <> 1
    or (select count(*) from public.votes where submission_id = v_fixture.reinstated_id) <> 1
    or (select count(*) from public.vote_refund_events) <>
      v_fixture.baseline_event_count + 1
    or (select count(*) from public.vote_refund_items) <>
      v_fixture.baseline_item_count + 5 then
    raise exception 'MANUAL_VOTE_REFUND_FAILURE_PATH_MUTATED_STATE';
  end if;
end;
$contract$;

rollback;

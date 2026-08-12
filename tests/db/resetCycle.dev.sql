\set ON_ERROR_STOP on

begin;

do $guard$
begin
  if exists (
    select 1
    from public.voting_cycles
    where status::text in (
      'draft', 'active', 'submission_open', 'submission_closed', 'voting_open',
      'voting_closed', 'paused', 'finalizing'
    )
  ) then
    raise exception 'DEV_RESET_CYCLE_REQUIRES_NO_CURRENT_CYCLE';
  end if;
end;
$guard$;

do $$
declare
  v_empty_cycle_id constant bigint := 2000000001;
  v_data_cycle_id constant bigint := 2000000002;
  v_submission_one constant bigint := 8000000001;
  v_submission_two constant bigint := 8000000002;
  v_sponsorship_id bigint;
  v_result jsonb;
  v_cycle public.voting_cycles%rowtype;
  v_restarted_cycle_id bigint;
  v_audit_count integer;
  v_state text;
  v_finalization_cycle_id constant bigint := 2000000300;
  v_finalization_submission_id constant bigint := 8000000300;
  v_finalization_submission_two constant bigint := 8000000301;
  v_finalization_submission_three constant bigint := 8000000302;
begin
  if exists (
    select 1
    from public.voting_cycles
    where id in (
      v_empty_cycle_id,
      v_data_cycle_id,
      v_finalization_cycle_id
    )
  ) or exists (
    select 1
    from public.submissions
    where id in (
      v_submission_one,
      v_submission_two,
      v_finalization_submission_id,
      v_finalization_submission_two,
      v_finalization_submission_three
    )
  ) then
    raise exception 'RESET_TEST_ID_COLLISION';
  end if;

  insert into public.voting_cycles (id, status)
  values (v_empty_cycle_id, 'submission_open');

  v_result := public.reset_cycle(
    v_empty_cycle_id,
    'reset-cycle-dev-test',
    'Scenario A empty cycle'
  );

  if v_result ->> 'status' <> 'draft'
    or (v_result ->> 'cycleId')::bigint <> v_empty_cycle_id
    or (v_result ->> 'cycleNumber')::bigint <> v_empty_cycle_id
    or (v_result ->> 'alreadyReset')::boolean
  then
    raise exception 'SCENARIO_A_FIRST_RESET_FAILED: %', v_result;
  end if;

  select count(*)::integer
  into v_audit_count
  from public.admin_action_logs
  where action = 'cycle_reset'
    and target_id = v_empty_cycle_id::text;

  if v_audit_count <> 1 then
    raise exception 'SCENARIO_A_AUDIT_COUNT_FAILED: %', v_audit_count;
  end if;

  v_result := public.reset_cycle(
    v_empty_cycle_id,
    'reset-cycle-dev-test',
    'Scenario F identical retry'
  );

  if not (v_result ->> 'alreadyReset')::boolean then
    raise exception 'SCENARIO_F_NOT_IDEMPOTENT: %', v_result;
  end if;

  select count(*)::integer
  into v_audit_count
  from public.admin_action_logs
  where action = 'cycle_reset'
    and target_id = v_empty_cycle_id::text;

  if v_audit_count <> 1 then
    raise exception 'SCENARIO_F_DUPLICATE_AUDIT: %', v_audit_count;
  end if;

  update public.voting_cycles
  set
    status = 'submission_open',
    starts_at = transaction_timestamp(),
    submission_starts_at = transaction_timestamp(),
    reset_at = null
  where id = v_empty_cycle_id
    and status = 'draft'
    and reset_at is not null
  returning id into v_restarted_cycle_id;

  if v_restarted_cycle_id <> v_empty_cycle_id then
    raise exception 'SCENARIO_A_RESTART_DID_NOT_REUSE_ROW';
  end if;

  -- Keep every scenario compatible with the one-current-cycle invariant.
  v_result := public.reset_cycle(
    v_empty_cycle_id,
    'reset-cycle-dev-test',
    'Scenario A cleanup before next current cycle'
  );

  if (v_result ->> 'status') <> 'draft'
    or (v_result ->> 'cycleId')::bigint <> v_empty_cycle_id
  then
    raise exception 'SCENARIO_A_CLEANUP_RESET_FAILED: %', v_result;
  end if;

  insert into public.voting_cycles (
    id,
    status,
    starts_at,
    ends_at,
    ended_at,
    finalized_at,
    winners_published,
    theme,
    title,
    is_sponsored,
    sponsor_name,
    sponsor_link,
    reward_description,
    sponsor_banner_key,
    submission_starts_at,
    submission_ends_at,
    voting_starts_at,
    voting_ends_at,
    results_published_at,
    submission_warn_threshold,
    submission_warned_at,
    submission_auto_close_enabled,
    submission_auto_close_threshold,
    submission_auto_closed_at,
    votes_per_user,
    allow_self_vote,
    sponsor_name_snapshot,
    sponsor_link_snapshot,
    sponsor_banner_url_snapshot
  ) values (
    v_data_cycle_id,
    'voting_open',
    transaction_timestamp(),
    transaction_timestamp(),
    transaction_timestamp(),
    transaction_timestamp(),
    true,
    'old theme',
    'old title',
    true,
    'old sponsor',
    'https://example.invalid',
    'old reward',
    'sponsored-cycles/drafts/00000000-0000-0000-0000-000000000003.webp',
    transaction_timestamp(),
    transaction_timestamp(),
    transaction_timestamp(),
    transaction_timestamp(),
    transaction_timestamp(),
    10,
    transaction_timestamp(),
    true,
    20,
    transaction_timestamp(),
    5,
    true,
    'old sponsor',
    'https://example.invalid',
    'https://cdn.example.invalid/banner.webp'
  );

  insert into public.submissions (
    id,
    cycle_id,
    discord_user_id,
    is_disqualified,
    moderation_status,
    r2_key,
    discord_username_at_upload,
    public_visibility_status
  ) values
    (
      v_submission_one,
      v_data_cycle_id,
      'reset-test-submitter-a',
      false,
      'clean',
      v_data_cycle_id::text || '/00000000-0000-0000-0000-000000000001.webp',
      'test-a',
      'visible'
    ),
    (
      v_submission_two,
      v_data_cycle_id,
      'reset-test-submitter-b',
      true,
      'disqualified',
      v_data_cycle_id::text || '/00000000-0000-0000-0000-000000000002.webp',
      'test-b',
      'removed'
    );

  insert into public.submission_private_data (
    submission_id,
    wallet_address,
    payout_choice
  ) values
    (v_submission_one, 'test-wallet-a', 'keep'),
    (v_submission_two, 'test-wallet-b', 'keep');

  insert into public.submission_social_links (
    submission_id,
    discord_user_id,
    platform,
    display_label,
    profile_url,
    is_verified_snapshot
  ) values (
    v_submission_two,
    'reset-test-submitter-b',
    'x',
    'test-social',
    'https://example.invalid/test-social',
    true
  );

  insert into public.votes (id, cycle_id, submission_id, discord_user_id)
  values
    (7000000001, v_data_cycle_id, v_submission_one, 'reset-test-voter-a'),
    (7000000002, v_data_cycle_id, v_submission_two, 'reset-test-voter-a');

  insert into public.cycle_results (
    id,
    cycle_id,
    submission_id,
    vote_count,
    is_winner,
    rank,
    final_vote_count,
    rank_in_cycle,
    tie_group,
    finalized_at,
    feed_eligible,
    feed_trash,
    feed_classification_version,
    is_disqualified_at_finalization,
    public_visibility_status_at_finalization
  ) values (
    6000000001,
    v_data_cycle_id,
    v_submission_one,
    1,
    true,
    1,
    1,
    1,
    1,
    transaction_timestamp(),
    true,
    false,
    1,
    false,
    'visible'
  );

  insert into public.winner_public_profiles (
    id,
    cycle_id,
    submission_id,
    x_username,
    wallet_address,
    payout_choice,
    win_share,
    wall,
    vote_count,
    r2_key
  ) values (
    5000000001,
    v_data_cycle_id,
    v_submission_one,
    'test-a',
    'test-wallet-a',
    'keep',
    1,
    'shame',
    1,
    v_data_cycle_id::text || '/00000000-0000-0000-0000-000000000001.webp'
  );

  insert into public.cycle_events (cycle_id, event_type)
  values (v_data_cycle_id, 'test_public_event');

  insert into public.cycle_reminders (
    cycle_id,
    phase,
    reminder_type,
    due_at
  ) values (
    v_data_cycle_id,
    'voting_open',
    'test_reminder',
    transaction_timestamp()
  );

  insert into public.user_cycle_acceptance (discord_user_id, cycle_id)
  values ('reset-test-submitter-a', v_data_cycle_id);

  insert into public.cycle_sponsorships (
    cycle_id,
    sponsor_name,
    sponsor_link,
    banner_r2_key
  ) values (
    v_data_cycle_id,
    'test sponsor',
    'https://example.invalid',
    'sponsored-cycles/drafts/00000000-0000-0000-0000-000000000003.webp'
  ) returning id into v_sponsorship_id;

  update public.voting_cycles
  set sponsorship_id = v_sponsorship_id
  where id = v_data_cycle_id;

  insert into public.sponsor_tracking_events (
    sponsorship_id,
    event_type,
    surface,
    viewer_hash
  ) values (
    v_sponsorship_id,
    'impression',
    'home_hud',
    'reset-cycle-test-viewer'
  );

  insert into public.upload_logs (
    cycle_id,
    submission_id,
    status,
    discord_user_id
  ) values (
    v_data_cycle_id::text,
    v_submission_one::text,
    'success',
    'reset-test-submitter-a'
  );

  insert into public.vote_logs (
    cycle_id,
    submission_id,
    status,
    discord_user_id
  ) values (
    v_data_cycle_id::text,
    v_submission_one::text,
    'accepted',
    'reset-test-voter-a'
  );

  insert into public.moderation_action_logs (
    actor_role,
    actor_id,
    action,
    target_type,
    target_id,
    reason_code,
    cycle_id
  ) values (
    'admin',
    'reset-cycle-dev-test',
    'test_action',
    'submission',
    v_submission_two::text,
    'test_reason',
    v_data_cycle_id::integer
  );

  insert into public.blocked_cycle_events (discord_user_id, cycle_id)
  values ('reset-test-submitter-b', v_data_cycle_id::integer);

  insert into public.app_config (key, value)
  values (
    'cycle_sponsor_meta_' || v_data_cycle_id::text,
    '{"test":true}'
  )
  on conflict (key) do update set value = excluded.value;

  v_result := public.reset_cycle(
    v_data_cycle_id,
    'reset-cycle-dev-test',
    'Scenarios B C D H with attempt data'
  );

  if (v_result ->> 'status') <> 'draft'
    or (v_result ->> 'removedSubmissions')::integer <> 2
    or (v_result ->> 'removedVotes')::integer <> 2
    or (v_result ->> 'affectedSubmitters')::integer <> 2
    or (v_result ->> 'removedResults')::integer <> 1
    or (v_result ->> 'removedWinnerRows')::integer <> 1
    or (v_result ->> 'r2KeysPendingCleanup')::integer <> 3
  then
    raise exception 'SCENARIOS_B_C_D_H_COUNTS_FAILED: %', v_result;
  end if;

  if exists (select 1 from public.submissions where cycle_id = v_data_cycle_id)
    or exists (select 1 from public.votes where cycle_id = v_data_cycle_id)
    or exists (select 1 from public.cycle_results where cycle_id = v_data_cycle_id)
    or exists (select 1 from public.winner_public_profiles where cycle_id = v_data_cycle_id)
    or exists (select 1 from public.submission_private_data where submission_id = any(array[v_submission_one, v_submission_two]))
    or exists (select 1 from public.submission_social_links where submission_id = any(array[v_submission_one, v_submission_two]))
    or exists (select 1 from public.cycle_events where cycle_id = v_data_cycle_id)
    or exists (select 1 from public.cycle_reminders where cycle_id = v_data_cycle_id)
    or exists (select 1 from public.user_cycle_acceptance where cycle_id = v_data_cycle_id)
    or exists (select 1 from public.cycle_sponsorships where cycle_id = v_data_cycle_id)
    or exists (select 1 from public.sponsor_tracking_events where sponsorship_id = v_sponsorship_id)
  then
    raise exception 'SCENARIOS_B_C_D_H_DEPENDENCY_CLEANUP_FAILED';
  end if;

  if not exists (select 1 from public.upload_logs where cycle_id = v_data_cycle_id::text)
    or not exists (select 1 from public.vote_logs where cycle_id = v_data_cycle_id::text)
    or not exists (select 1 from public.moderation_action_logs where cycle_id = v_data_cycle_id::integer)
    or not exists (select 1 from public.blocked_cycle_events where cycle_id = v_data_cycle_id::integer)
  then
    raise exception 'IMMUTABLE_AUDIT_LOGS_WERE_NOT_PRESERVED';
  end if;

  select *
  into v_cycle
  from public.voting_cycles
  where id = v_data_cycle_id;

  if v_cycle.status::text <> 'draft'
    or v_cycle.starts_at is not null
    or v_cycle.ends_at is not null
    or v_cycle.ended_at is not null
    or v_cycle.finalized_at is not null
    or v_cycle.winners_published
    or v_cycle.theme is not null
    or v_cycle.title is not null
    or v_cycle.is_sponsored
    or v_cycle.sponsor_name is not null
    or v_cycle.sponsor_link is not null
    or v_cycle.reward_description is not null
    or v_cycle.sponsor_banner_key is not null
    or v_cycle.rule_template_id is not null
    or v_cycle.submission_starts_at is not null
    or v_cycle.submission_ends_at is not null
    or v_cycle.voting_starts_at is not null
    or v_cycle.voting_ends_at is not null
    or v_cycle.results_published_at is not null
    or v_cycle.archived_at is not null
    or v_cycle.submission_warn_threshold is not null
    or v_cycle.submission_warned_at is not null
    or v_cycle.submission_auto_close_enabled
    or v_cycle.submission_auto_close_threshold is not null
    or v_cycle.submission_auto_closed_at is not null
    or v_cycle.votes_per_user <> 2
    or v_cycle.allow_self_vote
    or v_cycle.sponsorship_id is not null
    or v_cycle.sponsor_name_snapshot is not null
    or v_cycle.sponsor_link_snapshot is not null
    or v_cycle.sponsor_banner_url_snapshot is not null
    or v_cycle.paused_from_status is not null
    or v_cycle.phase_paused_at is not null
    or v_cycle.phase_paused_remaining_seconds is not null
    or v_cycle.phase_pause_reason is not null
    or v_cycle.reset_count <> 1
    or v_cycle.reset_at is null
  then
    raise exception 'VOTING_CYCLE_FIELDS_NOT_CLEAN';
  end if;

  foreach v_state in array array['finished', 'completed', 'archived']
  loop
    begin
      insert into public.voting_cycles (id, status)
      values (
        2000000100 + array_position(
          array['finished', 'completed', 'archived'],
          v_state
        ),
        v_state::public.voting_cycle_status
      );

      perform public.reset_cycle(
        2000000100 + array_position(
          array['finished', 'completed', 'archived'],
          v_state
        ),
        'reset-cycle-dev-test',
        'Scenario E rejection'
      );

      raise exception 'SCENARIO_E_ACCEPTED_%', v_state;
    exception
      when others then
        if sqlerrm <> 'CYCLE_STATE_NOT_RESETTABLE' then
          raise;
        end if;
    end;
  end loop;

  insert into public.voting_cycles (id, status)
  values (v_finalization_cycle_id, 'voting_closed');

  insert into public.submissions (
    id,
    cycle_id,
    discord_user_id,
    moderation_status,
    r2_key,
    discord_username_at_upload,
    public_visibility_status
  ) values
    (
      v_finalization_submission_id,
      v_finalization_cycle_id,
      'reset-test-finalization-submitter-a',
      'clean',
      v_finalization_cycle_id::text || '/00000000-0000-0000-0000-000000000300.webp',
      'finalization-test-a-1',
      'visible'
    ),
    (
      v_finalization_submission_two,
      v_finalization_cycle_id,
      'reset-test-finalization-submitter-a',
      'clean',
      v_finalization_cycle_id::text || '/00000000-0000-0000-0000-000000000301.webp',
      'finalization-test-a-2',
      'visible'
    ),
    (
      v_finalization_submission_three,
      v_finalization_cycle_id,
      'reset-test-finalization-submitter-b',
      'clean',
      v_finalization_cycle_id::text || '/00000000-0000-0000-0000-000000000302.webp',
      'finalization-test-b',
      'visible'
    );

  insert into public.submission_private_data (
    submission_id,
    wallet_address,
    payout_choice
  ) values
    (v_finalization_submission_id, 'finalization-wallet-a-1', 'keep'),
    (v_finalization_submission_two, 'finalization-wallet-a-2', 'keep'),
    (v_finalization_submission_three, 'finalization-wallet-b', 'keep');

  v_result := public.finalize_cycle(
    v_finalization_cycle_id,
    'reset-cycle-dev-test'
  );

  if (v_result ->> 'finalStatus') <> 'finished'
    or (v_result ->> 'rankedSubmissionCount')::integer <> 3
    or (v_result ->> 'winnerCount')::integer <> 3
    or not exists (
      select 1
      from public.voting_cycles
      where id = v_finalization_cycle_id
        and status = 'finished'
    )
    or (
      select count(*)
      from public.winner_public_profiles
      where cycle_id = v_finalization_cycle_id
        and abs(win_share - (1.0 / 3.0)) < 0.000000001
    ) <> 3
    or abs((
      select sum(winner.win_share)
      from public.winner_public_profiles winner
      join public.submissions submission
        on submission.id = winner.submission_id
      where winner.cycle_id = v_finalization_cycle_id
        and submission.discord_user_id =
          'reset-test-finalization-submitter-a'
    ) - (2.0 / 3.0)) >= 0.000000001
  then
    raise exception 'SCENARIO_K_FINALIZATION_REGRESSION: %', v_result;
  end if;
end;
$$;

rollback;

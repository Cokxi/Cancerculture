\set ON_ERROR_STOP on
select not exists (
  select 1
  from public.voting_cycles
  where status::text in (
    'active',
    'submission_open',
    'submission_closed',
    'voting_open',
    'voting_closed',
    'paused',
    'finalizing'
  )
) as can_run_full_enforcement \gset

\if :can_run_full_enforcement
begin;

do $$
declare
  v_cycle_id bigint := 9200000201;
  v_history_cycle_id bigint := 9200000202;
  v_current_user text := '991000000000000001';
  v_voter text := '991000000000000002';
  v_other_user text := '991000000000000003';
  v_history_user text := '991000000000000004';
  v_no_submission_user text := '991000000000000005';
  v_snapshot_user text := '991000000000000006';
  v_admin text := '991000000000000099';
  v_current_submission bigint := 992000001;
  v_other_submission bigint := 992000002;
  v_history_submission bigint := 992000003;
  v_snapshot_submission bigint := 992000004;
  v_snapshot_id uuid := gen_random_uuid();
  v_base timestamptz := transaction_timestamp() - interval '2 hours';
  v_result jsonb;
  v_history_result jsonb;
  v_history_winner jsonb;
  v_queue_state text;
  v_audit_count integer;
  v_r2_key text;
begin
  if exists (
    select 1
    from public.voting_cycles
    where id in (v_cycle_id, v_history_cycle_id)
  ) or exists (
    select 1
    from public.user_logs
    where discord_user_id in (
      v_current_user,
      v_voter,
      v_other_user,
      v_history_user,
      v_no_submission_user,
      v_snapshot_user,
      v_admin
    )
  ) or exists (
    select 1
    from public.submissions
    where id in (
      v_current_submission,
      v_other_submission,
      v_history_submission,
      v_snapshot_submission
    )
  ) then
    raise exception 'DISCORD_BAN_SUBMISSION_TEST_FIXTURE_COLLISION';
  end if;

  select count(*)::text || ':' ||
    coalesce(
      md5(string_agg(id::text || ':' || status, ',' order by id)),
      'empty'
    )
  into v_queue_state
  from public.media_cleanup_queue;

  insert into public.voting_cycles (
    id,
    status,
    starts_at,
    voting_starts_at
  ) values
    (
      v_cycle_id,
      'voting_open',
      v_base,
      v_base + interval '30 minutes'
    ),
    (
      v_history_cycle_id,
      'finished',
      v_base - interval '2 days',
      v_base - interval '1 day'
    );

  update public.voting_cycles
  set
    finalized_at = v_base - interval '12 hours',
    winners_published = true,
    results_published_at = v_base - interval '12 hours'
  where id = v_history_cycle_id;

  insert into public.user_logs (
    discord_user_id,
    current_discord_username
  ) values
    (v_current_user, 'ban-current'),
    (v_voter, 'ban-voter'),
    (v_other_user, 'ban-other'),
    (v_history_user, 'ban-history'),
    (v_no_submission_user, 'ban-empty'),
    (v_snapshot_user, 'ban-snapshot'),
    (v_admin, 'ban-admin');

  insert into public.discord_member_state (
    discord_user_id,
    current_discord_username,
    discord_joined_at,
    is_in_discord,
    discord_ban_active,
    discord_membership_observed_at,
    discord_ban_observed_at
  ) values
    (v_current_user, 'ban-current', v_base, true, false, v_base, v_base),
    (v_voter, 'ban-voter', v_base, true, false, v_base, v_base),
    (v_other_user, 'ban-other', v_base, true, false, v_base, v_base),
    (v_history_user, 'ban-history', v_base, true, false, v_base, v_base),
    (v_no_submission_user, 'ban-empty', v_base, true, false, v_base, v_base),
    (v_snapshot_user, 'ban-snapshot', v_base, true, false, v_base, v_base),
    (v_admin, 'ban-admin', v_base, true, false, v_base, v_base);

  insert into public.team_members (
    discord_user_id,
    role,
    discord_username
  ) values (
    v_admin,
    'admin',
    'ban-admin'
  );

  insert into public.submissions (
    id,
    cycle_id,
    discord_user_id,
    r2_key,
    discord_username_at_upload
  ) values
    (
      v_current_submission,
      v_cycle_id,
      v_current_user,
      v_cycle_id::text ||
        '/00000000-0000-4000-8000-000000000201.webp',
      'ban-current'
    ),
    (
      v_other_submission,
      v_cycle_id,
      v_other_user,
      v_cycle_id::text ||
        '/00000000-0000-4000-8000-000000000202.webp',
      'ban-other'
    ),
    (
      v_history_submission,
      v_history_cycle_id,
      v_history_user,
      v_history_cycle_id::text ||
        '/00000000-0000-4000-8000-000000000203.webp',
      'ban-history'
    ),
    (
      v_snapshot_submission,
      v_cycle_id,
      v_snapshot_user,
      v_cycle_id::text ||
        '/00000000-0000-4000-8000-000000000204.webp',
      'ban-snapshot'
    );

  insert into public.submission_private_data (
    submission_id,
    wallet_address,
    payout_choice
  ) values
    (v_current_submission, 'wallet-current', 'keep'),
    (v_other_submission, 'wallet-other', 'keep'),
    (v_snapshot_submission, 'wallet-snapshot', 'keep');

  insert into public.votes (
    id,
    cycle_id,
    submission_id,
    discord_user_id
  ) values (
    993000001,
    v_cycle_id,
    v_current_submission,
    v_voter
  );

  insert into public.cycle_results (
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
    public_visibility_status_at_finalization
  ) values (
    v_history_cycle_id,
    v_history_submission,
    7,
    true,
    1,
    7,
    1,
    1,
    v_base - interval '12 hours',
    true,
    'visible'
  );

  insert into public.winner_public_profiles (
    cycle_id,
    submission_id,
    wallet_address,
    payout_choice,
    win_share,
    wall,
    vote_count,
    r2_key
  ) values (
    v_history_cycle_id,
    v_history_submission,
    'wallet-history',
    'keep',
    1,
    'shame',
    7,
    v_history_cycle_id::text ||
      '/00000000-0000-4000-8000-000000000203.webp'
  );

  select to_jsonb(result.*)
  into v_history_result
  from public.cycle_results result
  where result.cycle_id = v_history_cycle_id
    and result.submission_id = v_history_submission;

  select to_jsonb(winner.*)
  into v_history_winner
  from public.winner_public_profiles winner
  where winner.cycle_id = v_history_cycle_id
    and winner.submission_id = v_history_submission;

  v_result := public.begin_discord_reconciliation_snapshot(
    'submission-snapshot-start',
    v_base + interval '10 minutes',
    repeat('1', 64),
    v_snapshot_id,
    5,
    1
  );
  v_result := public.append_discord_reconciliation_chunk(
    'submission-snapshot-members',
    'snapshot_members_chunk',
    v_base + interval '11 minutes',
    repeat('2', 64),
    v_snapshot_id,
    jsonb_build_array(
      jsonb_build_object(
        'discordUserId', v_current_user,
        'discordUsername', 'ban-current'
      ),
      jsonb_build_object(
        'discordUserId', v_voter,
        'discordUsername', 'ban-voter'
      ),
      jsonb_build_object(
        'discordUserId', v_other_user,
        'discordUsername', 'ban-other'
      ),
      jsonb_build_object(
        'discordUserId', v_history_user,
        'discordUsername', 'ban-history'
      ),
      jsonb_build_object(
        'discordUserId', v_no_submission_user,
        'discordUsername', 'ban-empty'
      )
    )
  );
  v_result := public.append_discord_reconciliation_chunk(
    'submission-snapshot-bans',
    'snapshot_bans_chunk',
    v_base + interval '12 minutes',
    repeat('3', 64),
    v_snapshot_id,
    jsonb_build_array(
      jsonb_build_object(
        'discordUserId', v_snapshot_user,
        'discordUsername', 'ban-snapshot'
      )
    )
  );
  v_result := public.finalize_discord_reconciliation_snapshot(
    'submission-snapshot-final',
    v_base + interval '13 minutes',
    repeat('4', 64),
    v_snapshot_id
  );

  if v_result ->> 'outcome' <> 'applied' or not exists (
    select 1
    from public.submissions
    where id = v_snapshot_submission
      and public_visibility_status = 'removed'
      and public_visibility_source = 'discord_ban'
      and is_disqualified
      and disqualification_type = 'discord_ban'
  ) then
    raise exception 'snapshot ban did not use Submission enforcement';
  end if;

  v_result := public.apply_discord_ban(
    'submission-empty-ban',
    v_base + interval '20 minutes',
    repeat('5', 64),
    v_no_submission_user,
    'ban-empty'
  );
  if v_result ->> 'outcome' <> 'applied' then
    raise exception 'ban without Submission failed';
  end if;

  v_result := public.apply_discord_ban(
    'submission-current-ban',
    v_base + interval '21 minutes',
    repeat('6', 64),
    v_current_user,
    'ban-current'
  );

  if not exists (
    select 1
    from public.submissions
    where id = v_current_submission
      and public_visibility_status = 'removed'
      and public_visibility_source = 'discord_ban'
      and is_disqualified
      and disqualification_type = 'discord_ban'
  ) then
    raise exception 'current Submission was not hidden and disqualified';
  end if;

  if (
    select count(*)
    from public.votes
    where submission_id = v_current_submission
  ) <> 1 then
    raise exception 'existing votes were not preserved';
  end if;

  begin
    perform public.cast_cycle_vote(
      v_cycle_id,
      v_current_submission,
      v_voter
    );
    raise exception 'vote on banned Submission unexpectedly succeeded';
  exception
    when others then
      if sqlerrm not like '%SUBMISSION_NOT_COMPETITION_ELIGIBLE%' then
        raise;
      end if;
  end;

  if exists (
    select 1
    from public.public_submissions_with_votes
    where id in (v_current_submission, v_snapshot_submission)
  ) then
    raise exception 'public Submission view exposed a banned Submission';
  end if;

  select count(*)::integer
  into v_audit_count
  from public.admin_action_logs
  where action = 'discord_ban_submissions_enforced'
    and target_id = v_current_user;

  v_result := public.apply_discord_ban(
    'submission-current-ban-repeat',
    v_base + interval '22 minutes',
    repeat('7', 64),
    v_current_user,
    'ban-current'
  );

  if (
    select count(*)::integer
    from public.admin_action_logs
    where action = 'discord_ban_submissions_enforced'
      and target_id = v_current_user
  ) <> v_audit_count then
    raise exception 'repeated ban duplicated Submission enforcement audit';
  end if;

  update public.voting_cycles
  set status = 'voting_closed'
  where id = v_cycle_id;

  v_result := public.finalize_cycle(v_cycle_id, v_admin);

  if v_result ->> 'finalStatus' <> 'finished' or exists (
    select 1
    from public.cycle_results
    where cycle_id = v_cycle_id
      and submission_id in (
        v_current_submission,
        v_snapshot_submission
      )
  ) then
    raise exception 'finalization included a Discord-ban disqualification';
  end if;

  if not exists (
    select 1
    from public.cycle_results
    where cycle_id = v_cycle_id
      and submission_id = v_other_submission
      and is_winner
  ) then
    raise exception 'eligible Submission was not finalized';
  end if;

  v_result := public.apply_discord_ban(
    'submission-history-ban',
    v_base + interval '30 minutes',
    repeat('8', 64),
    v_history_user,
    'ban-history'
  );

  if not exists (
    select 1
    from public.submissions
    where id = v_history_submission
      and public_visibility_status = 'removed'
      and public_visibility_source = 'discord_ban'
      and not is_disqualified
  ) then
    raise exception 'historical Submission was not hidden safely';
  end if;

  if (
    select to_jsonb(result.*)
    from public.cycle_results result
    where result.cycle_id = v_history_cycle_id
      and result.submission_id = v_history_submission
  ) is distinct from v_history_result then
    raise exception 'historical result snapshot changed';
  end if;

  if (
    select to_jsonb(winner.*)
    from public.winner_public_profiles winner
    where winner.cycle_id = v_history_cycle_id
      and winner.submission_id = v_history_submission
  ) is distinct from v_history_winner then
    raise exception 'historical Winner snapshot changed';
  end if;

  select r2_key
  into v_r2_key
  from public.submissions
  where id = v_history_submission;

  if v_r2_key is distinct from (
    v_history_cycle_id::text ||
    '/00000000-0000-4000-8000-000000000203.webp'
  ) then
    raise exception 'Ban changed the historical R2 key';
  end if;

  if (
    select count(*)::text || ':' ||
      coalesce(
        md5(string_agg(id::text || ':' || status, ',' order by id)),
        'empty'
      )
    from public.media_cleanup_queue
  ) is distinct from v_queue_state then
    raise exception 'Ban created or changed cleanup jobs';
  end if;

  begin
    update public.submissions
    set public_visibility_status = 'visible'
    where id = v_history_submission;
    raise exception 'unguarded Discord-ban republish succeeded';
  exception
    when others then
      if sqlerrm not like '%DISCORD_BAN_REPUBLISH_REQUIRES_REVIEW%' then
        raise;
      end if;
  end;

  begin
    perform public.republish_discord_ban_submission(
      v_history_submission,
      v_admin,
      'Manual review confirms safe public restoration.',
      true
    );
    raise exception 'republish succeeded while Discord ban was active';
  exception
    when others then
      if sqlerrm not like '%DISCORD_BAN_STILL_ACTIVE%' then
        raise;
      end if;
  end;

  v_result := public.apply_discord_unban(
    'submission-history-unban',
    v_base + interval '40 minutes',
    repeat('9', 64),
    v_history_user,
    'ban-history'
  );

  if exists (
    select 1
    from public.submissions
    where id = v_history_submission
      and public_visibility_status = 'visible'
  ) then
    raise exception 'unban automatically republished Submission';
  end if;

  v_result := public.apply_discord_member_join(
    'submission-history-rejoin',
    v_base + interval '50 minutes',
    repeat('a', 64),
    v_history_user,
    'ban-history'
  );

  if exists (
    select 1
    from public.submissions
    where id = v_history_submission
      and public_visibility_status = 'visible'
  ) then
    raise exception 'rejoin automatically republished Submission';
  end if;

  v_result := public.republish_discord_ban_submission(
    v_history_submission,
    v_admin,
    'Manual review confirms safe public restoration.',
    true
  );

  if v_result ->> 'outcome' <> 'republished' or not exists (
    select 1
    from public.submissions
    where id = v_history_submission
      and public_visibility_status = 'visible'
      and public_visibility_source = 'manual_republish'
      and public_republish_review_confirmed
      and public_republish_reason is not null
      and not is_disqualified
  ) then
    raise exception 'manual historical republish failed';
  end if;

  v_result := public.republish_discord_ban_submission(
    v_history_submission,
    v_admin,
    'Manual review confirms safe public restoration.',
    true
  );
  if v_result ->> 'outcome' <> 'already_republished' then
    raise exception 'republish retry was not idempotent';
  end if;

  v_result := public.apply_discord_unban(
    'submission-current-unban',
    v_base + interval '60 minutes',
    repeat('b', 64),
    v_current_user,
    'ban-current'
  );
  v_result := public.republish_discord_ban_submission(
    v_current_submission,
    v_admin,
    'Manual review permits visibility but not competition restore.',
    true
  );

  if not exists (
    select 1
    from public.submissions
    where id = v_current_submission
      and public_visibility_status = 'visible'
      and is_disqualified
      and disqualification_type = 'discord_ban'
  ) then
    raise exception 'republish restored competition eligibility';
  end if;

  if not exists (
    select 1
    from public.admin_action_logs
    where action = 'discord_ban_submission_republished'
      and target_id in (
        v_history_submission::text,
        v_current_submission::text
      )
      and meta ->> 'manualReviewConfirmed' = 'true'
  ) then
    raise exception 'republish audit missing';
  end if;

  if has_function_privilege(
    'anon',
    'public.republish_discord_ban_submission(bigint,text,text,boolean)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.republish_discord_ban_submission(bigint,text,text,boolean)',
    'EXECUTE'
  ) or has_function_privilege(
    'discord_bot',
    'public.republish_discord_ban_submission(bigint,text,text,boolean)',
    'EXECUTE'
  ) then
    raise exception 'republish RPC is exposed to an unauthorized role';
  end if;
end;
$$;

rollback;
\else
\ir discordBanRepublishIsolated.dev.sql
\endif

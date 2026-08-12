\set ON_ERROR_STOP on
begin;

do $$
declare
  v_seed bigint := 9300000000 + floor(random() * 500000000)::bigint;
  v_cycle_id bigint := v_seed;
  v_submission_id bigint := v_seed + 1000000000;
  v_target_user text := (970000000000000000 + v_seed)::text;
  v_admin_user text := (980000000000000000 + v_seed)::text;
  v_event_suffix text := gen_random_uuid()::text;
  v_base timestamptz := transaction_timestamp() - interval '2 days';
  v_result jsonb;
  v_result_snapshot jsonb;
  v_winner_snapshot jsonb;
begin
  if exists (select 1 from public.voting_cycles where id = v_cycle_id)
    or exists (select 1 from public.submissions where id = v_submission_id)
    or exists (
      select 1 from public.user_logs
      where discord_user_id in (v_target_user, v_admin_user)
    )
  then
    raise exception 'DISCORD_BAN_REPUBLISH_ISOLATED_FIXTURE_COLLISION';
  end if;

  insert into public.voting_cycles (
    id,
    status,
    starts_at,
    voting_starts_at,
    finalized_at,
    winners_published,
    results_published_at
  ) values (
    v_cycle_id,
    'finished',
    v_base,
    v_base + interval '1 hour',
    v_base + interval '2 hours',
    true,
    v_base + interval '2 hours'
  );

  insert into public.user_logs (
    discord_user_id,
    current_discord_username,
    is_banned
  ) values
    (v_target_user, 'isolated-ban-target', false),
    (v_admin_user, 'isolated-ban-admin', false);

  insert into public.discord_member_state (
    discord_user_id,
    current_discord_username,
    discord_joined_at,
    is_in_discord,
    discord_ban_active,
    discord_membership_observed_at,
    discord_ban_observed_at
  ) values
    (
      v_target_user,
      'isolated-ban-target',
      v_base,
      true,
      false,
      transaction_timestamp(),
      transaction_timestamp()
    ),
    (
      v_admin_user,
      'isolated-ban-admin',
      v_base,
      true,
      false,
      transaction_timestamp(),
      transaction_timestamp()
    );

  insert into public.team_members (
    discord_user_id,
    role,
    discord_username
  ) values (v_admin_user, 'admin', 'isolated-ban-admin');

  insert into public.submissions (
    id,
    cycle_id,
    discord_user_id,
    r2_key,
    discord_username_at_upload
  ) values (
    v_submission_id,
    v_cycle_id,
    v_target_user,
    v_cycle_id::text || '/' || gen_random_uuid()::text || '.webp',
    'isolated-ban-target'
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
    feed_trash,
    feed_classification_version,
    is_disqualified_at_finalization,
    public_visibility_status_at_finalization
  ) values (
    v_cycle_id,
    v_submission_id,
    7,
    true,
    1,
    7,
    1,
    1,
    v_base + interval '2 hours',
    true,
    false,
    1,
    false,
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
    v_cycle_id,
    v_submission_id,
    'isolated-wallet',
    'keep',
    1,
    'fame',
    7,
    v_cycle_id::text || '/snapshot.webp'
  );

  select to_jsonb(result.*)
  into v_result_snapshot
  from public.cycle_results result
  where result.cycle_id = v_cycle_id
    and result.submission_id = v_submission_id;

  select to_jsonb(winner.*)
  into v_winner_snapshot
  from public.winner_public_profiles winner
  where winner.cycle_id = v_cycle_id
    and winner.submission_id = v_submission_id;

  v_result := public.apply_discord_ban(
    'isolated-ban-' || v_event_suffix,
    transaction_timestamp() + interval '1 second',
    repeat('a', 64),
    v_target_user,
    'isolated-ban-target'
  );

  if v_result ->> 'outcome' <> 'applied'
    or not exists (
      select 1 from public.submissions
      where id = v_submission_id
        and public_visibility_status = 'removed'
        and public_visibility_source = 'discord_ban'
    )
  then
    raise exception 'active Ban did not hide the finished Submission';
  end if;

  begin
    perform public.republish_discord_ban_submission(
      v_submission_id,
      v_admin_user,
      'Isolated manual review confirms public restoration.',
      true
    );
    raise exception 'active Ban unexpectedly allowed republish';
  exception
    when others then
      if sqlerrm not like '%DISCORD_BAN_STILL_ACTIVE%' then
        raise;
      end if;
  end;

  v_result := public.apply_discord_unban(
    'isolated-unban-' || v_event_suffix,
    transaction_timestamp() + interval '2 seconds',
    repeat('b', 64),
    v_target_user,
    'isolated-ban-target'
  );

  if exists (
    select 1 from public.submissions
    where id = v_submission_id
      and public_visibility_status = 'visible'
  ) then
    raise exception 'Unban automatically republished the Submission';
  end if;

  v_result := public.republish_discord_ban_submission(
    v_submission_id,
    v_admin_user,
    'Isolated manual review confirms public restoration.',
    true
  );

  if v_result ->> 'outcome' <> 'republished'
    or not exists (
      select 1 from public.submissions
      where id = v_submission_id
        and public_visibility_status = 'visible'
        and public_visibility_source = 'manual_republish'
        and public_republish_review_confirmed
        and not is_disqualified
    )
  then
    raise exception 'manual finished-cycle republish failed';
  end if;

  if (
    select to_jsonb(result.*)
    from public.cycle_results result
    where result.cycle_id = v_cycle_id
      and result.submission_id = v_submission_id
  ) is distinct from v_result_snapshot then
    raise exception 'historical result snapshot changed';
  end if;

  if (
    select to_jsonb(winner.*)
    from public.winner_public_profiles winner
    where winner.cycle_id = v_cycle_id
      and winner.submission_id = v_submission_id
  ) is distinct from v_winner_snapshot then
    raise exception 'historical Winner snapshot changed';
  end if;

  if not exists (
    select 1 from public.admin_action_logs
    where action = 'discord_ban_submission_republished'
      and target_id = v_submission_id::text
      and meta ->> 'manualReviewConfirmed' = 'true'
  ) then
    raise exception 'republish audit missing';
  end if;
end;
$$;

rollback;

do $test$
declare
  v_admin text;
  v_cycle_id bigint;
  v_request_id uuid := gen_random_uuid();
  v_result jsonb;
  v_replay jsonb;
begin
  select member.discord_user_id
  into v_admin
  from public.team_members member
  where member.role = 'admin'
  order by member.discord_user_id
  limit 1;
  if v_admin is null then
    raise exception 'CYCLE_PRIZE_POOL_TEST_ADMIN_MISSING';
  end if;

  insert into public.voting_cycles(status, submission_starts_at)
  values ('submission_open', transaction_timestamp())
  returning id into v_cycle_id;

  if not public.is_cycle_prize_pool_editable(
    v_cycle_id,
    transaction_timestamp()
  ) then
    raise exception 'CYCLE_PRIZE_POOL_TEST_RUNNING_NOT_EDITABLE';
  end if;

  v_result := public.manage_current_cycle_prize_pool(
    v_admin,
    v_request_id,
    v_cycle_id,
    0,
    1250000000,
    1250000000
  );
  v_replay := public.manage_current_cycle_prize_pool(
    v_admin,
    v_request_id,
    v_cycle_id,
    0,
    1250000000,
    1250000000
  );
  if v_result ->> 'outcome' <> 'saved'
    or v_result ->> 'amountLamports' <> '1250000000'
    or v_result ->> 'rowVersion' <> '1'
    or v_replay ->> 'replayed' <> 'true' then
    raise exception 'CYCLE_PRIZE_POOL_TEST_SAVE_OR_REPLAY_FAILED';
  end if;

  begin
    perform public.manage_current_cycle_prize_pool(
      v_admin,
      gen_random_uuid(),
      v_cycle_id,
      1,
      1500000000,
      1500000001
    );
    raise exception 'CYCLE_PRIZE_POOL_TEST_CONFIRMATION_ACCEPTED';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'CYCLE_PRIZE_POOL_CONFIRMATION_INVALID' then
        raise;
      end if;
  end;

  update public.voting_cycles
  set status = 'voting_open',
      voting_starts_at = transaction_timestamp() - interval '1 hour',
      voting_ends_at = transaction_timestamp() - interval '1 second'
  where id = v_cycle_id;

  if public.is_cycle_prize_pool_editable(
    v_cycle_id,
    transaction_timestamp()
  ) then
    raise exception 'CYCLE_PRIZE_POOL_TEST_EXPIRED_VOTING_EDITABLE';
  end if;

  begin
    perform public.manage_current_cycle_prize_pool(
      v_admin,
      gen_random_uuid(),
      v_cycle_id,
      1,
      1500000000,
      1500000000
    );
    raise exception 'CYCLE_PRIZE_POOL_TEST_EXPIRED_SAVE_ACCEPTED';
  exception
    when sqlstate 'PT409' then
      if sqlerrm <> 'CYCLE_PRIZE_POOL_DEADLINE_PASSED' then
        raise;
      end if;
  end;

  begin
    update public.cycle_prize_pools
    set announced_lamports = 2
    where cycle_id = 37;
    raise exception 'CYCLE_PRIZE_POOL_TEST_RETROACTIVE_UPDATE_ACCEPTED';
  exception
    when sqlstate 'PT409' then
      if sqlerrm <> 'CYCLE_PRIZE_POOL_RETROACTIVE_CHANGE_FORBIDDEN' then
        raise;
      end if;
  end;

  begin
    insert into public.cycle_prize_pool_components(
      cycle_id,
      component_version,
      component_kind,
      amount_lamports,
      actor_discord_user_id,
      reason
    ) values (
      37,
      1000,
      'determination',
      1,
      v_admin,
      'Rollback-only forbidden retroactive component proof'
    );
    raise exception 'CYCLE_PRIZE_POOL_TEST_RETROACTIVE_COMPONENT_ACCEPTED';
  exception
    when sqlstate 'PT409' then
      if sqlerrm <> 'CYCLE_PRIZE_POOL_RETROACTIVE_CHANGE_FORBIDDEN' then
        raise;
      end if;
  end;
end;
$test$;

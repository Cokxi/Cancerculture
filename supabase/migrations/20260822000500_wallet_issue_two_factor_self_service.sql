begin;

do $baseline$
begin
  if to_regprocedure('public.assert_own_wallet_issue_intake_open(uuid,bigint)') is null
    or to_regprocedure('public.create_own_wallet_issue_intake(uuid,bigint,uuid,text,text,bytea,text,text,integer)') is null
    or to_regprocedure('public.finalize_cycle_without_prize_pool(bigint,text)') is null
    or to_regclass('public.account_totp_factors') is null
    or position(
      'WALLET_ISSUE_TWO_FACTOR_SELF_SERVICE' in pg_get_functiondef(
        'public.assert_own_wallet_issue_intake_open(uuid,bigint)'::regprocedure
      )
    ) > 0
  then
    raise exception using
      errcode = '55000',
      message = 'WALLET_ISSUE_TWO_FACTOR_SELF_SERVICE_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

create or replace function public.assert_own_wallet_issue_intake_open(
  p_session_id uuid,
  p_submission_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_submission public.submissions%rowtype;
  v_cycle public.voting_cycles%rowtype;
  v_private public.submission_private_data%rowtype;
  v_existing public.wallet_issue_intakes%rowtype;
begin
  v_owner_id := public.require_account_session(p_session_id);
  perform pg_advisory_xact_lock(
    hashtextextended('account-2fa:' || v_owner_id, 0)
  );
  if exists (
    select 1
    from public.account_totp_factors factor
    where factor.discord_user_id = v_owner_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'WALLET_ISSUE_TWO_FACTOR_SELF_SERVICE';
  end if;

  select * into v_existing
  from public.wallet_issue_intakes
  where submission_id = p_submission_id;
  if found then
    if v_existing.owner_discord_user_id <> v_owner_id then
      raise exception using errcode = '42501', message = 'WALLET_ISSUE_INTAKE_FORBIDDEN';
    end if;
    return jsonb_build_object(
      'outcome', 'existing', 'intakeId', v_existing.id,
      'status', v_existing.status, 'submittedAt', v_existing.submitted_at
    );
  end if;

  select * into v_submission from public.submissions
  where id = p_submission_id;
  if not found or v_submission.discord_user_id <> v_owner_id then
    raise exception using errcode = '42501', message = 'WALLET_ISSUE_INTAKE_FORBIDDEN';
  end if;
  select * into v_cycle from public.voting_cycles where id = v_submission.cycle_id;
  if not found
    or v_cycle.finalized_at is not null
    or v_cycle.status::text not in (
      'active', 'submission_open', 'submission_closed',
      'voting_open', 'voting_closed', 'paused'
    )
    or v_cycle.id <> (
      select current_cycle.id
      from public.voting_cycles current_cycle
      where current_cycle.finalized_at is null
        and current_cycle.status::text in (
          'active', 'submission_open', 'submission_closed',
          'voting_open', 'voting_closed', 'paused'
        )
      order by current_cycle.id desc
      limit 1
    )
  then
    raise exception using errcode = '55000', message = 'WALLET_ISSUE_INTAKE_CLOSED';
  end if;
  select * into v_private
  from public.submission_private_data private_data
  where private_data.submission_id = p_submission_id
  order by private_data.id desc
  limit 1;
  if not found or v_private.payout_choice not in ('keep', 'split') then
    raise exception using errcode = '55000', message = 'WALLET_ISSUE_INTAKE_NOT_APPLICABLE';
  end if;
  return jsonb_build_object(
    'outcome', 'open', 'cycleId', v_cycle.id,
    'submissionId', v_submission.id
  );
end;
$function$;

create or replace function public.finalize_cycle_without_prize_pool(
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
  v_finalized_at timestamptz;
  v_intake public.wallet_issue_intakes%rowtype;
  v_claim public.winner_claims%rowtype;
  v_case_result jsonb;
  v_case_id uuid;
  v_username text;
  v_claim_found boolean := false;
  v_promoted integer := 0;
  v_not_relevant integer := 0;
begin
  v_result := public.finalize_cycle_without_wallet_issue_intakes(
    p_cycle_id, p_actor_discord_user_id
  );
  select finalized_at into v_finalized_at
  from public.voting_cycles where id = p_cycle_id for update;
  if v_finalized_at is null then
    raise exception using message = 'WALLET_ISSUE_FINALIZATION_TIME_MISSING';
  end if;

  for v_intake in
    select * from public.wallet_issue_intakes
    where cycle_id = p_cycle_id and status = 'held'
    order by submitted_at, id
    for update
  loop
    perform pg_advisory_xact_lock(
      hashtextextended('account-2fa:' || v_intake.owner_discord_user_id, 0)
    );
    if exists (
      select 1
      from public.account_totp_factors factor
      where factor.discord_user_id = v_intake.owner_discord_user_id
    ) then
      select * into v_claim from public.winner_claims claim
      where claim.cycle_id = v_intake.cycle_id
        and claim.submission_id = v_intake.submission_id
        and claim.payout_choice in ('keep', 'split')
      for update;
      v_claim_found := found;
      update public.wallet_issue_intakes
      set status = 'not_relevant', version = version + 1,
          evaluated_at = v_finalized_at,
          delete_after = v_finalized_at + interval '14 days'
      where id = v_intake.id;
      if v_claim_found and v_claim.status = 'unclaimed' then
        perform public.enqueue_account_notification_event(
          'winner_claim:' || v_claim.id::text,
          'winner_claim_required', 'winners_claims',
          v_claim.winner_discord_user_id,
          '/my-profile/winnings/' || v_claim.id::text,
          true
        );
      end if;
      v_not_relevant := v_not_relevant + 1;
      continue;
    end if;

    select * into v_claim from public.winner_claims claim
    where claim.cycle_id = v_intake.cycle_id
      and claim.submission_id = v_intake.submission_id
      and claim.payout_choice in ('keep', 'split')
    for update;
    if found then
      if v_claim.status <> 'unclaimed' then
        raise exception using message = 'WALLET_ISSUE_WINNER_CLAIM_STATE_MISMATCH';
      end if;
      update public.winner_claims
      set status = 'correction_pending', version = version + 1,
          claim_deadline_at = null, updated_at = v_finalized_at
      where id = v_claim.id;
      insert into public.winner_claim_events (
        claim_id, actor_type, action, from_status, to_status,
        case_reference, occurred_at
      ) values (
        v_claim.id, 'system', 'correction_pending',
        'unclaimed', 'correction_pending',
        'wallet-issue:' || v_intake.id::text, v_finalized_at
      );
      select coalesce(nullif(btrim(current_discord_username), ''), 'Account')
      into v_username from public.user_logs
      where discord_user_id = v_intake.owner_discord_user_id;
      v_case_result := public.upsert_team_inbox_case(
        'wallet_issues', 'wallet-issue-intake:' || v_intake.id::text,
        v_intake.version + 1, v_intake.owner_discord_user_id,
        coalesce(v_username, 'Account')
      );
      v_case_id := (v_case_result ->> 'caseId')::uuid;
      update public.wallet_issue_intakes
      set status = 'promoted', version = version + 1,
          winner_claim_id = v_claim.id,
          team_inbox_case_id = v_case_id,
          evaluated_at = v_finalized_at,
          promoted_at = v_finalized_at
      where id = v_intake.id
      returning * into v_intake;
      perform public.enqueue_account_notification_event(
        'wallet-issue-received:' || v_intake.id::text,
        'wallet_issue_received', 'wallet_issues',
        v_intake.owner_discord_user_id,
        '/my-profile/winnings/' || v_claim.id::text,
        public.resolve_account_notification_visibility(
          v_intake.owner_discord_user_id, 'wallet_issues'
        )
      );
      insert into public.team_inbox_timeline_events (
        case_id, event_type, work_version, row_version,
        capability_context, source_version, outcome_code, created_at
      )
      select case_row.id, 'notification_queued',
        case_row.work_version, case_row.row_version,
        jsonb_build_object('topicKey', 'wallet_issues', 'producer', 'finalization'),
        case_row.source_version, 'owner_notification_queued', v_finalized_at
      from public.team_inbox_cases case_row where case_row.id = v_case_id;
      v_promoted := v_promoted + 1;
    else
      update public.wallet_issue_intakes
      set status = 'not_relevant', version = version + 1,
          evaluated_at = v_finalized_at,
          delete_after = v_finalized_at + interval '14 days'
      where id = v_intake.id;
      v_not_relevant := v_not_relevant + 1;
    end if;
  end loop;
  perform public.purge_due_wallet_issue_intakes();
  return v_result || jsonb_build_object(
    'walletIssuePromotedCount', v_promoted,
    'walletIssueNotRelevantCount', v_not_relevant
  );
end;
$function$;

alter function public.assert_own_wallet_issue_intake_open(uuid,bigint)
  owner to postgres;
alter function public.finalize_cycle_without_prize_pool(bigint,text)
  owner to postgres;

revoke all on function public.assert_own_wallet_issue_intake_open(uuid,bigint)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.finalize_cycle_without_prize_pool(bigint,text)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.assert_own_wallet_issue_intake_open(uuid,bigint) to service_role;

do $postflight$
begin
  if not has_function_privilege(
      'service_role',
      'public.assert_own_wallet_issue_intake_open(uuid,bigint)',
      'EXECUTE'
    )
    or has_function_privilege(
      'service_role',
      'public.finalize_cycle_without_prize_pool(bigint,text)',
      'EXECUTE'
    )
    or position(
      'WALLET_ISSUE_TWO_FACTOR_SELF_SERVICE' in pg_get_functiondef(
        'public.assert_own_wallet_issue_intake_open(uuid,bigint)'::regprocedure
      )
    ) = 0
    or position(
      'account_totp_factors' in pg_get_functiondef(
        'public.finalize_cycle_without_prize_pool(bigint,text)'::regprocedure
      )
    ) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'WALLET_ISSUE_TWO_FACTOR_SELF_SERVICE_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.assert_own_wallet_issue_intake_open(uuid,bigint) is
  'Allows a pre-finalization owner Wallet Issue intake only when account 2FA self-service is not active.';
comment on function public.finalize_cycle_without_prize_pool(bigint,text) is
  'Finalizes the Cycle and suppresses stale Wallet Issue promotion when the owner has active account 2FA self-service.';

commit;

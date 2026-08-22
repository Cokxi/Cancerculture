begin;

do $baseline$
declare
  v_definition text;
begin
  if to_regprocedure(
      'public.request_donation_recipient_correction(text,uuid,uuid,text)'
    ) is null
    or to_regprocedure(
      'public.enqueue_account_notification_event(text,text,text,text,text,boolean)'
    ) is null
    or to_regclass('public.notification_events') is null
    or to_regclass('public.account_notifications') is null
    or to_regclass('public.push_delivery_jobs') is null
    or (select count(*) from public.capability_catalog) <> 43
    or (select count(*) from public.capability_catalog where is_active) <> 39
    or not exists (
      select 1
      from pg_constraint
      where conrelid = 'public.notification_events'::regclass
        and conname = 'notification_event_type_check'
    )
    or position(
      'donation_recipient_change_required' in pg_get_constraintdef(
        (select oid
         from pg_constraint
         where conrelid = 'public.notification_events'::regclass
           and conname = 'notification_event_type_check')
      )
    ) = 0
  then
    raise exception using
      errcode = '55000',
      message = 'NOTIFICATION_PUSH_OUTBOX_BASELINE_MISMATCH';
  end if;

  v_definition := pg_get_functiondef(
    'public.request_donation_recipient_correction(text,uuid,uuid,text)'::regprocedure
  );
  if position('insert into public.account_notifications' in v_definition) = 0
    or position('enqueue_account_notification_event' in v_definition) > 0
  then
    raise exception using
      errcode = '55000',
      message = 'NOTIFICATION_PUSH_OUTBOX_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

create or replace function public.request_donation_recipient_correction(
  p_actor_discord_user_id text,
  p_request_id uuid,
  p_allocation_public_id uuid,
  p_public_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_allocation public.cycle_prize_allocations%rowtype;
  v_reason text := nullif(btrim(coalesce(p_public_reason, '')), '');
  v_current public.payout_donation_corrections%rowtype;
  v_correction public.payout_donation_corrections%rowtype;
  v_attempt bigint;
  v_hash text;
  v_request public.payout_mutation_requests%rowtype;
  v_response jsonb;
  v_visible boolean;
begin
  v_role := public.assert_winners_payout_capability(
    p_actor_discord_user_id, 'winners.manage_payouts'
  );
  if p_request_id is null or p_allocation_public_id is null
    or v_reason is null or char_length(v_reason) not between 3 and 300
  then
    raise exception using message = 'PAYOUT_INPUT_INVALID';
  end if;

  v_hash := public.payout_request_hash(jsonb_build_object(
    'allocation', p_allocation_public_id, 'reason', v_reason
  ));
  select * into v_request
  from public.payout_mutation_requests
  where actor_discord_user_id = p_actor_discord_user_id
    and request_id = p_request_id and action = 'request_donation_correction';
  if found then
    if v_request.request_hash <> v_hash then
      raise exception using message = 'PAYOUT_REQUEST_REUSED';
    end if;
    return v_request.response || jsonb_build_object('replayed', true);
  end if;

  select * into v_allocation
  from public.cycle_prize_allocations
  where public_id = p_allocation_public_id
  for update;
  if not found or v_allocation.donation_lamports <= 0 then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if exists (
    select 1 from public.payout_allocation_disqualifications disqualification
    where disqualification.allocation_id = v_allocation.id
  ) or exists (
    select 1
    from public.payout_plans plan
    join public.payout_lines line on line.plan_id = plan.id
    where plan.allocation_id = v_allocation.id
      and line.current_transaction_id is not null
  ) then
    return jsonb_build_object('outcome', 'state_conflict');
  end if;

  perform public.process_due_payout_donation_corrections(null);
  select * into v_current
  from public.payout_donation_corrections
  where allocation_id = v_allocation.id and status in ('open', 'submitted')
  for update;
  if found then
    update public.payout_donation_corrections
    set status = 'superseded', row_version = row_version + 1,
        deadline_at = null, closed_at = transaction_timestamp(),
        updated_at = transaction_timestamp()
    where id = v_current.id;
  end if;

  select coalesce(max(attempt_version), 0) + 1 into v_attempt
  from public.payout_donation_corrections
  where allocation_id = v_allocation.id;

  insert into public.payout_donation_corrections(
    allocation_id, attempt_version, public_reason, deadline_at, requested_by
  ) values (
    v_allocation.id, v_attempt, v_reason,
    transaction_timestamp() + interval '24 hours', p_actor_discord_user_id
  ) returning * into v_correction;

  insert into public.payout_events(
    event_type, actor_discord_user_id, target_type, target_public_id,
    target_version, request_id, reason,
    details
  ) values (
    'donation_correction_requested', p_actor_discord_user_id,
    'donation_correction', v_correction.public_id,
    v_correction.row_version, p_request_id, v_reason,
    jsonb_build_object('attemptVersion', v_correction.attempt_version)
  );

  v_visible := coalesce(public.resolve_account_notification_visibility(
    v_allocation.winner_discord_user_id, 'winners_claims'
  ), false);
  insert into public.notification_events(
    producer_key, event_type, category_key, audience_type,
    owner_discord_user_id, deep_link, public_body
  ) values (
    'donation-correction:' || v_correction.public_id::text,
    'donation_recipient_change_required', 'winners_claims', 'account',
    v_allocation.winner_discord_user_id,
    '/my-profile#donation-correction-' || v_correction.public_id::text,
    'Choose another charity within 24 hours. Reason: ' || v_reason
  );

  perform public.enqueue_account_notification_event(
    'donation-correction:' || v_correction.public_id::text,
    'donation_recipient_change_required',
    'winners_claims',
    v_allocation.winner_discord_user_id,
    '/my-profile#donation-correction-' || v_correction.public_id::text,
    v_visible
  );

  v_response := jsonb_build_object(
    'outcome', 'correction_requested',
    'correctionPublicId', v_correction.public_id,
    'rowVersion', v_correction.row_version,
    'deadlineAt', v_correction.deadline_at,
    'replayed', false
  );
  insert into public.payout_mutation_requests(
    actor_discord_user_id, request_id, action, request_hash, response
  ) values (
    p_actor_discord_user_id, p_request_id,
    'request_donation_correction', v_hash, v_response
  );
  return v_response;
end;
$function$;

alter function public.request_donation_recipient_correction(text,uuid,uuid,text)
  owner to postgres;
revoke all on function public.request_donation_recipient_correction(text,uuid,uuid,text)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.request_donation_recipient_correction(text,uuid,uuid,text)
  to service_role;

do $postflight$
declare
  v_signature regprocedure :=
    'public.request_donation_recipient_correction(text,uuid,uuid,text)'::regprocedure;
  v_definition text := pg_get_functiondef(
    'public.request_donation_recipient_correction(text,uuid,uuid,text)'::regprocedure
  );
begin
  if position('enqueue_account_notification_event' in v_definition) = 0
    or position('insert into public.account_notifications' in v_definition) > 0
    or position('donation_recipient_change_required' in v_definition) = 0
    or (select count(*)
        from pg_proc function_row
        join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
        where namespace_row.nspname = 'public'
          and function_row.proname = 'request_donation_recipient_correction') <> 1
    or exists (
      select 1
      from pg_proc function_row
      where function_row.oid = v_signature
        and (
          not function_row.prosecdef
          or pg_get_userbyid(function_row.proowner) <> 'postgres'
          or function_row.proconfig is distinct from
            array['search_path=public, pg_temp']::text[]
        )
    )
    or not has_function_privilege('service_role', v_signature, 'EXECUTE')
    or has_function_privilege('public', v_signature, 'EXECUTE')
    or has_function_privilege('anon', v_signature, 'EXECUTE')
    or has_function_privilege('authenticated', v_signature, 'EXECUTE')
    or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
    or (select count(*) from public.capability_catalog) <> 43
    or (select count(*) from public.capability_catalog where is_active) <> 39
  then
    raise exception using
      errcode = '55000',
      message = 'NOTIFICATION_PUSH_OUTBOX_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.request_donation_recipient_correction(text,uuid,uuid,text) is
  'Creates a versioned owner donation-recipient correction and queues its in-product and optional per-device Push delivery through the canonical notification helper.';

commit;

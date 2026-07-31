begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

create or replace function public.moderate_submission(
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
  v_actor_role text;
  v_actor_username text;
  v_required_capability text;
  v_expected_capability_version integer := 2;
  v_expected_capability_hash text;
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
    or v_expected_phase not in ('submission_open', 'voting_open')
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
  then
    raise exception using
      errcode = '22023',
      message = 'INVALID_SUBMISSION_MODERATION_REQUEST';
  end if;

  if v_operation = 'reinstate'
    and (v_reason_text is null or char_length(v_reason_text) < 3)
  then
    raise exception using
      errcode = '22023',
      message = 'REINSTATE_REASON_REQUIRED';
  end if;

  if v_operation = 'reinstate' and v_disqualification_type is not null then
    raise exception using
      errcode = '22023',
      message = 'INVALID_REINSTATE_DISQUALIFICATION_TYPE';
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
      return jsonb_set(
        v_existing_result,
        '{replayed}',
        'true'::jsonb
      );
    end if;

    raise exception using
      errcode = 'PT409',
      message = 'SUBMISSION_MODERATION_IDEMPOTENCY_CONFLICT';
  end if;

  select cycle_row.*
  into v_cycle
  from public.voting_cycles as cycle_row
  where cycle_row.id = p_cycle_id
  for update;

  if not found then
    raise exception using
      errcode = 'PT409',
      message = 'MODERATION_CYCLE_NOT_FOUND';
  end if;

  if v_cycle.status::text not in ('submission_open', 'voting_open') then
    raise exception using
      errcode = 'PT409',
      message = 'MODERATION_PHASE_CLOSED';
  end if;

  if v_cycle.status::text <> v_expected_phase then
    raise exception using
      errcode = 'PT409',
      message = 'MODERATION_PHASE_CONFLICT';
  end if;

  select submission_row.*
  into v_submission
  from public.submissions as submission_row
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
    p_expected_is_disqualified
  then
    raise exception using
      errcode = 'PT409',
      message = 'MODERATION_EXPECTED_STATE_CONFLICT';
  end if;

  if v_cycle.status::text = 'submission_open' then
    if v_operation = 'disqualify' then
      v_required_capability :=
        'submissions.submission_phase.disqualify';
      v_expected_capability_hash :=
        '3eec3024438e68d08891e147a1d770ad812af935732b6e60a804baa6a28b1732';
    else
      v_required_capability :=
        'submissions.submission_phase.reinstate';
      v_expected_capability_hash :=
        '7c0cfbaf53b08c43633f75c025ccf729ae3dbc9d4320c90b11117415ee304dd2';
    end if;
  elsif v_operation = 'disqualify' then
    v_required_capability :=
      'submissions.voting_phase.disqualify';
    v_expected_capability_hash :=
      'cb6ad152ee22b164b6c864f26dcaab25f10be3483bfa5b1f3a7b265c66a142de';
  else
    v_required_capability :=
      'submissions.voting_phase.reinstate';
    v_expected_capability_hash :=
      '4e4f1d199d4eb008d768676796bcf8ec34c2472c90d323fecbf7b247d7a36fe0';
  end if;

  if not exists (
    select 1
    from public.capability_catalog as capability_row
    where capability_row.key = v_required_capability
      and capability_row.is_active
      and capability_row.assignable_to_non_admin
      and capability_row.implementation_version =
        v_expected_capability_version
      and capability_row.definition_hash =
        v_expected_capability_hash
  ) then
    raise exception using
      errcode = '55000',
      message = 'MODERATION_AUTHORIZATION_DEPENDENCY_UNAVAILABLE';
  end if;

  select member_row.role,
         coalesce(
           nullif(btrim(actor_log.current_discord_username), ''),
           nullif(btrim(member_row.discord_username), ''),
           v_actor_id
         )
  into v_actor_role, v_actor_username
  from public.team_members as member_row
  join public.team_roles as role_row
    on role_row.key = member_row.role
   and role_row.is_active
  left join public.user_logs as actor_log
    on actor_log.discord_user_id = member_row.discord_user_id
  where member_row.discord_user_id = v_actor_id;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'SUBMISSION_MODERATION_FORBIDDEN';
  end if;

  if v_actor_role <> 'admin'
    and not exists (
      select 1
      from public.team_role_capabilities as grant_row
      where grant_row.role_key = v_actor_role
        and grant_row.capability_key = v_required_capability
    )
  then
    raise exception using
      errcode = '42501',
      message = 'SUBMISSION_MODERATION_FORBIDDEN';
  end if;

  v_before_state := jsonb_build_object(
    'isDisqualified', v_current_is_disqualified,
    'disqualificationType', v_submission.disqualification_type,
    'reasonCode', v_submission.disqualification_reason_code,
    'reasonText', v_submission.disqualification_reason_text,
    'disqualifiedAt', v_submission.disqualified_at,
    'actorDiscordUserId',
      v_submission.disqualified_by_discord_user_id,
    'actorDisplayName',
      v_submission.disqualified_by_discord_username
  );

  if v_current_is_disqualified is distinct from
    v_target_is_disqualified
  then
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
    )
    values (
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
        'phase', v_cycle.status::text,
        'operation', v_operation,
        'requiredCapability', v_required_capability,
        'before', v_before_state,
        'after', v_after_state,
        'r2_key', v_submission.r2_key
      ),
      p_cycle_id::integer,
      p_idempotency_key,
      v_cycle.status::text,
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
    'phase', v_cycle.status::text,
    'requiredCapability', v_required_capability,
    'changed',
      v_current_is_disqualified is distinct from
        v_target_is_disqualified,
    'isDisqualified', v_target_is_disqualified,
    'replayed', false
  );

  insert into public.submission_moderation_requests (
    idempotency_key,
    actor_discord_user_id,
    request_hash,
    request_payload,
    result
  )
  values (
    p_idempotency_key,
    v_actor_id,
    v_request_hash,
    v_request_payload,
    v_result
  );

  return v_result;
end;
$function$;

do $postflight$
declare
  v_definition text;
  v_pt409_count integer;
begin
  select pg_get_functiondef(
    'public.moderate_submission(text,bigint,bigint,text,text,boolean,text,text,text,uuid)'::regprocedure
  )
  into v_definition;

  select count(*)
  into v_pt409_count
  from regexp_matches(v_definition, 'PT409', 'g');

  if v_definition like '%40001%'
    or v_pt409_count <> 7
  then
    raise exception using
      errcode = '55000',
      message = 'MODERATE_SUBMISSION_CONFLICT_SQLSTATE_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.moderate_submission(
  text, bigint, bigint, text, text, boolean, text, text, text, uuid
) is
  'Atomically moderates one submission with dynamic capability authorization, deterministic idempotency, explicit stale conflict responses, ordered cycle/submission locks, and one audit row per real change.';

commit;

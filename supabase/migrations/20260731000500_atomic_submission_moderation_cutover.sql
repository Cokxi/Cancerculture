begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $preflight$
declare
  v_legacy public.capability_catalog%rowtype;
begin
  if to_regclass('public.voting_cycles') is null
    or to_regclass('public.submissions') is null
    or to_regclass('public.moderation_action_logs') is null
    or to_regclass('public.team_members') is null
    or to_regclass('public.team_roles') is null
    or to_regclass('public.capability_catalog') is null
    or to_regclass('public.team_role_capabilities') is null
    or to_regclass('public.user_logs') is null
  then
    raise exception using
      errcode = '55000',
      message = 'ATOMIC_SUBMISSION_MODERATION_DEPENDENCY_MISSING';
  end if;

  if exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'ATOMIC_SUBMISSION_MODERATION_REQUIRES_ZERO_GRANTS';
  end if;

  select *
  into v_legacy
  from public.capability_catalog
  where key = 'submissions.submission_phase.moderate'
  for update;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'LEGACY_SUBMISSION_MODERATION_CAPABILITY_MISSING';
  end if;

  if row(
    v_legacy.display_name,
    v_legacy.description,
    v_legacy.category,
    v_legacy.included_actions,
    v_legacy.excluded_actions,
    v_legacy.risk_level,
    v_legacy.assignable_to_non_admin,
    v_legacy.is_active,
    v_legacy.implementation_version,
    v_legacy.definition_hash,
    v_legacy.deprecated_at is null
  ) is distinct from row(
    'Submission Phase Moderation'::text,
    'Moderate submissions only during the currently permitted submission phase.'::text,
    'Submission Moderation'::text,
    array[
      'Disqualify submissions during the currently allowed submission phase.',
      'Reinstate submissions during the currently allowed submission phase.'
    ]::text[],
    array[
      'Voting-phase moderation.',
      'Vote refunds.',
      'Public visibility changes.',
      'Legal review.',
      'Finalized or archived cycles.'
    ]::text[],
    'high'::text,
    true,
    true,
    1,
    '89d9d8794cc2a15772f869cf6670802b89afd00b8adafbbd1229db1d6d29f116'::text,
    true
  ) then
    raise exception using
      errcode = '55000',
      message = 'LEGACY_SUBMISSION_MODERATION_CAPABILITY_DRIFT';
  end if;

  if (
    select count(*)
    from public.capability_catalog
    where key in (
      'submissions.submission_phase.disqualify',
      'submissions.submission_phase.reinstate',
      'submissions.voting_phase.disqualify',
      'submissions.voting_phase.reinstate'
    )
      and is_active
      and assignable_to_non_admin
  ) <> 4 then
    raise exception using
      errcode = '55000',
      message = 'GRANULAR_SUBMISSION_MODERATION_CAPABILITY_DRIFT';
  end if;
end;
$preflight$;

create table public.submission_moderation_requests (
  idempotency_key uuid primary key,
  actor_discord_user_id text not null,
  request_hash text not null,
  request_payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  constraint submission_moderation_requests_actor_check
    check (char_length(btrim(actor_discord_user_id)) between 1 and 100),
  constraint submission_moderation_requests_hash_check
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint submission_moderation_requests_payload_check
    check (jsonb_typeof(request_payload) = 'object'),
  constraint submission_moderation_requests_result_check
    check (jsonb_typeof(result) = 'object')
);

alter table public.submission_moderation_requests owner to postgres;
alter table public.submission_moderation_requests enable row level security;

revoke all on table public.submission_moderation_requests
  from public, anon, authenticated, discord_bot, service_role;
grant select on table public.submission_moderation_requests
  to service_role;

alter table public.moderation_action_logs
  add column moderation_request_id uuid,
  add column moderation_phase text,
  add column moderation_operation text,
  add column before_state jsonb,
  add column after_state jsonb;

alter table public.moderation_action_logs
  add constraint moderation_action_logs_atomic_contract_check
  check (
    (
      moderation_request_id is null
      and moderation_phase is null
      and moderation_operation is null
      and before_state is null
      and after_state is null
    )
    or (
      moderation_request_id is not null
      and moderation_phase in ('submission_open', 'voting_open')
      and moderation_operation in ('disqualify', 'reinstate')
      and jsonb_typeof(before_state) = 'object'
      and jsonb_typeof(after_state) = 'object'
      and action = case moderation_operation
        when 'disqualify' then 'disqualify_submission'
        when 'reinstate' then 'reinstate_submission'
      end
    )
  );

create unique index moderation_action_logs_moderation_request_id_idx
  on public.moderation_action_logs (moderation_request_id)
  where moderation_request_id is not null;

revoke all on table public.moderation_action_logs
  from public, anon, authenticated, discord_bot;
revoke all on table public.submissions
  from public, anon, authenticated, discord_bot;
revoke all on table public.team_members
  from public, anon, authenticated, discord_bot;
revoke all on table public.team_roles
  from public, anon, authenticated, discord_bot;
revoke all on table public.capability_catalog
  from public, anon, authenticated, discord_bot;
revoke all on table public.team_role_capabilities
  from public, anon, authenticated, discord_bot;

create function public.moderate_submission(
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
      errcode = '40001',
      message = 'SUBMISSION_MODERATION_IDEMPOTENCY_CONFLICT';
  end if;

  select cycle_row.*
  into v_cycle
  from public.voting_cycles as cycle_row
  where cycle_row.id = p_cycle_id
  for update;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'MODERATION_CYCLE_NOT_FOUND';
  end if;

  if v_cycle.status::text not in ('submission_open', 'voting_open') then
    raise exception using
      errcode = '40001',
      message = 'MODERATION_PHASE_CLOSED';
  end if;

  if v_cycle.status::text <> v_expected_phase then
    raise exception using
      errcode = '40001',
      message = 'MODERATION_PHASE_CONFLICT';
  end if;

  select submission_row.*
  into v_submission
  from public.submissions as submission_row
  where submission_row.id = p_submission_id
  for update;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'MODERATION_SUBMISSION_NOT_FOUND';
  end if;

  if v_submission.cycle_id is distinct from p_cycle_id then
    raise exception using
      errcode = '40001',
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
      errcode = '40001',
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

alter function public.moderate_submission(
  text, bigint, bigint, text, text, boolean, text, text, text, uuid
) owner to postgres;

revoke all on function public.moderate_submission(
  text, bigint, bigint, text, text, boolean, text, text, text, uuid
) from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.moderate_submission(
  text, bigint, bigint, text, text, boolean, text, text, text, uuid
) to service_role;

update public.capability_catalog
set assignable_to_non_admin = false,
    is_active = false,
    implementation_version = 2,
    definition_hash =
      '7d62383086022588673bb5c6cc7156851f99a7815d6f305d72bbfa2e0064789b',
    deprecated_at = transaction_timestamp()
where key = 'submissions.submission_phase.moderate';

do $postflight$
begin
  if exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'ATOMIC_SUBMISSION_MODERATION_GRANT_POSTFLIGHT_FAILED';
  end if;

  if (select count(*) from public.capability_catalog) <> 7
    or (select count(*) from public.capability_catalog where is_active) <> 6
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 6
  then
    raise exception using
      errcode = '55000',
      message = 'ATOMIC_SUBMISSION_MODERATION_CATALOG_TOTALS_MISMATCH';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = 'submissions.submission_phase.moderate'
      and not is_active
      and not assignable_to_non_admin
      and implementation_version = 2
      and definition_hash =
        '7d62383086022588673bb5c6cc7156851f99a7815d6f305d72bbfa2e0064789b'
      and deprecated_at is not null
  ) then
    raise exception using
      errcode = '55000',
      message = 'LEGACY_SUBMISSION_MODERATION_TOMBSTONE_FAILED';
  end if;

  if (
    select count(*)
    from pg_proc procedure_row
    join pg_namespace namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'public'
      and procedure_row.proname = 'moderate_submission'
  ) <> 1 then
    raise exception using
      errcode = '55000',
      message = 'MODERATE_SUBMISSION_SIGNATURE_COUNT_MISMATCH';
  end if;
end;
$postflight$;

comment on table public.submission_moderation_requests is
  'Append-only service-side idempotency and replay ledger for atomic manual submission moderation.';
comment on function public.moderate_submission(
  text, bigint, bigint, text, text, boolean, text, text, text, uuid
) is
  'Atomically authorizes, locks, applies and audits manual submission disqualification or reinstatement during submission_open or voting_open; service role only.';

commit;

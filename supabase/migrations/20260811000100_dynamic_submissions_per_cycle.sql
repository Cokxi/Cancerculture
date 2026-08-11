begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
declare
  v_submission_unique_definition text;
  v_active_operation_definition text;
  v_active_operation_predicate text;
  v_cycle_vote_constraint text;
  v_refund_vote_constraint text;
begin
  if to_regclass('public.voting_cycles') is null
    or to_regclass('public.submissions') is null
    or to_regclass('public.submission_upload_operations') is null
    or to_regclass('public.vote_refund_events') is null
  then
    raise exception using
      errcode = '55000',
      message = 'DYNAMIC_SUBMISSIONS_DEPENDENCY_MISSING';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'voting_cycles'
      and column_name in (
        'submissions_per_user',
        'upload_success_cooldown_seconds'
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'DYNAMIC_SUBMISSIONS_TARGET_ALREADY_PRESENT';
  end if;

  select pg_get_indexdef(index_row.indexrelid)
  into v_submission_unique_definition
  from pg_index index_row
  where index_row.indexrelid =
    to_regclass('public.submissions_cycle_id_discord_user_id_uidx');

  if v_submission_unique_definition is null
    or v_submission_unique_definition not like
      'CREATE UNIQUE INDEX % ON public.submissions USING btree (cycle_id, discord_user_id)'
  then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_UNIQUE_INDEX_BASELINE_MISMATCH';
  end if;

  select
    pg_get_indexdef(index_row.indexrelid),
    pg_get_expr(index_row.indpred, index_row.indrelid)
  into v_active_operation_definition, v_active_operation_predicate
  from pg_index index_row
  where index_row.indexrelid =
    to_regclass('public.submission_upload_operations_one_active_user_cycle_idx');

  if v_active_operation_definition is null
    or v_active_operation_definition not like
      'CREATE UNIQUE INDEX % ON public.submission_upload_operations USING btree (discord_user_id, cycle_id) WHERE %'
    or v_active_operation_predicate is distinct from
      '(status = ANY (ARRAY[''reserved''::text, ''r2_uploaded''::text]))'
  then
    raise exception using
      errcode = '55000',
      message = 'ACTIVE_UPLOAD_OPERATION_INDEX_BASELINE_MISMATCH';
  end if;

  select pg_get_constraintdef(constraint_row.oid)
  into v_cycle_vote_constraint
  from pg_constraint constraint_row
  where constraint_row.conrelid = 'public.voting_cycles'::regclass
    and constraint_row.conname = 'voting_cycles_votes_per_user_check';

  select pg_get_constraintdef(constraint_row.oid)
  into v_refund_vote_constraint
  from pg_constraint constraint_row
  where constraint_row.conrelid = 'public.vote_refund_events'::regclass
    and constraint_row.conname = 'vote_refund_events_cycle_check';

  if v_cycle_vote_constraint is null
    or v_cycle_vote_constraint not like '%votes_per_user%'
    or not (
      v_cycle_vote_constraint like '%BETWEEN 1 AND 10%'
      or (
        v_cycle_vote_constraint like '%>= 1%'
        and v_cycle_vote_constraint like '%<= 10%'
      )
    )
    or v_refund_vote_constraint is null
    or v_refund_vote_constraint not like '%cycle_id > 0%'
    or v_refund_vote_constraint not like '%reset_count >= 0%'
    or v_refund_vote_constraint not like '%votes_per_user%'
    or not (
      v_refund_vote_constraint like '%BETWEEN 1 AND 10%'
      or (
        v_refund_vote_constraint like '%>= 1%'
        and v_refund_vote_constraint like '%<= 10%'
      )
    )
  then
    raise exception using
      errcode = '55000',
      message = 'VOTE_CONSTRAINT_BASELINE_MISMATCH';
  end if;

  if to_regprocedure(
      'public.reserve_submission_upload(uuid,uuid,text,text,text,integer)'
    ) is null
    or to_regprocedure(
      'public.commit_submission_upload(uuid,uuid,text,text,integer,text)'
    ) is null
    or to_regprocedure('public.start_cycle(bigint,text,jsonb)') is null
    or to_regprocedure(
      'public.manage_cycle_phase(text,bigint,text,text,integer,integer,text,uuid)'
    ) is null
    or to_regprocedure(
      'public.refund_disqualified_votes(text,bigint,integer,integer,jsonb,text,uuid)'
    ) is null
  then
    raise exception using
      errcode = '55000',
      message = 'DYNAMIC_SUBMISSIONS_FUNCTION_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

alter table public.voting_cycles
  add column submissions_per_user integer,
  add column upload_success_cooldown_seconds integer;

update public.voting_cycles
set
  submissions_per_user = 1,
  upload_success_cooldown_seconds = 120;

alter table public.voting_cycles
  alter column submissions_per_user set default 2,
  alter column submissions_per_user set not null,
  alter column upload_success_cooldown_seconds set default 120,
  alter column upload_success_cooldown_seconds set not null,
  add constraint voting_cycles_submissions_per_user_check
    check (submissions_per_user between 1 and 20),
  add constraint voting_cycles_upload_success_cooldown_seconds_check
    check (upload_success_cooldown_seconds between 30 and 300),
  drop constraint voting_cycles_votes_per_user_check,
  add constraint voting_cycles_votes_per_user_check
    check (votes_per_user between 1 and 50);

comment on column public.voting_cycles.submissions_per_user is
  'Maximum successfully committed Submissions per internal user identity for this Cycle. Existing Cycles were materialized as legacy limit 1; future rows default to 2.';
comment on column public.voting_cycles.upload_success_cooldown_seconds is
  'Cycle-scoped delay after a successfully committed Submission before the same user may reserve the next Upload.';

alter table public.vote_refund_events
  drop constraint vote_refund_events_cycle_check,
  add constraint vote_refund_events_cycle_check
    check (
      cycle_id > 0
      and reset_count >= 0
      and votes_per_user between 1 and 50
    );

drop index public.submissions_cycle_id_discord_user_id_uidx;

create index submissions_cycle_user_id_idx
  on public.submissions (cycle_id, discord_user_id, id);

create index submission_upload_operations_completed_user_cycle_idx
  on public.submission_upload_operations (
    discord_user_id,
    cycle_id,
    completed_at desc,
    id
  )
  where status = 'completed';

create or replace function public.enforce_cycle_submission_settings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if old.status::text = 'draft' then
    return new;
  end if;

  if new.status::text = 'draft'
    and old.status::text <> 'draft'
    and new.reset_count = old.reset_count + 1
  then
    new.submissions_per_user := 2;
    new.upload_success_cooldown_seconds := 120;
    return new;
  end if;

  if new.status::text = 'draft' and old.status::text <> 'draft' then
    raise exception using
      errcode = 'PT409',
      message = 'CYCLE_SUBMISSION_SETTINGS_RESET_REQUIRED';
  end if;

  if new.submissions_per_user is distinct from old.submissions_per_user
    or new.upload_success_cooldown_seconds is distinct from
      old.upload_success_cooldown_seconds
  then
    raise exception using
      errcode = 'PT409',
      message = 'CYCLE_SUBMISSION_SETTINGS_IMMUTABLE';
  end if;

  return new;
end;
$function$;

alter function public.enforce_cycle_submission_settings() owner to postgres;
revoke all on function public.enforce_cycle_submission_settings()
  from public, anon, authenticated, service_role, discord_bot;

create trigger voting_cycles_submission_settings_guard
before update of status, reset_count, submissions_per_user,
  upload_success_cooldown_seconds
on public.voting_cycles
for each row execute function public.enforce_cycle_submission_settings();

create or replace function public.get_submission_upload_quota(
  p_cycle_id bigint,
  p_discord_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_cycle public.voting_cycles%rowtype;
  v_now timestamptz := clock_timestamp();
  v_used integer;
  v_last_completed_at timestamptz;
  v_next_allowed_at timestamptz;
  v_cooldown_remaining integer := 0;
begin
  if p_cycle_id is null
    or p_cycle_id <= 0
    or p_discord_user_id is null
    or btrim(p_discord_user_id) = ''
  then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  select cycle.*
  into v_cycle
  from public.voting_cycles cycle
  where cycle.id = p_cycle_id;

  if not found then
    return jsonb_build_object('outcome', 'cycle_not_found');
  end if;

  select count(*)::integer
  into v_used
  from public.submissions submission
  where submission.cycle_id = p_cycle_id
    and submission.discord_user_id = p_discord_user_id;

  select max(operation.completed_at)
  into v_last_completed_at
  from public.submission_upload_operations operation
  where operation.cycle_id = p_cycle_id
    and operation.discord_user_id = p_discord_user_id
    and operation.status = 'completed';

  if v_last_completed_at is not null then
    v_next_allowed_at := v_last_completed_at
      + make_interval(secs => v_cycle.upload_success_cooldown_seconds);
    v_cooldown_remaining := greatest(
      0,
      ceil(extract(epoch from (v_next_allowed_at - v_now)))::integer
    );
    if v_cooldown_remaining = 0 then
      v_next_allowed_at := null;
    end if;
  end if;

  return jsonb_build_object(
    'outcome', 'status',
    'cycleId', v_cycle.id,
    'cycleStatus', v_cycle.status::text,
    'used', v_used,
    'limit', v_cycle.submissions_per_user,
    'remaining', greatest(v_cycle.submissions_per_user - v_used, 0),
    'cooldownSeconds', v_cycle.upload_success_cooldown_seconds,
    'cooldownRemainingSeconds', v_cooldown_remaining,
    'nextUploadAllowedAt', v_next_allowed_at
  );
end;
$function$;

alter function public.get_submission_upload_quota(bigint, text)
  owner to postgres;
revoke all on function public.get_submission_upload_quota(bigint, text)
  from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.get_submission_upload_quota(bigint, text)
  to service_role;

do $widen_runtime_vote_contracts$
declare
  v_definition text;
  v_updated_definition text;
begin
  select pg_get_functiondef(
    'public.manage_cycle_phase(text,bigint,text,text,integer,integer,text,uuid)'::regprocedure
  ) into v_definition;
  v_updated_definition := replace(
    v_definition,
    'p_votes_per_user > 10',
    'p_votes_per_user > 50'
  );
  if v_updated_definition = v_definition then
    raise exception using
      errcode = '55000',
      message = 'MANAGE_CYCLE_VOTE_BOUND_NOT_FOUND';
  end if;
  execute v_updated_definition;

  select pg_get_functiondef(
    'public.refund_disqualified_votes(text,bigint,integer,integer,jsonb,text,uuid)'::regprocedure
  ) into v_definition;
  v_updated_definition := replace(
    v_definition,
    'p_expected_votes_per_user not between 1 and 10',
    'p_expected_votes_per_user not between 1 and 50'
  );
  if v_updated_definition = v_definition then
    raise exception using
      errcode = '55000',
      message = 'VOTE_REFUND_BOUND_NOT_FOUND';
  end if;
  execute v_updated_definition;
end;
$widen_runtime_vote_contracts$;

do $extend_reset_contract$
declare
  v_definition text;
  v_updated_definition text;
begin
  select pg_get_functiondef(
    'public.reset_cycle(bigint,text,text)'::regprocedure
  ) into v_definition;

  v_updated_definition := replace(
    v_definition,
    $needle$  perform pg_advisory_xact_lock(
    hashtextextended('cycle-reset:' || p_cycle_id::text, 0)
  );

  select *$needle$,
    $replacement$  perform pg_advisory_xact_lock(
    hashtextextended('cycle-reset:' || p_cycle_id::text, 0)
  );

  insert into public.media_cleanup_queue (
    storage_provider,
    storage_key,
    reason,
    status
  )
  select distinct
    operation.storage_provider,
    operation.storage_key,
    'cycle_reset:' || p_cycle_id::text,
    'pending'
  from public.submission_upload_operations operation
  where operation.cycle_id = p_cycle_id
    and operation.status in ('reserved', 'r2_uploaded')
  on conflict (storage_provider, storage_key) do nothing;

  update public.submission_upload_operations operation
  set
    status = 'cleanup_pending',
    cleanup_required = true,
    last_error_code = 'cycle_reset',
    updated_at = clock_timestamp(),
    completed_at = null,
    submission_id = null
  where operation.cycle_id = p_cycle_id
    and operation.status in ('reserved', 'r2_uploaded');

  select *$replacement$
  );

  if v_updated_definition = v_definition then
    raise exception using
      errcode = '55000',
      message = 'RESET_UPLOAD_OPERATION_INSERTION_POINT_NOT_FOUND';
  end if;

  v_definition := v_updated_definition;
  v_updated_definition := replace(
    v_definition,
    $needle$      'previous_status', v_previous_status,$needle$,
    $replacement$      'previous_status', v_previous_status,
      'previous_votes_per_user', v_cycle.votes_per_user,
      'previous_submissions_per_user', v_cycle.submissions_per_user,
      'previous_upload_success_cooldown_seconds',
        v_cycle.upload_success_cooldown_seconds,
      'reset_votes_per_user', 2,
      'reset_submissions_per_user', 2,
      'reset_upload_success_cooldown_seconds', 120,$replacement$
  );

  if v_updated_definition = v_definition then
    raise exception using
      errcode = '55000',
      message = 'RESET_AUDIT_INSERTION_POINT_NOT_FOUND';
  end if;

  execute v_updated_definition;
end;
$extend_reset_contract$;

alter function public.reset_cycle(bigint, text, text) owner to postgres;
revoke all on function public.reset_cycle(bigint, text, text)
  from public, anon, authenticated, service_role, discord_bot;

alter function public.manage_cycle_phase(
  text, bigint, text, text, integer, integer, text, uuid
) owner to postgres;
revoke all on function public.manage_cycle_phase(
  text, bigint, text, text, integer, integer, text, uuid
) from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.manage_cycle_phase(
  text, bigint, text, text, integer, integer, text, uuid
) to service_role;

alter function public.refund_disqualified_votes(
  text, bigint, integer, integer, jsonb, text, uuid
) owner to postgres;
revoke all on function public.refund_disqualified_votes(
  text, bigint, integer, integer, jsonb, text, uuid
) from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.refund_disqualified_votes(
  text, bigint, integer, integer, jsonb, text, uuid
) to service_role;

create or replace function public.start_cycle(
  p_cycle_id bigint,
  p_actor_discord_user_id text,
  p_settings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_current public.voting_cycles%rowtype;
  v_cycle public.voting_cycles%rowtype;
  v_now timestamptz := transaction_timestamp();
  v_actor_discord_id bigint;
  v_theme text;
  v_theme_source text;
  v_reward_description text;
  v_submissions_per_user integer;
  v_upload_success_cooldown_seconds integer;
  v_is_sponsored boolean := false;
  v_sponsor_name text;
  v_sponsor_link text;
  v_sponsor_banner_r2_key text;
  v_sponsor_banner_url text;
  v_sponsorship_id bigint;
  v_created_cycle boolean := false;
  v_reused_draft boolean := false;
  v_reused_reset_draft boolean := false;
begin
  if p_cycle_id is not null and p_cycle_id <= 0 then
    raise exception using message = 'INVALID_CYCLE_ID';
  end if;

  if p_actor_discord_user_id is null
    or btrim(p_actor_discord_user_id) = ''
  then
    raise exception using message = 'INVALID_START_ACTOR';
  end if;

  begin
    v_actor_discord_id := btrim(p_actor_discord_user_id)::bigint;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception using message = 'INVALID_START_ACTOR';
  end;

  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception using message = 'INVALID_START_SETTINGS';
  end if;

  if p_settings #> '{sponsored,enabled}' is not null
    and jsonb_typeof(p_settings #> '{sponsored,enabled}') <> 'boolean'
  then
    raise exception using message = 'INVALID_SPONSOR_SETTINGS';
  end if;

  if coalesce(p_settings ->> 'submissionsPerUser', '2') !~ '^[0-9]+$'
    or coalesce(
      p_settings ->> 'uploadSuccessCooldownSeconds',
      '120'
    ) !~ '^[0-9]+$'
    or length(coalesce(p_settings ->> 'submissionsPerUser', '2')) > 2
    or length(coalesce(
      p_settings ->> 'uploadSuccessCooldownSeconds',
      '120'
    )) > 3
  then
    raise exception using message = 'INVALID_START_SETTINGS';
  end if;

  v_submissions_per_user := coalesce(
    (p_settings ->> 'submissionsPerUser')::integer,
    2
  );
  v_upload_success_cooldown_seconds := coalesce(
    (p_settings ->> 'uploadSuccessCooldownSeconds')::integer,
    120
  );

  if v_submissions_per_user not between 1 and 20
    or v_upload_success_cooldown_seconds not between 30 and 300
  then
    raise exception using message = 'INVALID_START_SETTINGS';
  end if;

  v_theme := nullif(btrim(p_settings ->> 'theme'), '');
  v_theme_source := coalesce(
    nullif(btrim(p_settings ->> 'themeSource'), ''),
    'none'
  );
  v_reward_description := nullif(
    btrim(p_settings ->> 'rewardDescription'),
    ''
  );
  v_is_sponsored := coalesce(
    (p_settings #>> '{sponsored,enabled}')::boolean,
    false
  );
  v_sponsor_name := nullif(
    btrim(p_settings #>> '{sponsored,companyName}'),
    ''
  );
  v_sponsor_link := nullif(
    btrim(p_settings #>> '{sponsored,sponsorLink}'),
    ''
  );
  v_sponsor_banner_r2_key := nullif(
    btrim(p_settings #>> '{sponsored,bannerR2Key}'),
    ''
  );
  v_sponsor_banner_url := nullif(
    btrim(p_settings #>> '{sponsored,bannerUrl}'),
    ''
  );

  if v_theme_source not in ('manual', 'next_cycle_theme', 'none') then
    raise exception using message = 'INVALID_THEME_SOURCE';
  end if;

  if v_is_sponsored and (
    v_sponsor_name is null
    or v_sponsor_link is null
    or v_sponsor_banner_r2_key is null
  ) then
    raise exception using message = 'INCOMPLETE_SPONSOR_SETTINGS';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cycle-start-global', 0)
  );

  select *
  into v_current
  from public.voting_cycles
  where status in (
    'active',
    'submission_open',
    'submission_closed',
    'voting_open',
    'voting_closed',
    'paused',
    'finalizing'
  )
  order by id desc
  limit 1
  for update;

  if found then
    if p_cycle_id = v_current.id
      and v_current.status in ('submission_open', 'active')
    then
      return jsonb_build_object(
        'cycleId', v_current.id,
        'cycleNumber', v_current.id,
        'status', v_current.status::text,
        'startedAt', coalesce(
          v_current.submission_starts_at,
          v_current.starts_at
        ),
        'alreadyStarted', true,
        'createdCycle', false,
        'reusedDraft', true,
        'reusedResetDraft', v_current.reset_count > 0,
        'resetCount', v_current.reset_count,
        'submissionsPerUser', v_current.submissions_per_user,
        'uploadSuccessCooldownSeconds',
          v_current.upload_success_cooldown_seconds
      );
    end if;

    raise exception using
      message = 'CURRENT_CYCLE_EXISTS',
      detail = 'An unfinished/current cycle already exists.';
  end if;

  if p_cycle_id is not null then
    select *
    into v_cycle
    from public.voting_cycles
    where id = p_cycle_id
    for update;

    if not found then
      raise exception using message = 'CYCLE_NOT_FOUND';
    end if;
  else
    select *
    into v_cycle
    from public.voting_cycles
    where status = 'draft'
    order by (reset_at is not null) desc, id desc
    limit 1
    for update;
  end if;

  if found then
    if v_cycle.status <> 'draft' then
      raise exception using
        message = 'CYCLE_NOT_STARTABLE',
        detail = 'Requested cycle status is ' || v_cycle.status::text;
    end if;

    if exists (
      select 1 from public.submissions where cycle_id = v_cycle.id
    )
      or exists (select 1 from public.votes where cycle_id = v_cycle.id)
      or exists (select 1 from public.cycle_results where cycle_id = v_cycle.id)
      or exists (
        select 1 from public.winner_public_profiles where cycle_id = v_cycle.id
      )
      or exists (select 1 from public.cycle_events where cycle_id = v_cycle.id)
      or exists (
        select 1 from public.cycle_reminders where cycle_id = v_cycle.id
      )
      or exists (
        select 1 from public.user_cycle_acceptance where cycle_id = v_cycle.id
      )
    then
      raise exception using message = 'CYCLE_DRAFT_NOT_CLEAN';
    end if;

    v_reused_draft := true;
    v_reused_reset_draft := v_cycle.reset_at is not null;

    update public.voting_cycles
    set
      status = 'submission_open',
      starts_at = v_now,
      ends_at = null,
      created_by_discord_id = v_actor_discord_id,
      ended_at = null,
      finalized_at = null,
      winners_published = false,
      theme = v_theme,
      title = null,
      is_sponsored = v_is_sponsored,
      sponsor_name = case when v_is_sponsored then v_sponsor_name else null end,
      sponsor_link = case when v_is_sponsored then v_sponsor_link else null end,
      reward_description = v_reward_description,
      sponsor_banner_key = case
        when v_is_sponsored then v_sponsor_banner_r2_key
        else null
      end,
      rule_template_id = null,
      submission_starts_at = v_now,
      submission_ends_at = null,
      voting_starts_at = null,
      voting_ends_at = null,
      results_published_at = null,
      archived_at = null,
      submission_warn_threshold = null,
      submission_warned_at = null,
      submission_auto_close_enabled = false,
      submission_auto_close_threshold = null,
      submission_auto_closed_at = null,
      votes_per_user = 2,
      submissions_per_user = v_submissions_per_user,
      upload_success_cooldown_seconds =
        v_upload_success_cooldown_seconds,
      allow_self_vote = false,
      sponsorship_id = null,
      sponsor_name_snapshot = case
        when v_is_sponsored then v_sponsor_name
        else null
      end,
      sponsor_link_snapshot = case
        when v_is_sponsored then v_sponsor_link
        else null
      end,
      sponsor_banner_url_snapshot = case
        when v_is_sponsored then v_sponsor_banner_url
        else null
      end,
      paused_from_status = null,
      phase_paused_at = null,
      phase_paused_remaining_seconds = null,
      phase_pause_reason = null,
      reset_at = null
    where id = v_cycle.id
    returning * into v_cycle;
  else
    insert into public.voting_cycles (
      status,
      starts_at,
      created_by_discord_id,
      theme,
      is_sponsored,
      sponsor_name,
      sponsor_link,
      reward_description,
      sponsor_banner_key,
      submission_starts_at,
      votes_per_user,
      submissions_per_user,
      upload_success_cooldown_seconds,
      allow_self_vote,
      sponsor_name_snapshot,
      sponsor_link_snapshot,
      sponsor_banner_url_snapshot
    ) values (
      'submission_open',
      v_now,
      v_actor_discord_id,
      v_theme,
      v_is_sponsored,
      case when v_is_sponsored then v_sponsor_name else null end,
      case when v_is_sponsored then v_sponsor_link else null end,
      v_reward_description,
      case when v_is_sponsored then v_sponsor_banner_r2_key else null end,
      v_now,
      2,
      v_submissions_per_user,
      v_upload_success_cooldown_seconds,
      false,
      case when v_is_sponsored then v_sponsor_name else null end,
      case when v_is_sponsored then v_sponsor_link else null end,
      case when v_is_sponsored then v_sponsor_banner_url else null end
    )
    returning * into v_cycle;

    v_created_cycle := true;
  end if;

  delete from public.cycle_sponsorships
  where cycle_id = v_cycle.id;

  if v_is_sponsored then
    insert into public.cycle_sponsorships (
      cycle_id,
      sponsor_name,
      sponsor_link,
      banner_r2_key,
      is_active,
      starts_at,
      ends_at,
      updated_at
    ) values (
      v_cycle.id,
      v_sponsor_name,
      v_sponsor_link,
      v_sponsor_banner_r2_key,
      true,
      v_now,
      null,
      v_now
    )
    returning id into v_sponsorship_id;

    update public.voting_cycles
    set sponsorship_id = v_sponsorship_id
    where id = v_cycle.id
    returning * into v_cycle;
  end if;

  insert into public.cycle_events (
    cycle_id,
    event_type,
    actor_type,
    actor_discord_user_id,
    payload
  ) values (
    v_cycle.id,
    'submission_phase_opened',
    'admin',
    p_actor_discord_user_id,
    jsonb_build_object(
      'phase', 'submission_open',
      'theme', v_theme,
      'reward_description', v_reward_description,
      'ends_at', null,
      'started_at', v_now,
      'submissions_per_user', v_cycle.submissions_per_user,
      'upload_success_cooldown_seconds',
        v_cycle.upload_success_cooldown_seconds,
      'votes_per_user', v_cycle.votes_per_user,
      'reused_draft', v_reused_draft,
      'reused_reset_cycle', v_reused_reset_draft,
      'reset_count', v_cycle.reset_count,
      'sponsored_cycle', case
        when v_is_sponsored then jsonb_build_object(
          'company_name', v_sponsor_name,
          'sponsor_link', v_sponsor_link,
          'banner_r2_key', v_sponsor_banner_r2_key
        )
        else 'null'::jsonb
      end
    )
  );

  insert into public.admin_action_logs (
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    meta
  ) values (
    'admin',
    p_actor_discord_user_id,
    'cycle_started',
    'cycle',
    v_cycle.id::text,
    jsonb_build_object(
      'phase', 'submission_open',
      'submission_starts_at', v_now,
      'submission_ends_at', null,
      'ends_at', null,
      'theme', v_theme,
      'theme_source', v_theme_source,
      'reward_description', v_reward_description,
      'submissions_per_user', v_cycle.submissions_per_user,
      'upload_success_cooldown_seconds',
        v_cycle.upload_success_cooldown_seconds,
      'votes_per_user', v_cycle.votes_per_user,
      'reused_draft', v_reused_draft,
      'reused_reset_cycle', v_reused_reset_draft,
      'reset_count', v_cycle.reset_count,
      'sponsored_cycle', case
        when v_is_sponsored then jsonb_build_object(
          'company_name', v_sponsor_name,
          'sponsor_link', v_sponsor_link,
          'banner_r2_key', v_sponsor_banner_r2_key
        )
        else 'null'::jsonb
      end
    )
  );

  insert into public.app_config (key, value)
  values ('cycle_theme', v_theme)
  on conflict (key) do update set value = excluded.value;

  insert into public.app_config (key, value)
  values
    ('next_cycle_theme', null),
    ('next_cycle_reward_description', null),
    ('next_cycle_sponsored_enabled', 'false'),
    ('next_cycle_sponsor_name', null),
    ('next_cycle_sponsor_link', null),
    ('next_cycle_sponsor_banner_r2_key', null),
    ('next_cycle_is_sponsored', 'false')
  on conflict (key) do update set value = excluded.value;

  update public.user_logs
  set upload_fail_count = 0
  where upload_fail_count <> 0;

  return jsonb_build_object(
    'cycleId', v_cycle.id,
    'cycleNumber', v_cycle.id,
    'status', v_cycle.status::text,
    'startedAt', v_cycle.submission_starts_at,
    'alreadyStarted', false,
    'createdCycle', v_created_cycle,
    'reusedDraft', v_reused_draft,
    'reusedResetDraft', v_reused_reset_draft,
    'resetCount', v_cycle.reset_count,
    'submissionsPerUser', v_cycle.submissions_per_user,
    'uploadSuccessCooldownSeconds',
      v_cycle.upload_success_cooldown_seconds
  );
end;
$function$;

alter function public.start_cycle(bigint, text, jsonb) owner to postgres;
revoke all on function public.start_cycle(bigint, text, jsonb)
  from public, anon, authenticated, service_role, discord_bot;

create or replace function public.reserve_submission_upload(
  p_session_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_content_sha256 text,
  p_media_type text,
  p_media_bytes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz;
  v_discord_user_id text;
  v_operation public.submission_upload_operations%rowtype;
  v_cycle public.voting_cycles%rowtype;
  v_user public.user_logs%rowtype;
  v_membership public.discord_member_state%rowtype;
  v_rules_version integer;
  v_cleanup_status text;
  v_storage_key text;
  v_used integer;
  v_last_completed_at timestamptz;
  v_next_allowed_at timestamptz;
  v_cooldown_remaining integer := 0;
begin
  if p_session_id is null then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  if p_idempotency_key is null
    or p_request_fingerprint is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_content_sha256 is null
    or p_content_sha256 !~ '^[0-9a-f]{64}$'
    or p_media_type is distinct from 'image/webp'
    or p_media_bytes is null
    or p_media_bytes <= 0
    or p_media_bytes > 16777216
  then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  select session.discord_user_id
  into v_discord_user_id
  from public.sessions session
  where session.id = p_session_id
    and session.revoked_at is null;

  if not found then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'submission-upload-idempotency:' ||
      v_discord_user_id || ':' || p_idempotency_key::text,
      0
    )
  );

  select operation.*
  into v_operation
  from public.submission_upload_operations operation
  where operation.discord_user_id = v_discord_user_id
    and operation.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_operation.request_fingerprint <> p_request_fingerprint
      or v_operation.content_sha256 <> p_content_sha256
      or v_operation.media_type <> p_media_type
      or v_operation.media_bytes <> p_media_bytes
    then
      return jsonb_build_object(
        'outcome', 'idempotency_conflict',
        'cycleId', v_operation.cycle_id
      );
    end if;

    if v_operation.status = 'completed' then
      return jsonb_build_object(
        'outcome', 'already_completed',
        'operationId', v_operation.id,
        'cycleId', v_operation.cycle_id,
        'submissionId', v_operation.submission_id
      );
    end if;

    if v_operation.status in ('reserved', 'r2_uploaded') then
      return jsonb_build_object(
        'outcome', 'in_progress',
        'operationId', v_operation.id,
        'cycleId', v_operation.cycle_id
      );
    end if;

    if v_operation.status = 'cleanup_pending' then
      select queue.status
      into v_cleanup_status
      from public.media_cleanup_queue queue
      where queue.storage_provider = v_operation.storage_provider
        and queue.storage_key = v_operation.storage_key;

      if v_cleanup_status is distinct from 'completed' then
        return jsonb_build_object(
          'outcome', case
            when v_cleanup_status = 'dead' then 'cleanup_blocked'
            else 'cleanup_pending'
          end,
          'operationId', v_operation.id,
          'cycleId', v_operation.cycle_id
        );
      end if;
    end if;
  end if;

  select cycle.*
  into v_cycle
  from public.voting_cycles cycle
  where cycle.status in ('submission_open', 'active')
  order by cycle.id desc
  limit 1;

  if not found then
    return jsonb_build_object('outcome', 'cycle_not_open');
  end if;

  if v_operation.id is not null
    and v_operation.cycle_id <> v_cycle.id
  then
    return jsonb_build_object(
      'outcome', 'idempotency_cycle_conflict',
      'cycleId', v_operation.cycle_id
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'submission-upload-user-cycle:' ||
      v_discord_user_id || ':' || v_cycle.id::text,
      0
    )
  );

  select cycle.*
  into v_cycle
  from public.voting_cycles cycle
  where cycle.id = v_cycle.id
    and cycle.status in ('submission_open', 'active')
  for update;

  if not found then
    return jsonb_build_object('outcome', 'cycle_not_open');
  end if;

  v_now := clock_timestamp();

  select users.*
  into v_user
  from public.user_logs users
  where users.discord_user_id = v_discord_user_id;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  if v_user.is_banned then
    return jsonb_build_object('outcome', 'banned');
  end if;

  if coalesce(v_user.upload_fail_count, 0) >= 5 then
    return jsonb_build_object('outcome', 'rate_limited');
  end if;

  select rules.current_version
  into v_rules_version
  from public.rules_meta rules
  where rules.id = 1;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  if v_user.accepted_rules_version is distinct from v_rules_version then
    return jsonb_build_object('outcome', 'rules_not_accepted');
  end if;

  select membership.*
  into v_membership
  from public.discord_member_state membership
  where membership.discord_user_id = v_discord_user_id;

  if not found or not coalesce(v_membership.is_in_discord, false) then
    return jsonb_build_object('outcome', 'not_in_discord');
  end if;

  if v_membership.discord_joined_at is null
    or v_membership.discord_joined_at > v_now - interval '10 minutes'
  then
    return jsonb_build_object('outcome', 'joined_too_recently');
  end if;

  select count(*)::integer
  into v_used
  from public.submissions submission
  where submission.cycle_id = v_cycle.id
    and submission.discord_user_id = v_discord_user_id;

  if v_used >= v_cycle.submissions_per_user then
    return jsonb_build_object(
      'outcome', 'upload_limit_reached',
      'used', v_used,
      'limit', v_cycle.submissions_per_user,
      'remaining', 0
    );
  end if;

  select max(operation.completed_at)
  into v_last_completed_at
  from public.submission_upload_operations operation
  where operation.discord_user_id = v_discord_user_id
    and operation.cycle_id = v_cycle.id
    and operation.status = 'completed';

  if v_last_completed_at is not null then
    v_next_allowed_at := v_last_completed_at
      + make_interval(secs => v_cycle.upload_success_cooldown_seconds);
    v_cooldown_remaining := greatest(
      0,
      ceil(extract(epoch from (v_next_allowed_at - v_now)))::integer
    );
  end if;

  if v_cooldown_remaining > 0 then
    return jsonb_build_object(
      'outcome', 'cooldown_active',
      'used', v_used,
      'limit', v_cycle.submissions_per_user,
      'remaining', v_cycle.submissions_per_user - v_used,
      'cooldownRemainingSeconds', v_cooldown_remaining,
      'nextUploadAllowedAt', v_next_allowed_at
    );
  end if;

  if exists (
    select 1
    from public.submission_upload_operations other_operation
    where other_operation.discord_user_id = v_discord_user_id
      and other_operation.cycle_id = v_cycle.id
      and other_operation.status in ('reserved', 'r2_uploaded')
      and (
        v_operation.id is null
        or other_operation.id <> v_operation.id
      )
  ) then
    return jsonb_build_object('outcome', 'upload_in_progress');
  end if;

  v_storage_key :=
    v_cycle.id::text || '/' || gen_random_uuid()::text || '.webp';

  if v_operation.id is null then
    insert into public.submission_upload_operations (
      discord_user_id,
      cycle_id,
      idempotency_key,
      request_fingerprint,
      content_sha256,
      storage_key,
      media_type,
      media_bytes,
      status,
      created_at,
      updated_at,
      last_attempt_at
    ) values (
      v_discord_user_id,
      v_cycle.id,
      p_idempotency_key,
      p_request_fingerprint,
      p_content_sha256,
      v_storage_key,
      p_media_type,
      p_media_bytes,
      'reserved',
      v_now,
      v_now,
      v_now
    )
    returning * into v_operation;
  else
    update public.submission_upload_operations operation
    set
      storage_key = v_storage_key,
      status = 'reserved',
      r2_etag = null,
      cleanup_required = false,
      last_error_code = null,
      updated_at = v_now,
      last_attempt_at = v_now,
      completed_at = null,
      submission_id = null
    where operation.id = v_operation.id
    returning * into v_operation;
  end if;

  return jsonb_build_object(
    'outcome', 'reserved',
    'operationId', v_operation.id,
    'cycleId', v_operation.cycle_id,
    'storageKey', v_operation.storage_key,
    'used', v_used,
    'limit', v_cycle.submissions_per_user,
    'remaining', v_cycle.submissions_per_user - v_used
  );
end;
$function$;

alter function public.reserve_submission_upload(
  uuid, uuid, text, text, text, integer
) owner to postgres;
revoke all on function public.reserve_submission_upload(
  uuid, uuid, text, text, text, integer
) from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.reserve_submission_upload(
  uuid, uuid, text, text, text, integer
) to service_role;

create or replace function public.commit_submission_upload(
  p_operation_id uuid,
  p_session_id uuid,
  p_wallet_address text,
  p_payout_choice text,
  p_split_percent integer,
  p_charity text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz;
  v_discord_user_id text;
  v_operation public.submission_upload_operations%rowtype;
  v_cycle public.voting_cycles%rowtype;
  v_user public.user_logs%rowtype;
  v_membership public.discord_member_state%rowtype;
  v_rules_version integer;
  v_submission_id bigint;
  v_social_snapshot_count integer := 0;
  v_wallet_address text := coalesce(btrim(p_wallet_address), '');
  v_charity text := nullif(btrim(p_charity), '');
  v_used integer;
  v_last_completed_at timestamptz;
  v_next_allowed_at timestamptz;
  v_cooldown_remaining integer := 0;
begin
  if p_operation_id is null or p_session_id is null then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  if p_payout_choice is null
    or p_payout_choice not in ('keep', 'donate', 'split')
    or length(v_wallet_address) > 512
    or length(coalesce(v_charity, '')) > 256
    or (
      p_payout_choice = 'keep'
      and (
        v_wallet_address = ''
        or p_split_percent is not null
        or v_charity is not null
      )
    )
    or (
      p_payout_choice = 'donate'
      and (
        v_wallet_address <> ''
        or p_split_percent is not null
        or v_charity is null
      )
    )
    or (
      p_payout_choice = 'split'
      and (
        v_wallet_address = ''
        or p_split_percent is null
        or p_split_percent <= 0
        or p_split_percent >= 100
        or v_charity is null
      )
    )
  then
    return jsonb_build_object('outcome', 'invalid_private_data');
  end if;

  select session.discord_user_id
  into v_discord_user_id
  from public.sessions session
  where session.id = p_session_id
    and session.revoked_at is null;

  if not found then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select operation.*
  into v_operation
  from public.submission_upload_operations operation
  where operation.id = p_operation_id
    and operation.discord_user_id = v_discord_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_operation.status = 'completed' then
    return jsonb_build_object(
      'outcome', 'already_completed',
      'operationId', v_operation.id,
      'cycleId', v_operation.cycle_id,
      'submissionId', v_operation.submission_id
    );
  end if;

  if v_operation.status <> 'r2_uploaded' then
    return jsonb_build_object(
      'outcome', 'invalid_state',
      'status', v_operation.status
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'submission-upload-user-cycle:' ||
      v_discord_user_id || ':' || v_operation.cycle_id::text,
      0
    )
  );

  select cycle.*
  into v_cycle
  from public.voting_cycles cycle
  where cycle.id = v_operation.cycle_id
  for update;

  if not found or v_cycle.status::text not in ('submission_open', 'active') then
    return jsonb_build_object('outcome', 'cycle_not_open');
  end if;

  v_now := clock_timestamp();

  select users.*
  into v_user
  from public.user_logs users
  where users.discord_user_id = v_discord_user_id;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  if v_user.is_banned then
    return jsonb_build_object('outcome', 'banned');
  end if;

  if coalesce(v_user.upload_fail_count, 0) >= 5 then
    return jsonb_build_object('outcome', 'rate_limited');
  end if;

  select rules.current_version
  into v_rules_version
  from public.rules_meta rules
  where rules.id = 1;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  if v_user.accepted_rules_version is distinct from v_rules_version then
    return jsonb_build_object('outcome', 'rules_not_accepted');
  end if;

  select membership.*
  into v_membership
  from public.discord_member_state membership
  where membership.discord_user_id = v_discord_user_id;

  if not found or not coalesce(v_membership.is_in_discord, false) then
    return jsonb_build_object('outcome', 'not_in_discord');
  end if;

  if v_membership.discord_joined_at is null
    or v_membership.discord_joined_at > v_now - interval '10 minutes'
  then
    return jsonb_build_object('outcome', 'joined_too_recently');
  end if;

  select count(*)::integer
  into v_used
  from public.submissions submission
  where submission.cycle_id = v_operation.cycle_id
    and submission.discord_user_id = v_discord_user_id;

  if v_used >= v_cycle.submissions_per_user then
    return jsonb_build_object(
      'outcome', 'upload_limit_reached',
      'used', v_used,
      'limit', v_cycle.submissions_per_user,
      'remaining', 0
    );
  end if;

  select max(operation.completed_at)
  into v_last_completed_at
  from public.submission_upload_operations operation
  where operation.discord_user_id = v_discord_user_id
    and operation.cycle_id = v_operation.cycle_id
    and operation.status = 'completed';

  if v_last_completed_at is not null then
    v_next_allowed_at := v_last_completed_at
      + make_interval(secs => v_cycle.upload_success_cooldown_seconds);
    v_cooldown_remaining := greatest(
      0,
      ceil(extract(epoch from (v_next_allowed_at - v_now)))::integer
    );
  end if;

  if v_cooldown_remaining > 0 then
    return jsonb_build_object(
      'outcome', 'cooldown_active',
      'used', v_used,
      'limit', v_cycle.submissions_per_user,
      'remaining', v_cycle.submissions_per_user - v_used,
      'cooldownRemainingSeconds', v_cooldown_remaining,
      'nextUploadAllowedAt', v_next_allowed_at
    );
  end if;

  if v_operation.storage_provider <> 'r2'
    or v_operation.storage_key !~ (
      '^' || v_operation.cycle_id::text || '/[0-9A-Fa-f-]{36}[.]webp$'
    )
    or v_operation.media_type <> 'image/webp'
    or v_operation.media_bytes <= 0
    or v_operation.content_sha256 !~ '^[0-9a-f]{64}$'
  then
    return jsonb_build_object('outcome', 'invalid_media_metadata');
  end if;

  insert into public.submissions (
    cycle_id,
    discord_user_id,
    r2_key,
    discord_username_at_upload
  ) values (
    v_operation.cycle_id,
    v_discord_user_id,
    v_operation.storage_key,
    coalesce(v_user.current_discord_username, 'unknown')
  )
  returning id into v_submission_id;

  insert into public.submission_private_data (
    submission_id,
    x_username,
    wallet_address,
    payout_choice,
    split_percent,
    charity
  ) values (
    v_submission_id,
    null,
    v_wallet_address,
    p_payout_choice,
    case when p_payout_choice = 'split' then p_split_percent else null end,
    case when p_payout_choice in ('donate', 'split') then v_charity else null end
  );

  if v_user.show_socials_on_submissions then
    insert into public.submission_social_links (
      submission_id,
      discord_user_id,
      platform,
      display_label,
      profile_url,
      is_verified_snapshot,
      source_user_social_link_id
    )
    select
      v_submission_id,
      v_discord_user_id,
      social.platform,
      case
        when nullif(btrim(social.handle), '') is not null
          and not (
            social.platform = 'facebook'
            and social.handle like 'id:%'
          )
          then social.handle
        else social.profile_url
      end,
      social.profile_url,
      true,
      social.id
    from public.user_social_links social
    where social.discord_user_id = v_discord_user_id
      and social.is_verified = true
    order by social.created_at, social.id;

    get diagnostics v_social_snapshot_count = row_count;
  end if;

  insert into public.upload_logs (
    cycle_id,
    discord_user_id,
    submission_id,
    status,
    reason
  ) values (
    v_operation.cycle_id::text,
    v_discord_user_id,
    v_submission_id::text,
    'success',
    null
  );

  update public.submission_upload_operations operation
  set
    status = 'completed',
    submission_id = v_submission_id,
    cleanup_required = false,
    last_error_code = null,
    updated_at = v_now,
    last_attempt_at = v_now,
    completed_at = v_now
  where operation.id = v_operation.id;

  v_used := v_used + 1;
  v_next_allowed_at := v_now
    + make_interval(secs => v_cycle.upload_success_cooldown_seconds);

  return jsonb_build_object(
    'outcome', 'completed',
    'operationId', v_operation.id,
    'cycleId', v_operation.cycle_id,
    'submissionId', v_submission_id,
    'socialSnapshotCount', v_social_snapshot_count,
    'used', v_used,
    'limit', v_cycle.submissions_per_user,
    'remaining', greatest(v_cycle.submissions_per_user - v_used, 0),
    'cooldownRemainingSeconds', case
      when v_used < v_cycle.submissions_per_user
        then v_cycle.upload_success_cooldown_seconds
      else 0
    end,
    'nextUploadAllowedAt', case
      when v_used < v_cycle.submissions_per_user then v_next_allowed_at
      else null
    end
  );
end;
$function$;

alter function public.commit_submission_upload(
  uuid, uuid, text, text, integer, text
) owner to postgres;
revoke all on function public.commit_submission_upload(
  uuid, uuid, text, text, integer, text
) from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.commit_submission_upload(
  uuid, uuid, text, text, integer, text
) to service_role;

do $publish_dynamic_limit_copy$
declare
  v_rules_document public.content_documents%rowtype;
  v_faq_document public.content_documents%rowtype;
  v_rules_content jsonb;
  v_faq_content jsonb;
  v_rules_revision_id bigint;
  v_faq_revision_id bigint;
  v_rules_revision_number bigint;
  v_faq_revision_number bigint;
  v_previous_rules_version integer;
  v_rules_version integer;
begin
  select document.*
  into v_rules_document
  from public.content_documents document
  where document.key = 'rules'
  for update;

  select document.*
  into v_faq_document
  from public.content_documents document
  where document.key = 'faq'
  for update;

  if v_rules_document.published_revision_id is null
    or v_rules_document.draft_revision_id is not null
    or v_faq_document.published_revision_id is null
    or v_faq_document.draft_revision_id is not null
  then
    raise exception using
      errcode = '55000',
      message = 'DYNAMIC_LIMIT_COPY_DOCUMENT_BASELINE_MISMATCH';
  end if;

  select revision.content
  into v_rules_content
  from public.content_revisions revision
  where revision.document_key = 'rules'
    and revision.id = v_rules_document.published_revision_id;

  select revision.content
  into v_faq_content
  from public.content_revisions revision
  where revision.document_key = 'faq'
    and revision.id = v_faq_document.published_revision_id;

  if v_rules_content #>> '{sections,0,id}' <> 'participation'
    or v_rules_content #>> '{sections,0,paragraphs,1}' <>
      'Each user may submit one (1) meme and cast one (1) vote per cycle.'
    or v_faq_content #>> '{sections,0,id}' <> 'wallet'
    or v_faq_content #>> '{sections,0,paragraphs,6}' <>
      'You can check which wallet address you submitted in your profile under your current submission.'
    or not exists (
      select 1
      from public.homepage_info_blocks block
      where block.seed_key = 'how-it-works'
        and block.body like E'%\u2022 1 submission\n\u2022 2 votes%'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'DYNAMIC_LIMIT_COPY_PUBLISHED_BASELINE_MISMATCH';
  end if;

  v_rules_content := jsonb_set(
    v_rules_content,
    '{sections,0,paragraphs,1}',
    to_jsonb(
      'Each cycle defines the maximum number of Submissions and Votes each user may use. Neither maximum is a required total.'::text
    )
  );
  v_faq_content := jsonb_set(
    v_faq_content,
    '{sections,0,paragraphs,6}',
    to_jsonb(
      'You can check the saved wallet and payout choice for each of your current-cycle Submissions in My Profile.'::text
    )
  );

  perform public.assert_rules_content_payload(v_rules_content);
  perform public.assert_faq_content_payload(v_faq_content);

  select coalesce(max(revision.revision_number), 0) + 1
  into v_rules_revision_number
  from public.content_revisions revision
  where revision.document_key = 'rules';

  select coalesce(max(revision.revision_number), 0) + 1
  into v_faq_revision_number
  from public.content_revisions revision
  where revision.document_key = 'faq';

  insert into public.content_revisions (
    document_key,
    revision_number,
    content,
    content_hash,
    created_by_discord_user_id
  ) values (
    'rules',
    v_rules_revision_number,
    v_rules_content,
    encode(
      extensions.digest(convert_to(v_rules_content::text, 'UTF8'), 'sha256'),
      'hex'
    ),
    null
  ) returning id into v_rules_revision_id;

  insert into public.content_revisions (
    document_key,
    revision_number,
    content,
    content_hash,
    created_by_discord_user_id
  ) values (
    'faq',
    v_faq_revision_number,
    v_faq_content,
    encode(
      extensions.digest(convert_to(v_faq_content::text, 'UTF8'), 'sha256'),
      'hex'
    ),
    null
  ) returning id into v_faq_revision_id;

  select current_version
  into v_previous_rules_version
  from public.rules_meta
  where id = 1
  for update;

  update public.rules_meta
  set
    current_version = current_version + 1,
    updated_at = transaction_timestamp()
  where id = 1
  returning current_version into v_rules_version;

  update public.content_documents
  set
    published_revision_id = v_rules_revision_id,
    state_version = state_version + 1,
    updated_at = transaction_timestamp(),
    updated_by_discord_user_id = null
  where key = 'rules';

  update public.content_documents
  set
    published_revision_id = v_faq_revision_id,
    state_version = state_version + 1,
    updated_at = transaction_timestamp(),
    updated_by_discord_user_id = null
  where key = 'faq';

  insert into public.content_publications (
    document_key,
    event_type,
    revision_id,
    previous_revision_id,
    requested_material_change,
    effective_material_change,
    structure_changed,
    previous_rules_version,
    rules_version,
    request_id,
    published_by_discord_user_id
  ) values
    (
      'rules',
      'publish',
      v_rules_revision_id,
      v_rules_document.published_revision_id,
      true,
      true,
      false,
      v_previous_rules_version,
      v_rules_version,
      '20260811-0001-4000-8000-000000000001'::uuid,
      '0'
    ),
    (
      'faq',
      'publish',
      v_faq_revision_id,
      v_faq_document.published_revision_id,
      null,
      null,
      null,
      null,
      null,
      '20260811-0001-4000-8000-000000000002'::uuid,
      '0'
    );

  update public.homepage_info_blocks
  set body = replace(
    body,
    E'\u2022 1 submission\n\u2022 2 votes',
    E'\u2022 A cycle-specific Submission quota\n\u2022 A cycle-specific Vote limit'
  )
  where seed_key = 'how-it-works';

  insert into public.admin_action_logs (
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    meta
  ) values
    (
      'system',
      'migration:20260811000100',
      'rules_published',
      'content_document',
      'rules',
      jsonb_build_object(
        'revision_id', v_rules_revision_id,
        'revision_number', v_rules_revision_number,
        'material_change', true,
        'previous_rules_version', v_previous_rules_version,
        'rules_version', v_rules_version,
        'source', 'dynamic_submission_limits_migration'
      )
    ),
    (
      'system',
      'migration:20260811000100',
      'faq_published',
      'content_document',
      'faq',
      jsonb_build_object(
        'revision_id', v_faq_revision_id,
        'revision_number', v_faq_revision_number,
        'source', 'dynamic_submission_limits_migration'
      )
    ),
    (
      'system',
      'migration:20260811000100',
      'homepage_info_updated',
      'homepage_info_block',
      'how-it-works',
      jsonb_build_object(
        'source', 'dynamic_submission_limits_migration'
      )
    );
end;
$publish_dynamic_limit_copy$;

do $postflight$
declare
  v_active_operation_definition text;
  v_active_operation_predicate text;
  v_function_name text;
  v_signature text;
begin
  if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'voting_cycles'
        and column_name = 'submissions_per_user'
        and is_nullable = 'NO'
        and column_default = '2'
    )
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'voting_cycles'
        and column_name = 'upload_success_cooldown_seconds'
        and is_nullable = 'NO'
        and column_default = '120'
    )
    or exists (
      select 1
      from public.voting_cycles
      where submissions_per_user <> 1
        or upload_success_cooldown_seconds <> 120
    )
  then
    raise exception using
      errcode = '55000',
      message = 'DYNAMIC_SUBMISSIONS_HISTORICAL_BACKFILL_FAILED';
  end if;

  if to_regclass(
      'public.submissions_cycle_id_discord_user_id_uidx'
    ) is not null
    or to_regclass('public.submissions_cycle_user_id_idx') is null
    or to_regclass(
      'public.submission_upload_operations_completed_user_cycle_idx'
    ) is null
  then
    raise exception using
      errcode = '55000',
      message = 'DYNAMIC_SUBMISSIONS_INDEX_POSTFLIGHT_FAILED';
  end if;

  if exists (
      select 1
      from public.content_documents document
      join public.content_revisions revision
        on revision.document_key = document.key
       and revision.id = document.published_revision_id
      where document.key in ('rules', 'faq')
        and (
          revision.content::text ilike '%one (1) meme%'
          or revision.content::text ilike '%current submission%'
        )
    )
    or exists (
      select 1
      from public.homepage_info_blocks block
      where block.seed_key = 'how-it-works'
        and block.body like E'%\u2022 1 submission%'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'DYNAMIC_LIMIT_COPY_POSTFLIGHT_FAILED';
  end if;

  select
    pg_get_indexdef(index_row.indexrelid),
    pg_get_expr(index_row.indpred, index_row.indrelid)
  into v_active_operation_definition, v_active_operation_predicate
  from pg_index index_row
  where index_row.indexrelid =
    to_regclass('public.submission_upload_operations_one_active_user_cycle_idx');

  if v_active_operation_definition is null
    or v_active_operation_definition not like
      'CREATE UNIQUE INDEX % ON public.submission_upload_operations USING btree (discord_user_id, cycle_id) WHERE %'
    or v_active_operation_predicate is distinct from
      '(status = ANY (ARRAY[''reserved''::text, ''r2_uploaded''::text]))'
  then
    raise exception using
      errcode = '55000',
      message = 'ACTIVE_UPLOAD_OPERATION_INDEX_POSTFLIGHT_FAILED';
  end if;

  foreach v_function_name in array array[
    'start_cycle',
    'reserve_submission_upload',
    'commit_submission_upload',
    'get_submission_upload_quota',
    'enforce_cycle_submission_settings',
    'manage_cycle_phase',
    'refund_disqualified_votes',
    'reset_cycle'
  ] loop
    if (
      select count(*)
      from pg_proc function_row
      join pg_namespace namespace_row
        on namespace_row.oid = function_row.pronamespace
      where namespace_row.nspname = 'public'
        and function_row.proname = v_function_name
    ) <> 1 then
      raise exception using
        errcode = '55000',
        message = 'DYNAMIC_SUBMISSIONS_OVERLOAD_POSTFLIGHT_FAILED',
        detail = v_function_name;
    end if;
  end loop;

  if exists (
    select 1
    from pg_proc function_row
    join pg_namespace namespace_row
      on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname in (
        'start_cycle',
        'reserve_submission_upload',
        'commit_submission_upload',
        'get_submission_upload_quota',
        'enforce_cycle_submission_settings',
        'manage_cycle_phase',
        'refund_disqualified_votes',
        'reset_cycle'
      )
      and (
        pg_get_userbyid(function_row.proowner) <> 'postgres'
        or not function_row.prosecdef
        or function_row.proconfig is distinct from
          array['search_path=public, pg_temp']::text[]
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'DYNAMIC_SUBMISSIONS_FUNCTION_HARDENING_FAILED';
  end if;

  foreach v_signature in array array[
    'public.get_submission_upload_quota(bigint,text)',
    'public.reserve_submission_upload(uuid,uuid,text,text,text,integer)',
    'public.commit_submission_upload(uuid,uuid,text,text,integer,text)',
    'public.manage_cycle_phase(text,bigint,text,text,integer,integer,text,uuid)',
    'public.refund_disqualified_votes(text,bigint,integer,integer,jsonb,text,uuid)'
  ] loop
    if has_function_privilege('anon', v_signature, 'execute')
      or has_function_privilege('authenticated', v_signature, 'execute')
      or has_function_privilege('discord_bot', v_signature, 'execute')
      or not has_function_privilege('service_role', v_signature, 'execute')
    then
      raise exception using
        errcode = '55000',
        message = 'DYNAMIC_SUBMISSIONS_FUNCTION_ACL_FAILED',
        detail = v_signature;
    end if;
  end loop;

  foreach v_signature in array array[
    'public.start_cycle(bigint,text,jsonb)',
    'public.reset_cycle(bigint,text,text)',
    'public.enforce_cycle_submission_settings()'
  ] loop
    if has_function_privilege('anon', v_signature, 'execute')
      or has_function_privilege('authenticated', v_signature, 'execute')
      or has_function_privilege('discord_bot', v_signature, 'execute')
      or has_function_privilege('service_role', v_signature, 'execute')
    then
      raise exception using
        errcode = '55000',
        message = 'DYNAMIC_SUBMISSIONS_FUNCTION_ACL_FAILED',
        detail = v_signature;
    end if;
  end loop;
end;
$postflight$;

commit;

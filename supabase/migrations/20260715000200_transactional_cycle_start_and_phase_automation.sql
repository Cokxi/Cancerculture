begin;

do $$
declare
  v_current_cycle_count integer;
begin
  select count(*)::integer
  into v_current_cycle_count
  from public.voting_cycles
  where status in (
    'active',
    'submission_open',
    'submission_closed',
    'voting_open',
    'voting_closed',
    'paused',
    'finalizing'
  );

  if v_current_cycle_count > 1 then
    raise exception using
      message = 'CURRENT_CYCLE_INVARIANT_VIOLATION',
      detail = 'Resolve duplicate unfinished/current cycles before applying this migration.';
  end if;
end;
$$;

create unique index if not exists voting_cycles_one_current_idx
  on public.voting_cycles ((1))
  where status in (
    'active',
    'submission_open',
    'submission_closed',
    'voting_open',
    'voting_closed',
    'paused',
    'finalizing'
  );

comment on index public.voting_cycles_one_current_idx is
  'Defense in depth: at most one legacy/current unfinished cycle may exist. Draft and terminal states are intentionally excluded.';

create or replace function public.start_cycle(
  p_cycle_id bigint,
  p_actor_discord_user_id text,
  p_settings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current public.voting_cycles%rowtype;
  v_cycle public.voting_cycles%rowtype;
  v_now timestamptz := transaction_timestamp();
  v_actor_discord_id bigint;
  v_theme text;
  v_theme_source text;
  v_reward_description text;
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
        'resetCount', v_current.reset_count
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
      or exists (
        select 1 from public.votes where cycle_id = v_cycle.id
      )
      or exists (
        select 1 from public.cycle_results where cycle_id = v_cycle.id
      )
      or exists (
        select 1 from public.winner_public_profiles where cycle_id = v_cycle.id
      )
      or exists (
        select 1 from public.cycle_events where cycle_id = v_cycle.id
      )
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
    'resetCount', v_cycle.reset_count
  );
end;
$$;

revoke all on function public.start_cycle(bigint, text, jsonb) from public;
grant execute on function public.start_cycle(bigint, text, jsonb) to service_role;

comment on function public.start_cycle(bigint, text, jsonb) is
  'Globally serializes Cycle Start, locks/reuses a clean draft when available, preserves reset history, and atomically writes cycle state, sponsorship, event, audit, and runtime config.';

create or replace function public.process_due_cycle_transitions(
  p_cycle_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle public.voting_cycles%rowtype;
  v_now timestamptz := transaction_timestamp();
  v_previous_status text;
  v_voting_started_at timestamptz;
  v_submission_ended_at timestamptz;
  v_voting_closed_event_at timestamptz;
  v_repair_codes text[] := '{}'::text[];
  v_changed_rows integer := 0;
  v_step_rows integer := 0;
begin
  if p_cycle_id is not null and p_cycle_id <= 0 then
    raise exception using message = 'INVALID_CYCLE_ID';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cycle-phase-automation-global', 0)
  );

  if p_cycle_id is not null then
    select *
    into v_cycle
    from public.voting_cycles
    where id = p_cycle_id
    for update;
  else
    select *
    into v_cycle
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
  end if;

  if not found then
    return jsonb_build_object(
      'outcome', 'noop',
      'cycleId', null,
      'previousStatus', null,
      'status', null,
      'transition', null,
      'reason', 'no_current_cycle',
      'repairCodes', '[]'::jsonb,
      'eventCreated', false,
      'processedAt', v_now
    );
  end if;

  v_previous_status := v_cycle.status::text;

  if v_previous_status = 'paused' then
    return jsonb_build_object(
      'outcome', 'noop',
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', v_previous_status,
      'transition', null,
      'reason', 'paused',
      'repairCodes', '[]'::jsonb,
      'eventCreated', false,
      'processedAt', v_now
    );
  end if;

  if v_previous_status = 'active' then
    return jsonb_build_object(
      'outcome', 'diagnostic',
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', v_previous_status,
      'transition', null,
      'reason', 'legacy_active_phase_is_ambiguous',
      'repairCodes', '[]'::jsonb,
      'eventCreated', false,
      'processedAt', v_now
    );
  end if;

  if v_previous_status = 'submission_open' then
    if v_cycle.voting_ends_at is not null then
      return jsonb_build_object(
        'outcome', 'diagnostic',
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', 'submission_open_has_voting_end',
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    if v_cycle.submission_ends_at is null then
      return jsonb_build_object(
        'outcome', case
          when v_cycle.voting_starts_at is null then 'noop'
          else 'diagnostic'
        end,
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', case
          when v_cycle.voting_starts_at is null then 'submission_timer_not_set'
          else 'submission_open_has_voting_start_without_deadline'
        end,
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    if v_cycle.submission_ends_at > v_now then
      return jsonb_build_object(
        'outcome', case
          when v_cycle.voting_starts_at is null then 'noop'
          else 'diagnostic'
        end,
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', case
          when v_cycle.voting_starts_at is null then 'submission_not_due'
          else 'submission_open_has_early_voting_start'
        end,
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    v_voting_started_at := coalesce(v_cycle.voting_starts_at, v_now);

    if v_cycle.voting_starts_at is not null then
      v_repair_codes := array_append(
        v_repair_codes,
        'preserved_existing_voting_start'
      );
    end if;

    update public.voting_cycles
    set
      status = 'voting_open',
      ends_at = null,
      voting_starts_at = v_voting_started_at,
      voting_ends_at = null,
      paused_from_status = null,
      phase_paused_at = null,
      phase_paused_remaining_seconds = null,
      phase_pause_reason = null
    where id = v_cycle.id;

    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = v_cycle.id
      and phase = 'submission_open'
      and status = 'pending';

    update public.app_config
    set value = null
    where key = 'cycle_end_at';

    insert into public.cycle_events (
      cycle_id,
      event_type,
      actor_type,
      payload
    ) values (
      v_cycle.id,
      'voting_phase_opened',
      'system',
      jsonb_build_object(
        'from_phase', 'submission_open',
        'phase', 'voting_open',
        'automatic', true,
        'database_time', v_now,
        'submission_ended_at', v_cycle.submission_ends_at,
        'voting_starts_at', v_voting_started_at,
        'voting_ends_at', null,
        'votes_per_user', v_cycle.votes_per_user,
        'repair_codes', to_jsonb(v_repair_codes)
      )
    );

    return jsonb_build_object(
      'outcome', 'transitioned',
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', 'voting_open',
      'transition', 'submission_open_to_voting_open',
      'reason', 'submission_deadline_reached',
      'repairCodes', to_jsonb(v_repair_codes),
      'eventCreated', true,
      'processedAt', v_now
    );
  end if;

  if v_previous_status = 'submission_closed' then
    if v_cycle.voting_ends_at is not null then
      return jsonb_build_object(
        'outcome', 'diagnostic',
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', 'submission_closed_has_voting_end',
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    v_submission_ended_at := coalesce(v_cycle.submission_ends_at, v_now);
    v_voting_started_at := coalesce(v_cycle.voting_starts_at, v_now);

    if v_cycle.submission_ends_at is null then
      v_repair_codes := array_append(
        v_repair_codes,
        'submission_end_recovered_at_processing_time'
      );
    end if;

    if v_cycle.voting_starts_at is null then
      v_repair_codes := array_append(
        v_repair_codes,
        'voting_start_recovered_at_processing_time'
      );
    end if;

    update public.voting_cycles
    set
      status = 'voting_open',
      ends_at = null,
      submission_ends_at = v_submission_ended_at,
      voting_starts_at = v_voting_started_at,
      voting_ends_at = null,
      paused_from_status = null,
      phase_paused_at = null,
      phase_paused_remaining_seconds = null,
      phase_pause_reason = null
    where id = v_cycle.id;

    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = v_cycle.id
      and phase = 'submission_open'
      and status = 'pending';

    update public.app_config
    set value = null
    where key = 'cycle_end_at';

    insert into public.cycle_events (
      cycle_id,
      event_type,
      actor_type,
      payload
    ) values (
      v_cycle.id,
      'voting_phase_opened',
      'system',
      jsonb_build_object(
        'from_phase', 'submission_closed',
        'phase', 'voting_open',
        'automatic', true,
        'recovery', true,
        'database_time', v_now,
        'submission_ended_at', v_submission_ended_at,
        'voting_starts_at', v_voting_started_at,
        'voting_ends_at', null,
        'votes_per_user', v_cycle.votes_per_user,
        'repair_codes', to_jsonb(v_repair_codes)
      )
    );

    return jsonb_build_object(
      'outcome', 'transitioned',
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', 'voting_open',
      'transition', 'submission_closed_to_voting_open',
      'reason', 'recovered_stranded_submission_close',
      'repairCodes', to_jsonb(v_repair_codes),
      'eventCreated', true,
      'processedAt', v_now
    );
  end if;

  if v_previous_status = 'voting_open' then
    if v_cycle.voting_starts_at is null then
      return jsonb_build_object(
        'outcome', 'diagnostic',
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', 'voting_open_missing_voting_start',
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    if v_cycle.submission_ends_at is null then
      v_submission_ended_at := v_cycle.voting_starts_at;
      v_repair_codes := array_append(
        v_repair_codes,
        'submission_end_aligned_to_voting_start'
      );
    else
      v_submission_ended_at := v_cycle.submission_ends_at;
    end if;

    if v_cycle.ends_at is not null then
      v_repair_codes := array_append(
        v_repair_codes,
        'legacy_cycle_end_cleared'
      );
    end if;

    if v_cycle.voting_ends_at is null
      or v_cycle.voting_ends_at > v_now
    then
      if cardinality(v_repair_codes) > 0 then
        update public.voting_cycles
        set
          ends_at = null,
          submission_ends_at = v_submission_ended_at
        where id = v_cycle.id;

        return jsonb_build_object(
          'outcome', 'repaired',
          'cycleId', v_cycle.id,
          'previousStatus', v_previous_status,
          'status', v_previous_status,
          'transition', null,
          'reason', 'voting_open_normalized',
          'repairCodes', to_jsonb(v_repair_codes),
          'eventCreated', false,
          'processedAt', v_now
        );
      end if;

      return jsonb_build_object(
        'outcome', 'noop',
        'cycleId', v_cycle.id,
        'previousStatus', v_previous_status,
        'status', v_previous_status,
        'transition', null,
        'reason', case
          when v_cycle.voting_ends_at is null then 'voting_timer_not_set'
          else 'voting_not_due'
        end,
        'repairCodes', '[]'::jsonb,
        'eventCreated', false,
        'processedAt', v_now
      );
    end if;

    update public.voting_cycles
    set
      status = 'voting_closed',
      ends_at = null,
      submission_ends_at = v_submission_ended_at,
      paused_from_status = null,
      phase_paused_at = null,
      phase_paused_remaining_seconds = null,
      phase_pause_reason = null
    where id = v_cycle.id;

    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = v_cycle.id
      and phase = 'voting_open'
      and status = 'pending';

    update public.app_config
    set value = null
    where key = 'cycle_end_at';

    insert into public.cycle_events (
      cycle_id,
      event_type,
      actor_type,
      payload
    ) values (
      v_cycle.id,
      'voting_phase_closed',
      'system',
      jsonb_build_object(
        'from_phase', 'voting_open',
        'phase', 'voting_closed',
        'automatic', true,
        'database_time', v_now,
        'voting_ended_at', v_cycle.voting_ends_at,
        'repair_codes', to_jsonb(v_repair_codes)
      )
    );

    return jsonb_build_object(
      'outcome', 'transitioned',
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', 'voting_closed',
      'transition', 'voting_open_to_voting_closed',
      'reason', 'voting_deadline_reached',
      'repairCodes', to_jsonb(v_repair_codes),
      'eventCreated', true,
      'processedAt', v_now
    );
  end if;

  if v_previous_status = 'voting_closed' then
    select max(created_at)
    into v_voting_closed_event_at
    from public.cycle_events
    where cycle_id = v_cycle.id
      and event_type = 'voting_phase_closed';

    if v_cycle.ends_at is not null then
      v_repair_codes := array_append(
        v_repair_codes,
        'legacy_cycle_end_cleared'
      );
    end if;

    if v_cycle.submission_ends_at is null
      and v_cycle.voting_starts_at is not null
    then
      v_repair_codes := array_append(
        v_repair_codes,
        'submission_end_aligned_to_voting_start'
      );
    end if;

    if v_voting_closed_event_at is not null and (
      v_cycle.voting_ends_at is null
      or v_cycle.voting_ends_at > v_voting_closed_event_at
    ) then
      v_repair_codes := array_append(
        v_repair_codes,
        'voting_end_aligned_to_close_event'
      );
    end if;

    if cardinality(v_repair_codes) > 0 then
      update public.voting_cycles
      set
        ends_at = null,
        submission_ends_at = case
          when submission_ends_at is null and voting_starts_at is not null
            then voting_starts_at
          else submission_ends_at
        end,
        voting_ends_at = case
          when v_voting_closed_event_at is not null and (
            voting_ends_at is null
            or voting_ends_at > v_voting_closed_event_at
          ) then v_voting_closed_event_at
          else voting_ends_at
        end
      where id = v_cycle.id;

      get diagnostics v_changed_rows = row_count;
    end if;

    update public.cycle_reminders
    set status = 'cancelled'
    where cycle_id = v_cycle.id
      and phase = 'voting_open'
      and status = 'pending';

    get diagnostics v_step_rows = row_count;
    v_changed_rows := v_changed_rows + v_step_rows;

    update public.app_config
    set value = null
    where key = 'cycle_end_at'
      and value is not null;

    get diagnostics v_step_rows = row_count;
    v_changed_rows := v_changed_rows + v_step_rows;

    return jsonb_build_object(
      'outcome', case when v_changed_rows > 0 then 'repaired' else 'noop' end,
      'cycleId', v_cycle.id,
      'previousStatus', v_previous_status,
      'status', v_previous_status,
      'transition', null,
      'reason', case
        when v_changed_rows > 0 then 'voting_closed_normalized'
        else 'voting_already_closed'
      end,
      'repairCodes', to_jsonb(v_repair_codes),
      'eventCreated', false,
      'processedAt', v_now
    );
  end if;

  return jsonb_build_object(
    'outcome', 'noop',
    'cycleId', v_cycle.id,
    'previousStatus', v_previous_status,
    'status', v_previous_status,
    'transition', null,
    'reason', 'status_not_automated',
    'repairCodes', '[]'::jsonb,
    'eventCreated', false,
    'processedAt', v_now
  );
end;
$$;

revoke all on function public.process_due_cycle_transitions(bigint) from public;
grant execute on function public.process_due_cycle_transitions(bigint) to service_role;

comment on function public.process_due_cycle_transitions(bigint) is
  'Uses database time plus a global advisory lock and row lock for idempotent automatic phase transitions. It repairs only explicit canonical cases; ambiguous legacy or contradictory states return diagnostics without mutation.';

commit;

begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 30
    or (select count(*) from public.capability_catalog where is_active) <> 28
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 28
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'logs.vote_refunds.view'
        and is_active
        and assignable_to_non_admin
        and implementation_version = 2
        and definition_hash =
          'f3e1102733e29e8338b95f831e89f9f09f7f7af70ce4dfcfce51cba450c358b2'
    )
    or to_regclass('public.submissions') is null
    or to_regclass('public.voting_cycles') is null
    or to_regclass('public.user_logs') is null
    or to_regclass('public.moderation_action_logs') is null
    or (
      select count(*)
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'moderation_action_logs'
        and column_name = any (array[
          'id',
          'created_at',
          'actor_id',
          'actor_discord_username',
          'action',
          'target_type',
          'target_id',
          'target_discord_user_id',
          'reason_code',
          'reason_text',
          'cycle_id',
          'moderation_request_id',
          'moderation_phase',
          'before_state',
          'after_state'
        ]::text[])
    ) <> 15 then
    raise exception using
      errcode = '55000',
      message = 'USER_DQ_HISTORY_BASELINE_MISMATCH';
  end if;

  if exists (
      select 1
      from public.capability_catalog
      where key = 'users.disqualified_submissions.view'
    )
    or to_regclass('public.submission_disqualification_events') is not null
    or to_regprocedure(
      'public.get_user_disqualification_history(text,timestamp with time zone,uuid,integer)'
    ) is not null
    or to_regprocedure(
      'public.get_user_disqualification_profiles(timestamp with time zone,uuid,integer)'
    ) is not null
    or to_regprocedure(
      'public.capture_submission_disqualification_log_event()'
    ) is not null
    or to_regprocedure(
      'public.capture_discord_ban_disqualification_event()'
    ) is not null then
    raise exception using
      errcode = '55000',
      message = 'USER_DQ_HISTORY_TARGET_ALREADY_PRESENT';
  end if;
end;
$preflight$;

insert into public.capability_catalog (
  key,
  display_name,
  description,
  category,
  included_actions,
  excluded_actions,
  risk_level,
  assignable_to_non_admin,
  is_active,
  implementation_version,
  definition_hash
)
values (
  'users.disqualified_submissions.view',
  'View User Disqualification History',
  'View a redacted profile-oriented history of current and reinstated submission disqualifications without gaining moderation powers.',
  'User Moderation',
  array[
    'View current and reinstated submission disqualifications grouped by user and submission.',
    'View cycle, transition status, timestamps, broad reason category, and a safe thumbnail or destination when separately permitted.',
    'View the minimal current user identity needed to select and understand the affected profile.'
  ]::text[],
  array[
    'Disqualifying, reinstating, hiding, restoring, exporting, or otherwise changing submissions.',
    'Viewing delegated free-text notes, exact reason codes, actor identities, evidence, object keys, request data, or before/after snapshots.',
    'Viewing votes, refund details, identity history, ban history, flag history, or unrelated logs.',
    'Publishing disqualification history on public profiles or exposing it to another ordinary user.'
  ]::text[],
  'high',
  true,
  true,
  1,
  '0519db20cffc9d57d6feb8e54dca7633711cbebec26754ad986aac10685ce839'
);

create table public.submission_disqualification_events (
  id uuid primary key default gen_random_uuid(),
  submission_id bigint not null
    references public.submissions(id) on delete restrict,
  cycle_id bigint not null
    references public.voting_cycles(id) on delete restrict,
  subject_discord_user_id text not null,
  transition text not null
    check (transition in ('disqualified', 'reinstated')),
  occurred_at timestamptz not null,
  source text not null
    check (source in (
      'submission_open',
      'voting_open',
      'voting_closed',
      'discord_ban',
      'legacy_log',
      'current_state_backfill'
    )),
  provenance text not null
    check (provenance in ('complete', 'legacy_partial')),
  actor_discord_user_id text,
  actor_display_name text,
  reason_code text not null,
  reason_text text,
  moderation_log_id uuid unique
    references public.moderation_action_logs(id) on delete restrict,
  recorded_at timestamptz not null default transaction_timestamp(),
  constraint submission_disqualification_events_subject_check
    check (char_length(btrim(subject_discord_user_id)) between 1 and 100),
  constraint submission_disqualification_events_reason_check
    check (
      char_length(btrim(reason_code)) between 1 and 100
      and (reason_text is null or char_length(reason_text) <= 1000)
    )
);

alter table public.submission_disqualification_events owner to postgres;
alter table public.submission_disqualification_events enable row level security;

revoke all on table public.submission_disqualification_events
  from public, anon, authenticated, discord_bot, service_role;

create index submission_dq_events_subject_cursor_idx
  on public.submission_disqualification_events (
    subject_discord_user_id,
    occurred_at desc,
    id desc
  );

create index submission_dq_events_submission_timeline_idx
  on public.submission_disqualification_events (
    submission_id,
    occurred_at,
    id
  );

create function public.protect_submission_disqualification_events()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'SUBMISSION_DISQUALIFICATION_EVENTS_APPEND_ONLY';
end;
$function$;

alter function public.protect_submission_disqualification_events()
  owner to postgres;
revoke all on function public.protect_submission_disqualification_events()
  from public, anon, authenticated, discord_bot, service_role;

create trigger protect_submission_disqualification_events
before update or delete on public.submission_disqualification_events
for each row execute function public.protect_submission_disqualification_events();

create function public.capture_submission_disqualification_log_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_submission public.submissions%rowtype;
begin
  if new.target_type <> 'submission'
    or new.action not in ('disqualify_submission', 'reinstate_submission') then
    return new;
  end if;

  if new.target_id !~ '^[1-9][0-9]{0,17}$' then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_DISQUALIFICATION_EVENT_TARGET_INVALID';
  end if;

  select *
  into strict v_submission
  from public.submissions
  where id = new.target_id::bigint;

  insert into public.submission_disqualification_events (
    submission_id,
    cycle_id,
    subject_discord_user_id,
    transition,
    occurred_at,
    source,
    provenance,
    actor_discord_user_id,
    actor_display_name,
    reason_code,
    reason_text,
    moderation_log_id
  ) values (
    v_submission.id,
    v_submission.cycle_id,
    v_submission.discord_user_id,
    case new.action
      when 'disqualify_submission' then 'disqualified'
      else 'reinstated'
    end,
    new.created_at,
    case
      when new.moderation_phase in (
        'submission_open', 'voting_open', 'voting_closed'
      ) then new.moderation_phase
      else 'legacy_log'
    end,
    case
      when new.moderation_request_id is not null
        and jsonb_typeof(new.before_state) = 'object'
        and jsonb_typeof(new.after_state) = 'object'
      then 'complete'
      else 'legacy_partial'
    end,
    new.actor_id,
    new.actor_discord_username,
    coalesce(nullif(btrim(new.reason_code), ''), 'moderation_reason_unknown'),
    new.reason_text,
    new.id
  )
  on conflict (moderation_log_id) do nothing;

  return new;
exception
  when no_data_found then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_DISQUALIFICATION_EVENT_SUBMISSION_MISSING';
end;
$function$;

alter function public.capture_submission_disqualification_log_event()
  owner to postgres;
revoke all on function public.capture_submission_disqualification_log_event()
  from public, anon, authenticated, discord_bot, service_role;

create function public.capture_discord_ban_disqualification_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  insert into public.submission_disqualification_events (
    submission_id,
    cycle_id,
    subject_discord_user_id,
    transition,
    occurred_at,
    source,
    provenance,
    actor_discord_user_id,
    actor_display_name,
    reason_code,
    reason_text
  ) values (
    new.id,
    new.cycle_id,
    new.discord_user_id,
    'disqualified',
    coalesce(new.disqualified_at, transaction_timestamp()),
    'discord_ban',
    'complete',
    null,
    'Discord sync',
    coalesce(
      nullif(btrim(new.disqualification_reason_code), ''),
      'discord_ban'
    ),
    null
  );

  return new;
end;
$function$;

alter function public.capture_discord_ban_disqualification_event()
  owner to postgres;
revoke all on function public.capture_discord_ban_disqualification_event()
  from public, anon, authenticated, discord_bot, service_role;

insert into public.submission_disqualification_events (
  submission_id,
  cycle_id,
  subject_discord_user_id,
  transition,
  occurred_at,
  source,
  provenance,
  actor_discord_user_id,
  actor_display_name,
  reason_code,
  reason_text,
  moderation_log_id
)
select
  submission.id,
  submission.cycle_id,
  submission.discord_user_id,
  case log.action
    when 'disqualify_submission' then 'disqualified'
    else 'reinstated'
  end,
  log.created_at,
  case
    when log.moderation_phase in (
      'submission_open', 'voting_open', 'voting_closed'
    ) then log.moderation_phase
    else 'legacy_log'
  end,
  case
    when log.moderation_request_id is not null
      and jsonb_typeof(log.before_state) = 'object'
      and jsonb_typeof(log.after_state) = 'object'
    then 'complete'
    else 'legacy_partial'
  end,
  log.actor_id,
  log.actor_discord_username,
  coalesce(nullif(btrim(log.reason_code), ''), 'moderation_reason_unknown'),
  log.reason_text,
  log.id
from public.moderation_action_logs log
join public.submissions submission
  on log.target_type = 'submission'
 and log.target_id ~ '^[1-9][0-9]{0,17}$'
 and submission.id = log.target_id::bigint
where log.action in ('disqualify_submission', 'reinstate_submission')
order by log.created_at, log.id;

insert into public.submission_disqualification_events (
  submission_id,
  cycle_id,
  subject_discord_user_id,
  transition,
  occurred_at,
  source,
  provenance,
  actor_discord_user_id,
  actor_display_name,
  reason_code,
  reason_text
)
select
  submission.id,
  submission.cycle_id,
  submission.discord_user_id,
  'disqualified',
  coalesce(submission.disqualified_at, transaction_timestamp()),
  'current_state_backfill',
  'legacy_partial',
  submission.disqualified_by_discord_user_id,
  submission.disqualified_by_discord_username,
  coalesce(
    nullif(btrim(submission.disqualification_reason_code), ''),
    'moderation_reason_unknown'
  ),
  submission.disqualification_reason_text
from public.submissions submission
where coalesce(submission.is_disqualified, false)
  and (
    select event.transition
    from public.submission_disqualification_events event
    where event.submission_id = submission.id
    order by event.occurred_at desc, event.id desc
    limit 1
  ) is distinct from 'disqualified';

create trigger capture_submission_disqualification_log_event
after insert on public.moderation_action_logs
for each row execute function public.capture_submission_disqualification_log_event();

create trigger capture_discord_ban_disqualification_event
after update of is_disqualified on public.submissions
for each row
when (
  coalesce(old.is_disqualified, false) = false
  and new.is_disqualified = true
  and new.disqualification_type = 'discord_ban'
  and new.disqualified_by_discord_user_id is null
  and new.disqualified_by_discord_username = 'Discord sync'
)
execute function public.capture_discord_ban_disqualification_event();

create function public.get_user_disqualification_history(
  p_subject_discord_user_id text,
  p_after_at timestamptz default null,
  p_after_event_id uuid default null,
  p_limit integer default 25
)
returns table (
  submission_id bigint,
  cycle_id bigint,
  cycle_status text,
  subject_discord_user_id text,
  current_is_disqualified boolean,
  public_visibility_status text,
  r2_key text,
  latest_event_at timestamptz,
  latest_event_id uuid,
  event_count integer,
  events jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
begin
  if p_subject_discord_user_id is null
    or char_length(btrim(p_subject_discord_user_id)) not between 1 and 100
    or p_limit not between 1 and 50
    or ((p_after_at is null) <> (p_after_event_id is null)) then
    raise exception using
      errcode = '22023',
      message = 'USER_DQ_HISTORY_REQUEST_INVALID';
  end if;

  return query
  with grouped as (
    select
      event.submission_id,
      max(event.occurred_at) as latest_event_at,
      (array_agg(event.id order by event.occurred_at desc, event.id desc))[1]
        as latest_event_id,
      count(*)::integer as event_count,
      jsonb_agg(
        jsonb_build_object(
          'id', event.id,
          'transition', event.transition,
          'occurredAt', event.occurred_at,
          'source', event.source,
          'provenance', event.provenance,
          'actorDiscordUserId', event.actor_discord_user_id,
          'actorDisplayName', event.actor_display_name,
          'reasonCode', event.reason_code,
          'reasonText', event.reason_text
        )
        order by event.occurred_at, event.id
      ) as events
    from public.submission_disqualification_events event
    where event.subject_discord_user_id = btrim(p_subject_discord_user_id)
    group by event.submission_id
  ), page as (
    select grouped.*
    from grouped
    where p_after_at is null
      or (grouped.latest_event_at, grouped.latest_event_id)
        < (p_after_at, p_after_event_id)
    order by grouped.latest_event_at desc, grouped.latest_event_id desc
    limit p_limit
  )
  select
    submission.id,
    submission.cycle_id,
    cycle.status::text,
    submission.discord_user_id,
    coalesce(submission.is_disqualified, false),
    submission.public_visibility_status,
    submission.r2_key,
    page.latest_event_at,
    page.latest_event_id,
    page.event_count,
    page.events
  from page
  join public.submissions submission on submission.id = page.submission_id
  join public.voting_cycles cycle on cycle.id = submission.cycle_id
  order by page.latest_event_at desc, page.latest_event_id desc;
end;
$function$;

alter function public.get_user_disqualification_history(
  text, timestamptz, uuid, integer
) owner to postgres;
revoke all on function public.get_user_disqualification_history(
  text, timestamptz, uuid, integer
) from public, anon, authenticated, discord_bot;
grant execute on function public.get_user_disqualification_history(
  text, timestamptz, uuid, integer
) to service_role;

create function public.get_user_disqualification_profiles(
  p_after_at timestamptz default null,
  p_after_public_profile_id uuid default null,
  p_limit integer default 25
)
returns table (
  discord_user_id text,
  public_profile_id uuid,
  current_discord_username text,
  current_discord_handle text,
  current_display_name text,
  current_guild_nickname text,
  latest_event_at timestamptz,
  current_disqualified_count integer,
  submission_count integer,
  event_count integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
begin
  if p_limit not between 1 and 50
    or ((p_after_at is null) <>
      (p_after_public_profile_id is null)) then
    raise exception using
      errcode = '22023',
      message = 'USER_DQ_PROFILE_REQUEST_INVALID';
  end if;

  return query
  with grouped as (
    select
      event.subject_discord_user_id,
      max(event.occurred_at) as latest_event_at,
      count(distinct event.submission_id)::integer as submission_count,
      count(*)::integer as event_count
    from public.submission_disqualification_events event
    group by event.subject_discord_user_id
  ), current_counts as (
    select
      submission.discord_user_id,
      count(*)::integer as current_disqualified_count
    from public.submissions submission
    where coalesce(submission.is_disqualified, false)
    group by submission.discord_user_id
  )
  select
    grouped.subject_discord_user_id,
    user_log.public_profile_id,
    user_log.current_discord_username,
    user_log.current_discord_handle,
    user_log.current_display_name,
    user_log.current_guild_nickname,
    grouped.latest_event_at,
    coalesce(current_counts.current_disqualified_count, 0),
    grouped.submission_count,
    grouped.event_count
  from grouped
  join public.user_logs user_log
    on user_log.discord_user_id = grouped.subject_discord_user_id
  left join current_counts
    on current_counts.discord_user_id = grouped.subject_discord_user_id
  where user_log.public_profile_id is not null
    and (
      p_after_at is null
      or (grouped.latest_event_at, user_log.public_profile_id)
        < (p_after_at, p_after_public_profile_id)
    )
  order by grouped.latest_event_at desc, user_log.public_profile_id desc
  limit p_limit;
end;
$function$;

alter function public.get_user_disqualification_profiles(
  timestamptz, uuid, integer
) owner to postgres;
revoke all on function public.get_user_disqualification_profiles(
  timestamptz, uuid, integer
) from public, anon, authenticated, discord_bot;
grant execute on function public.get_user_disqualification_profiles(
  timestamptz, uuid, integer
) to service_role;

comment on table public.submission_disqualification_events is
  'Server-only append-only per-Submission disqualification and reinstatement history. Public profile visibility is a separate projection and never deletes audit.';
comment on column public.submission_disqualification_events.provenance is
  'complete for atomically captured events; legacy_partial when older state cannot be reconstructed without inference.';
comment on function public.get_user_disqualification_history(
  text, timestamptz, uuid, integer
) is
  'Service-only cursor-paginated raw source for self, Owner, and capability-redacted user DQ history projections.';

do $postflight$
begin
  if (select count(*) from public.capability_catalog) <> 31
    or (select count(*) from public.capability_catalog where is_active) <> 29
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 29
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'users.disqualified_submissions.view'
        and is_active
        and assignable_to_non_admin
        and implementation_version = 1
        and definition_hash =
          '0519db20cffc9d57d6feb8e54dca7633711cbebec26754ad986aac10685ce839'
    )
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key = 'users.disqualified_submissions.view'
    ) then
    raise exception using
      errcode = '55000',
      message = 'USER_DQ_HISTORY_CAPABILITY_FINAL_STATE_MISMATCH';
  end if;

  if not coalesce((
      select relation.relrowsecurity
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = 'submission_disqualification_events'
    ), false)
    or has_table_privilege(
      'anon', 'public.submission_disqualification_events', 'select'
    )
    or has_table_privilege(
      'authenticated', 'public.submission_disqualification_events', 'select'
    )
    or has_table_privilege(
      'service_role', 'public.submission_disqualification_events', 'select'
    )
    or (
      select count(*)
      from pg_trigger
      where tgrelid = 'public.submission_disqualification_events'::regclass
        and not tgisinternal
        and tgenabled <> 'D'
    ) <> 1
    or (
      select count(*)
      from pg_trigger
      where tgrelid in (
        'public.moderation_action_logs'::regclass,
        'public.submissions'::regclass
      )
        and tgname in (
          'capture_submission_disqualification_log_event',
          'capture_discord_ban_disqualification_event'
        )
        and not tgisinternal
        and tgenabled <> 'D'
    ) <> 2 then
    raise exception using
      errcode = '55000',
      message = 'USER_DQ_HISTORY_AUDIT_FINAL_STATE_MISMATCH';
  end if;

  if not has_function_privilege(
      'service_role',
      'public.get_user_disqualification_history(text,timestamp with time zone,uuid,integer)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.get_user_disqualification_profiles(timestamp with time zone,uuid,integer)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.get_user_disqualification_history(text,timestamp with time zone,uuid,integer)',
      'execute'
    )
    or has_function_privilege(
      'anon',
      'public.get_user_disqualification_profiles(timestamp with time zone,uuid,integer)',
      'execute'
    ) then
    raise exception using
      errcode = '55000',
      message = 'USER_DQ_HISTORY_READ_ACL_FINAL_STATE_MISMATCH';
  end if;
end;
$postflight$;

commit;

\set ON_ERROR_STOP on

begin;

set local lock_timeout = '10s';
set local statement_timeout = '90s';

create temp table warning_expiry_scheduler_fixture (
  actor_discord_user_id text not null,
  target_discord_user_id text primary key,
  public_comment_ids uuid[] not null,
  object_versions bigint[] not null,
  text_versions bigint[] not null,
  warning_ids uuid[] not null,
  auto_flag_case_id uuid not null,
  website_ban_version bigint not null,
  is_banned boolean not null,
  participation_held boolean not null,
  manual_flag_case_count bigint not null,
  website_ban_event_count bigint not null
) on commit drop;

-- Keep legitimate overdue DEV rows outside this rollback-only fixture so the
-- bounded processor can observe exactly one synthetic due target.
update public.user_warning_current
set expires_at = clock_timestamp() + interval '100 years'
where state = 'active'
  and expires_at <= clock_timestamp();

do $fixture$
declare
  v_actor text;
  v_target text;
  v_public_ids uuid[];
  v_object_versions bigint[];
  v_text_versions bigint[];
  v_warning_ids uuid[] := array[]::uuid[];
  v_result jsonb;
  v_warning_id uuid;
  v_case_id uuid;
  v_index integer;
begin
  if to_regprocedure(
    'public.process_due_user_warning_expiries(integer)'
  ) is null then
    raise exception 'DEV_WARNING_EXPIRY_PROCESSOR_UNAVAILABLE';
  end if;

  select member.discord_user_id
  into v_actor
  from public.team_members member
  where member.role = 'admin'
  order by member.discord_user_id
  limit 1;

  select candidate.author_discord_user_id
  into v_target
  from (
    select comment_row.author_discord_user_id, count(*) as comment_count
    from public.community_comments comment_row
    join public.community_comment_text_versions text_version
      on text_version.comment_id = comment_row.id
     and text_version.version = comment_row.current_text_version
    left join public.user_warnings warning_row
      on warning_row.source_comment_id = comment_row.id
    where comment_row.author_deleted_at is null
      and text_version.normalized_body is not null
      and warning_row.warning_id is null
      and public.is_community_comment_submission_eligible(
        comment_row.submission_id
      )
      and not exists (
        select 1
        from public.user_warnings existing_warning
        where existing_warning.target_discord_user_id =
          comment_row.author_discord_user_id
      )
    group by comment_row.author_discord_user_id
    having count(*) >= 5
    order by count(*) desc, comment_row.author_discord_user_id
    limit 1
  ) candidate;

  select
    array_agg(source.public_comment_id order by source.created_at, source.public_comment_id),
    array_agg(source.object_version order by source.created_at, source.public_comment_id),
    array_agg(source.current_text_version order by source.created_at, source.public_comment_id)
  into v_public_ids, v_object_versions, v_text_versions
  from (
    select
      comment_row.public_comment_id,
      comment_row.object_version,
      comment_row.current_text_version,
      comment_row.created_at
    from public.community_comments comment_row
    join public.community_comment_text_versions text_version
      on text_version.comment_id = comment_row.id
     and text_version.version = comment_row.current_text_version
    left join public.user_warnings warning_row
      on warning_row.source_comment_id = comment_row.id
    where comment_row.author_discord_user_id = v_target
      and comment_row.author_deleted_at is null
      and text_version.normalized_body is not null
      and warning_row.warning_id is null
      and public.is_community_comment_submission_eligible(
        comment_row.submission_id
      )
    order by comment_row.created_at, comment_row.public_comment_id
    limit 5
  ) source;

  if v_actor is null or v_target is null or cardinality(v_public_ids) <> 5 then
    raise exception 'DEV_WARNING_EXPIRY_FIXTURE_UNAVAILABLE';
  end if;

  for v_index in 1..4 loop
    v_result := public.issue_user_warning(
      v_actor,
      v_public_ids[v_index],
      v_object_versions[v_index],
      v_text_versions[v_index],
      'other',
      'Rollback-only Warning expiry scheduler fixture.',
      gen_random_uuid()
    );
    select warning_row.warning_id
    into v_warning_id
    from public.user_warnings warning_row
    where warning_row.public_warning_id = (v_result ->> 'warningId')::uuid;
    v_warning_ids := array_append(v_warning_ids, v_warning_id);
  end loop;

  select flag_case.case_id
  into v_case_id
  from public.user_warning_auto_flag_cases flag_case
  where flag_case.target_discord_user_id = v_target
    and flag_case.status = 'open';

  if v_case_id is null then
    raise exception 'DEV_WARNING_EXPIRY_AUTO_FLAG_DID_NOT_OPEN';
  end if;

  insert into warning_expiry_scheduler_fixture (
    actor_discord_user_id,
    target_discord_user_id,
    public_comment_ids,
    object_versions,
    text_versions,
    warning_ids,
    auto_flag_case_id,
    website_ban_version,
    is_banned,
    participation_held,
    manual_flag_case_count,
    website_ban_event_count
  )
  select
    v_actor,
    v_target,
    v_public_ids,
    v_object_versions,
    v_text_versions,
    v_warning_ids,
    v_case_id,
    user_log.website_ban_version,
    user_log.is_banned,
    (public.get_user_participation_hold(v_target) ->> 'held')::boolean,
    (
      select count(*)
      from public.user_flag_cases manual_case
      where manual_case.discord_user_id = v_target
    ),
    (
      select count(*)
      from public.website_ban_events ban_event
      where ban_event.target_discord_user_id = v_target
    )
  from public.user_logs user_log
  where user_log.discord_user_id = v_target;
end;
$fixture$;

-- Backdate only the rollback-only immutable fixtures. The append-only trigger
-- is restored before invoking the canonical processor.
alter table public.user_warnings disable trigger protect_user_warnings;

update public.user_warnings warning_row
set
  issued_at = warning_row.issued_at - interval '30 days',
  original_expires_at =
    warning_row.issued_at - interval '30 days'
    + make_interval(days => warning_row.original_tier_days),
  original_recurrence_until =
    warning_row.issued_at - interval '30 days'
    + make_interval(
      days => case warning_row.original_tier_days
        when 1 then 3
        else warning_row.original_tier_days
      end
    )
where warning_row.warning_id = any (
  select unnest(fixture.warning_ids)
  from warning_expiry_scheduler_fixture fixture
);

alter table public.user_warnings enable trigger protect_user_warnings;

update public.user_warning_current current_row
set
  recurrence_until = current_row.recurrence_until - interval '30 days',
  expires_at = current_row.expires_at - interval '30 days',
  recalculated_at = current_row.recalculated_at - interval '30 days'
where current_row.warning_id = any (
  select unnest(fixture.warning_ids)
  from warning_expiry_scheduler_fixture fixture
);

do $contract$
declare
  v_fixture warning_expiry_scheduler_fixture%rowtype;
  v_first jsonb;
  v_repeat jsonb;
  v_non_due jsonb;
begin
  select * into strict v_fixture from warning_expiry_scheduler_fixture;

  v_first := public.process_due_user_warning_expiries(1);
  if v_first <> jsonb_build_object(
    'processedTargets', 1,
    'expiredWarnings', 4
  ) then
    raise exception 'DEV_WARNING_EXPIRY_RESULT_INVALID';
  end if;

  if (
    select count(*)
    from public.user_warning_current current_row
    where current_row.warning_id = any(v_fixture.warning_ids)
      and current_row.state = 'expired'
  ) <> 4
    or (
      select count(*)
      from public.user_warning_events event_row
      where event_row.warning_id = any(v_fixture.warning_ids)
        and event_row.event_type = 'expired'
    ) <> 4
    or not exists (
      select 1
      from public.user_warning_auto_flag_cases flag_case
      where flag_case.case_id = v_fixture.auto_flag_case_id
        and flag_case.status = 'closed'
    )
    or (
      select count(*)
      from public.user_warning_auto_flag_events flag_event
      where flag_event.case_id = v_fixture.auto_flag_case_id
        and flag_event.event_type = 'closed'
    ) <> 1
  then
    raise exception 'DEV_WARNING_EXPIRY_STATE_INVALID';
  end if;

  v_repeat := public.process_due_user_warning_expiries(1);
  if v_repeat <> jsonb_build_object(
    'processedTargets', 0,
    'expiredWarnings', 0
  ) or (
    select count(*)
    from public.user_warning_events event_row
    where event_row.warning_id = any(v_fixture.warning_ids)
      and event_row.event_type = 'expired'
  ) <> 4 then
    raise exception 'DEV_WARNING_EXPIRY_REPEAT_NOT_IDEMPOTENT';
  end if;

  v_non_due := public.issue_user_warning(
    v_fixture.actor_discord_user_id,
    v_fixture.public_comment_ids[5],
    v_fixture.object_versions[5],
    v_fixture.text_versions[5],
    'other',
    'Rollback-only non-due Warning fixture.',
    gen_random_uuid()
  );

  if public.process_due_user_warning_expiries(1) <> jsonb_build_object(
    'processedTargets', 0,
    'expiredWarnings', 0
  ) or not exists (
    select 1
    from public.user_warnings warning_row
    join public.user_warning_current current_row
      on current_row.warning_id = warning_row.warning_id
    where warning_row.public_warning_id = (v_non_due ->> 'warningId')::uuid
      and current_row.state = 'active'
      and current_row.expires_at > clock_timestamp()
  ) then
    raise exception 'DEV_WARNING_EXPIRY_NON_DUE_CHANGED';
  end if;

  if exists (
    select 1
    from public.user_logs user_log
    where user_log.discord_user_id = v_fixture.target_discord_user_id
      and (
        user_log.website_ban_version <> v_fixture.website_ban_version
        or user_log.is_banned <> v_fixture.is_banned
      )
  ) or (
    public.get_user_participation_hold(v_fixture.target_discord_user_id)
      ->> 'held'
  )::boolean <> v_fixture.participation_held
    or (
      select count(*)
      from public.user_flag_cases manual_case
      where manual_case.discord_user_id = v_fixture.target_discord_user_id
    ) <> v_fixture.manual_flag_case_count
    or (
      select count(*)
      from public.website_ban_events ban_event
      where ban_event.target_discord_user_id = v_fixture.target_discord_user_id
    ) <> v_fixture.website_ban_event_count
  then
    raise exception 'DEV_WARNING_EXPIRY_SANCTION_SIDE_EFFECT';
  end if;
end;
$contract$;

rollback;

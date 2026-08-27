do $migration_preflight$
begin
  if to_regclass('public.community_comment_moderation_events') is null
    or to_regclass('public.community_comment_text_versions') is null
    or to_regclass('public.community_comments') is null
    or to_regclass('public.capability_catalog') is null
    or to_regclass('public.team_role_capabilities') is null
  then
    raise exception using
      errcode = '55000', message = 'COMMENT_MODERATION_EXPLORER_FOUNDATION_MISSING';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'community_comment_moderation_events'
      and column_name = 'reviewed_text_version'
  ) or exists (
    select 1 from public.capability_catalog
    where key = 'logs.community_comment_moderation.details.view'
  ) or to_regprocedure(
    'public.get_community_comment_moderation_explorer(text,uuid,bigint,timestamp with time zone,bigint,integer,boolean)'
  ) is not null then
    raise exception using
      errcode = '55000', message = 'COMMENT_MODERATION_EXPLORER_ALREADY_PRESENT';
  end if;

  if not exists (
    select 1 from public.capability_catalog capability
    where capability.key = 'logs.community_comment_moderation.view'
      and capability.is_active
      and capability.assignable_to_non_admin
      and capability.implementation_version = 1
      and capability.definition_hash =
        '6db2fa540e00d5146aebbfe021eec0a26dea7bf1078f59a5dda74ad8a5813ea3'
  ) then
    raise exception using
      errcode = '55000', message = 'COMMENT_MODERATION_LOG_CAPABILITY_DRIFT';
  end if;
end;
$migration_preflight$;

alter table public.community_comment_moderation_events
  add column reviewed_text_version bigint;

alter table public.community_comment_moderation_events
  add constraint community_comment_moderation_events_reviewed_text_version_fkey
  foreign key (comment_id, reviewed_text_version)
  references public.community_comment_text_versions(comment_id, version)
  on delete restrict;

create index community_comment_moderation_events_comment_timeline_idx
  on public.community_comment_moderation_events(
    public_comment_id, created_at desc, id desc
  );

create index community_comment_moderation_events_submission_timeline_idx
  on public.community_comment_moderation_events(
    submission_id, created_at desc, id desc
  );

update public.capability_catalog
set display_name = 'View Comment Moderation History',
    description =
      'View bounded, searchable, grouped, redacted append-only Comment moderation history without gaining sensitive detail or mutation authority.',
    included_actions = array[
      'Search by exact public Comment ID or positive public Submission ID and review Comment-grouped chronological Remove and Restore timelines.',
      'View current Comment status, immutable moderation and object-version transitions, database time, redacted actor snapshots, and capability-checked source Case links.'
    ]::text[],
    excluded_actions = array[
      'Removing or restoring Comments, claiming or solving Cases, or viewing Report and Spam Case details without their exact rights.',
      'Viewing protected prior Comment text, internal reasons, reporter identities, raw Spam signals, private heuristics, or unrelated moderation data.',
      'Exporting unbounded logs or exposing internal IDs, Discord IDs, secrets, IP, device, or security data.',
      'Managing retention, roles, grants, Team membership, Owner access, or unrelated logs.'
    ]::text[],
    risk_level = 'high',
    implementation_version = 2,
    definition_hash =
      '3c8b544642d1c583134b5cbe30b9ea31bbff3af7a7105568c42de79b052a7210'
where key = 'logs.community_comment_moderation.view';

insert into public.capability_catalog (
  key, display_name, description, category, included_actions,
  excluded_actions, risk_level, is_active, assignable_to_non_admin,
  implementation_version, definition_hash
)
values (
  'logs.community_comment_moderation.details.view',
  'View Sensitive Comment Moderation Evidence',
  'View the exact immutable Comment text version and internal reason bound to an authorized moderation event, always together with the base Comment moderation history right.',
  'Logs',
  array[
    'View the exact immutable Comment text version reviewed for newly bound Remove and Restore events.',
    'View the bounded internal moderation reason and explicit legacy-unproven evidence state inside the protected Comment-centred timeline.'
  ]::text[],
  array[
    'Viewing Comment moderation history without logs.community_comment_moderation.view.',
    'Viewing reporter identities, raw Spam signals, private heuristics, actor Discord IDs, or unrelated Comment and Case data.',
    'Removing or restoring Comments, claiming or solving Cases, changing retention, or deleting or rewriting append-only history.',
    'Exporting unbounded evidence or managing roles, grants, Team membership, or Owner access.'
  ]::text[],
  'critical', true, true, 1,
  '7f6857f2a246e4cc55029277441f25382630158b71758237d40366f0cc8b7452'
);

create or replace function public.assert_community_comment_capabilities(
  p_actor_discord_user_id text,
  p_capabilities text[]
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_role text;
  v_capability text;
  v_expected_version integer;
  v_expected_hash text;
begin
  if v_actor_id !~ '^[0-9]{1,100}$'
    or p_capabilities is null
    or cardinality(p_capabilities) not between 1 and 3
    or exists (select 1 from unnest(p_capabilities) item where item is null)
  then
    raise exception using errcode = '42501', message = 'COMMENT_REVIEW_FORBIDDEN';
  end if;

  select member.role into v_role
  from public.team_members member
  join public.team_roles role on role.key = member.role and role.is_active
  where member.discord_user_id = v_actor_id;
  if not found then
    raise exception using errcode = '42501', message = 'COMMENT_REVIEW_FORBIDDEN';
  end if;

  foreach v_capability in array p_capabilities loop
    select expected.implementation_version, expected.definition_hash
    into v_expected_version, v_expected_hash
    from (values
      ('community.comment_reports.view', 2,
        '31e7f8d6bb49d148c717991d39b8cfbb7cde4e7757026839854b0fdad89a4775'),
      ('community.comment_reports.review', 1,
        'b201f956e4cc586b0a445455935224c3cefd5d5c950260e6899c451191e19da9'),
      ('community.comments.moderate', 1,
        '68c743df9ccd4dba9cf6f511a0d7b737e1d7ba84450425722846912784c17e9f'),
      ('community.comment_spam.view', 1,
        '389916756fe7326a7ba51977168f22d0f4a079b77b25deed29bdeeb1e05d42da'),
      ('community.comment_spam.review', 1,
        'eb211f298b166f8896c55f669cb721c790f3b27c3eb87d60799b7af741c14b76'),
      ('logs.community_comment_moderation.view', 2,
        '3c8b544642d1c583134b5cbe30b9ea31bbff3af7a7105568c42de79b052a7210'),
      ('logs.community_comment_moderation.details.view', 1,
        '7f6857f2a246e4cc55029277441f25382630158b71758237d40366f0cc8b7452')
    ) expected(capability_key, implementation_version, definition_hash)
    where expected.capability_key = v_capability;

    if v_expected_version is null or not exists (
      select 1 from public.capability_catalog capability
      where capability.key = v_capability
        and capability.is_active
        and capability.assignable_to_non_admin
        and capability.implementation_version = v_expected_version
        and capability.definition_hash = v_expected_hash
    ) then
      raise exception using errcode = '55000', message = 'COMMENT_REVIEW_CAPABILITY_UNAVAILABLE';
    end if;
    if v_role <> 'admin' and not exists (
      select 1 from public.team_role_capabilities grant_row
      where grant_row.role_key = v_role and grant_row.capability_key = v_capability
    ) then
      raise exception using errcode = '42501', message = 'COMMENT_REVIEW_FORBIDDEN';
    end if;
  end loop;
  return v_role;
end;
$function$;

create or replace function public.apply_community_comment_moderation(
  p_actor_discord_user_id text,
  p_public_comment_id uuid,
  p_action text,
  p_expected_object_version bigint,
  p_expected_moderation_version bigint,
  p_internal_reason text,
  p_source_topic text,
  p_source_case_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_comment public.community_comments%rowtype;
  v_role text;
  v_actor_display text;
  v_from_version bigint;
  v_reviewed_text_version bigint;
begin
  if p_action not in ('remove', 'restore') or p_public_comment_id is null
    or p_request_id is null
    or char_length(btrim(p_internal_reason)) not between 3 and 1000
    or (p_source_topic is null) <> (p_source_case_id is null)
    or (p_source_topic is not null and p_source_topic not in ('comment_reports', 'comment_spam'))
  then
    raise exception using errcode = '22023', message = 'COMMUNITY_COMMENT_MODERATION_INPUT_INVALID';
  end if;
  v_role := public.assert_community_comment_capabilities(
    p_actor_discord_user_id, array['community.comments.moderate']::text[]
  );
  select * into v_comment from public.community_comments
  where public_comment_id = p_public_comment_id for update;
  if not found or v_comment.author_deleted_at is not null
    or not public.is_community_comment_submission_eligible(v_comment.submission_id)
  then
    return jsonb_build_object('outcome', 'comment_unavailable');
  end if;
  if v_comment.object_version <> p_expected_object_version
    or v_comment.team_moderation_version <> p_expected_moderation_version
  then
    return jsonb_build_object(
      'outcome', 'stale', 'objectVersion', v_comment.object_version,
      'moderationVersion', v_comment.team_moderation_version,
      'removed', v_comment.team_removed_at is not null
    );
  end if;
  if (p_action = 'remove' and v_comment.team_removed_at is not null)
    or (p_action = 'restore' and v_comment.team_removed_at is null)
  then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  select coalesce(
    nullif(btrim(actor_row.current_discord_username), ''),
    nullif(btrim(actor_row.current_display_name), ''), 'Team member'
  ) into v_actor_display
  from public.user_logs actor_row
  where actor_row.discord_user_id = p_actor_discord_user_id;

  v_from_version := v_comment.object_version;
  v_reviewed_text_version := v_comment.current_text_version;
  update public.community_comments
  set team_removed_at = case when p_action = 'remove'
        then transaction_timestamp() else null end,
      team_moderation_version = team_moderation_version + 1,
      object_version = object_version + 1
  where id = v_comment.id returning * into v_comment;
  update public.community_comment_threads
  set version = version + 1, updated_at = transaction_timestamp()
  where id = v_comment.thread_id;
  insert into public.community_comment_moderation_events(
    comment_id, public_comment_id, submission_id, action,
    from_object_version, to_object_version, moderation_version,
    actor_discord_user_id, actor_display_snapshot, actor_role_snapshot,
    internal_reason, source_topic, source_case_id, request_id,
    reviewed_text_version
  ) values (
    v_comment.id, v_comment.public_comment_id, v_comment.submission_id, p_action,
    v_from_version, v_comment.object_version, v_comment.team_moderation_version,
    p_actor_discord_user_id, v_actor_display, v_role,
    btrim(p_internal_reason), p_source_topic, p_source_case_id, p_request_id,
    v_reviewed_text_version
  );
  return jsonb_build_object(
    'outcome', case when p_action = 'remove' then 'removed' else 'restored' end,
    'publicCommentId', v_comment.public_comment_id,
    'objectVersion', v_comment.object_version,
    'moderationVersion', v_comment.team_moderation_version,
    'comment', public.build_community_comment_public_json(v_comment.id)
  );
end;
$function$;

create function public.get_community_comment_moderation_explorer(
  p_actor_discord_user_id text,
  p_public_comment_id uuid default null,
  p_submission_id bigint default null,
  p_before_created_at timestamptz default null,
  p_before_id bigint default null,
  p_limit integer default 50,
  p_include_sensitive boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_can_view_report_case boolean := false;
  v_can_view_spam_case boolean := false;
  v_items jsonb;
begin
  if p_limit not between 1 and 50
    or (p_submission_id is not null and p_submission_id <= 0)
    or ((p_before_created_at is null) <> (p_before_id is null))
    or p_include_sensitive is null
  then
    raise exception using errcode = '22023', message = 'COMMENT_MODERATION_EXPLORER_INPUT_INVALID';
  end if;

  if p_include_sensitive then
    v_role := public.assert_community_comment_capabilities(
      p_actor_discord_user_id,
      array[
        'logs.community_comment_moderation.view',
        'logs.community_comment_moderation.details.view'
      ]::text[]
    );
  else
    v_role := public.assert_community_comment_capabilities(
      p_actor_discord_user_id,
      array['logs.community_comment_moderation.view']::text[]
    );
  end if;

  v_can_view_report_case := v_role = 'admin' or exists (
    select 1
    from public.team_role_capabilities grant_row
    join public.capability_catalog capability
      on capability.key = grant_row.capability_key
    where grant_row.role_key = v_role
      and grant_row.capability_key = 'community.comment_reports.view'
      and capability.is_active
      and capability.implementation_version = 2
      and capability.definition_hash =
        '31e7f8d6bb49d148c717991d39b8cfbb7cde4e7757026839854b0fdad89a4775'
  );
  v_can_view_spam_case := v_role = 'admin' or exists (
    select 1
    from public.team_role_capabilities grant_row
    join public.capability_catalog capability
      on capability.key = grant_row.capability_key
    where grant_row.role_key = v_role
      and grant_row.capability_key = 'community.comment_spam.view'
      and capability.is_active
      and capability.implementation_version = 1
      and capability.definition_hash =
        '389916756fe7326a7ba51977168f22d0f4a079b77b25deed29bdeeb1e05d42da'
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', item.id,
    'publicCommentId', item.public_comment_id,
    'submissionId', item.submission_id,
    'action', item.action,
    'fromObjectVersion', item.from_object_version,
    'toObjectVersion', item.to_object_version,
    'moderationVersion', item.moderation_version,
    'actorDisplayName', item.actor_display_snapshot,
    'actorRole', item.actor_role_snapshot,
    'sourceTopic', item.source_topic,
    'sourceCaseId', case
      when item.source_topic = 'comment_reports' and v_can_view_report_case
        then item.source_case_id
      when item.source_topic = 'comment_spam' and v_can_view_spam_case
        then item.source_case_id
      else null
    end,
    'sourceCaseLinkAvailable', case
      when item.source_topic = 'comment_reports'
        then item.source_case_id is not null and v_can_view_report_case
      when item.source_topic = 'comment_spam'
        then item.source_case_id is not null and v_can_view_spam_case
      else false
    end,
    'createdAt', item.created_at,
    'currentStatus', case
      when item.author_deleted_at is not null then 'author_deleted'
      when item.team_removed_at is not null then 'team_removed'
      else 'visible'
    end,
    'currentObjectVersion', item.current_object_version,
    'currentModerationVersion', item.current_moderation_version,
    'currentTextVersion', item.current_text_version,
    'reviewedTextVersionState', case
      when item.reviewed_text_version is null then 'legacy_unproven'
      else 'bound'
    end,
    'reviewedTextVersion', item.reviewed_text_version,
    'reviewedText', case when p_include_sensitive then item.reviewed_text else null end,
    'internalReason', case when p_include_sensitive then item.internal_reason else null end
  ) order by item.created_at desc, item.id desc), '[]'::jsonb)
  into v_items
  from (
    select
      event.id,
      event.public_comment_id,
      event.submission_id,
      event.action,
      event.from_object_version,
      event.to_object_version,
      event.moderation_version,
      event.actor_display_snapshot,
      event.actor_role_snapshot,
      event.internal_reason,
      event.source_topic,
      event.source_case_id,
      event.created_at,
      event.reviewed_text_version,
      comment_row.object_version as current_object_version,
      comment_row.team_moderation_version as current_moderation_version,
      comment_row.current_text_version,
      comment_row.team_removed_at,
      comment_row.author_deleted_at,
      text_version.normalized_body as reviewed_text
    from public.community_comment_moderation_events event
    join public.community_comments comment_row on comment_row.id = event.comment_id
    left join public.community_comment_text_versions text_version
      on text_version.comment_id = event.comment_id
     and text_version.version = event.reviewed_text_version
    where (p_public_comment_id is null or event.public_comment_id = p_public_comment_id)
      and (p_submission_id is null or event.submission_id = p_submission_id)
      and (
        p_before_created_at is null
        or (event.created_at, event.id) < (p_before_created_at, p_before_id)
      )
    order by event.created_at desc, event.id desc
    limit p_limit
  ) item;

  return jsonb_build_object(
    'items', v_items,
    'sensitiveDetailsIncluded', p_include_sensitive
  );
end;
$function$;

alter function public.assert_community_comment_capabilities(text,text[]) owner to postgres;
alter function public.apply_community_comment_moderation(text,uuid,text,bigint,bigint,text,text,uuid,uuid) owner to postgres;
alter function public.get_community_comment_moderation_explorer(text,uuid,bigint,timestamptz,bigint,integer,boolean) owner to postgres;

revoke all on function public.assert_community_comment_capabilities(text,text[])
  from public, anon, authenticated, service_role, discord_bot;
revoke all on function public.apply_community_comment_moderation(text,uuid,text,bigint,bigint,text,text,uuid,uuid)
  from public, anon, authenticated, service_role, discord_bot;
revoke all on function public.get_community_comment_moderation_explorer(text,uuid,bigint,timestamptz,bigint,integer,boolean)
  from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.get_community_comment_moderation_explorer(text,uuid,bigint,timestamptz,bigint,integer,boolean)
  to service_role;

comment on column public.community_comment_moderation_events.reviewed_text_version is
  'Exact immutable Comment text version reviewed by new moderation events; NULL means legacy evidence cannot be proven and must not be inferred.';
comment on function public.get_community_comment_moderation_explorer(text,uuid,bigint,timestamptz,bigint,integer,boolean) is
  'Returns bounded Comment-centred moderation history; sensitive evidence and source Case links are projected only under their exact capabilities.';

do $migration_postflight$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'community_comment_moderation_events'
      and column_name = 'reviewed_text_version'
      and data_type = 'bigint'
      and is_nullable = 'YES'
  ) or not exists (
    select 1 from public.capability_catalog capability
    where capability.key = 'logs.community_comment_moderation.view'
      and capability.implementation_version = 2
      and capability.definition_hash =
        '3c8b544642d1c583134b5cbe30b9ea31bbff3af7a7105568c42de79b052a7210'
  ) or not exists (
    select 1 from public.capability_catalog capability
    where capability.key = 'logs.community_comment_moderation.details.view'
      and capability.is_active
      and capability.assignable_to_non_admin
      and capability.implementation_version = 1
      and capability.definition_hash =
        '7f6857f2a246e4cc55029277441f25382630158b71758237d40366f0cc8b7452'
  ) or exists (
    select 1 from public.team_role_capabilities grant_row
    where grant_row.capability_key = 'logs.community_comment_moderation.details.view'
  ) or to_regprocedure(
    'public.get_community_comment_moderation_explorer(text,uuid,bigint,timestamp with time zone,bigint,integer,boolean)'
  ) is null then
    raise exception using
      errcode = '55000', message = 'COMMENT_MODERATION_EXPLORER_POSTFLIGHT_FAILED';
  end if;
end;
$migration_postflight$;

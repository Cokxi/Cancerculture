begin;

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 20
    or (select count(*) from public.capability_catalog where is_active) <> 18
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 18
    or exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'TEAM_AUTHORIZATION_LOG_CAPABILITY_BASELINE_MISMATCH';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = 'logs.submission_moderation.view'
      and implementation_version = 1
      and definition_hash = 'fc820ff4bea36171834588856c8f1ca09f0b0391d0b04ff6c0521fffa85d88e7'
      and is_active
      and assignable_to_non_admin
  ) then
    raise exception using
      errcode = '55000',
      message = 'TEAM_AUTHORIZATION_LOG_CAPABILITY_PREVIOUS_CUTOVER_MISMATCH';
  end if;

  if exists (
    select 1
    from public.capability_catalog
    where key = 'logs.team_authorization.view'
  ) then
    raise exception using
      errcode = '55000',
      message = 'TEAM_AUTHORIZATION_LOG_CAPABILITY_ALREADY_PRESENT';
  end if;

  if to_regclass('public.team_authorization_audit') is null
    or (
      select count(*)
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'team_authorization_audit'
        and column_name = any (array[
          'id',
          'occurred_at',
          'actor_discord_user_id',
          'actor_role_key',
          'event_type',
          'target_role_key',
          'target_discord_user_id',
          'capability_key',
          'before_state',
          'after_state',
          'reason',
          'request_id'
        ]::text[])
    ) <> 12
    or not coalesce((
      select c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'team_authorization_audit'
    ), false)
    or has_table_privilege('anon', 'public.team_authorization_audit', 'select')
    or has_table_privilege('authenticated', 'public.team_authorization_audit', 'select')
    or not exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.team_authorization_audit'::regclass
        and tgname = 'protect_team_authorization_audit'
        and tgenabled <> 'D'
        and not tgisinternal
    ) then
    raise exception using
      errcode = '55000',
      message = 'TEAM_AUTHORIZATION_LOG_AUDIT_CONTRACT_MISMATCH';
  end if;

  if to_regclass(
    'public.team_authorization_audit_event_occurred_idx'
  ) is not null then
    raise exception using
      errcode = '55000',
      message = 'TEAM_AUTHORIZATION_LOG_INDEX_ALREADY_PRESENT';
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
  'logs.team_authorization.view',
  'View Team Authorization History',
  'View separately paginated team-membership and Roles & Permissions authorization events through a safe read-only projection.',
  'Logs',
  array[
    'View team enrollment, removal, role-assignment, and Owner-access changes with actor, target, timestamp, role-transition, and reason context.',
    'View role lifecycle and capability grant or revocation events with actor, affected role, capability, timestamp, and reason context.'
  ]::text[],
  array[
    'Viewing raw before/after objects, request or idempotency data, row versions, batch identifiers, or other internal enforcement details.',
    'Adding or removing team members, changing team or Owner assignments, or managing role definitions and lifecycle.',
    'Viewing or changing the Roles & Permissions matrix, granting or revoking capabilities, or viewing unrelated logs.'
  ]::text[],
  'high',
  true,
  true,
  1,
  '69faf8e792eb9ee98366d3be382d6020ba46994b514c07c3ab2e970c716be1ba'
);

create index team_authorization_audit_event_occurred_idx
  on public.team_authorization_audit (
    event_type,
    occurred_at desc,
    id desc
  );

do $postflight$
begin
  if (select count(*) from public.capability_catalog) <> 21
    or (select count(*) from public.capability_catalog where is_active) <> 19
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 19
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'logs.team_authorization.view'
        and implementation_version = 1
        and definition_hash = '69faf8e792eb9ee98366d3be382d6020ba46994b514c07c3ab2e970c716be1ba'
        and is_active
        and assignable_to_non_admin
    ) then
    raise exception using
      errcode = '55000',
      message = 'TEAM_AUTHORIZATION_LOG_CAPABILITY_FINAL_STATE_MISMATCH';
  end if;

  if exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'TEAM_AUTHORIZATION_LOG_CAPABILITY_MUST_START_UNGRANTED';
  end if;

  if to_regclass(
    'public.team_authorization_audit_event_occurred_idx'
  ) is null then
    raise exception using
      errcode = '55000',
      message = 'TEAM_AUTHORIZATION_LOG_INDEX_MISSING';
  end if;
end;
$postflight$;

commit;

begin;

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 21
    or (select count(*) from public.capability_catalog where is_active) <> 19
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 19
    or exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_LOG_CAPABILITY_BASELINE_MISMATCH';
  end if;

  if not exists (
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
      message = 'CYCLE_LOG_CAPABILITY_PREVIOUS_CUTOVER_MISMATCH';
  end if;

  if exists (
    select 1
    from public.capability_catalog
    where key = 'cycles.logs.view'
  ) then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_LOG_CAPABILITY_ALREADY_PRESENT';
  end if;

  if to_regclass('public.admin_action_logs') is null
    or (
      select count(*)
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'admin_action_logs'
        and column_name = any (array[
          'id',
          'created_at',
          'actor_type',
          'actor_id',
          'action',
          'target_type',
          'target_id',
          'meta'
        ]::text[])
    ) <> 8
    or not coalesce((
      select c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'admin_action_logs'
    ), false)
    or has_table_privilege('anon', 'public.admin_action_logs', 'select')
    or has_table_privilege('authenticated', 'public.admin_action_logs', 'select')
    or to_regclass('public.voting_cycles') is null
    or (
      select count(*)
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'voting_cycles'
        and column_name = any (array['id', 'theme']::text[])
    ) <> 2 then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_LOG_SOURCE_CONTRACT_MISMATCH';
  end if;

  if to_regclass('public.admin_action_logs_cycle_created_idx') is not null then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_LOG_INDEX_ALREADY_PRESENT';
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
  'cycles.logs.view',
  'View Cycle Logs',
  'View paginated cycle start, finalization, and reset events through a safe read-only projection.',
  'Cycles',
  array[
    'View cycle start, finalization, and reset events with their cycle, current theme, actor, and timestamp context.',
    'Navigate the bounded server-paginated Cycle Logs history.'
  ]::text[],
  array[
    'Viewing raw audit metadata, free-text reset reasons, sponsor data, storage cleanup details, scheduler data, or other infrastructure context.',
    'Starting, ending, finalizing, resetting, scheduling, or otherwise changing cycles, phases, themes, or settings.',
    'Managing winners, payouts, sponsors, submissions, or unrelated logs.'
  ]::text[],
  'high',
  true,
  true,
  1,
  '915c24cf6a167040c8637e59ca27a28510c6299b2ea417ae770f86e992924beb'
);

create index admin_action_logs_cycle_created_idx
  on public.admin_action_logs (created_at desc, id desc)
  where target_type = 'cycle'
    and action in ('cycle_started', 'cycle_finalized', 'cycle_reset');

do $postflight$
begin
  if (select count(*) from public.capability_catalog) <> 22
    or (select count(*) from public.capability_catalog where is_active) <> 20
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 20
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'cycles.logs.view'
        and display_name = 'View Cycle Logs'
        and description = 'View paginated cycle start, finalization, and reset events through a safe read-only projection.'
        and category = 'Cycles'
        and included_actions = array[
          'View cycle start, finalization, and reset events with their cycle, current theme, actor, and timestamp context.',
          'Navigate the bounded server-paginated Cycle Logs history.'
        ]::text[]
        and excluded_actions = array[
          'Viewing raw audit metadata, free-text reset reasons, sponsor data, storage cleanup details, scheduler data, or other infrastructure context.',
          'Starting, ending, finalizing, resetting, scheduling, or otherwise changing cycles, phases, themes, or settings.',
          'Managing winners, payouts, sponsors, submissions, or unrelated logs.'
        ]::text[]
        and risk_level = 'high'
        and assignable_to_non_admin
        and is_active
        and implementation_version = 1
        and definition_hash = '915c24cf6a167040c8637e59ca27a28510c6299b2ea417ae770f86e992924beb'
    )
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key = 'cycles.logs.view'
    )
    or to_regclass('public.admin_action_logs_cycle_created_idx') is null then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_LOG_CAPABILITY_POSTFLIGHT_MISMATCH';
  end if;

  if has_table_privilege('anon', 'public.admin_action_logs', 'select')
    or has_table_privilege('authenticated', 'public.admin_action_logs', 'select') then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_LOG_BROWSER_ACL_MISMATCH';
  end if;
end;
$postflight$;

commit;

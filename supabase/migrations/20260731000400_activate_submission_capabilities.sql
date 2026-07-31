begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $preflight$
declare
  missing_columns text;
begin
  if to_regclass('public.capability_catalog') is null
    or to_regclass('public.team_role_capabilities') is null
  then
    raise exception using
      errcode = '55000',
      message = 'TEAM_CAPABILITY_CATALOG_FOUNDATION_MISSING';
  end if;

  select string_agg(required.column_name, ', ' order by required.column_name)
  into missing_columns
  from (
    values
      ('key'),
      ('display_name'),
      ('description'),
      ('category'),
      ('included_actions'),
      ('excluded_actions'),
      ('risk_level'),
      ('assignable_to_non_admin'),
      ('is_active'),
      ('implementation_version'),
      ('definition_hash'),
      ('deprecated_at')
  ) as required(column_name)
  where not exists (
    select 1
    from information_schema.columns existing
    where existing.table_schema = 'public'
      and existing.table_name = 'capability_catalog'
      and existing.column_name = required.column_name
  );

  if missing_columns is not null then
    raise exception using
      errcode = '55000',
      message = 'CAPABILITY_CATALOG_SCHEMA_MISMATCH',
      detail = missing_columns;
  end if;
end;
$preflight$;

lock table public.capability_catalog
  in share row exclusive mode;
lock table public.team_role_capabilities
  in share row exclusive mode;

create temporary table activated_submission_capabilities_expected (
  key text primary key,
  display_name text not null,
  description text not null,
  category text not null,
  included_actions text[] not null,
  excluded_actions text[] not null,
  risk_level text not null,
  staged_implementation_version integer not null,
  staged_definition_hash text not null,
  active_implementation_version integer not null,
  active_definition_hash text not null
) on commit drop;

insert into activated_submission_capabilities_expected (
  key,
  display_name,
  description,
  category,
  included_actions,
  excluded_actions,
  risk_level,
  staged_implementation_version,
  staged_definition_hash,
  active_implementation_version,
  active_definition_hash
)
values
  (
    'submissions.submission_phase.disqualify',
    'Disqualify Submission-Phase Submissions',
    'Disqualify a submission only during the currently permitted submission phase.',
    'Submission Moderation',
    array[
      'Disqualify a submission during the currently allowed submission phase.'
    ],
    array[
      'Reinstating submissions.',
      'Voting-phase moderation.',
      'Vote refunds.',
      'Public visibility changes.',
      'Legal review.',
      'Finalized or archived cycles and historical repairs.'
    ],
    'high',
    1,
    'c1353c1e75a0c9db90d798677deebd61f0a350e8c731fdc1ab2288f3da967cc0',
    2,
    '3eec3024438e68d08891e147a1d770ad812af935732b6e60a804baa6a28b1732'
  ),
  (
    'submissions.submission_phase.reinstate',
    'Reinstate Submission-Phase Submissions',
    'Reinstate a previously disqualified submission only during the currently permitted submission phase under the existing moderation policy.',
    'Submission Moderation',
    array[
      'Reinstate a previously disqualified submission during the currently allowed submission phase.'
    ],
    array[
      'Disqualifying submissions.',
      'Voting-phase moderation.',
      'Vote refunds.',
      'Public visibility changes.',
      'Legal review.',
      'Finalized or archived cycles and historical repairs.'
    ],
    'high',
    1,
    'a6c71a89139e91598e94ef77bd3951fd07f06d45ce76d7af0e2dd537c37ef889',
    2,
    '7c0cfbaf53b08c43633f75c025ccf729ae3dbc9d4320c90b11117415ee304dd2'
  ),
  (
    'submissions.voting_phase.disqualify',
    'Disqualify Voting-Phase Submissions',
    'Disqualify a submission only during an open voting phase.',
    'Submission Moderation',
    array[
      'Disqualify a submission during the open voting phase.'
    ],
    array[
      'Reinstating submissions.',
      'Submission-phase moderation.',
      'Vote refunds.',
      'Historical result repairs.',
      'Public visibility changes.',
      'Legal review.'
    ],
    'critical',
    1,
    '0a502187ae8a63f322119c19f8c880bc745902e110afae1b8d4a46388b8f3275',
    2,
    'cb6ad152ee22b164b6c864f26dcaab25f10be3483bfa5b1f3a7b265c66a142de'
  ),
  (
    'submissions.voting_phase.reinstate',
    'Reinstate Voting-Phase Submissions',
    'Reinstate a previously disqualified submission only during an open voting phase under the voting-phase reinstatement policy.',
    'Submission Moderation',
    array[
      'Reinstate a previously disqualified submission during the open voting phase.'
    ],
    array[
      'Disqualifying submissions.',
      'Submission-phase moderation.',
      'Vote refunds.',
      'Historical result repairs.',
      'Public visibility changes.',
      'Legal review.'
    ],
    'critical',
    1,
    '01733447007f7df2532c87a9ecd19042a1d02a687123cebd4bf57f2a7df976fe',
    2,
    '4e4f1d199d4eb008d768676796bcf8ec34c2472c90d323fecbf7b247d7a36fe0'
  );

do $activate$
declare
  staged_count integer;
  active_count integer;
  updated_count integer;
  non_target_fingerprint_before text;
  non_target_fingerprint_after text;
begin
  if (select count(*) from public.capability_catalog) <> 7 then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_CAPABILITY_ACTIVATION_CATALOG_BASELINE_MISMATCH';
  end if;

  if exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_CAPABILITY_ACTIVATION_REQUIRES_ZERO_GRANTS';
  end if;

  select count(*)
  into staged_count
  from public.capability_catalog existing
  join activated_submission_capabilities_expected expected
    on expected.key = existing.key
  where row(
    existing.display_name,
    existing.description,
    existing.category,
    existing.included_actions,
    existing.excluded_actions,
    existing.risk_level,
    existing.assignable_to_non_admin,
    existing.is_active,
    existing.implementation_version,
    existing.definition_hash,
    existing.deprecated_at
  ) is not distinct from row(
    expected.display_name,
    expected.description,
    expected.category,
    expected.included_actions,
    expected.excluded_actions,
    expected.risk_level,
    false,
    false,
    expected.staged_implementation_version,
    expected.staged_definition_hash,
    null::timestamptz
  );

  select count(*)
  into active_count
  from public.capability_catalog existing
  join activated_submission_capabilities_expected expected
    on expected.key = existing.key
  where row(
    existing.display_name,
    existing.description,
    existing.category,
    existing.included_actions,
    existing.excluded_actions,
    existing.risk_level,
    existing.assignable_to_non_admin,
    existing.is_active,
    existing.implementation_version,
    existing.definition_hash,
    existing.deprecated_at
  ) is not distinct from row(
    expected.display_name,
    expected.description,
    expected.category,
    expected.included_actions,
    expected.excluded_actions,
    expected.risk_level,
    true,
    true,
    expected.active_implementation_version,
    expected.active_definition_hash,
    null::timestamptz
  );

  if staged_count <> 4 and active_count <> 4 then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_CAPABILITY_ACTIVATION_STATE_DRIFT',
      detail = format('staged=%s active=%s', staged_count, active_count);
  end if;

  select md5(coalesce(string_agg(to_jsonb(existing)::text, E'\n' order by existing.key), ''))
  into non_target_fingerprint_before
  from public.capability_catalog existing
  where not exists (
    select 1
    from activated_submission_capabilities_expected expected
    where expected.key = existing.key
  );

  if staged_count = 4 then
    update public.capability_catalog existing
    set
      assignable_to_non_admin = true,
      is_active = true,
      implementation_version = expected.active_implementation_version,
      definition_hash = expected.active_definition_hash
    from activated_submission_capabilities_expected expected
    where expected.key = existing.key;

    get diagnostics updated_count = row_count;
    if updated_count <> 4 then
      raise exception using
        errcode = '55000',
        message = 'SUBMISSION_CAPABILITY_ACTIVATION_UPDATE_COUNT_MISMATCH';
    end if;
  end if;

  select md5(coalesce(string_agg(to_jsonb(existing)::text, E'\n' order by existing.key), ''))
  into non_target_fingerprint_after
  from public.capability_catalog existing
  where not exists (
    select 1
    from activated_submission_capabilities_expected expected
    where expected.key = existing.key
  );

  if non_target_fingerprint_after is distinct from non_target_fingerprint_before then
    raise exception using
      errcode = '55000',
      message = 'NON_TARGET_CAPABILITY_CHANGED_DURING_ACTIVATION';
  end if;
end;
$activate$;

do $postflight$
begin
  if (
    select count(*)
    from public.capability_catalog existing
    join activated_submission_capabilities_expected expected
      on expected.key = existing.key
    where row(
      existing.display_name,
      existing.description,
      existing.category,
      existing.included_actions,
      existing.excluded_actions,
      existing.risk_level,
      existing.assignable_to_non_admin,
      existing.is_active,
      existing.implementation_version,
      existing.definition_hash,
      existing.deprecated_at
    ) is not distinct from row(
      expected.display_name,
      expected.description,
      expected.category,
      expected.included_actions,
      expected.excluded_actions,
      expected.risk_level,
      true,
      true,
      expected.active_implementation_version,
      expected.active_definition_hash,
      null::timestamptz
    )
  ) <> 4 then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_CAPABILITY_ACTIVATION_POSTFLIGHT_FAILED';
  end if;

  if (select count(*) from public.capability_catalog where is_active) <> 7
    or (
      select count(*)
      from public.capability_catalog
      where assignable_to_non_admin
    ) <> 7
  then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_CAPABILITY_ACTIVATION_TOTALS_MISMATCH';
  end if;

  if exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_CAPABILITY_ACTIVATION_GRANT_POSTFLIGHT_FAILED';
  end if;
end;
$postflight$;

commit;

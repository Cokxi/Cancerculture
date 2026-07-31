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

create temporary table staged_submission_capabilities_expected (
  key text primary key,
  display_name text not null,
  description text not null,
  category text not null,
  included_actions text[] not null,
  excluded_actions text[] not null,
  risk_level text not null,
  assignable_to_non_admin boolean not null,
  is_active boolean not null,
  implementation_version integer not null,
  definition_hash text not null,
  deprecated_at timestamptz
) on commit drop;

insert into staged_submission_capabilities_expected (
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
  definition_hash,
  deprecated_at
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
    false,
    false,
    1,
    'c1353c1e75a0c9db90d798677deebd61f0a350e8c731fdc1ab2288f3da967cc0',
    null
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
    false,
    false,
    1,
    'a6c71a89139e91598e94ef77bd3951fd07f06d45ce76d7af0e2dd537c37ef889',
    null
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
    false,
    false,
    1,
    '0a502187ae8a63f322119c19f8c880bc745902e110afae1b8d4a46388b8f3275',
    null
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
    false,
    false,
    1,
    '01733447007f7df2532c87a9ecd19042a1d02a687123cebd4bf57f2a7df976fe',
    null
  );

do $catalog_preflight$
declare
  conflicting_key text;
begin
  select expected.key
  into conflicting_key
  from staged_submission_capabilities_expected expected
  join public.capability_catalog existing
    on existing.key = expected.key
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
  ) is distinct from row(
    expected.display_name,
    expected.description,
    expected.category,
    expected.included_actions,
    expected.excluded_actions,
    expected.risk_level,
    expected.assignable_to_non_admin,
    expected.is_active,
    expected.implementation_version,
    expected.definition_hash,
    expected.deprecated_at
  )
  order by expected.key
  limit 1;

  if conflicting_key is not null then
    raise exception using
      errcode = '55000',
      message = 'STAGED_SUBMISSION_CAPABILITY_CONFLICT',
      detail = conflicting_key;
  end if;

  if exists (
    select 1
    from public.team_role_capabilities grant_row
    join staged_submission_capabilities_expected expected
      on expected.key = grant_row.capability_key
  ) then
    raise exception using
      errcode = '55000',
      message = 'STAGED_SUBMISSION_CAPABILITY_ALREADY_GRANTED';
  end if;

  if not exists (
    select 1
    from public.capability_catalog existing
    where existing.key = 'submissions.submission_phase.moderate'
      and existing.display_name = 'Submission Phase Moderation'
      and existing.description =
        'Moderate submissions only during the currently permitted submission phase.'
      and existing.category = 'Submission Moderation'
      and existing.included_actions = array[
        'Disqualify submissions during the currently allowed submission phase.',
        'Reinstate submissions during the currently allowed submission phase.'
      ]
      and existing.excluded_actions = array[
        'Voting-phase moderation.',
        'Vote refunds.',
        'Public visibility changes.',
        'Legal review.',
        'Finalized or archived cycles.'
      ]
      and existing.risk_level = 'high'
      and existing.assignable_to_non_admin
      and existing.is_active
      and existing.implementation_version = 1
      and existing.definition_hash =
        '89d9d8794cc2a15772f869cf6670802b89afd00b8adafbbd1229db1d6d29f116'
      and existing.deprecated_at is null
  ) then
    raise exception using
      errcode = '55000',
      message = 'LEGACY_SUBMISSION_MODERATION_CAPABILITY_DRIFT';
  end if;
end;
$catalog_preflight$;

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
  definition_hash,
  deprecated_at
)
select
  expected.key,
  expected.display_name,
  expected.description,
  expected.category,
  expected.included_actions,
  expected.excluded_actions,
  expected.risk_level,
  expected.assignable_to_non_admin,
  expected.is_active,
  expected.implementation_version,
  expected.definition_hash,
  expected.deprecated_at
from staged_submission_capabilities_expected expected
where not exists (
  select 1
  from public.capability_catalog existing
  where existing.key = expected.key
);

do $postflight$
begin
  if (
    select count(*)
    from public.capability_catalog existing
    join staged_submission_capabilities_expected expected
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
      expected.assignable_to_non_admin,
      expected.is_active,
      expected.implementation_version,
      expected.definition_hash,
      expected.deprecated_at
    )
  ) <> 4 then
    raise exception using
      errcode = '55000',
      message = 'STAGED_SUBMISSION_CAPABILITY_POSTFLIGHT_FAILED';
  end if;

  if exists (
    select 1
    from public.team_role_capabilities grant_row
    join staged_submission_capabilities_expected expected
      on expected.key = grant_row.capability_key
  ) then
    raise exception using
      errcode = '55000',
      message = 'STAGED_SUBMISSION_CAPABILITY_GRANT_POSTFLIGHT_FAILED';
  end if;
end;
$postflight$;

commit;

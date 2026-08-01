begin;

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 16
    or (select count(*) from public.capability_catalog where is_active) <> 14
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 14
    or exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'UPLOAD_LOG_CAPABILITY_BASELINE_MISMATCH';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = 'users.directory.full.view'
      and implementation_version = 2
      and definition_hash = 'df91b4c3c90ae2f90d5be05f77b70be1717e3b50892f705ff4ba477d969e81b1'
      and is_active
      and assignable_to_non_admin
  ) then
    raise exception using
      errcode = '55000',
      message = 'UPLOAD_LOG_CAPABILITY_PREVIOUS_CUTOVER_MISMATCH';
  end if;

  if exists (
    select 1
    from public.capability_catalog
    where key = 'logs.uploads.view'
  ) then
    raise exception using
      errcode = '55000',
      message = 'UPLOAD_LOG_CAPABILITY_ALREADY_PRESENT';
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
  'logs.uploads.view',
  'View Upload Logs',
  'View redacted submission-upload outcomes and their user, cycle, submission, and timestamp context.',
  'Logs',
  array[
    'View recent submission-upload success and failure outcomes.',
    'View the associated user, cycle, submission reference, timestamp, and redacted outcome category.'
  ]::text[],
  array[
    'Viewing raw provider, storage, infrastructure, or internal error details.',
    'Viewing upload-abuse counters, thresholds, or manual unblock actions.',
    'Viewing avatar, vote, social, moderation, or other unrelated logs.'
  ]::text[],
  'moderate',
  true,
  true,
  1,
  '3968acde89ace9d541824c1e010573c0d5b3be4b30f6b75b8e5a3dd543ad2a2b'
);

do $postflight$
begin
  if (select count(*) from public.capability_catalog) <> 17
    or (select count(*) from public.capability_catalog where is_active) <> 15
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 15
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'logs.uploads.view'
        and implementation_version = 1
        and definition_hash = '3968acde89ace9d541824c1e010573c0d5b3be4b30f6b75b8e5a3dd543ad2a2b'
        and is_active
        and assignable_to_non_admin
    ) then
    raise exception using
      errcode = '55000',
      message = 'UPLOAD_LOG_CAPABILITY_FINAL_CATALOG_MISMATCH';
  end if;

  if exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'UPLOAD_LOG_CAPABILITY_MUST_START_UNGRANTED';
  end if;
end;
$postflight$;

commit;

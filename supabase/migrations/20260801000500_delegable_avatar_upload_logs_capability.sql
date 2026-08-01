begin;

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 17
    or (select count(*) from public.capability_catalog where is_active) <> 15
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 15
    or exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'AVATAR_UPLOAD_LOG_CAPABILITY_BASELINE_MISMATCH';
  end if;

  if not exists (
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
      message = 'AVATAR_UPLOAD_LOG_CAPABILITY_PREVIOUS_CUTOVER_MISMATCH';
  end if;

  if exists (
    select 1
    from public.capability_catalog
    where key = 'logs.avatar_uploads.view'
  ) then
    raise exception using
      errcode = '55000',
      message = 'AVATAR_UPLOAD_LOG_CAPABILITY_ALREADY_PRESENT';
  end if;

  if to_regclass('public.avatar_upload_logs') is null
    or (
      select count(*)
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'avatar_upload_logs'
        and column_name = any (array[
          'id',
          'created_at',
          'discord_user_id',
          'status',
          'reason',
          'avatar_key',
          'cooldown_until'
        ]::text[])
    ) <> 7 then
    raise exception using
      errcode = '55000',
      message = 'AVATAR_UPLOAD_LOG_TABLE_CONTRACT_MISMATCH';
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
  'logs.avatar_uploads.view',
  'View Avatar Upload Logs',
  'View redacted avatar-upload outcomes and their user and timestamp context without storage details.',
  'Logs',
  array[
    'View recent avatar-upload success and failure outcomes.',
    'View the associated user, timestamp, and redacted outcome category.'
  ]::text[],
  array[
    'Viewing raw provider, storage, infrastructure, or internal error details and avatar object keys.',
    'Changing avatars, cooldowns, upload protections, or user profile state.',
    'Viewing submission-upload, vote, social, moderation, or other unrelated logs.'
  ]::text[],
  'moderate',
  true,
  true,
  1,
  'd9b917101f9051d91eef9f2f20cbfa738fcd8787abe8283b0862d007416d5813'
);

do $postflight$
begin
  if (select count(*) from public.capability_catalog) <> 18
    or (select count(*) from public.capability_catalog where is_active) <> 16
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 16
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'logs.avatar_uploads.view'
        and implementation_version = 1
        and definition_hash = 'd9b917101f9051d91eef9f2f20cbfa738fcd8787abe8283b0862d007416d5813'
        and is_active
        and assignable_to_non_admin
    ) then
    raise exception using
      errcode = '55000',
      message = 'AVATAR_UPLOAD_LOG_CAPABILITY_FINAL_CATALOG_MISMATCH';
  end if;

  if exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'AVATAR_UPLOAD_LOG_CAPABILITY_MUST_START_UNGRANTED';
  end if;
end;
$postflight$;

commit;

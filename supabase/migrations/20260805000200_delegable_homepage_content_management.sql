begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 27
    or (select count(*) from public.capability_catalog where is_active) <> 25
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 25 then
    raise exception using
      errcode = '55000',
      message = 'HOMEPAGE_CONTENT_CAPABILITY_BASELINE_MISMATCH';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = 'faq.manage'
      and implementation_version = 1
      and definition_hash =
        '7a0e2cecaf38453e42a00bbc60058f9a7793512941f2c62750d5c5537a030c93'
      and is_active
      and assignable_to_non_admin
  ) then
    raise exception using
      errcode = '55000',
      message = 'HOMEPAGE_CONTENT_PREVIOUS_CUTOVER_MISMATCH';
  end if;

  if to_regclass('public.homepage_info_blocks') is null
    or to_regclass('public.team_role_capabilities') is null
    or exists (
      select 1
      from public.capability_catalog
      where key = 'homepage_content.manage'
    )
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key = 'homepage_content.manage'
    ) then
    raise exception using
      errcode = '55000',
      message = 'HOMEPAGE_CONTENT_CAPABILITY_TARGET_MISMATCH';
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
  'homepage_content.manage',
  'Manage Homepage Info Boxes',
  'Create, edit, activate, deactivate, reorder, preview, and permanently delete the validated public Homepage Info Boxes.',
  'Content',
  array[
    'View all active and inactive Homepage Info Boxes, stored actor identifiers, and timestamps in the Content area.',
    'Create and edit validated titles, body text, display order, and optional internal or HTTPS links.',
    'Activate or deactivate boxes and preview the active public ordering.',
    'Permanently delete a box after explicit confirmation and invalidate the public Homepage cache after every successful mutation.'
  ]::text[],
  array[
    'Managing Rules, FAQ, Coin Launch Links, or any other Homepage content.',
    'Using non-HTTPS external links, embedded credentials, unsafe rendering, or bypassing content validation.',
    'Managing roles, permissions, team membership, or Owner access.',
    'Viewing unrelated logs or mutating unrelated public content, cycles, users, submissions, sponsorships, or payouts.'
  ]::text[],
  'high',
  true,
  true,
  1,
  'b9f5db882c8fa65f235ef2fe83f1cc90515761e21ea885e4ca80e58b2476957a'
);

do $postflight$
begin
  if (select count(*) from public.capability_catalog) <> 28
    or (select count(*) from public.capability_catalog where is_active) <> 26
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 26
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'homepage_content.manage'
        and display_name = 'Manage Homepage Info Boxes'
        and category = 'Content'
        and risk_level = 'high'
        and is_active
        and assignable_to_non_admin
        and implementation_version = 1
        and definition_hash =
          'b9f5db882c8fa65f235ef2fe83f1cc90515761e21ea885e4ca80e58b2476957a'
    )
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key = 'homepage_content.manage'
    ) then
    raise exception using
      errcode = '55000',
      message = 'HOMEPAGE_CONTENT_CAPABILITY_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;

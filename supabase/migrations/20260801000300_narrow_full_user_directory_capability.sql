begin;

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 16
    or (select count(*) from public.capability_catalog where is_active) <> 14
    or (
      select count(*) from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 14
    or exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'FULL_USER_DIRECTORY_NARROWING_BASELINE_MISMATCH';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = 'users.directory.full.view'
      and implementation_version = 1
      and definition_hash = '2a029efd6ee65c6e775ff6b596213f54e1fc1465b338c8a3cc5791c66aef0676'
      and is_active
      and assignable_to_non_admin
  ) then
    raise exception using
      errcode = '55000',
      message = 'FULL_USER_DIRECTORY_DEFINITION_MISMATCH';
  end if;
end;
$preflight$;

update public.capability_catalog
set included_actions = array[
      'View current and known Discord names.',
      'View first-seen and last-seen timestamps.',
      'View aggregate submission and username-change statistics.',
      'Open the user''s recent non-disqualified submission list without per-submission vote totals.'
    ]::text[],
    excluded_actions = array[
      'Viewing website-ban reasons or history.',
      'Creating or revoking website bans.',
      'Viewing flag reasons or flag history.',
      'Viewing vote, wallet, session, or infrastructure data.',
      'Viewing disqualified submission history or per-submission vote totals.'
    ]::text[],
    implementation_version = 2,
    definition_hash = 'df91b4c3c90ae2f90d5be05f77b70be1717e3b50892f705ff4ba477d969e81b1'
where key = 'users.directory.full.view';

create or replace function public.authorize_user_moderation_capability(
  p_actor_discord_user_id text,
  p_capability_key text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_actor_role text;
  v_expected_hash text;
  v_expected_version integer := 1;
begin
  v_expected_hash := case p_capability_key
    when 'users.directory.full.view' then 'df91b4c3c90ae2f90d5be05f77b70be1717e3b50892f705ff4ba477d969e81b1'
    when 'users.upload_blocks.view' then '174c20de72228105c16c01b98a9da10f232ecdbe2f9e6c1f0b309a1c37479204'
    when 'users.website_bans.view' then '4e8d362ef56b5f101e66ac6d3db552f505ecf6c4580dbefe36f397d4571e7388'
    when 'users.website_bans.create' then '66118e044f0defc403ce7a63539a30156b4000bd0a05dbeeafe73a9661407470'
    when 'users.website_bans.revoke' then '1a5b5dd1c07c638051dc76ea079561baff6b8204b17be017d04e186de6b09706'
    when 'logs.website_bans.view' then 'a3ce56bd99c5e3aa74ff1d863a8969b73cd23717cc9ced50a7c8c375cda743e3'
    else null
  end;
  if p_capability_key = 'users.directory.full.view' then
    v_expected_version := 2;
  end if;

  if nullif(v_actor_id, '') is null or v_expected_hash is null then
    raise exception using errcode = '42501', message = 'USER_MODERATION_FORBIDDEN';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = p_capability_key
      and is_active
      and assignable_to_non_admin
      and implementation_version = v_expected_version
      and definition_hash = v_expected_hash
  ) then
    raise exception using
      errcode = '55000',
      message = 'USER_MODERATION_AUTHORIZATION_DEPENDENCY_UNAVAILABLE';
  end if;

  select member_row.role
  into v_actor_role
  from public.team_members as member_row
  join public.team_roles as role_row
    on role_row.key = member_row.role and role_row.is_active
  where member_row.discord_user_id = v_actor_id;

  if not found then
    raise exception using errcode = '42501', message = 'USER_MODERATION_FORBIDDEN';
  end if;
  if v_actor_role = 'admin' then
    return;
  end if;
  if not exists (
    select 1 from public.team_role_capabilities
    where role = v_actor_role and capability_key = p_capability_key
  ) then
    raise exception using errcode = '42501', message = 'USER_MODERATION_FORBIDDEN';
  end if;
end;
$function$;

alter function public.authorize_user_moderation_capability(text, text) owner to postgres;
revoke all on function public.authorize_user_moderation_capability(text, text)
  from public, anon, authenticated, discord_bot, service_role;

do $postflight$
begin
  if not exists (
    select 1
    from public.capability_catalog
    where key = 'users.directory.full.view'
      and implementation_version = 2
      and definition_hash = 'df91b4c3c90ae2f90d5be05f77b70be1717e3b50892f705ff4ba477d969e81b1'
      and is_active
      and assignable_to_non_admin
  ) or exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'FULL_USER_DIRECTORY_NARROWING_FAILED';
  end if;
end;
$postflight$;

commit;

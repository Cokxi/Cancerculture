\set ON_ERROR_STOP on

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $persistent_state$
begin
  if (
    select count(*)
    from public.team_roles
  ) <> 4 then
    raise exception 'EXPECTED_EXACTLY_FOUR_TEAM_ROLES';
  end if;

  if not exists (
    select 1
    from public.team_roles
    where key = 'admin'
      and display_name = 'Admin'
      and is_system = true
      and is_active = true
  ) then
    raise exception 'ADMIN_ROLE_SEED_INVALID';
  end if;

  if exists (
    select 1
    from public.team_members
    where role = 'mod'
  ) then
    raise exception 'LEGACY_MOD_ROLE_REMAINS';
  end if;

  if exists (
    select 1
    from public.team_members member
    left join public.team_roles role_row
      on role_row.key = member.role
    where role_row.key is null
  ) then
    raise exception 'TEAM_MEMBER_ROLE_NOT_REGISTERED';
  end if;

  if (
    select count(*)
    from public.capability_catalog
  ) <> 3 then
    raise exception 'EXPECTED_EXACTLY_THREE_CAPABILITIES';
  end if;

  if (
    select count(*)
    from public.team_role_capabilities
  ) <> 9 then
    raise exception 'EXPECTED_EXACTLY_NINE_INITIAL_GRANTS';
  end if;

  if exists (
    select role_key
    from public.team_role_capabilities
    group by role_key
    having count(*) <> 3
  ) then
    raise exception 'NON_ADMIN_GRANT_COUNT_INVALID';
  end if;

  if exists (
    select 1
    from public.team_role_capabilities
    where role_key = 'admin'
  ) then
    raise exception 'ADMIN_GRANT_ROW_FOUND';
  end if;

  if exists (
    select 1
    from public.team_authorization_audit
  ) then
    raise exception 'AUTHORIZATION_AUDIT_NOT_EMPTY';
  end if;
end;
$persistent_state$;

do $rollback_tests$
declare
  v_audit_id uuid;
begin
  begin
    insert into public.team_members (
      discord_user_id,
      role
    )
    values (
      'foundation-rollback-unknown-role',
      'unknown_role'
    );
    raise exception 'UNKNOWN_TEAM_ROLE_ACCEPTED';
  exception
    when foreign_key_violation then
      null;
  end;

  begin
    update public.team_roles
    set key = 'renamed_moderator'
    where key = 'moderator';
    raise exception 'TEAM_ROLE_KEY_UPDATE_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'TEAM_ROLE_KEY_IMMUTABLE' then
        raise;
      end if;
  end;

  begin
    delete from public.team_roles
    where key = 'moderator';
    raise exception 'TEAM_ROLE_DELETE_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'TEAM_ROLE_DELETE_FORBIDDEN' then
        raise;
      end if;
  end;

  begin
    update public.team_roles
    set display_name = 'Changed Admin'
    where key = 'admin';
    raise exception 'ADMIN_ROLE_UPDATE_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'ADMIN_ROLE_IMMUTABLE' then
        raise;
      end if;
  end;

  begin
    update public.team_roles
    set is_active = false
    where key = 'admin';
    raise exception 'ADMIN_ROLE_DEACTIVATION_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'ADMIN_ROLE_IMMUTABLE' then
        raise;
      end if;
  end;

  begin
    insert into public.team_role_capabilities (
      role_key,
      capability_key,
      grant_reason
    )
    values (
      'admin',
      'users.flag',
      'Rollback-only invalid admin grant'
    );
    raise exception 'ADMIN_GRANT_ACCEPTED';
  exception
    when check_violation then
      null;
  end;

  begin
    insert into public.team_role_capabilities (
      role_key,
      capability_key,
      grant_reason
    )
    values (
      'trial_moderator',
      'unknown.capability',
      'Rollback-only unknown capability grant'
    );
    raise exception 'UNKNOWN_CAPABILITY_ACCEPTED';
  exception
    when foreign_key_violation then
      null;
  end;

  begin
    insert into public.team_role_capabilities (
      role_key,
      capability_key,
      grant_reason
    )
    values (
      'trial_moderator',
      'users.flag',
      'Rollback-only duplicate grant'
    );
    raise exception 'DUPLICATE_GRANT_ACCEPTED';
  exception
    when unique_violation then
      null;
  end;

  insert into public.team_authorization_audit (
    idempotency_key,
    actor_discord_user_id,
    actor_role_key,
    event_type,
    target_discord_user_id,
    before_state,
    after_state,
    reason
  )
  values (
    gen_random_uuid(),
    'foundation-rollback-admin',
    'admin',
    'member_role_changed',
    'foundation-rollback-target',
    '{}'::jsonb,
    '{}'::jsonb,
    'Rollback-only immutable audit test'
  )
  returning id into v_audit_id;

  begin
    update public.team_authorization_audit
    set reason = 'Rollback-only changed reason'
    where id = v_audit_id;
    raise exception 'AUTHORIZATION_AUDIT_UPDATE_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'TEAM_AUTHORIZATION_AUDIT_IMMUTABLE' then
        raise;
      end if;
  end;

  begin
    delete from public.team_authorization_audit
    where id = v_audit_id;
    raise exception 'AUTHORIZATION_AUDIT_DELETE_ACCEPTED';
  exception
    when sqlstate '55000' then
      if sqlerrm <> 'TEAM_AUTHORIZATION_AUDIT_IMMUTABLE' then
        raise;
      end if;
  end;

  insert into public.social_verification_logs (
    id,
    action,
    actor_discord_user_id,
    actor_role,
    target_discord_user_id,
    user_social_link_id,
    platform,
    profile_url
  )
  values (
    -900000000000000000,
    'verify_social',
    'foundation-rollback-actor',
    'custom_reviewer',
    'foundation-rollback-target',
    -900000000000000000,
    'x',
    'https://example.invalid/foundation-rollback'
  );

  begin
    insert into public.social_verification_logs (
      id,
      action,
      actor_discord_user_id,
      actor_role,
      target_discord_user_id,
      user_social_link_id,
      platform,
      profile_url
    )
    values (
      -900000000000000001,
      'verify_social',
      'foundation-rollback-actor',
      'Invalid-Role',
      'foundation-rollback-target',
      -900000000000000001,
      'x',
      'https://example.invalid/foundation-rollback-invalid'
    );
    raise exception 'INVALID_SOCIAL_ACTOR_ROLE_ACCEPTED';
  exception
    when check_violation then
      null;
  end;
end;
$rollback_tests$;

rollback;

\set ON_ERROR_STOP on

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

delete from public.team_members;

insert into public.user_logs (
  discord_user_id,
  current_discord_username
)
values
  ('role-foundation-admin', 'role-foundation-admin'),
  ('role-foundation-target', 'role-foundation-target'),
  ('role-foundation-trial', 'role-foundation-trial')
on conflict (discord_user_id) do update
set current_discord_username = excluded.current_discord_username;

insert into public.team_members (
  discord_user_id,
  discord_username,
  role
)
values
  (
    'role-foundation-admin',
    'role-foundation-admin',
    'admin'
  ),
  (
    'role-foundation-trial',
    'role-foundation-trial',
    'trial_moderator'
  );

set local role service_role;

do $test$
declare
  v_result jsonb;
  v_audit_count integer;
begin
  foreach v_result in array array[
    to_jsonb('trial_moderator'::text),
    to_jsonb('moderator'::text),
    to_jsonb('super_moderator'::text),
    to_jsonb('admin'::text)
  ]
  loop
    v_result := public.set_team_member_role(
      'role-foundation-admin',
      'role-foundation-target',
      v_result #>> '{}',
      'DEV role assignment test'
    );

    if not (v_result ->> 'changed')::boolean then
      raise exception 'CANONICAL_ROLE_CHANGE_NOT_APPLIED';
    end if;
  end loop;

  if (
    select role
    from public.team_members
    where discord_user_id = 'role-foundation-target'
  ) <> 'admin' then
    raise exception 'CANONICAL_ROLE_SEQUENCE_FAILED';
  end if;

  select count(*)::integer
  into v_audit_count
  from public.admin_action_logs
  where target_id = 'role-foundation-target'
    and action = 'team_member_role_changed';

  v_result := public.set_team_member_role(
    'role-foundation-admin',
    'role-foundation-target',
    'admin',
    'Identical DEV retry'
  );

  if (v_result ->> 'changed')::boolean then
    raise exception 'IDENTICAL_RETRY_CHANGED_STATE';
  end if;

  if (
    select count(*)::integer
    from public.admin_action_logs
    where target_id = 'role-foundation-target'
      and action = 'team_member_role_changed'
  ) <> v_audit_count then
    raise exception 'IDENTICAL_RETRY_DUPLICATED_AUDIT';
  end if;

  v_result := public.set_team_member_role(
    'role-foundation-admin',
    'role-foundation-target',
    null,
    'DEV removal test'
  );

  if not (v_result ->> 'changed')::boolean
    or exists (
      select 1
      from public.team_members
      where discord_user_id = 'role-foundation-target'
    )
  then
    raise exception 'TEAM_MEMBER_REMOVAL_FAILED';
  end if;

  v_result := public.set_team_member_role(
    'role-foundation-admin',
    'role-foundation-target',
    null,
    'Identical DEV removal retry'
  );

  if (v_result ->> 'changed')::boolean then
    raise exception 'REMOVAL_RETRY_CHANGED_STATE';
  end if;

  if not exists (
    select 1
    from public.admin_action_logs
    where target_id = 'role-foundation-target'
      and action = 'team_member_removed'
      and meta ->> 'previousRole' = 'admin'
      and meta ->> 'newRole' is null
      and meta ->> 'reason' = 'DEV removal test'
  ) then
    raise exception 'REMOVAL_AUDIT_MISSING';
  end if;

  begin
    perform public.set_team_member_role(
      'role-foundation-admin',
      'role-foundation-target',
      'mod',
      'Legacy write rejection'
    );
    raise exception 'LEGACY_ROLE_WRITE_ACCEPTED';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'INVALID_TEAM_ROLE' then
        raise;
      end if;
  end;

  begin
    perform public.set_team_member_role(
      'role-foundation-trial',
      'role-foundation-target',
      'moderator',
      'Non-admin rejection'
    );
    raise exception 'NON_ADMIN_ROLE_CHANGE_ACCEPTED';
  exception
    when sqlstate '42501' then
      if sqlerrm <> 'ACTOR_NOT_ADMIN' then
        raise;
      end if;
  end;

  begin
    perform public.set_team_member_role(
      'role-foundation-admin',
      'role-foundation-target',
      'trial_moderator',
      ' '
    );
    raise exception 'EMPTY_REASON_ACCEPTED';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'REASON_REQUIRED' then
        raise;
      end if;
  end;

  begin
    insert into public.team_members (
      discord_user_id,
      role
    )
    values ('role-foundation-invalid', 'unknown');
    raise exception 'UNKNOWN_CONSTRAINT_ROLE_ACCEPTED';
  exception
    when check_violation then
      null;
  end;

  perform public.set_team_member_role(
    'role-foundation-admin',
    'role-foundation-target',
    'admin',
    'Prepare last-admin test'
  );

  delete from public.team_members
  where discord_user_id = 'role-foundation-admin';

  begin
    perform public.set_team_member_role(
      'role-foundation-target',
      'role-foundation-target',
      'moderator',
      'Last admin demotion rejection'
    );
    raise exception 'LAST_ADMIN_DEMOTION_ACCEPTED';
  exception
    when check_violation then
      if sqlerrm <> 'LAST_ADMIN_PROTECTED' then
        raise;
      end if;
  end;

  begin
    perform public.set_team_member_role(
      'role-foundation-target',
      'role-foundation-target',
      null,
      'Last admin removal rejection'
    );
    raise exception 'LAST_ADMIN_REMOVAL_ACCEPTED';
  exception
    when check_violation then
      if sqlerrm <> 'LAST_ADMIN_PROTECTED' then
        raise;
      end if;
  end;

  if (
    select count(*)
    from public.team_members
    where role = 'admin'
  ) <> 1 then
    raise exception 'LAST_ADMIN_WAS_NOT_PRESERVED';
  end if;
end;
$test$;

reset role;

rollback;

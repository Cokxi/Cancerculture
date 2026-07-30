begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

lock table public.team_members in share row exclusive mode;

do $preflight$
begin
  if exists (
    select 1
    from public.team_members
    where role not in ('admin', 'mod')
  ) then
    raise exception using
      errcode = '23514',
      message = 'UNKNOWN_TEAM_MEMBER_ROLE';
  end if;
end;
$preflight$;

alter table public.team_members
  drop constraint team_members_role_check;

update public.team_members
set role = 'trial_moderator'
where role = 'mod';

alter table public.team_members
  add constraint team_members_role_check
  check (
    role in (
      'trial_moderator',
      'moderator',
      'super_moderator',
      'admin'
    )
  );

-- Preserve legacy audit rows while allowing every canonical actor role.
alter table public.social_verification_logs
  drop constraint social_verification_logs_actor_role_check;

alter table public.social_verification_logs
  add constraint social_verification_logs_actor_role_check
  check (
    actor_role in (
      'mod',
      'trial_moderator',
      'moderator',
      'super_moderator',
      'admin'
    )
  );

create or replace function public.set_team_member_role(
  p_actor_discord_user_id text,
  p_target_discord_user_id text,
  p_new_role text,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_actor_role text;
  v_previous_role text;
  v_target_username text;
  v_target_user_exists boolean;
  v_member_exists boolean;
begin
  if nullif(btrim(p_actor_discord_user_id), '') is null then
    raise exception using
      errcode = '42501',
      message = 'ACTOR_NOT_ADMIN';
  end if;

  if nullif(btrim(p_target_discord_user_id), '') is null then
    raise exception using
      errcode = '22023',
      message = 'TARGET_USER_NOT_FOUND';
  end if;

  if nullif(btrim(p_reason), '') is null then
    raise exception using
      errcode = '22023',
      message = 'REASON_REQUIRED';
  end if;

  if p_new_role is not null
    and p_new_role not in (
      'trial_moderator',
      'moderator',
      'super_moderator',
      'admin'
    )
  then
    raise exception using
      errcode = '22023',
      message = 'INVALID_TEAM_ROLE';
  end if;

  -- Serialize all role changes so concurrent requests cannot remove the last
  -- admin or produce conflicting role/audit state.
  perform pg_advisory_xact_lock(
    hashtextextended('public.team_members.role_management', 0)
  );

  select role
  into v_actor_role
  from public.team_members
  where discord_user_id = p_actor_discord_user_id;

  if v_actor_role is distinct from 'admin' then
    raise exception using
      errcode = '42501',
      message = 'ACTOR_NOT_ADMIN';
  end if;

  select role
  into v_previous_role
  from public.team_members
  where discord_user_id = p_target_discord_user_id
  for update;
  v_member_exists := found;

  select current_discord_username
  into v_target_username
  from public.user_logs
  where discord_user_id = p_target_discord_user_id;
  v_target_user_exists := found;

  if not v_member_exists and not v_target_user_exists then
    raise exception using
      errcode = 'P0002',
      message = 'TARGET_USER_NOT_FOUND';
  end if;

  if v_previous_role = 'admin'
    and p_new_role is distinct from 'admin'
    and (
      select count(*)
      from public.team_members
      where role = 'admin'
    ) <= 1
  then
    raise exception using
      errcode = '23514',
      message = 'LAST_ADMIN_PROTECTED';
  end if;

  if p_new_role is null then
    if not v_member_exists then
      return jsonb_build_object(
        'changed', false,
        'previousRole', null,
        'newRole', null
      );
    end if;

    delete from public.team_members
    where discord_user_id = p_target_discord_user_id;
  else
    if v_member_exists and v_previous_role = p_new_role then
      return jsonb_build_object(
        'changed', false,
        'previousRole', v_previous_role,
        'newRole', v_previous_role
      );
    end if;

    insert into public.team_members (
      discord_user_id,
      discord_username,
      role
    )
    values (
      p_target_discord_user_id,
      v_target_username,
      p_new_role
    )
    on conflict (discord_user_id)
    do update set
      role = excluded.role,
      discord_username = coalesce(
        excluded.discord_username,
        public.team_members.discord_username
      );
  end if;

  insert into public.admin_action_logs (
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    meta
  )
  values (
    'admin',
    p_actor_discord_user_id,
    case
      when p_new_role is null then 'team_member_removed'
      else 'team_member_role_changed'
    end,
    'team_member',
    p_target_discord_user_id,
    jsonb_build_object(
      'previousRole', v_previous_role,
      'newRole', p_new_role,
      'reason', btrim(p_reason)
    )
  );

  return jsonb_build_object(
    'changed', true,
    'previousRole', v_previous_role,
    'newRole', p_new_role
  );
end;
$function$;

alter function public.set_team_member_role(text, text, text, text)
  owner to postgres;

revoke all on function public.set_team_member_role(text, text, text, text)
  from public;
revoke execute on function public.set_team_member_role(text, text, text, text)
  from anon, authenticated;
grant execute on function public.set_team_member_role(text, text, text, text)
  to service_role;

comment on function public.set_team_member_role(text, text, text, text) is
  'Atomically changes canonical team roles and audits the result; service role only.';

commit;

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
declare
  v_signature text;
  v_function regprocedure;
begin
  if current_user <> 'postgres'
    or not exists (select 1 from pg_roles where rolname = 'postgres')
    or not exists (select 1 from pg_roles where rolname = 'service_role')
    or not exists (select 1 from pg_roles where rolname = 'discord_bot')
    or not exists (select 1 from pg_roles where rolname = 'anon')
    or not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise exception using
      errcode = '55000',
      message = 'PUBLIC_ACL_ROLE_BASELINE_MISMATCH';
  end if;

  if not exists (
    select 1
    from pg_namespace
    where nspname = 'public'
      and pg_get_userbyid(nspowner) in ('postgres', 'pg_database_owner')
  ) then
    raise exception using
      errcode = '55000',
      message = 'PUBLIC_ACL_SCHEMA_BASELINE_MISMATCH';
  end if;

  if exists (
    select 1
    from pg_default_acl d
    join pg_roles owner_role on owner_role.oid = d.defaclrole
    where owner_role.rolname = 'postgres'
      and d.defaclnamespace = 0
  )
    or exists (
      select 1
      from pg_default_acl d
      join pg_roles owner_role on owner_role.oid = d.defaclrole
      join pg_namespace n on n.oid = d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) acl
      left join pg_roles grantee_role on grantee_role.oid = acl.grantee
      where owner_role.rolname = 'postgres'
        and n.nspname = 'public'
        and (
          d.defaclobjtype not in ('r', 'S', 'f')
          or coalesce(grantee_role.rolname, 'PUBLIC') not in (
            'PUBLIC',
            'postgres',
            'anon',
            'authenticated',
            'service_role'
          )
        )
    ) then
    raise exception using
      errcode = '55000',
      message = 'PUBLIC_ACL_DEFAULT_PRIVILEGE_BASELINE_MISMATCH';
  end if;

  foreach v_signature in array array[
    'public.apply_discord_live_event(text,text,timestamptz,text,text,text)',
    'public.audit_discord_sync_action(text,text,jsonb)',
    'public.claim_discord_membership_sync_event(text,text,timestamptz,text)',
    'public.finish_discord_membership_sync_event(text,text)',
    'public.enforce_discord_authenticated_action()',
    'public.enforce_discord_ban_submissions(text,timestamptz,text)',
    'public.enforce_discord_ban_submissions_trigger()',
    'public.enforce_submission_upload_abuse_block()',
    'public.protect_discord_ban_republish()',
    'public.revoke_website_ban_sessions()',
    'public.apply_discord_member_join_v2(text,timestamptz,text,text,text,timestamptz)',
    'public.apply_discord_member_join(text,timestamptz,text,text,text)',
    'public.apply_discord_member_remove(text,timestamptz,text,text,text)',
    'public.apply_discord_ban(text,timestamptz,text,text,text)',
    'public.apply_discord_unban(text,timestamptz,text,text,text)',
    'public.begin_discord_reconciliation_snapshot(text,timestamptz,text,uuid,integer,integer)',
    'public.append_discord_reconciliation_chunk(text,text,timestamptz,text,uuid,jsonb)',
    'public.finalize_discord_reconciliation_snapshot(text,timestamptz,text,uuid)',
    'public.record_discord_reconciliation_failure(text,timestamptz,text,text)',
    'public.get_cancerculture_session_access(uuid)',
    'public.create_cancerculture_session(uuid,text)',
    'public.sync_discord_user_context(text,text,text,text)'
  ] loop
    v_function := to_regprocedure(v_signature);

    if v_function is null
      or not exists (
        select 1
        from pg_proc p
        where p.oid = v_function
          and pg_get_userbyid(p.proowner) = 'postgres'
          and p.prosecdef
          and p.proconfig = array['search_path=public, pg_temp']::text[]
      ) then
      raise exception using
        errcode = '55000',
        message = 'PUBLIC_ACL_FUNCTION_BASELINE_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  if to_regclass('public.discord_guard_logs') is null
    or to_regclass('public.discord_guard_logs_id_seq') is null
    or pg_get_serial_sequence('public.discord_guard_logs', 'id')
      <> 'public.discord_guard_logs_id_seq'
    or not coalesce((
      select relrowsecurity
      from pg_class
      where oid = 'public.discord_guard_logs'::regclass
    ), false)
    or not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = 'discord_guard_logs'
        and policyname = 'discord_bot_insert_guard_logs'
        and cmd = 'INSERT'
        and roles = array['discord_bot']::name[]
        and with_check = 'true'
    ) then
    raise exception using
      errcode = '55000',
      message = 'PUBLIC_ACL_DISCORD_GUARD_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

-- Canonical application-owned public-schema ACL. Provider-owned
-- supabase_admin default privileges require a separate managed operation.
alter schema public owner to postgres;

revoke all on schema public
  from public, anon, authenticated, pg_database_owner,
       service_role, discord_bot, postgres;

grant usage, create on schema public to postgres;
grant usage on schema public to service_role, discord_bot;

-- Match the application-owned DEV defaults: future postgres-owned tables and
-- sequences remain server-only until a migration grants a narrower contract.
alter default privileges for role postgres in schema public
  revoke all on tables
  from public, postgres, anon, authenticated, discord_bot;

alter default privileges for role postgres in schema public
  grant all on tables to service_role;

alter default privileges for role postgres in schema public
  revoke all on sequences
  from public, postgres, anon, authenticated, discord_bot;

alter default privileges for role postgres in schema public
  grant all on sequences to service_role;

-- DEV has no public-schema-specific function grants for postgres-created
-- routines. Existing function ACLs are hardened explicitly below.
alter default privileges for role postgres in schema public
  revoke all on functions
  from public, postgres, anon, authenticated, service_role, discord_bot;

-- Internal SECURITY DEFINER helpers and trigger functions are owner-only.
revoke execute on function public.apply_discord_live_event(
  text, text, timestamptz, text, text, text
) from public, anon, authenticated, service_role, discord_bot;

revoke execute on function public.audit_discord_sync_action(
  text, text, jsonb
) from public, anon, authenticated, service_role, discord_bot;

revoke execute on function public.claim_discord_membership_sync_event(
  text, text, timestamptz, text
) from public, anon, authenticated, service_role, discord_bot;

revoke execute on function public.finish_discord_membership_sync_event(
  text, text
) from public, anon, authenticated, service_role, discord_bot;

revoke execute on function public.enforce_discord_authenticated_action()
  from public, anon, authenticated, service_role, discord_bot;

revoke execute on function public.enforce_discord_ban_submissions(
  text, timestamptz, text
) from public, anon, authenticated, service_role, discord_bot;

revoke execute on function public.enforce_discord_ban_submissions_trigger()
  from public, anon, authenticated, service_role, discord_bot;

revoke execute on function public.enforce_submission_upload_abuse_block()
  from public, anon, authenticated, service_role, discord_bot;

revoke execute on function public.protect_discord_ban_republish()
  from public, anon, authenticated, service_role, discord_bot;

revoke execute on function public.revoke_website_ban_sessions()
  from public, anon, authenticated, service_role, discord_bot;

-- Preserve the externally invoked Discord sync and session RPCs, including
-- the retained compatibility join entry point.
revoke execute on function public.apply_discord_member_join_v2(
  text, timestamptz, text, text, text, timestamptz
) from public, anon, authenticated, discord_bot;
grant execute on function public.apply_discord_member_join_v2(
  text, timestamptz, text, text, text, timestamptz
) to service_role;

revoke execute on function public.apply_discord_member_join(
  text, timestamptz, text, text, text
) from public, anon, authenticated, discord_bot;
grant execute on function public.apply_discord_member_join(
  text, timestamptz, text, text, text
) to service_role;

revoke execute on function public.apply_discord_member_remove(
  text, timestamptz, text, text, text
) from public, anon, authenticated, discord_bot;
grant execute on function public.apply_discord_member_remove(
  text, timestamptz, text, text, text
) to service_role;

revoke execute on function public.apply_discord_ban(
  text, timestamptz, text, text, text
) from public, anon, authenticated, discord_bot;
grant execute on function public.apply_discord_ban(
  text, timestamptz, text, text, text
) to service_role;

revoke execute on function public.apply_discord_unban(
  text, timestamptz, text, text, text
) from public, anon, authenticated, discord_bot;
grant execute on function public.apply_discord_unban(
  text, timestamptz, text, text, text
) to service_role;

revoke execute on function public.begin_discord_reconciliation_snapshot(
  text, timestamptz, text, uuid, integer, integer
) from public, anon, authenticated, discord_bot;
grant execute on function public.begin_discord_reconciliation_snapshot(
  text, timestamptz, text, uuid, integer, integer
) to service_role;

revoke execute on function public.append_discord_reconciliation_chunk(
  text, text, timestamptz, text, uuid, jsonb
) from public, anon, authenticated, discord_bot;
grant execute on function public.append_discord_reconciliation_chunk(
  text, text, timestamptz, text, uuid, jsonb
) to service_role;

revoke execute on function public.finalize_discord_reconciliation_snapshot(
  text, timestamptz, text, uuid
) from public, anon, authenticated, discord_bot;
grant execute on function public.finalize_discord_reconciliation_snapshot(
  text, timestamptz, text, uuid
) to service_role;

revoke execute on function public.record_discord_reconciliation_failure(
  text, timestamptz, text, text
) from public, anon, authenticated, discord_bot;
grant execute on function public.record_discord_reconciliation_failure(
  text, timestamptz, text, text
) to service_role;

revoke execute on function public.get_cancerculture_session_access(uuid)
  from public, anon, authenticated, discord_bot;
grant execute on function public.get_cancerculture_session_access(uuid)
  to service_role;

revoke execute on function public.create_cancerculture_session(uuid, text)
  from public, anon, authenticated, discord_bot;
grant execute on function public.create_cancerculture_session(uuid, text)
  to service_role;

-- Preserve the shared server/Bot user-context synchronization entry point.
revoke execute on function public.sync_discord_user_context(
  text, text, text, text
) from public, anon, authenticated;
grant execute on function public.sync_discord_user_context(
  text, text, text, text
) to service_role, discord_bot;

-- Reassert the Bot's only direct table/sequence access.
revoke all on table public.discord_guard_logs from discord_bot;
grant insert on table public.discord_guard_logs to discord_bot;

revoke all on sequence public.discord_guard_logs_id_seq from discord_bot;
grant usage, select on sequence public.discord_guard_logs_id_seq
  to discord_bot;

do $postflight$
declare
  v_signature text;
  v_function regprocedure;
begin
  if not exists (
    select 1
    from pg_namespace n
    where n.nspname = 'public'
      and pg_get_userbyid(n.nspowner) = 'postgres'
      and (
        select count(*)
        from aclexplode(n.nspacl) acl
      ) = 4
      and not exists (
        select 1
        from aclexplode(n.nspacl) acl
        left join pg_roles grantee_role on grantee_role.oid = acl.grantee
        where not (
          (grantee_role.rolname = 'postgres'
            and acl.privilege_type in ('USAGE', 'CREATE'))
          or (grantee_role.rolname in ('service_role', 'discord_bot')
            and acl.privilege_type = 'USAGE')
        )
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'PUBLIC_ACL_SCHEMA_POSTFLIGHT_MISMATCH';
  end if;

  if exists (
    select 1
    from pg_default_acl d
    join pg_roles owner_role on owner_role.oid = d.defaclrole
    where owner_role.rolname = 'postgres'
      and d.defaclnamespace = 0
  )
    or (
      select count(*)
      from pg_default_acl d
      join pg_roles owner_role on owner_role.oid = d.defaclrole
      join pg_namespace n on n.oid = d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) acl
      join pg_roles grantee_role on grantee_role.oid = acl.grantee
      where owner_role.rolname = 'postgres'
        and n.nspname = 'public'
        and grantee_role.rolname = 'service_role'
        and (
          (d.defaclobjtype = 'r' and acl.privilege_type in (
            'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
            'REFERENCES', 'TRIGGER', 'MAINTAIN'
          ))
          or (d.defaclobjtype = 'S' and acl.privilege_type in (
            'USAGE', 'SELECT', 'UPDATE'
          ))
        )
    ) <> 11
    or exists (
      select 1
      from pg_default_acl d
      join pg_roles owner_role on owner_role.oid = d.defaclrole
      join pg_namespace n on n.oid = d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) acl
      left join pg_roles grantee_role on grantee_role.oid = acl.grantee
      where owner_role.rolname = 'postgres'
        and n.nspname = 'public'
        and not (
          grantee_role.rolname = 'service_role'
          and (
            (d.defaclobjtype = 'r' and acl.privilege_type in (
              'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
              'REFERENCES', 'TRIGGER', 'MAINTAIN'
            ))
            or (d.defaclobjtype = 'S' and acl.privilege_type in (
              'USAGE', 'SELECT', 'UPDATE'
            ))
          )
        )
    ) then
    raise exception using
      errcode = '55000',
      message = 'PUBLIC_ACL_DEFAULT_PRIVILEGE_POSTFLIGHT_MISMATCH';
  end if;

  foreach v_signature in array array[
    'public.apply_discord_live_event(text,text,timestamptz,text,text,text)',
    'public.audit_discord_sync_action(text,text,jsonb)',
    'public.claim_discord_membership_sync_event(text,text,timestamptz,text)',
    'public.finish_discord_membership_sync_event(text,text)',
    'public.enforce_discord_authenticated_action()',
    'public.enforce_discord_ban_submissions(text,timestamptz,text)',
    'public.enforce_discord_ban_submissions_trigger()',
    'public.enforce_submission_upload_abuse_block()',
    'public.protect_discord_ban_republish()',
    'public.revoke_website_ban_sessions()'
  ] loop
    v_function := to_regprocedure(v_signature);

    if (
      select count(*)
      from pg_proc p
      cross join lateral aclexplode(
        coalesce(p.proacl, acldefault('f', p.proowner))
      ) acl
      where p.oid = v_function
    ) <> 1
      or exists (
        select 1
        from pg_proc p
        cross join lateral aclexplode(
          coalesce(p.proacl, acldefault('f', p.proowner))
        ) acl
        where p.oid = v_function
          and (
            acl.grantee <> p.proowner
            or acl.privilege_type <> 'EXECUTE'
          )
      ) then
      raise exception using
        errcode = '55000',
        message = 'PUBLIC_ACL_INTERNAL_FUNCTION_POSTFLIGHT_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  foreach v_signature in array array[
    'public.apply_discord_member_join_v2(text,timestamptz,text,text,text,timestamptz)',
    'public.apply_discord_member_join(text,timestamptz,text,text,text)',
    'public.apply_discord_member_remove(text,timestamptz,text,text,text)',
    'public.apply_discord_ban(text,timestamptz,text,text,text)',
    'public.apply_discord_unban(text,timestamptz,text,text,text)',
    'public.begin_discord_reconciliation_snapshot(text,timestamptz,text,uuid,integer,integer)',
    'public.append_discord_reconciliation_chunk(text,text,timestamptz,text,uuid,jsonb)',
    'public.finalize_discord_reconciliation_snapshot(text,timestamptz,text,uuid)',
    'public.record_discord_reconciliation_failure(text,timestamptz,text,text)',
    'public.get_cancerculture_session_access(uuid)',
    'public.create_cancerculture_session(uuid,text)'
  ] loop
    v_function := to_regprocedure(v_signature);

    if (
      select count(*)
      from pg_proc p
      cross join lateral aclexplode(
        coalesce(p.proacl, acldefault('f', p.proowner))
      ) acl
      where p.oid = v_function
    ) <> 2
      or not has_function_privilege('service_role', v_function, 'EXECUTE')
      or has_function_privilege('anon', v_function, 'EXECUTE')
      or has_function_privilege('authenticated', v_function, 'EXECUTE')
      or has_function_privilege('discord_bot', v_function, 'EXECUTE') then
      raise exception using
        errcode = '55000',
        message = 'PUBLIC_ACL_OUTER_FUNCTION_POSTFLIGHT_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  v_function := to_regprocedure(
    'public.sync_discord_user_context(text,text,text,text)'
  );
  if (
    select count(*)
    from pg_proc p
    cross join lateral aclexplode(
      coalesce(p.proacl, acldefault('f', p.proowner))
    ) acl
    where p.oid = v_function
  ) <> 3
    or not has_function_privilege('service_role', v_function, 'EXECUTE')
    or not has_function_privilege('discord_bot', v_function, 'EXECUTE')
    or has_function_privilege('anon', v_function, 'EXECUTE')
    or has_function_privilege('authenticated', v_function, 'EXECUTE') then
    raise exception using
      errcode = '55000',
      message = 'PUBLIC_ACL_SYNC_FUNCTION_POSTFLIGHT_MISMATCH';
  end if;

  if not has_table_privilege(
      'discord_bot', 'public.discord_guard_logs', 'INSERT'
    )
    or has_table_privilege(
      'discord_bot', 'public.discord_guard_logs', 'SELECT'
    )
    or has_table_privilege(
      'discord_bot', 'public.discord_guard_logs', 'UPDATE'
    )
    or has_table_privilege(
      'discord_bot', 'public.discord_guard_logs', 'DELETE'
    )
    or not has_sequence_privilege(
      'discord_bot', 'public.discord_guard_logs_id_seq', 'USAGE'
    )
    or not has_sequence_privilege(
      'discord_bot', 'public.discord_guard_logs_id_seq', 'SELECT'
    )
    or has_sequence_privilege(
      'discord_bot', 'public.discord_guard_logs_id_seq', 'UPDATE'
    ) then
    raise exception using
      errcode = '55000',
      message = 'PUBLIC_ACL_DISCORD_GUARD_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;

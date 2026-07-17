-- LIVE catch-up package F: RLS, grants, and SECURITY DEFINER hardening

begin;

-- The Website uses server-side service-role access. Browser roles receive no
-- direct public-schema table/view privileges.
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- The Bot may append guard logs but may not directly mutate membership state.
revoke all on table public.discord_member_state from discord_bot;
grant insert on table public.discord_guard_logs to discord_bot;
grant select, usage on sequence public.discord_guard_logs_id_seq to discord_bot;

-- Preserve the reviewed policies. They remain inert unless a matching table
-- grant is deliberately added later.
drop policy if exists "Allow realtime read access to votes" on public.votes;
create policy "Allow realtime read access to votes"
  on public.votes
  for select
  to anon, authenticated
  using (true);

-- Pin every privileged function to a non-user-writable search path and remove
-- PostgreSQL's default PUBLIC execute privilege.
do $$
declare
  v_function record;
begin
  for v_function in
    select
      n.nspname as schema_name,
      p.proname as function_name,
      pg_get_function_identity_arguments(p.oid) as identity_arguments
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
    order by p.proname, pg_get_function_identity_arguments(p.oid)
  loop
    execute format(
      'alter function %I.%I(%s) set search_path = public, pg_temp',
      v_function.schema_name,
      v_function.function_name,
      v_function.identity_arguments
    );
    execute format(
      'revoke all on function %I.%I(%s) from public',
      v_function.schema_name,
      v_function.function_name,
      v_function.identity_arguments
    );
  end loop;
end;
$$;

-- This retained Legacy function is called only by trusted server/Bot roles.
revoke all on function public.sync_discord_user_context(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.sync_discord_user_context(text, text, text, text)
  to service_role, discord_bot;

-- The current Website queries this view through the server-side service role.
revoke all on table public.public_submissions_with_votes
  from public, anon, authenticated;
grant select on table public.public_submissions_with_votes to service_role;

commit;

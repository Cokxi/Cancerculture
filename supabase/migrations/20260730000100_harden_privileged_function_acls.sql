begin;

-- Privileged cycle RPCs are server-only. Revoke direct browser grants as well
-- as any privilege inherited through PostgreSQL's PUBLIC pseudo-role.
revoke execute on function public.finalize_cycle(bigint, text)
  from public, anon, authenticated;

revoke execute on function public.reset_cycle(bigint, text, text)
  from public, anon, authenticated;

revoke execute on function public.start_cycle(bigint, text, jsonb)
  from public, anon, authenticated;

revoke execute on function public.process_due_cycle_transitions(bigint)
  from public, anon, authenticated;

grant execute on function public.finalize_cycle(bigint, text)
  to service_role;

grant execute on function public.reset_cycle(bigint, text, text)
  to service_role;

grant execute on function public.start_cycle(bigint, text, jsonb)
  to service_role;

grant execute on function public.process_due_cycle_transitions(bigint)
  to service_role;

-- These functions are invoked only by their existing triggers. Trigger
-- execution does not require callers to retain direct EXECUTE privileges.
revoke execute on function public.reset_social_verification_on_change()
  from public, anon, authenticated, service_role, discord_bot;

revoke execute on function public.set_user_logs_updated_at()
  from public, anon, authenticated, service_role, discord_bot;

-- This retained legacy RPC is restricted to trusted server and Discord Bot
-- callers and uses the canonical SECURITY DEFINER search path.
alter function public.sync_discord_user_context(text, text, text, text)
  set search_path = public, pg_temp;

revoke execute on function public.sync_discord_user_context(text, text, text, text)
  from public, anon, authenticated;

grant execute on function public.sync_discord_user_context(text, text, text, text)
  to service_role, discord_bot;

commit;

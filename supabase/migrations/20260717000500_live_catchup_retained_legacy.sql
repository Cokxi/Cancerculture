-- LIVE catch-up package E: retained active Legacy structures
--
-- These objects predate the repository migration chain. They are deliberately
-- retained rather than recreated because the pre-catch-up LIVE schema and the
-- reviewed DEV baseline contain them with matching object identities. This
-- package makes that exclusion explicit and fails closed if an expected object
-- is absent.

begin;

do $$
declare
  v_name text;
  v_tables constant text[] := array[
    'admin_action_logs',
    'admin_invites',
    'app_config',
    'avatar_upload_logs',
    'blocked_cycle_events',
    'blocked_user_meta',
    'cycle_rule_templates',
    'cycle_sponsorships',
    'discord_guard_logs',
    'invite_auth_logs',
    'moderation_action_logs',
    'next_cycle_config',
    'rules_meta',
    'sessions',
    'social_verification_logs',
    'sponsor_tracking_events',
    'submission_private_data',
    'submission_social_links',
    'team_members',
    'upload_logs',
    'user_cycle_acceptance',
    'user_logs',
    'user_social_links',
    'vote_logs',
    'winner_public_profiles'
  ];
  v_views constant text[] := array[
    'submissions_with_votes',
    'user_logs_with_stats'
  ];
  v_functions constant text[] := array[
    'public.reset_social_verification_on_change()',
    'public.set_user_logs_updated_at()',
    'public.sync_discord_user_context(text,text,text,text)'
  ];
begin
  foreach v_name in array v_tables loop
    if to_regclass(format('public.%I', v_name)) is null then
      raise exception 'Missing retained Legacy table: public.%', v_name;
    end if;
  end loop;

  foreach v_name in array v_views loop
    if to_regclass(format('public.%I', v_name)) is null then
      raise exception 'Missing retained Legacy view: public.%', v_name;
    end if;
  end loop;

  foreach v_name in array v_functions loop
    if to_regprocedure(v_name) is null then
      raise exception 'Missing retained Legacy function: %', v_name;
    end if;
  end loop;
end;
$$;

commit;

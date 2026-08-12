\set ON_ERROR_STOP on

begin;

set local statement_timeout = '60s';

\if :{?expected_preserved_fingerprint_md5}
\else
\set expected_preserved_fingerprint_md5 ''
\endif

\ir prelaunchApplicationDataFactoryResetPreservedFingerprint.inc.sql

select set_config(
  'cancerculture.factory_reset_expected_preserved_fingerprint_md5',
  :'expected_preserved_fingerprint_md5',
  true
);
select set_config(
  'cancerculture.factory_reset_actual_preserved_fingerprint_md5',
  :'preserved_fingerprint_md5',
  true
);

do $postflight$
declare
  v_admin_discord_user_id text;
  v_session_result jsonb;
  v_cycle_id constant bigint := 8900000000001;
  v_cycle_number bigint;
  v_table_name text;
  v_row_count bigint;
  v_expected_preserved_fingerprint text := current_setting(
    'cancerculture.factory_reset_expected_preserved_fingerprint_md5', true
  );
  v_actual_preserved_fingerprint text := current_setting(
    'cancerculture.factory_reset_actual_preserved_fingerprint_md5', true
  );
begin
  if coalesce(v_expected_preserved_fingerprint, '') !~ '^[0-9a-f]{32}$'
    or v_actual_preserved_fingerprint is distinct from
      v_expected_preserved_fingerprint then
    raise exception 'FACTORY_RESET_PRESERVED_CONTENT_FINGERPRINT_MISMATCH';
  end if;

  if (select count(*) from public.user_logs) <> 1
    or (select count(*) from public.team_members) <> 1
    or (
      select count(*)
      from public.team_members member
      join public.user_logs account
        on account.discord_user_id = member.discord_user_id
      where member.role = 'admin'
    ) <> 1
    or (select count(*) from public.team_role_capabilities) <> 0 then
    raise exception 'FACTORY_RESET_ADMIN_BASELINE_MISMATCH';
  end if;

  if exists (
    select 1
    from public.user_logs
    where flagged_for_review
      or is_banned
      or first_seen_at is distinct from created_at
      or last_seen_at is distinct from created_at
      or avatar_key is not null
      or accepted_rules_version is not null
      or show_socials
      or show_socials_on_submissions
      or coalesce(upload_fail_count, 0) <> 0
      or coalesce(attention_events_count, 0) <> 0
      or coalesce(upload_fail_cycle_count, 0) <> 0
      or coalesce(auto_banned, false)
      or website_ban_version <> 0
  ) then
    raise exception 'FACTORY_RESET_ADMIN_ACTIVITY_NOT_CLEAN';
  end if;

  if exists (
      select 1
      from public.app_config
      where (
          key in ('next_cycle_is_sponsored', 'next_cycle_sponsored_enabled')
          and value is distinct from 'false'
        )
        or (
          key in (
            'next_cycle_reward_description',
            'next_cycle_sponsor_banner_r2_key',
            'next_cycle_sponsor_banner_key',
            'next_cycle_sponsor_link',
            'next_cycle_sponsor_name'
          )
          and value is not null
        )
    )
    or exists (
      select 1
      from public.next_cycle_config
      where is_sponsored
        or sponsor_name is not null
        or sponsor_link is not null
        or reward_description is not null
        or sponsor_banner_key is not null
    ) then
    raise exception 'FACTORY_RESET_SPONSOR_BASELINE_MISMATCH';
  end if;

  if (select count(*) from public.capability_catalog) <> 38
    or (select count(*) from public.team_roles where is_system) <> 4
    or (select count(*) from public.content_documents) <> 2
    or (select count(*) from public.content_revisions) < 2
    or (select count(*) from public.content_publications) < 2
    or (select count(*) from public.homepage_info_blocks) < 1
    or (select count(*) from public.cycle_vote_signal_policies) < 1
    or (select count(*) from public.cycle_vote_signal_policy_state) <> 1
    or (select count(*) from public.cycle_scheduler_health) <> 1
    or (select count(*) from public.discord_sync_health) <> 1 then
    raise exception 'FACTORY_RESET_PRESERVED_CONFIGURATION_MISMATCH';
  end if;

  foreach v_table_name in array array[
    'admin_action_logs',
    'admin_invites',
    'avatar_upload_logs',
    'blocked_cycle_events',
    'blocked_user_meta',
    'content_management_requests',
    'cycle_events',
    'cycle_management_requests',
    'cycle_reminders',
    'cycle_results',
    'cycle_sponsorships',
    'cycle_vote_observation_events',
    'cycle_vote_observation_snapshots',
    'cycle_vote_signal_bindings',
    'cycle_vote_submission_observations',
    'discord_guard_logs',
    'discord_member_state',
    'discord_membership_sync_events',
    'discord_reconciliation_bans',
    'discord_reconciliation_members',
    'discord_reconciliation_snapshots',
    'invite_auth_logs',
    'media_cleanup_queue',
    'moderation_action_logs',
    'sessions',
    'social_verification_logs',
    'sponsor_tracking_events',
    'submission_disqualification_events',
    'submission_moderation_requests',
    'submission_private_data',
    'submission_report_case_events',
    'submission_report_cases',
    'submission_report_payloads',
    'submission_report_reads',
    'submission_report_requests',
    'submission_reporter_identities',
    'submission_reports',
    'submission_social_links',
    'submission_upload_abuse_states',
    'submission_upload_operations',
    'submissions',
    'team_authorization_audit',
    'team_authorization_batches',
    'team_role_capabilities',
    'upload_logs',
    'user_cycle_acceptance',
    'user_flag_actor_snapshots',
    'user_flag_cases',
    'user_flag_events',
    'user_flag_requests',
    'user_social_links',
    'vote_logs',
    'vote_refund_events',
    'vote_refund_items',
    'votes',
    'voting_cycles',
    'website_ban_events',
    'website_ban_requests',
    'winner_public_profiles'
  ]
  loop
    execute format('select count(*) from public.%I', v_table_name)
      into v_row_count;
    if v_row_count <> 0 then
      raise exception 'FACTORY_RESET_APPLICATION_DATA_NOT_EMPTY: %',
        v_table_name;
    end if;
  end loop;

  select member.discord_user_id
  into strict v_admin_discord_user_id
  from public.team_members member
  where member.role = 'admin';

  v_session_result := public.create_cancerculture_session(
    gen_random_uuid(),
    v_admin_discord_user_id
  );

  if v_session_result ->> 'outcome' <> 'created'
    or (select count(*) from public.sessions) <> 1 then
    raise exception 'FACTORY_RESET_ADMIN_RELOGIN_CONTRACT_FAILED';
  end if;

  insert into public.voting_cycles(id, status, title, theme)
  values (
    v_cycle_id,
    'submission_open',
    'Factory reset postflight',
    'Factory reset postflight'
  )
  returning public_number into v_cycle_number;

  if v_cycle_number <> 1 then
    raise exception 'FACTORY_RESET_NEXT_PUBLIC_CYCLE_NUMBER_MISMATCH';
  end if;
end;
$postflight$;

rollback;

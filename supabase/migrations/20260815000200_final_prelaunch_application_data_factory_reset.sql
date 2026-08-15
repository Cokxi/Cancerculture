begin;

set local lock_timeout = '10s';
set local statement_timeout = '180s';

create temporary table factory_reset_disposition (
  table_name text primary key,
  disposition text not null check (disposition in ('preserve', 'subset', 'reset'))
) on commit drop;

insert into factory_reset_disposition(table_name, disposition)
values
  ('admin_action_logs', 'reset'),
  ('admin_invites', 'reset'),
  ('app_config', 'preserve'),
  ('avatar_upload_logs', 'reset'),
  ('blocked_cycle_events', 'reset'),
  ('blocked_user_meta', 'reset'),
  ('capability_catalog', 'preserve'),
  ('coin_launches', 'preserve'),
  ('content_documents', 'preserve'),
  ('content_management_requests', 'reset'),
  ('content_publications', 'preserve'),
  ('content_revisions', 'preserve'),
  ('cycle_events', 'reset'),
  ('cycle_management_requests', 'reset'),
  ('cycle_reminders', 'reset'),
  ('cycle_results', 'reset'),
  ('cycle_rule_templates', 'preserve'),
  ('cycle_scheduler_health', 'preserve'),
  ('cycle_sponsorships', 'reset'),
  ('cycle_vote_observation_events', 'reset'),
  ('cycle_vote_observation_snapshots', 'reset'),
  ('cycle_vote_signal_bindings', 'reset'),
  ('cycle_vote_signal_policies', 'preserve'),
  ('cycle_vote_signal_policy_state', 'preserve'),
  ('cycle_vote_submission_observations', 'reset'),
  ('discord_guard_logs', 'reset'),
  ('discord_member_state', 'reset'),
  ('discord_membership_sync_events', 'reset'),
  ('discord_reconciliation_bans', 'reset'),
  ('discord_reconciliation_members', 'reset'),
  ('discord_reconciliation_snapshots', 'reset'),
  ('discord_sync_health', 'preserve'),
  ('homepage_info_blocks', 'preserve'),
  ('invite_auth_logs', 'reset'),
  ('media_cleanup_queue', 'reset'),
  ('moderation_action_logs', 'reset'),
  ('next_cycle_config', 'preserve'),
  ('rules_meta', 'preserve'),
  ('sessions', 'reset'),
  ('social_verification_logs', 'reset'),
  ('sponsor_media_upload_operations', 'reset'),
  ('sponsor_tracking_aggregates', 'reset'),
  ('sponsor_tracking_events', 'reset'),
  ('submission_disqualification_events', 'reset'),
  ('submission_moderation_requests', 'reset'),
  ('submission_private_data', 'reset'),
  ('submission_report_case_events', 'reset'),
  ('submission_report_cases', 'reset'),
  ('submission_report_payloads', 'reset'),
  ('submission_report_reads', 'reset'),
  ('submission_report_requests', 'reset'),
  ('submission_reporter_identities', 'reset'),
  ('submission_reports', 'reset'),
  ('submission_social_links', 'reset'),
  ('submission_upload_abuse_states', 'reset'),
  ('submission_upload_operations', 'reset'),
  ('submissions', 'reset'),
  ('team_authorization_audit', 'reset'),
  ('team_authorization_batches', 'reset'),
  ('team_members', 'subset'),
  ('team_role_capabilities', 'reset'),
  ('team_roles', 'preserve'),
  ('upload_logs', 'reset'),
  ('user_cycle_acceptance', 'reset'),
  ('user_flag_actor_snapshots', 'reset'),
  ('user_flag_cases', 'reset'),
  ('user_flag_events', 'reset'),
  ('user_flag_requests', 'reset'),
  ('user_logs', 'subset'),
  ('user_social_links', 'reset'),
  ('vote_logs', 'reset'),
  ('vote_refund_events', 'reset'),
  ('vote_refund_items', 'reset'),
  ('votes', 'reset'),
  ('voting_cycles', 'reset'),
  ('website_ban_events', 'reset'),
  ('website_ban_requests', 'reset'),
  ('winner_public_profiles', 'reset');

do $target_preflight$
declare
  v_expected_tables text[];
  v_actual_tables text[];
  v_actual_views text[];
  v_target text;
  v_confirmation text;
  v_owner_fingerprint text;
  v_rollback_only boolean;
  v_hash text;
begin
  select array_agg(table_name order by table_name)
  into v_expected_tables
  from factory_reset_disposition;

  select array_agg(table_name order by table_name)
  into v_actual_tables
  from information_schema.tables
  where table_schema = 'public'
    and table_type = 'BASE TABLE';

  if cardinality(v_expected_tables) <> 78
    or v_actual_tables is distinct from v_expected_tables then
    raise exception using errcode = '55000',
      message = 'FINAL_FACTORY_RESET_78_TABLE_CATALOG_MISMATCH';
  end if;

  select array_agg(table_name order by table_name)
  into v_actual_views
  from information_schema.views
  where table_schema = 'public';

  if v_actual_views is distinct from array[
    'public_submissions_with_votes',
    'submissions_with_votes',
    'user_logs_with_stats',
    'vote_refund_candidates',
    'vote_refund_submission_audit'
  ]::text[] then
    raise exception using errcode = '55000',
      message = 'FINAL_FACTORY_RESET_5_VIEW_CATALOG_MISMATCH';
  end if;

  if (select count(*) from pg_sequences where schemaname = 'public') <> 20 then
    raise exception using errcode = '55000',
      message = 'FINAL_FACTORY_RESET_20_SEQUENCE_CATALOG_MISMATCH';
  end if;

  v_target := current_setting('cancerculture.factory_reset_target_project_ref', true);
  v_confirmation := current_setting('cancerculture.factory_reset_confirmation', true);
  v_owner_fingerprint := current_setting('cancerculture.factory_reset_owner_anchor_fingerprint', true);
  v_rollback_only := current_setting('cancerculture.factory_reset_rollback_only', true) = 'on';

  if (not v_rollback_only and (
      v_target is distinct from 'nrxfuvsfezfqcwfmpxxl'
      or v_confirmation is distinct from 'FINAL_PRELAUNCH_LIVE_RESET_20260815_A1'
      or v_owner_fingerprint is distinct from '7f3f31d172f4d928ef01de221b7d6a1'
    ))
    or (v_rollback_only and (
      v_target is distinct from 'gceljiuydyiwkomymuqh'
      or v_confirmation is distinct from 'FINAL_PRELAUNCH_DEV_ROLLBACK_ONLY_20260815'
      or coalesce(v_owner_fingerprint, '') !~ '^[0-9a-f]{32}$'
    )) then
    raise exception using errcode = '55000',
      message = 'FINAL_FACTORY_RESET_TARGET_CONFIRMATION_MISMATCH';
  end if;

  foreach v_hash in array array[
    current_setting('cancerculture.factory_reset_backup_sha256', true),
    current_setting('cancerculture.factory_reset_backup_record_sha256', true),
    current_setting('cancerculture.factory_reset_media_manifest_sha256', true),
    current_setting('cancerculture.factory_reset_catalog_sha256', true),
    current_setting('cancerculture.factory_reset_data_sha256', true),
    current_setting('cancerculture.factory_reset_reference_sha256', true)
  ]
  loop
    if coalesce(v_hash, '') !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '55000',
        message = 'FINAL_FACTORY_RESET_HASH_BINDING_REQUIRED';
    end if;
  end loop;

  if (
    select array_agg(key order by key)
    from public.team_roles
    where is_system and is_active
  ) is distinct from array[
    'admin', 'moderator', 'super_moderator', 'trial_moderator'
  ]::text[]
    or exists (select 1 from public.team_roles where not is_system)
    or (select count(*) from public.team_members where role = 'admin') <> 1
    or (
      select count(*)
      from public.team_members member
      join public.user_logs account using (discord_user_id)
      where member.role = 'admin'
        and account.public_profile_id is not null
    ) <> 1 then
    raise exception using errcode = '55000',
      message = 'FINAL_FACTORY_RESET_OWNER_ANCHOR_MISMATCH';
  end if;

  if to_regprocedure('public.assign_voting_cycle_public_number()') is null
    or not exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.voting_cycles'::regclass
        and trigger_row.tgname = 'voting_cycles_assign_public_number'
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled = 'O'
    )
    or to_regclass('public.sponsor_tracking_aggregates') is null
    or to_regclass('public.sponsor_media_upload_operations') is null
    or to_regprocedure('public.record_sponsor_event_v2(text,bigint,text,text,text)') is null then
    raise exception using errcode = '55000',
      message = 'FINAL_FACTORY_RESET_CURRENT_SCHEMA_CONTRACT_MISSING';
  end if;
end;
$target_preflight$;

do $writer_preflight$
begin
  if exists (
      select 1 from public.submission_upload_operations
      where status in ('reserved', 'r2_uploaded')
    )
    or exists (
      select 1 from public.sponsor_media_upload_operations
      where status = 'reserved'
    )
    or exists (
      select 1 from public.media_cleanup_queue
      where status <> 'completed'
    )
    or exists (
      select 1 from public.discord_reconciliation_snapshots
      where status = 'collecting'
    )
    or exists (
      select 1 from public.cycle_scheduler_health
      where active_run_id is not null
    )
    or exists (
      select 1
      from pg_stat_activity
      where pid <> pg_backend_pid()
        and datname = current_database()
        and backend_type = 'client backend'
        and backend_xid is not null
    ) then
    raise exception using errcode = '55000',
      message = 'FINAL_FACTORY_RESET_WRITERS_NOT_QUIESCENT';
  end if;
end;
$writer_preflight$;

create temporary table factory_reset_admin_user
  (like public.user_logs including defaults including constraints)
  on commit drop;
create temporary table factory_reset_admin_member
  (like public.team_members including defaults including constraints)
  on commit drop;

insert into factory_reset_admin_user
select account.*
from public.user_logs account
join public.team_members member using (discord_user_id)
where member.role = 'admin';

insert into factory_reset_admin_member
select * from public.team_members where role = 'admin';

create temporary table factory_reset_admin_fingerprint on commit drop as
select
  md5(jsonb_build_object(
    'discord_user_id', account.discord_user_id,
    'public_profile_id', account.public_profile_id,
    'created_at', account.created_at,
    'current_discord_username', account.current_discord_username
  )::text) as account_hash,
  md5(to_jsonb(member)::text) as member_hash
from factory_reset_admin_user account
cross join factory_reset_admin_member member;

create temporary table factory_reset_data_before (
  table_name text primary key,
  row_count bigint not null,
  content_hash text not null
) on commit drop;

do $capture_data$
declare
  v_table text;
  v_count bigint;
  v_hash text;
begin
  for v_table in select table_name from factory_reset_disposition order by table_name
  loop
    execute format(
      'select count(*)::bigint, md5(coalesce(string_agg(md5(to_jsonb(source_row)::text), '''' order by md5(to_jsonb(source_row)::text)), '''')) from public.%I source_row',
      v_table
    ) into v_count, v_hash;
    insert into factory_reset_data_before values (v_table, v_count, v_hash);
  end loop;
end;
$capture_data$;

create temporary table factory_reset_special_preserve_before (
  contract_name text primary key,
  row_count bigint not null,
  content_hash text not null
) on commit drop;

insert into factory_reset_special_preserve_before
select 'app_config_non_sponsor', count(*)::bigint,
  md5(coalesce(string_agg(md5(to_jsonb(config_row)::text), '' order by config_row.key), ''))
from public.app_config config_row
where config_row.key not in (
  'next_cycle_is_sponsored', 'next_cycle_sponsored_enabled',
  'next_cycle_reward_description', 'next_cycle_sponsor_name',
  'next_cycle_sponsor_link', 'next_cycle_sponsor_banner_key',
  'next_cycle_sponsor_banner_r2_key',
  'next_cycle_sponsor_feed_banner_r2_key',
  'next_cycle_sponsor_draft_revision'
)
union all
select 'next_cycle_config_non_sponsor', count(*)::bigint,
  md5(coalesce(string_agg(md5(jsonb_build_object(
    'id', config_row.id,
    'title', config_row.title,
    'theme', config_row.theme,
    'rule_template_id', config_row.rule_template_id
  )::text), '' order by config_row.id), ''))
from public.next_cycle_config config_row;

create temporary table factory_reset_sequence_before on commit drop as
select schemaname, sequencename, last_value, start_value, increment_by,
  min_value, max_value, cache_size, cycle
from pg_sequences
where schemaname = 'public';

create temporary table factory_reset_contract_snapshot (
  phase text not null,
  contract_name text not null,
  row_count bigint not null,
  content_hash text not null,
  primary key (phase, contract_name)
) on commit drop;

with contract_rows(contract_name, contract_value) as (
  select 'relations', concat_ws(':', class_row.relkind, class_row.relname,
    pg_get_userbyid(class_row.relowner), class_row.relrowsecurity,
    class_row.relforcerowsecurity, coalesce(class_row.relacl::text, '<default>'))
  from pg_class class_row
  join pg_namespace namespace_row on namespace_row.oid = class_row.relnamespace
  where namespace_row.nspname = 'public'
    and class_row.relkind in ('r', 'p', 'v', 'm', 'S')
  union all
  select 'columns', concat_ws(':', table_name, ordinal_position, column_name,
    data_type, udt_name, is_nullable, coalesce(column_default, '<none>'))
  from information_schema.columns where table_schema = 'public'
  union all
  select 'constraints', concat_ws(':', class_row.relname, constraint_row.conname,
    constraint_row.contype, pg_get_constraintdef(constraint_row.oid, true))
  from pg_constraint constraint_row
  join pg_class class_row on class_row.oid = constraint_row.conrelid
  join pg_namespace namespace_row on namespace_row.oid = class_row.relnamespace
  where namespace_row.nspname = 'public'
  union all
  select 'indexes', concat_ws(':', table_row.relname, index_row.relname,
    pg_get_indexdef(index_row.oid))
  from pg_index index_meta
  join pg_class table_row on table_row.oid = index_meta.indrelid
  join pg_class index_row on index_row.oid = index_meta.indexrelid
  join pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
  where namespace_row.nspname = 'public'
  union all
  select 'triggers', concat_ws(':', table_row.relname, trigger_row.tgname,
    trigger_row.tgenabled::text, pg_get_triggerdef(trigger_row.oid, true))
  from pg_trigger trigger_row
  join pg_class table_row on table_row.oid = trigger_row.tgrelid
  join pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
  where namespace_row.nspname = 'public' and not trigger_row.tgisinternal
  union all
  select 'foreign_keys', concat_ws(':', table_row.relname, constraint_row.conname,
    pg_get_constraintdef(constraint_row.oid, true))
  from pg_constraint constraint_row
  join pg_class table_row on table_row.oid = constraint_row.conrelid
  join pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
  where namespace_row.nspname = 'public' and constraint_row.contype = 'f'
  union all
  select 'policies', to_jsonb(policy_row)::text
  from pg_policies policy_row where policy_row.schemaname = 'public'
  union all
  select 'functions', concat_ws(':', function_row.oid::regprocedure::text,
    pg_get_userbyid(function_row.proowner), function_row.prosecdef,
    function_row.provolatile, coalesce(array_to_string(function_row.proconfig, ';'), '<default>'),
    coalesce(function_row.proacl::text, '<default>'), md5(pg_get_functiondef(function_row.oid)))
  from pg_proc function_row
  join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
  where namespace_row.nspname = 'public' and function_row.prokind in ('f', 'p')
  union all
  select 'schema_acl', concat_ws(':', pg_get_userbyid(namespace_row.nspowner),
    coalesce(namespace_row.nspacl::text, '<default>'))
  from pg_namespace namespace_row where namespace_row.nspname = 'public'
)
insert into factory_reset_contract_snapshot
select 'before', contract_name, count(*)::bigint,
  md5(coalesce(string_agg(md5(contract_value), '' order by md5(contract_value)), ''))
from contract_rows group by contract_name;

do $hash_binding$
declare
  v_catalog_sha text;
  v_data_sha text;
  v_reference_sha text;
begin
  select encode(extensions.digest(string_agg(
    contract_name || ':' || row_count || ':' || content_hash,
    '' order by contract_name
  ), 'sha256'), 'hex')
  into v_catalog_sha
  from factory_reset_contract_snapshot where phase = 'before';

  select encode(extensions.digest(string_agg(
    table_name || ':' || row_count || ':' || content_hash,
    '' order by table_name
  ), 'sha256'), 'hex')
  into v_data_sha
  from factory_reset_data_before;

  select encode(extensions.digest(string_agg(
    table_name || ':' || row_count || ':' || content_hash,
    '' order by table_name
  ), 'sha256'), 'hex')
  into v_reference_sha
  from factory_reset_data_before
  where table_name in (
    'app_config', 'avatar_upload_logs', 'cycle_sponsorships',
    'media_cleanup_queue', 'next_cycle_config',
    'sponsor_media_upload_operations', 'submission_upload_operations',
    'submissions', 'user_logs', 'voting_cycles', 'winner_public_profiles'
  );

  if v_catalog_sha is distinct from current_setting('cancerculture.factory_reset_catalog_sha256', true)
    or v_data_sha is distinct from current_setting('cancerculture.factory_reset_data_sha256', true)
    or v_reference_sha is distinct from current_setting('cancerculture.factory_reset_reference_sha256', true) then
    raise exception using errcode = '55000',
      message = 'FINAL_FACTORY_RESET_FINGERPRINT_BINDING_MISMATCH';
  end if;
end;
$hash_binding$;

truncate table
  public.admin_action_logs,
  public.admin_invites,
  public.avatar_upload_logs,
  public.blocked_cycle_events,
  public.blocked_user_meta,
  public.content_management_requests,
  public.cycle_events,
  public.cycle_management_requests,
  public.cycle_reminders,
  public.cycle_results,
  public.cycle_sponsorships,
  public.cycle_vote_observation_events,
  public.cycle_vote_observation_snapshots,
  public.cycle_vote_signal_bindings,
  public.cycle_vote_submission_observations,
  public.discord_guard_logs,
  public.discord_member_state,
  public.discord_membership_sync_events,
  public.discord_reconciliation_bans,
  public.discord_reconciliation_members,
  public.discord_reconciliation_snapshots,
  public.invite_auth_logs,
  public.media_cleanup_queue,
  public.moderation_action_logs,
  public.sessions,
  public.social_verification_logs,
  public.sponsor_media_upload_operations,
  public.sponsor_tracking_aggregates,
  public.sponsor_tracking_events,
  public.submission_disqualification_events,
  public.submission_moderation_requests,
  public.submission_private_data,
  public.submission_report_case_events,
  public.submission_report_cases,
  public.submission_report_payloads,
  public.submission_report_reads,
  public.submission_report_requests,
  public.submission_reporter_identities,
  public.submission_reports,
  public.submission_social_links,
  public.submission_upload_abuse_states,
  public.submission_upload_operations,
  public.submissions,
  public.team_authorization_audit,
  public.team_authorization_batches,
  public.team_members,
  public.team_role_capabilities,
  public.upload_logs,
  public.user_cycle_acceptance,
  public.user_flag_actor_snapshots,
  public.user_flag_cases,
  public.user_flag_events,
  public.user_flag_requests,
  public.user_logs,
  public.user_social_links,
  public.vote_logs,
  public.vote_refund_events,
  public.vote_refund_items,
  public.votes,
  public.voting_cycles,
  public.website_ban_events,
  public.website_ban_requests,
  public.winner_public_profiles
continue identity restrict;

insert into public.user_logs select * from factory_reset_admin_user;
insert into public.team_members select * from factory_reset_admin_member;

update public.user_logs
set first_seen_at = created_at,
  last_seen_at = created_at,
  known_discord_usernames = array[current_discord_username],
  username_change_count = 0,
  flagged_for_review = false,
  flagged_at = null,
  flagged_by_discord_user_id = null,
  flagged_by_discord_username = null,
  unflagged_at = null,
  unflagged_by_discord_user_id = null,
  unflagged_by_discord_username = null,
  internal_notes = null,
  flag_reason_code = null,
  flag_note = null,
  is_banned = false,
  banned_by_discord_username = null,
  unbanned_by_discord_username = null,
  unflag_reason = null,
  ban_reason = null,
  ban_source = null,
  banned_at = null,
  banned_by_discord_user_id = null,
  unbanned_at = null,
  unban_reason = null,
  unbanned_by_discord_user_id = null,
  upload_fail_count = 0,
  upload_fail_window_start = null,
  last_upload_fail_at = null,
  attention_events_count = 0,
  upload_fail_cycle_count = 0,
  upload_cooldown_until = null,
  auto_banned = false,
  accepted_rules_version = null,
  avatar_key = null,
  avatar_updated_at = null,
  show_socials = false,
  show_socials_on_submissions = false,
  known_display_names = case when current_display_name is null then '{}'::text[] else array[current_display_name] end,
  known_guild_nicknames = case when current_guild_nickname is null then '{}'::text[] else array[current_guild_nickname] end,
  website_ban_version = 0;

update public.app_config
set value = case
  when key in ('next_cycle_is_sponsored', 'next_cycle_sponsored_enabled') then 'false'
  when key = 'next_cycle_sponsor_draft_revision' then '0'
  else null
end
where key in (
  'next_cycle_is_sponsored',
  'next_cycle_sponsored_enabled',
  'next_cycle_reward_description',
  'next_cycle_sponsor_name',
  'next_cycle_sponsor_link',
  'next_cycle_sponsor_banner_key',
  'next_cycle_sponsor_banner_r2_key',
  'next_cycle_sponsor_feed_banner_r2_key',
  'next_cycle_sponsor_draft_revision'
);

update public.next_cycle_config
set is_sponsored = false,
  sponsor_name = null,
  sponsor_link = null,
  reward_description = null,
  sponsor_banner_key = null,
  updated_by_discord_user_id = null,
  updated_by_discord_username = null;

with contract_rows(contract_name, contract_value) as (
  select 'relations', concat_ws(':', class_row.relkind, class_row.relname,
    pg_get_userbyid(class_row.relowner), class_row.relrowsecurity,
    class_row.relforcerowsecurity, coalesce(class_row.relacl::text, '<default>'))
  from pg_class class_row join pg_namespace namespace_row on namespace_row.oid = class_row.relnamespace
  where namespace_row.nspname = 'public' and class_row.relkind in ('r', 'p', 'v', 'm', 'S')
  union all select 'columns', concat_ws(':', table_name, ordinal_position, column_name, data_type, udt_name, is_nullable, coalesce(column_default, '<none>')) from information_schema.columns where table_schema = 'public'
  union all select 'constraints', concat_ws(':', class_row.relname, constraint_row.conname, constraint_row.contype, pg_get_constraintdef(constraint_row.oid, true)) from pg_constraint constraint_row join pg_class class_row on class_row.oid = constraint_row.conrelid join pg_namespace namespace_row on namespace_row.oid = class_row.relnamespace where namespace_row.nspname = 'public'
  union all select 'indexes', concat_ws(':', table_row.relname, index_row.relname, pg_get_indexdef(index_row.oid)) from pg_index index_meta join pg_class table_row on table_row.oid = index_meta.indrelid join pg_class index_row on index_row.oid = index_meta.indexrelid join pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace where namespace_row.nspname = 'public'
  union all select 'triggers', concat_ws(':', table_row.relname, trigger_row.tgname, trigger_row.tgenabled::text, pg_get_triggerdef(trigger_row.oid, true)) from pg_trigger trigger_row join pg_class table_row on table_row.oid = trigger_row.tgrelid join pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace where namespace_row.nspname = 'public' and not trigger_row.tgisinternal
  union all select 'foreign_keys', concat_ws(':', table_row.relname, constraint_row.conname, pg_get_constraintdef(constraint_row.oid, true)) from pg_constraint constraint_row join pg_class table_row on table_row.oid = constraint_row.conrelid join pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace where namespace_row.nspname = 'public' and constraint_row.contype = 'f'
  union all select 'policies', to_jsonb(policy_row)::text from pg_policies policy_row where policy_row.schemaname = 'public'
  union all select 'functions', concat_ws(':', function_row.oid::regprocedure::text, pg_get_userbyid(function_row.proowner), function_row.prosecdef, function_row.provolatile, coalesce(array_to_string(function_row.proconfig, ';'), '<default>'), coalesce(function_row.proacl::text, '<default>'), md5(pg_get_functiondef(function_row.oid))) from pg_proc function_row join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace where namespace_row.nspname = 'public' and function_row.prokind in ('f', 'p')
  union all select 'schema_acl', concat_ws(':', pg_get_userbyid(namespace_row.nspowner), coalesce(namespace_row.nspacl::text, '<default>')) from pg_namespace namespace_row where namespace_row.nspname = 'public'
)
insert into factory_reset_contract_snapshot
select 'after', contract_name, count(*)::bigint,
  md5(coalesce(string_agg(md5(contract_value), '' order by md5(contract_value)), ''))
from contract_rows group by contract_name;

do $postflight$
declare
  v_table record;
  v_count bigint;
  v_hash text;
  v_sequence_mismatch bigint;
begin
  for v_table in
    select * from factory_reset_disposition where disposition = 'reset' order by table_name
  loop
    execute format('select count(*)::bigint from public.%I', v_table.table_name) into v_count;
    if v_count <> 0 then
      raise exception using errcode = '55000', message = 'FINAL_FACTORY_RESET_TABLE_NOT_EMPTY', detail = v_table.table_name;
    end if;
  end loop;

  for v_table in
    select disposition.table_name, before_state.row_count, before_state.content_hash
    from factory_reset_disposition disposition
    join factory_reset_data_before before_state using (table_name)
    where disposition.disposition = 'preserve'
      and disposition.table_name not in ('app_config', 'next_cycle_config')
    order by disposition.table_name
  loop
    execute format(
      'select count(*)::bigint, md5(coalesce(string_agg(md5(to_jsonb(source_row)::text), '''' order by md5(to_jsonb(source_row)::text)), '''')) from public.%I source_row',
      v_table.table_name
    ) into v_count, v_hash;
    if v_count is distinct from v_table.row_count
      or v_hash is distinct from v_table.content_hash then
      raise exception using errcode = '55000',
        message = 'FINAL_FACTORY_RESET_PRESERVED_DATA_DRIFT',
        detail = v_table.table_name;
    end if;
  end loop;

  select count(*)::bigint,
    md5(coalesce(string_agg(md5(to_jsonb(config_row)::text), '' order by config_row.key), ''))
  into v_count, v_hash
  from public.app_config config_row
  where config_row.key not in (
    'next_cycle_is_sponsored', 'next_cycle_sponsored_enabled',
    'next_cycle_reward_description', 'next_cycle_sponsor_name',
    'next_cycle_sponsor_link', 'next_cycle_sponsor_banner_key',
    'next_cycle_sponsor_banner_r2_key',
    'next_cycle_sponsor_feed_banner_r2_key',
    'next_cycle_sponsor_draft_revision'
  );
  if not exists (
    select 1 from factory_reset_special_preserve_before
    where contract_name = 'app_config_non_sponsor'
      and row_count = v_count and content_hash = v_hash
  ) then
    raise exception using errcode = '55000', message = 'FINAL_FACTORY_RESET_PRESERVED_APP_CONFIG_DRIFT';
  end if;

  select count(*)::bigint,
    md5(coalesce(string_agg(md5(jsonb_build_object(
      'id', config_row.id, 'title', config_row.title, 'theme', config_row.theme,
      'rule_template_id', config_row.rule_template_id
    )::text), '' order by config_row.id), ''))
  into v_count, v_hash
  from public.next_cycle_config config_row;
  if not exists (
    select 1 from factory_reset_special_preserve_before
    where contract_name = 'next_cycle_config_non_sponsor'
      and row_count = v_count and content_hash = v_hash
  ) then
    raise exception using errcode = '55000', message = 'FINAL_FACTORY_RESET_PRESERVED_NEXT_CYCLE_DRIFT';
  end if;

  if (select count(*) from public.user_logs) <> 1
    or (select count(*) from public.team_members where role = 'admin') <> 1
    or (select count(*) from public.team_role_capabilities) <> 0
    or exists (select 1 from public.voting_cycles)
    or (
      select md5(jsonb_build_object(
        'discord_user_id', account.discord_user_id,
        'public_profile_id', account.public_profile_id,
        'created_at', account.created_at,
        'current_discord_username', account.current_discord_username
      )::text)
      from public.user_logs account
    ) is distinct from (select account_hash from factory_reset_admin_fingerprint)
    or (
      select md5(to_jsonb(member)::text) from public.team_members member
    ) is distinct from (select member_hash from factory_reset_admin_fingerprint)
    or exists (
      select 1 from factory_reset_contract_snapshot before_snapshot
      full join factory_reset_contract_snapshot after_snapshot
        on after_snapshot.contract_name = before_snapshot.contract_name
        and after_snapshot.phase = 'after'
      where before_snapshot.phase = 'before'
        and (after_snapshot.row_count is distinct from before_snapshot.row_count
          or after_snapshot.content_hash is distinct from before_snapshot.content_hash)
    ) then
    raise exception using errcode = '55000', message = 'FINAL_FACTORY_RESET_POSTFLIGHT_FAILED';
  end if;

  select count(*) into v_sequence_mismatch
  from factory_reset_sequence_before before_state
  full join pg_sequences after_state
    on after_state.schemaname = before_state.schemaname
    and after_state.sequencename = before_state.sequencename
  where coalesce(after_state.schemaname, before_state.schemaname) = 'public'
    and (before_state.sequencename is null or after_state.sequencename is null
      or after_state.last_value is distinct from before_state.last_value
      or after_state.start_value is distinct from before_state.start_value
      or after_state.increment_by is distinct from before_state.increment_by
      or after_state.min_value is distinct from before_state.min_value
      or after_state.max_value is distinct from before_state.max_value
      or after_state.cache_size is distinct from before_state.cache_size
      or after_state.cycle is distinct from before_state.cycle);

  if v_sequence_mismatch <> 0 then
    raise exception using errcode = '55000', message = 'FINAL_FACTORY_RESET_SEQUENCE_DRIFT';
  end if;

  if exists (
      select 1 from public.user_logs
      where first_seen_at is distinct from created_at
        or last_seen_at is distinct from created_at
        or avatar_key is not null
        or flagged_for_review or is_banned
        or accepted_rules_version is not null
        or show_socials or show_socials_on_submissions
    )
    or exists (
      select 1 from public.app_config
      where (key in ('next_cycle_is_sponsored', 'next_cycle_sponsored_enabled') and value is distinct from 'false')
        or (key = 'next_cycle_sponsor_draft_revision' and value is distinct from '0')
        or (key in ('next_cycle_reward_description', 'next_cycle_sponsor_name', 'next_cycle_sponsor_link', 'next_cycle_sponsor_banner_key', 'next_cycle_sponsor_banner_r2_key', 'next_cycle_sponsor_feed_banner_r2_key') and value is not null)
    )
    or exists (
      select 1 from public.next_cycle_config
      where is_sponsored or sponsor_name is not null or sponsor_link is not null
        or reward_description is not null or sponsor_banner_key is not null
        or updated_by_discord_user_id is not null or updated_by_discord_username is not null
    ) then
    raise exception using errcode = '55000', message = 'FINAL_FACTORY_RESET_NEUTRALITY_FAILED';
  end if;
end;
$postflight$;

do $rollback_sentinel$
begin
  if current_setting('cancerculture.factory_reset_rollback_only', true) = 'on' then
    raise exception using errcode = 'P0001',
      message = 'FINAL_FACTORY_RESET_ROLLBACK_ONLY_COMPLETE_20260815';
  end if;
end;
$rollback_sentinel$;

commit;

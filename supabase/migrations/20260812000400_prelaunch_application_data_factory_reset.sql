begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

create temporary table factory_reset_tables (
  table_name text primary key,
  preserve_admin_row boolean not null default false
) on commit drop;

insert into factory_reset_tables(table_name, preserve_admin_row)
values
  ('admin_action_logs', false),
  ('admin_invites', false),
  ('avatar_upload_logs', false),
  ('blocked_cycle_events', false),
  ('blocked_user_meta', false),
  ('content_management_requests', false),
  ('cycle_events', false),
  ('cycle_management_requests', false),
  ('cycle_reminders', false),
  ('cycle_results', false),
  ('cycle_sponsorships', false),
  ('cycle_vote_observation_events', false),
  ('cycle_vote_observation_snapshots', false),
  ('cycle_vote_signal_bindings', false),
  ('cycle_vote_submission_observations', false),
  ('discord_guard_logs', false),
  ('discord_member_state', false),
  ('discord_membership_sync_events', false),
  ('discord_reconciliation_bans', false),
  ('discord_reconciliation_members', false),
  ('discord_reconciliation_snapshots', false),
  ('invite_auth_logs', false),
  ('media_cleanup_queue', false),
  ('moderation_action_logs', false),
  ('sessions', false),
  ('social_verification_logs', false),
  ('sponsor_tracking_events', false),
  ('submission_disqualification_events', false),
  ('submission_moderation_requests', false),
  ('submission_private_data', false),
  ('submission_report_case_events', false),
  ('submission_report_cases', false),
  ('submission_report_payloads', false),
  ('submission_report_reads', false),
  ('submission_report_requests', false),
  ('submission_reporter_identities', false),
  ('submission_reports', false),
  ('submission_social_links', false),
  ('submission_upload_abuse_states', false),
  ('submission_upload_operations', false),
  ('submissions', false),
  ('team_authorization_audit', false),
  ('team_authorization_batches', false),
  ('team_members', true),
  ('team_role_capabilities', false),
  ('upload_logs', false),
  ('user_cycle_acceptance', false),
  ('user_flag_actor_snapshots', false),
  ('user_flag_cases', false),
  ('user_flag_events', false),
  ('user_flag_requests', false),
  ('user_logs', true),
  ('user_social_links', false),
  ('vote_logs', false),
  ('vote_refund_events', false),
  ('vote_refund_items', false),
  ('votes', false),
  ('voting_cycles', false),
  ('website_ban_events', false),
  ('website_ban_requests', false),
  ('winner_public_profiles', false);

create temporary table factory_reset_state (
  should_reset boolean not null default false
) on commit drop;

insert into factory_reset_state default values;

do $preflight$
declare
  v_table record;
  v_has_rows boolean;
  v_confirmation text;
  v_backup_sha256 text;
  v_media_manifest_sha256 text;
begin
  for v_table in select table_name from factory_reset_tables order by table_name
  loop
    if to_regclass(format('public.%I', v_table.table_name)) is null then
      raise exception using errcode = '55000',
        message = 'FACTORY_RESET_REQUIRED_TABLE_MISSING',
        detail = v_table.table_name;
    end if;

    execute format(
      'select exists (select 1 from public.%I limit 1)',
      v_table.table_name
    ) into v_has_rows;

    if v_has_rows then
      update factory_reset_state set should_reset = true;
    end if;
  end loop;

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
        or updated_by_discord_user_id is not null
        or updated_by_discord_username is not null
    ) then
    update factory_reset_state set should_reset = true;
  end if;

  if not (select should_reset from factory_reset_state) then
    return;
  end if;

  v_confirmation := current_setting(
    'cancerculture.factory_reset_confirmation', true
  );
  v_backup_sha256 := current_setting(
    'cancerculture.factory_reset_backup_sha256', true
  );
  v_media_manifest_sha256 := current_setting(
    'cancerculture.factory_reset_media_manifest_sha256', true
  );

  if v_confirmation is distinct from
      'PRELAUNCH_APPLICATION_DATA_RESET_20260812'
    or coalesce(v_backup_sha256, '') !~ '^[0-9a-f]{64}$'
    or coalesce(v_media_manifest_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '55000',
      message = 'FACTORY_RESET_EXPLICIT_BACKUP_CONFIRMATION_REQUIRED';
  end if;

  if (
    select array_agg(role_key order by role_key)
    from (
      select key as role_key
      from public.team_roles
      where is_system and is_active
    ) roles
  ) is distinct from array[
    'admin',
    'moderator',
    'super_moderator',
    'trial_moderator'
  ]::text[]
    or exists (
      select 1 from public.team_roles where not is_system
    ) then
    raise exception using errcode = '55000',
      message = 'FACTORY_RESET_SYSTEM_ROLE_PREFLIGHT_FAILED';
  end if;

  if (
    select count(*) from public.team_members where role = 'admin'
  ) <> 1
    or (
      select count(*)
      from public.team_members member
      join public.user_logs account
        on account.discord_user_id = member.discord_user_id
      where member.role = 'admin'
    ) <> 1 then
    raise exception using errcode = '55000',
      message = 'FACTORY_RESET_CANONICAL_ADMIN_PREFLIGHT_FAILED';
  end if;

  if exists (
      select 1
      from public.submission_upload_operations
      where status in ('reserved', 'r2_uploaded')
    )
    or exists (
      select 1
      from public.media_cleanup_queue
      where status = 'processing'
        and locked_until > clock_timestamp()
    )
    or exists (
      select 1
      from public.discord_reconciliation_snapshots
      where status = 'collecting'
    )
    or exists (
      select 1
      from public.cycle_scheduler_health
      where active_run_id is not null
    ) then
    raise exception using errcode = '55000',
      message = 'FACTORY_RESET_WRITERS_NOT_QUIESCENT';
  end if;

  if to_regprocedure(
      'public.assign_voting_cycle_public_number()'
    ) is null
    or not exists (
      select 1
      from pg_trigger trigger_row
      join pg_class table_row on table_row.oid = trigger_row.tgrelid
      join pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
      where namespace_row.nspname = 'public'
        and table_row.relname = 'voting_cycles'
        and trigger_row.tgname = 'voting_cycles_assign_public_number'
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled = 'O'
    ) then
    raise exception using errcode = '55000',
      message = 'FACTORY_RESET_PUBLIC_NUMBER_CONTRACT_MISSING';
  end if;
end;
$preflight$;

create temporary table factory_reset_admin_user
  (like public.user_logs including defaults including constraints)
  on commit drop;

create temporary table factory_reset_admin_member
  (like public.team_members including defaults including constraints)
  on commit drop;

insert into factory_reset_admin_user
select account.*
from public.user_logs account
join public.team_members member
  on member.discord_user_id = account.discord_user_id
where member.role = 'admin'
  and (select should_reset from factory_reset_state);

insert into factory_reset_admin_member
select member.*
from public.team_members member
where member.role = 'admin'
  and (select should_reset from factory_reset_state);

create temporary table factory_reset_preserved_fingerprints (
  table_name text primary key,
  row_count bigint not null,
  content_hash text not null
) on commit drop;

do $capture_preserved$
declare
  v_table_name text;
  v_row_count bigint;
  v_content_hash text;
begin
  foreach v_table_name in array array[
    'capability_catalog',
    'coin_launches',
    'content_documents',
    'content_publications',
    'content_revisions',
    'cycle_rule_templates',
    'cycle_scheduler_health',
    'cycle_vote_signal_policies',
    'cycle_vote_signal_policy_state',
    'discord_sync_health',
    'homepage_info_blocks',
    'rules_meta',
    'team_roles'
  ]
  loop
    if to_regclass(format('public.%I', v_table_name)) is null then
      raise exception using errcode = '55000',
        message = 'FACTORY_RESET_PRESERVED_TABLE_MISSING',
        detail = v_table_name;
    end if;

    execute format(
      $sql$
        select
          count(*)::bigint,
          md5(coalesce(
            string_agg(md5(to_jsonb(source_row)::text), '' order by md5(to_jsonb(source_row)::text)),
            ''
          ))
        from public.%I source_row
      $sql$,
      v_table_name
    ) into v_row_count, v_content_hash;

    insert into factory_reset_preserved_fingerprints(
      table_name,
      row_count,
      content_hash
    ) values (
      v_table_name,
      v_row_count,
      v_content_hash
    );
  end loop;
end;
$capture_preserved$;

insert into factory_reset_preserved_fingerprints(
  table_name,
  row_count,
  content_hash
)
select
  'app_config_non_sponsor',
  count(*)::bigint,
  md5(coalesce(string_agg(
    md5(to_jsonb(config_row)::text),
    '' order by config_row.key
  ), ''))
from public.app_config config_row
where config_row.key not in (
  'next_cycle_is_sponsored',
  'next_cycle_reward_description',
  'next_cycle_sponsor_banner_r2_key',
  'next_cycle_sponsor_banner_key',
  'next_cycle_sponsor_link',
  'next_cycle_sponsor_name',
  'next_cycle_sponsored_enabled'
);

insert into factory_reset_preserved_fingerprints(
  table_name,
  row_count,
  content_hash
)
select
  'next_cycle_config_non_sponsor',
  count(*)::bigint,
  md5(coalesce(string_agg(
    md5(jsonb_build_object(
      'id', config_row.id,
      'title', config_row.title,
      'theme', config_row.theme,
      'rule_template_id', config_row.rule_template_id
    )::text),
    '' order by config_row.id
  ), ''))
from public.next_cycle_config config_row;

create temporary table factory_reset_sequence_state on commit drop as
select
  schemaname,
  sequencename,
  last_value,
  start_value,
  increment_by,
  min_value,
  max_value,
  cache_size,
  cycle
from pg_sequences
where schemaname = 'public';

create temporary table factory_reset_contract_fingerprints (
  contract_name text primary key,
  row_count bigint not null,
  content_hash text not null
) on commit drop;

insert into factory_reset_contract_fingerprints
select
  'triggers',
  count(*)::bigint,
  md5(coalesce(string_agg(
    md5(
      namespace_row.nspname || '.' || table_row.relname || ':' ||
      trigger_row.tgname || ':' || trigger_row.tgenabled::text || ':' ||
      pg_get_triggerdef(trigger_row.oid, true)
    ),
    '' order by namespace_row.nspname, table_row.relname, trigger_row.tgname
  ), ''))
from pg_trigger trigger_row
join pg_class table_row on table_row.oid = trigger_row.tgrelid
join pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
where namespace_row.nspname = 'public'
  and not trigger_row.tgisinternal
union all
select
  'policies',
  count(*)::bigint,
  md5(coalesce(string_agg(
    md5(to_jsonb(policy_row)::text),
    '' order by policy_row.schemaname, policy_row.tablename, policy_row.policyname
  ), ''))
from pg_policies policy_row
where policy_row.schemaname = 'public'
union all
select
  'acl_owners',
  count(*)::bigint,
  md5(coalesce(string_agg(
    md5(contract_row.contract_value),
    '' order by contract_row.contract_value
  ), ''))
from (
  select
    'schema:public:' || pg_get_userbyid(namespace_row.nspowner) || ':' ||
      coalesce(namespace_row.nspacl::text, '<default>') as contract_value
  from pg_namespace namespace_row
  where namespace_row.nspname = 'public'
  union all
  select
    'relation:' || relation_row.relkind::text || ':' || relation_row.relname || ':' ||
      pg_get_userbyid(relation_row.relowner) || ':' ||
      coalesce(relation_row.relacl::text, '<default>')
  from pg_class relation_row
  join pg_namespace namespace_row on namespace_row.oid = relation_row.relnamespace
  where namespace_row.nspname = 'public'
    and relation_row.relkind in ('r', 'p', 'v', 'm', 'S')
  union all
  select
    'function:' || function_row.oid::regprocedure::text || ':' ||
      pg_get_userbyid(function_row.proowner) || ':' ||
      coalesce(function_row.proacl::text, '<default>')
  from pg_proc function_row
  join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
  where namespace_row.nspname = 'public'
) contract_row;

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

insert into public.user_logs
select * from factory_reset_admin_user;

update public.user_logs
set
  first_seen_at = created_at,
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
  known_display_names = case
    when current_display_name is null then '{}'::text[]
    else array[current_display_name]
  end,
  known_guild_nicknames = case
    when current_guild_nickname is null then '{}'::text[]
    else array[current_guild_nickname]
  end,
  website_ban_version = 0
where (select should_reset from factory_reset_state);

insert into public.team_members
select * from factory_reset_admin_member;

update public.app_config
set value = case
  when key in ('next_cycle_is_sponsored', 'next_cycle_sponsored_enabled')
    then 'false'
  else null
end
where key in (
  'next_cycle_is_sponsored',
  'next_cycle_reward_description',
  'next_cycle_sponsor_banner_r2_key',
  'next_cycle_sponsor_banner_key',
  'next_cycle_sponsor_link',
  'next_cycle_sponsor_name',
  'next_cycle_sponsored_enabled'
);

update public.next_cycle_config
set
  is_sponsored = false,
  sponsor_name = null,
  sponsor_link = null,
  reward_description = null,
  sponsor_banner_key = null,
  updated_by_discord_user_id = null,
  updated_by_discord_username = null
where is_sponsored
  or sponsor_name is not null
  or sponsor_link is not null
  or reward_description is not null
  or sponsor_banner_key is not null
  or updated_by_discord_user_id is not null
  or updated_by_discord_username is not null;

do $postflight$
declare
  v_table record;
  v_row_count bigint;
  v_expected_count bigint;
  v_fingerprint record;
  v_current_hash text;
  v_sequence_mismatch_count integer;
  v_contract record;
  v_contract_count bigint;
  v_contract_hash text;
begin
  for v_table in select * from factory_reset_tables order by table_name
  loop
    execute format(
      'select count(*)::bigint from public.%I',
      v_table.table_name
    ) into v_row_count;

    v_expected_count := case
      when v_table.preserve_admin_row
        and (select should_reset from factory_reset_state) then 1
      else 0
    end;

    if v_row_count <> v_expected_count then
      raise exception using errcode = '55000',
        message = 'FACTORY_RESET_DATA_POSTFLIGHT_FAILED',
        detail = format(
          '%s expected %s rows, found %s',
          v_table.table_name,
          v_expected_count,
          v_row_count
        );
    end if;
  end loop;

  if (select should_reset from factory_reset_state) and (
    not exists (
      select 1
      from public.team_members member
      join public.user_logs account
        on account.discord_user_id = member.discord_user_id
      where member.role = 'admin'
    )
    or exists (
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
    )
  ) then
    raise exception using errcode = '55000',
      message = 'FACTORY_RESET_ADMIN_POSTFLIGHT_FAILED';
  end if;

  for v_fingerprint in
    select * from factory_reset_preserved_fingerprints order by table_name
  loop
    if v_fingerprint.table_name = 'app_config_non_sponsor' then
      select
        count(*)::bigint,
        md5(coalesce(string_agg(
          md5(to_jsonb(config_row)::text),
          '' order by config_row.key
        ), ''))
      into v_row_count, v_current_hash
      from public.app_config config_row
      where config_row.key not in (
        'next_cycle_is_sponsored',
        'next_cycle_reward_description',
        'next_cycle_sponsor_banner_r2_key',
        'next_cycle_sponsor_banner_key',
        'next_cycle_sponsor_link',
        'next_cycle_sponsor_name',
        'next_cycle_sponsored_enabled'
      );
    elsif v_fingerprint.table_name = 'next_cycle_config_non_sponsor' then
      select
        count(*)::bigint,
        md5(coalesce(string_agg(
          md5(jsonb_build_object(
            'id', config_row.id,
            'title', config_row.title,
            'theme', config_row.theme,
            'rule_template_id', config_row.rule_template_id
          )::text),
          '' order by config_row.id
        ), ''))
      into v_row_count, v_current_hash
      from public.next_cycle_config config_row;
    else
      execute format(
        $sql$
          select
            count(*)::bigint,
            md5(coalesce(
              string_agg(md5(to_jsonb(source_row)::text), '' order by md5(to_jsonb(source_row)::text)),
              ''
            ))
          from public.%I source_row
        $sql$,
        v_fingerprint.table_name
      ) into v_row_count, v_current_hash;
    end if;

    if v_row_count <> v_fingerprint.row_count
      or v_current_hash <> v_fingerprint.content_hash then
      raise exception using errcode = '55000',
        message = 'FACTORY_RESET_PRESERVED_DATA_POSTFLIGHT_FAILED',
        detail = v_fingerprint.table_name;
    end if;
  end loop;

  select count(*)
  into v_sequence_mismatch_count
  from factory_reset_sequence_state before_state
  full join pg_sequences after_state
    on after_state.schemaname = before_state.schemaname
    and after_state.sequencename = before_state.sequencename
  where coalesce(after_state.schemaname, before_state.schemaname) = 'public'
    and (
      before_state.schemaname is null
      or after_state.schemaname is null
      or after_state.last_value is distinct from before_state.last_value
      or after_state.start_value is distinct from before_state.start_value
      or after_state.increment_by is distinct from before_state.increment_by
      or after_state.min_value is distinct from before_state.min_value
      or after_state.max_value is distinct from before_state.max_value
      or after_state.cache_size is distinct from before_state.cache_size
      or after_state.cycle is distinct from before_state.cycle
    );

  if v_sequence_mismatch_count <> 0 then
    raise exception using errcode = '55000',
      message = 'FACTORY_RESET_SEQUENCE_POSTFLIGHT_FAILED';
  end if;

  for v_contract in
    select * from factory_reset_contract_fingerprints order by contract_name
  loop
    if v_contract.contract_name = 'triggers' then
      select
        count(*)::bigint,
        md5(coalesce(string_agg(
          md5(
            namespace_row.nspname || '.' || table_row.relname || ':' ||
            trigger_row.tgname || ':' || trigger_row.tgenabled::text || ':' ||
            pg_get_triggerdef(trigger_row.oid, true)
          ),
          '' order by namespace_row.nspname, table_row.relname, trigger_row.tgname
        ), ''))
      into v_contract_count, v_contract_hash
      from pg_trigger trigger_row
      join pg_class table_row on table_row.oid = trigger_row.tgrelid
      join pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
      where namespace_row.nspname = 'public'
        and not trigger_row.tgisinternal;
    elsif v_contract.contract_name = 'policies' then
      select
        count(*)::bigint,
        md5(coalesce(string_agg(
          md5(to_jsonb(policy_row)::text),
          '' order by policy_row.schemaname, policy_row.tablename, policy_row.policyname
        ), ''))
      into v_contract_count, v_contract_hash
      from pg_policies policy_row
      where policy_row.schemaname = 'public';
    else
      select
        count(*)::bigint,
        md5(coalesce(string_agg(
          md5(contract_row.contract_value),
          '' order by contract_row.contract_value
        ), ''))
      into v_contract_count, v_contract_hash
      from (
        select
          'schema:public:' || pg_get_userbyid(namespace_row.nspowner) || ':' ||
            coalesce(namespace_row.nspacl::text, '<default>') as contract_value
        from pg_namespace namespace_row
        where namespace_row.nspname = 'public'
        union all
        select
          'relation:' || relation_row.relkind::text || ':' || relation_row.relname || ':' ||
            pg_get_userbyid(relation_row.relowner) || ':' ||
            coalesce(relation_row.relacl::text, '<default>')
        from pg_class relation_row
        join pg_namespace namespace_row
          on namespace_row.oid = relation_row.relnamespace
        where namespace_row.nspname = 'public'
          and relation_row.relkind in ('r', 'p', 'v', 'm', 'S')
        union all
        select
          'function:' || function_row.oid::regprocedure::text || ':' ||
            pg_get_userbyid(function_row.proowner) || ':' ||
            coalesce(function_row.proacl::text, '<default>')
        from pg_proc function_row
        join pg_namespace namespace_row
          on namespace_row.oid = function_row.pronamespace
        where namespace_row.nspname = 'public'
      ) contract_row;
    end if;

    if v_contract_count <> v_contract.row_count
      or v_contract_hash <> v_contract.content_hash then
      raise exception using errcode = '55000',
        message = 'FACTORY_RESET_SECURITY_CONTRACT_POSTFLIGHT_FAILED',
        detail = v_contract.contract_name;
    end if;
  end loop;

  if exists (select 1 from public.voting_cycles)
    or (select count(*) from public.team_role_capabilities) <> 0
    or exists (
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
        or updated_by_discord_user_id is not null
        or updated_by_discord_username is not null
    ) then
    raise exception using errcode = '55000',
      message = 'FACTORY_RESET_LAUNCH_BASELINE_POSTFLIGHT_FAILED';
  end if;
end;
$postflight$;

commit;

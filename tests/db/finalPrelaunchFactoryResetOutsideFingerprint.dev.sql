\set ON_ERROR_STOP on

begin read only;

create temporary table final_reset_harness_data (
  table_name text primary key,
  row_count bigint not null,
  content_hash text not null
) on commit drop;

do $capture$
declare
  v_table text;
  v_count bigint;
  v_hash text;
begin
  for v_table in
    select table_name
    from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  loop
    execute format(
      'select count(*)::bigint, md5(coalesce(string_agg(md5(to_jsonb(source_row)::text), '''' order by md5(to_jsonb(source_row)::text)), '''')) from public.%I source_row',
      v_table
    ) into v_count, v_hash;
    insert into final_reset_harness_data values (v_table, v_count, v_hash);
  end loop;
end;
$capture$;

create temporary table final_reset_harness_contract (
  contract_name text primary key,
  row_count bigint not null,
  content_hash text not null
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
insert into final_reset_harness_contract
select contract_name, count(*)::bigint,
  md5(coalesce(string_agg(md5(contract_value), '' order by md5(contract_value)), ''))
from contract_rows group by contract_name;

with fingerprints as (
  select
    (select encode(extensions.digest(string_agg(
      contract_name || ':' || row_count || ':' || content_hash,
      '' order by contract_name
    ), 'sha256'), 'hex') from final_reset_harness_contract) as catalog_sha256,
    (select encode(extensions.digest(string_agg(
      table_name || ':' || row_count || ':' || content_hash,
      '' order by table_name
    ), 'sha256'), 'hex') from final_reset_harness_data) as data_sha256,
    (select encode(extensions.digest(string_agg(
      table_name || ':' || row_count || ':' || content_hash,
      '' order by table_name
    ), 'sha256'), 'hex')
      from final_reset_harness_data
      where table_name in (
        'app_config', 'avatar_upload_logs', 'cycle_sponsorships',
        'media_cleanup_queue', 'next_cycle_config',
        'sponsor_media_upload_operations', 'submission_upload_operations',
        'submissions', 'user_logs', 'voting_cycles', 'winner_public_profiles'
      )) as reference_sha256,
    (select encode(extensions.digest(coalesce(string_agg(
      concat_ws(':', sequencename, last_value, start_value, increment_by,
        min_value, max_value, cache_size, cycle),
      '' order by sequencename
    ), ''), 'sha256'), 'hex')
      from pg_sequences where schemaname = 'public') as sequence_sha256,
    case
      when to_regclass('supabase_migrations.schema_migrations') is null
        then encode(extensions.digest('<absent>', 'sha256'), 'hex')
      else encode(extensions.digest(query_to_xml(
        'select * from supabase_migrations.schema_migrations order by version',
        true, true, ''
      )::text, 'sha256'), 'hex')
    end as ledger_sha256,
    (select md5(jsonb_build_object(
      'discord_user_id', account.discord_user_id,
      'public_profile_id', account.public_profile_id,
      'created_at', account.created_at,
      'current_discord_username', account.current_discord_username
    )::text)
      from public.user_logs account
      join public.team_members member using (discord_user_id)
      where member.role = 'admin') as owner_fingerprint
), final as (
  select *, encode(extensions.digest(
    catalog_sha256 || data_sha256 || reference_sha256 || sequence_sha256 || ledger_sha256,
    'sha256'
  ), 'hex') as outside_sha256
  from fingerprints
)
select concat_ws('|', outside_sha256, catalog_sha256, data_sha256,
  reference_sha256, sequence_sha256, ledger_sha256, owner_fingerprint)
from final;

rollback;

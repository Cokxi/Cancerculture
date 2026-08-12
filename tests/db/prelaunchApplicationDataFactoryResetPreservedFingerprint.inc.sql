with preserved_queries(table_name, query_text) as (
  select table_name, format(
    'select to_jsonb(source_row) as row_data from public.%I source_row order by md5(to_jsonb(source_row)::text)',
    table_name
  )
  from unnest(array[
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
  ]::text[]) table_name
  union all
  select
    'app_config_non_sponsor',
    $query$
      select to_jsonb(config_row) as row_data
      from public.app_config config_row
      where config_row.key not in (
        'next_cycle_is_sponsored',
        'next_cycle_reward_description',
        'next_cycle_sponsor_banner_r2_key',
        'next_cycle_sponsor_banner_key',
        'next_cycle_sponsor_link',
        'next_cycle_sponsor_name',
        'next_cycle_sponsored_enabled'
      )
      order by config_row.key
    $query$
  union all
  select
    'next_cycle_config_non_sponsor',
    $query$
      select jsonb_build_object(
        'id', config_row.id,
        'title', config_row.title,
        'theme', config_row.theme,
        'rule_template_id', config_row.rule_template_id
      ) as row_data
      from public.next_cycle_config config_row
      order by config_row.id
    $query$
), fingerprints as (
  select
    table_name,
    md5(query_to_xml(query_text, true, true, '')::text) as content_hash
  from preserved_queries
)
select md5(coalesce(string_agg(
  table_name || ':' || content_hash,
  '' order by table_name
), '')) as preserved_fingerprint_md5
from fingerprints
\gset

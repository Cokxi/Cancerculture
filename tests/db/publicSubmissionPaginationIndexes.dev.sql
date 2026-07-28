-- Controlled DEV only; LIVE execution is expressly prohibited.
-- psql -X -v ON_ERROR_STOP=1 -f tests/db/publicSubmissionPaginationIndexes.dev.sql
\set ON_ERROR_STOP on

begin;
set local transaction read only;

do $$
declare
  v_index record;
begin
  select
    i.indisvalid,
    i.indisready,
    i.indnatts,
    i.indnkeyatts,
    i.indpred,
    i.indexprs,
    i.indoption::text as indoption,
    am.amname,
    pg_get_indexdef(i.indexrelid, 1, true) as key_1,
    pg_get_indexdef(i.indexrelid, 2, true) as key_2,
    pg_get_indexdef(i.indexrelid, 3, true) as key_3
  into v_index
  from pg_catalog.pg_class as index_class
  join pg_catalog.pg_namespace as index_namespace
    on index_namespace.oid = index_class.relnamespace
  join pg_catalog.pg_index as i
    on i.indexrelid = index_class.oid
  join pg_catalog.pg_class as table_class
    on table_class.oid = i.indrelid
  join pg_catalog.pg_namespace as table_namespace
    on table_namespace.oid = table_class.relnamespace
  join pg_catalog.pg_am as am
    on am.oid = index_class.relam
  where index_namespace.nspname = 'public'
    and index_class.relname =
      'winner_public_profiles_wall_created_at_id_idx'
    and table_namespace.nspname = 'public'
    and table_class.relname = 'winner_public_profiles';

  if not found then
    raise exception
      'winner_public_profiles_wall_created_at_id_idx is missing or belongs to the wrong table';
  end if;

  if not v_index.indisvalid or not v_index.indisready then
    raise exception
      'winner_public_profiles_wall_created_at_id_idx is not valid and ready';
  end if;

  if v_index.amname <> 'btree'
    or v_index.indnatts <> 3
    or v_index.indnkeyatts <> 3
    or v_index.indpred is not null
    or v_index.indexprs is not null
    or v_index.key_1 <> 'wall'
    or v_index.key_2 <> 'created_at'
    or v_index.key_3 <> 'id'
    or v_index.indoption <> '0 3 3'
  then
    raise exception
      'winner_public_profiles_wall_created_at_id_idx has an unexpected definition';
  end if;

  select
    i.indisvalid,
    i.indisready,
    i.indnatts,
    i.indnkeyatts,
    i.indpred,
    i.indexprs,
    i.indoption::text as indoption,
    am.amname,
    pg_get_indexdef(i.indexrelid, 1, true) as key_1,
    pg_get_indexdef(i.indexrelid, 2, true) as key_2,
    pg_get_indexdef(i.indexrelid, 3, true) as key_3
  into v_index
  from pg_catalog.pg_class as index_class
  join pg_catalog.pg_namespace as index_namespace
    on index_namespace.oid = index_class.relnamespace
  join pg_catalog.pg_index as i
    on i.indexrelid = index_class.oid
  join pg_catalog.pg_class as table_class
    on table_class.oid = i.indrelid
  join pg_catalog.pg_namespace as table_namespace
    on table_namespace.oid = table_class.relnamespace
  join pg_catalog.pg_am as am
    on am.oid = index_class.relam
  where index_namespace.nspname = 'public'
    and index_class.relname = 'submissions_cycle_id_id_idx'
    and table_namespace.nspname = 'public'
    and table_class.relname = 'submissions';

  if not found then
    raise exception
      'submissions_cycle_id_id_idx is missing or belongs to the wrong table';
  end if;

  if not v_index.indisvalid or not v_index.indisready then
    raise exception
      'submissions_cycle_id_id_idx is not valid and ready';
  end if;

  if v_index.amname <> 'btree'
    or v_index.indnatts <> 2
    or v_index.indnkeyatts <> 2
    or v_index.indpred is not null
    or v_index.indexprs is not null
    or v_index.key_1 <> 'cycle_id'
    or v_index.key_2 <> 'id'
    or v_index.indoption <> '0 0'
  then
    raise exception
      'submissions_cycle_id_id_idx has an unexpected definition';
  end if;
end;
$$;

rollback;

select 'public_submission_pagination_indexes_ok' as result;

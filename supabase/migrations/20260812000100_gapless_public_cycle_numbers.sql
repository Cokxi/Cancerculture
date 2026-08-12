begin;

do $preflight$
begin
  if to_regclass('public.voting_cycles') is null
    or to_regprocedure(
      'public.start_cycle_managed(bigint,text,jsonb)'
    ) is null
    or to_regprocedure(
      'public.reset_cycle_managed(bigint,text,text)'
    ) is null
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'voting_cycles'
        and column_name = 'reset_count'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'PUBLIC_CYCLE_NUMBER_BASELINE_MISMATCH';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'voting_cycles'
      and column_name = 'public_number'
  ) then
    raise exception using
      errcode = '42701',
      message = 'PUBLIC_CYCLE_NUMBER_ALREADY_PRESENT';
  end if;
end;
$preflight$;

alter table public.voting_cycles
  add column public_number bigint;

comment on column public.voting_cycles.public_number is
  'Stable gapless public Cycle number. Assigned once on the first non-draft lifecycle state; never used as an internal identifier or foreign key.';

with numbered_cycles as (
  select
    cycle.id,
    row_number() over (order by cycle.id) as public_number
  from public.voting_cycles cycle
  where cycle.status <> 'draft'
     or cycle.reset_count > 0
     or cycle.starts_at is not null
     or cycle.submission_starts_at is not null
)
update public.voting_cycles cycle
set public_number = numbered.public_number
from numbered_cycles numbered
where numbered.id = cycle.id;

alter table public.voting_cycles
  add constraint voting_cycles_public_number_positive_check
  check (public_number is null or public_number > 0),
  add constraint voting_cycles_started_public_number_check
  check (status = 'draft' or public_number is not null);

create unique index voting_cycles_public_number_uidx
  on public.voting_cycles (public_number)
  where public_number is not null;

create or replace function public.assign_voting_cycle_public_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_next_public_number bigint;
begin
  if tg_op = 'UPDATE' and old.public_number is not null then
    if new.public_number is distinct from old.public_number then
      raise exception using
        errcode = '22023',
        message = 'PUBLIC_CYCLE_NUMBER_IMMUTABLE';
    end if;

    return new;
  end if;

  if new.public_number is not null then
    raise exception using
      errcode = '22023',
      message = 'PUBLIC_CYCLE_NUMBER_MANAGED';
  end if;

  if new.status <> 'draft' then
    perform pg_advisory_xact_lock(
      hashtextextended('cycle-public-number-allocation', 0)
    );

    select coalesce(max(cycle.public_number), 0) + 1
    into v_next_public_number
    from public.voting_cycles cycle;

    new.public_number := v_next_public_number;
  end if;

  return new;
end;
$function$;

alter function public.assign_voting_cycle_public_number() owner to postgres;
revoke all on function public.assign_voting_cycle_public_number()
  from public, anon, authenticated, service_role, discord_bot;

create trigger voting_cycles_assign_public_number
before insert or update of status, public_number
on public.voting_cycles
for each row
execute function public.assign_voting_cycle_public_number();

do $normalize_managed_cycle_results$
declare
  v_signature regprocedure;
  v_definition text;
  v_updated_definition text;
begin
  foreach v_signature in array array[
    'public.start_cycle_managed(bigint,text,jsonb)'::regprocedure,
    'public.reset_cycle_managed(bigint,text,text)'::regprocedure
  ] loop
    select pg_get_functiondef(v_signature)
    into v_definition;

    v_updated_definition := replace(
      v_definition,
      E'  return v_result;\n',
      E'  return v_result || jsonb_build_object(\n' ||
      E'    ''cycleNumber'', (\n' ||
      E'      select cycle.public_number\n' ||
      E'      from public.voting_cycles cycle\n' ||
      E'      where cycle.id = (v_result ->> ''cycleId'')::bigint\n' ||
      E'    )\n' ||
      E'  );\n'
    );

    if v_updated_definition = v_definition then
      raise exception using
        errcode = '55000',
        message = 'MANAGED_CYCLE_RESULT_RETURN_NOT_FOUND',
        detail = v_signature::text;
    end if;

    execute v_updated_definition;
  end loop;
end;
$normalize_managed_cycle_results$;

alter function public.start_cycle_managed(bigint, text, jsonb)
  owner to postgres;
revoke all on function public.start_cycle_managed(bigint, text, jsonb)
  from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.start_cycle_managed(bigint, text, jsonb)
  to service_role;

alter function public.reset_cycle_managed(bigint, text, text)
  owner to postgres;
revoke all on function public.reset_cycle_managed(bigint, text, text)
  from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.reset_cycle_managed(bigint, text, text)
  to service_role;

comment on function public.start_cycle_managed(bigint, text, jsonb) is
  'Capability-authorized atomic Cycle Start. cycleId remains the internal database ID; cycleNumber is the immutable public number.';
comment on function public.reset_cycle_managed(bigint, text, text) is
  'Capability-authorized atomic Cycle Reset. Reuses both the internal cycleId and its immutable public cycleNumber.';

do $postflight$
declare
  v_numbered_count bigint;
  v_distinct_count bigint;
  v_min_number bigint;
  v_max_number bigint;
begin
  select
    count(*),
    count(distinct cycle.public_number),
    min(cycle.public_number),
    max(cycle.public_number)
  into
    v_numbered_count,
    v_distinct_count,
    v_min_number,
    v_max_number
  from public.voting_cycles cycle
  where cycle.public_number is not null;

  if v_numbered_count > 0 and (
    v_min_number <> 1
    or v_max_number <> v_numbered_count
    or v_distinct_count <> v_numbered_count
  ) then
    raise exception using
      errcode = '55000',
      message = 'PUBLIC_CYCLE_NUMBER_BACKFILL_NOT_GAPLESS';
  end if;

  if exists (
    select 1
    from public.voting_cycles cycle
    where cycle.status <> 'draft'
      and cycle.public_number is null
  ) then
    raise exception using
      errcode = '55000',
      message = 'STARTED_CYCLE_PUBLIC_NUMBER_MISSING';
  end if;

  if not exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.voting_cycles'::regclass
      and trigger_row.tgname = 'voting_cycles_assign_public_number'
      and trigger_row.tgfoid =
        'public.assign_voting_cycle_public_number()'::regprocedure
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  ) then
    raise exception using
      errcode = '55000',
      message = 'PUBLIC_CYCLE_NUMBER_TRIGGER_MISSING';
  end if;

  if not exists (
    select 1
    from pg_proc function_row
    join pg_namespace namespace_row
      on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname = 'assign_voting_cycle_public_number'
      and function_row.pronargs = 0
      and function_row.prosecdef
      and pg_get_userbyid(function_row.proowner) = 'postgres'
      and function_row.proconfig = array['search_path=public, pg_temp']
  ) then
    raise exception using
      errcode = '55000',
      message = 'PUBLIC_CYCLE_NUMBER_FUNCTION_NOT_HARDENED';
  end if;

  if has_function_privilege(
      'anon',
      'public.assign_voting_cycle_public_number()',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.assign_voting_cycle_public_number()',
      'EXECUTE'
    )
    or has_function_privilege(
      'service_role',
      'public.assign_voting_cycle_public_number()',
      'EXECUTE'
    )
    or has_function_privilege(
      'discord_bot',
      'public.assign_voting_cycle_public_number()',
      'EXECUTE'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'PUBLIC_CYCLE_NUMBER_FUNCTION_ACL_MISMATCH';
  end if;

  if not has_function_privilege(
      'service_role',
      'public.start_cycle_managed(bigint,text,jsonb)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.reset_cycle_managed(bigint,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'public.start_cycle_managed(bigint,text,jsonb)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.start_cycle_managed(bigint,text,jsonb)',
      'EXECUTE'
    )
    or has_function_privilege(
      'discord_bot',
      'public.start_cycle_managed(bigint,text,jsonb)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'public.reset_cycle_managed(bigint,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.reset_cycle_managed(bigint,text,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'discord_bot',
      'public.reset_cycle_managed(bigint,text,text)',
      'EXECUTE'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'MANAGED_CYCLE_FUNCTION_ACL_MISMATCH';
  end if;
end;
$postflight$;

commit;

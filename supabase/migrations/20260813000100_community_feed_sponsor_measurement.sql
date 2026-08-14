begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if to_regclass('public.sponsor_tracking_events') is null
    or to_regclass('public.cycle_sponsorships') is null
    or exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'sponsor_tracking_events'
        and column_name in ('feed_kind', 'measurement_window_start')
    )
    or to_regclass('public.sponsor_tracking_aggregates') is not null
    or to_regprocedure(
      'public.record_sponsor_event_v2(bigint,text,text,text,text)'
    ) is not null
    or to_regprocedure(
      'public.prune_sponsor_measurement_retention()'
    ) is not null then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_SPONSOR_MEASUREMENT_BASELINE_MISMATCH';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sponsor_tracking_events'::regclass
      and conname = 'sponsor_tracking_events_surface_check'
      and pg_get_constraintdef(oid) like '%home_hud%'
      and pg_get_constraintdef(oid) not like '%spread%'
  ) then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_SPONSOR_MEASUREMENT_CONSTRAINT_MISMATCH';
  end if;
end;
$preflight$;

alter table public.sponsor_tracking_events
  add column feed_kind text,
  add column measurement_window_start timestamptz;

alter table public.sponsor_tracking_events
  drop constraint sponsor_tracking_events_surface_check,
  add constraint sponsor_tracking_events_surface_check
    check (surface = any (array[
      'home_hud'::text,
      'vote_modal'::text,
      'history_modal'::text,
      'fame_modal'::text,
      'shame_modal'::text,
      'spread'::text
    ])),
  add constraint sponsor_tracking_events_feed_kind_check
    check (
      (surface = 'spread' and feed_kind = any (array[
        'live'::text, 'top10'::text, 'all'::text, 'trash'::text
      ]))
      or (surface <> 'spread' and feed_kind is null)
    ),
  add constraint sponsor_tracking_events_window_check
    check (
      measurement_window_start is null
      or measurement_window_start = date_bin(
        interval '30 minutes',
        measurement_window_start,
        timestamptz '2000-01-01 00:00:00+00'
      )
    );

create unique index sponsor_tracking_events_measurement_window_uidx
  on public.sponsor_tracking_events (
    sponsorship_id,
    event_type,
    surface,
    coalesce(feed_kind, ''),
    viewer_hash,
    measurement_window_start
  )
  where measurement_window_start is not null;

create table public.sponsor_tracking_aggregates (
  sponsorship_id bigint not null
    references public.cycle_sponsorships(id) on delete cascade,
  event_day date not null,
  event_type text not null
    check (event_type = any (array['impression'::text, 'click'::text])),
  surface text not null
    check (surface = any (array[
      'home_hud'::text,
      'vote_modal'::text,
      'history_modal'::text,
      'fame_modal'::text,
      'shame_modal'::text,
      'spread'::text
    ])),
  feed_kind text,
  event_count bigint not null default 0 check (event_count >= 0),
  updated_at timestamptz not null default now(),
  constraint sponsor_tracking_aggregates_feed_kind_check check (
    (surface = 'spread' and feed_kind = any (array[
      'live'::text, 'top10'::text, 'all'::text, 'trash'::text
    ]))
    or (surface <> 'spread' and feed_kind is null)
  )
);

create unique index sponsor_tracking_aggregates_identity_uidx
  on public.sponsor_tracking_aggregates (
    sponsorship_id,
    event_day,
    event_type,
    surface,
    coalesce(feed_kind, '')
  );

create index sponsor_tracking_aggregates_report_idx
  on public.sponsor_tracking_aggregates (
    sponsorship_id,
    event_day desc,
    event_type
  );

alter table public.sponsor_tracking_aggregates enable row level security;
revoke all on table public.sponsor_tracking_aggregates from public, anon, authenticated;
grant select on table public.sponsor_tracking_aggregates to service_role;

insert into public.sponsor_tracking_aggregates (
  sponsorship_id,
  event_day,
  event_type,
  surface,
  feed_kind,
  event_count,
  updated_at
)
select
  sponsorship_id,
  (created_at at time zone 'UTC')::date,
  event_type,
  surface,
  null,
  count(*),
  now()
from public.sponsor_tracking_events
group by
  sponsorship_id,
  (created_at at time zone 'UTC')::date,
  event_type,
  surface;

create function public.record_sponsor_event_v2(
  p_sponsorship_id bigint,
  p_event_type text,
  p_surface text,
  p_feed_kind text,
  p_viewer_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := transaction_timestamp();
  v_window_start timestamptz;
  v_inserted boolean := false;
begin
  if p_sponsorship_id is null or p_sponsorship_id <= 0
    or p_event_type is null
    or p_event_type not in ('impression', 'click')
    or p_surface is null
    or p_surface not in (
      'home_hud', 'vote_modal', 'history_modal',
      'fame_modal', 'shame_modal', 'spread'
    )
    or p_viewer_hash is null
    or p_viewer_hash !~ '^[0-9a-f]{64}$'
    or (
      p_surface = 'spread'
      and (p_feed_kind is null or p_feed_kind not in ('live', 'top10', 'all', 'trash'))
    )
    or (p_surface <> 'spread' and p_feed_kind is not null)
    or not exists (
      select 1
      from public.cycle_sponsorships
      where id = p_sponsorship_id
    ) then
    raise exception using
      errcode = '22023',
      message = 'SPONSOR_MEASUREMENT_INPUT_INVALID';
  end if;

  v_window_start := date_bin(
    interval '30 minutes',
    v_now,
    timestamptz '2000-01-01 00:00:00+00'
  );

  insert into public.sponsor_tracking_events (
    sponsorship_id,
    event_type,
    surface,
    feed_kind,
    viewer_hash,
    measurement_window_start,
    created_at
  ) values (
    p_sponsorship_id,
    p_event_type,
    p_surface,
    p_feed_kind,
    p_viewer_hash,
    v_window_start,
    v_now
  )
  on conflict do nothing
  returning true into v_inserted;

  if coalesce(v_inserted, false) then
    insert into public.sponsor_tracking_aggregates (
      sponsorship_id,
      event_day,
      event_type,
      surface,
      feed_kind,
      event_count,
      updated_at
    ) values (
      p_sponsorship_id,
      (v_now at time zone 'UTC')::date,
      p_event_type,
      p_surface,
      p_feed_kind,
      1,
      v_now
    )
    on conflict (
      sponsorship_id,
      event_day,
      event_type,
      surface,
      (coalesce(feed_kind, ''))
    ) do update
      set event_count = public.sponsor_tracking_aggregates.event_count + 1,
          updated_at = excluded.updated_at;

    return jsonb_build_object('outcome', 'tracked');
  end if;

  return jsonb_build_object('outcome', 'deduped');
end;
$function$;

create function public.prune_sponsor_measurement_retention()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_events_deleted bigint;
  v_aggregates_deleted bigint;
begin
  delete from public.sponsor_tracking_events
  where created_at < transaction_timestamp() - interval '30 days';
  get diagnostics v_events_deleted = row_count;

  delete from public.sponsor_tracking_aggregates
  where event_day < (
    (transaction_timestamp() at time zone 'UTC')::date - interval '25 months'
  )::date;
  get diagnostics v_aggregates_deleted = row_count;

  return jsonb_build_object(
    'rawEventsDeleted', v_events_deleted,
    'aggregatesDeleted', v_aggregates_deleted
  );
end;
$function$;

alter function public.record_sponsor_event_v2(bigint, text, text, text, text)
  owner to postgres;
alter function public.prune_sponsor_measurement_retention()
  owner to postgres;

revoke all on function public.record_sponsor_event_v2(bigint, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.prune_sponsor_measurement_retention()
  from public, anon, authenticated;
grant execute on function public.record_sponsor_event_v2(bigint, text, text, text, text)
  to service_role;
grant execute on function public.prune_sponsor_measurement_retention()
  to service_role;

revoke insert, update, delete, truncate
  on table public.sponsor_tracking_events from service_role;

do $postflight$
declare
  v_record_oid oid := to_regprocedure(
    'public.record_sponsor_event_v2(bigint,text,text,text,text)'
  );
  v_prune_oid oid := to_regprocedure(
    'public.prune_sponsor_measurement_retention()'
  );
begin
  if v_record_oid is null or v_prune_oid is null
    or to_regclass('public.sponsor_tracking_aggregates') is null
    or not coalesce((
      select relrowsecurity
      from pg_class
      where oid = 'public.sponsor_tracking_aggregates'::regclass
    ), false)
    or has_table_privilege('anon', 'public.sponsor_tracking_aggregates', 'select')
    or has_table_privilege('authenticated', 'public.sponsor_tracking_aggregates', 'select')
    or has_table_privilege('service_role', 'public.sponsor_tracking_events', 'insert')
    or not has_table_privilege('service_role', 'public.sponsor_tracking_aggregates', 'select')
    or not has_function_privilege(
      'service_role',
      'public.record_sponsor_event_v2(bigint,text,text,text,text)',
      'execute'
    )
    or has_function_privilege(
      'anon',
      'public.record_sponsor_event_v2(bigint,text,text,text,text)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.record_sponsor_event_v2(bigint,text,text,text,text)',
      'execute'
    )
    or exists (
      select 1
      from pg_proc
      where oid in (v_record_oid, v_prune_oid)
        and (
          not prosecdef
          or pg_get_userbyid(proowner) <> 'postgres'
          or proconfig is distinct from array['search_path=public, pg_temp']::text[]
        )
    ) then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_SPONSOR_MEASUREMENT_POSTFLIGHT_FAILED';
  end if;
end;
$postflight$;

commit;

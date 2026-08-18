begin;

do $baseline$
begin
  if to_regclass('public.team_inbox_topic_catalog') is null
    or to_regclass('public.team_inbox_cases') is null
    or to_regprocedure('public.upsert_team_inbox_case(text,text,bigint,text,text)') is null
    or exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'team_inbox_topic_catalog'
        and column_name = 'accepts_new_cases'
    )
    or to_regprocedure('public.protect_team_inbox_topic_history()') is not null
    or (select count(*) from public.team_inbox_topic_catalog) <> 1
    or exists (select 1 from public.team_inbox_cases)
    or (select count(*) from public.capability_catalog) <> 39
    or (select count(*) from public.capability_catalog where is_active) <> 35
  then
    raise exception using
      errcode = '55000',
      message = 'TEAM_INBOX_HISTORY_VISIBILITY_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

alter table public.team_inbox_topic_catalog
  add column accepts_new_cases boolean not null default false,
  add constraint team_inbox_topic_acceptance_check
    check (not accepts_new_cases or is_active);

create function public.protect_team_inbox_topic_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if exists (
    select 1 from public.team_inbox_cases case_row
    where case_row.topic_key = old.topic_key
  ) then
    if tg_op = 'DELETE' then
      raise exception using
        errcode = '55000',
        message = 'TEAM_INBOX_TOPIC_HISTORY_MUST_REMAIN_VISIBLE';
    end if;
    if old.is_active and not new.is_active then
      raise exception using
        errcode = '55000',
        message = 'TEAM_INBOX_TOPIC_HISTORY_MUST_REMAIN_VISIBLE';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

create trigger team_inbox_topic_history_visible
before update of is_active or delete on public.team_inbox_topic_catalog
for each row execute function public.protect_team_inbox_topic_history();

create or replace function public.upsert_team_inbox_case(
  p_topic_key text,
  p_source_key text,
  p_source_version bigint,
  p_subject_discord_user_id text,
  p_subject_username_snapshot text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case public.team_inbox_cases%rowtype;
begin
  if p_source_version <= 0
    or char_length(p_source_key) not between 8 and 240
    or p_subject_discord_user_id !~ '^[0-9]{1,100}$'
    or char_length(btrim(p_subject_username_snapshot)) not between 1 and 160
    or not exists (
      select 1 from public.team_inbox_topic_catalog
      where topic_key = p_topic_key
        and is_active
        and accepts_new_cases
    )
  then
    raise exception using errcode = '22023', message = 'TEAM_INBOX_SOURCE_INPUT_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'team-inbox-source:' || p_topic_key || ':' || p_source_key, 0
  ));
  select * into v_case from public.team_inbox_cases
  where topic_key = p_topic_key and source_key = p_source_key
  for update;
  if not found then
    insert into public.team_inbox_cases (
      topic_key, source_key, source_version,
      subject_discord_user_id, subject_username_snapshot
    ) values (
      p_topic_key, p_source_key, p_source_version,
      p_subject_discord_user_id, btrim(p_subject_username_snapshot)
    ) returning * into v_case;
    insert into public.team_inbox_timeline_events (
      case_id, event_type, work_version, row_version, source_version
    ) values (
      v_case.id, 'created', v_case.work_version, v_case.row_version, p_source_version
    );
    return jsonb_build_object('outcome', 'created', 'caseId', v_case.id);
  end if;
  if p_source_version <= v_case.source_version then
    return jsonb_build_object('outcome', 'replayed', 'caseId', v_case.id);
  end if;
  if v_case.status = 'solved' then
    update public.team_inbox_cases
    set source_version = p_source_version,
        subject_username_snapshot = btrim(p_subject_username_snapshot),
        status = 'open', assignee_discord_user_id = null,
        assignee_display_snapshot = null, claimed_at = null, solved_at = null,
        work_version = work_version + 1, row_version = row_version + 1,
        updated_at = transaction_timestamp()
    where id = v_case.id returning * into v_case;
    insert into public.team_inbox_timeline_events (
      case_id, event_type, work_version, row_version, source_version
    ) values (
      v_case.id, 'reopened', v_case.work_version, v_case.row_version, p_source_version
    );
    return jsonb_build_object('outcome', 'reopened', 'caseId', v_case.id);
  end if;
  update public.team_inbox_cases
  set source_version = p_source_version,
      subject_username_snapshot = btrim(p_subject_username_snapshot),
      row_version = row_version + 1,
      updated_at = transaction_timestamp()
  where id = v_case.id returning * into v_case;
  insert into public.team_inbox_timeline_events (
    case_id, event_type, work_version, row_version, source_version,
    outcome_code
  ) values (
    v_case.id, 'topic_action', v_case.work_version, v_case.row_version,
    p_source_version, 'source_updated'
  );
  return jsonb_build_object('outcome', 'updated', 'caseId', v_case.id);
end;
$function$;

alter function public.protect_team_inbox_topic_history() owner to postgres;
alter function public.upsert_team_inbox_case(text,text,bigint,text,text) owner to postgres;

revoke all on function public.protect_team_inbox_topic_history()
  from public, anon, authenticated, discord_bot, service_role;

do $postflight$
begin
  if not exists (
      select 1
      from public.team_inbox_topic_catalog
      where topic_key = 'wallet_issues'
        and not is_active
        and not accepts_new_cases
    )
    or (
      select count(*)
      from pg_trigger
      where tgrelid = 'public.team_inbox_topic_catalog'::regclass
        and tgname = 'team_inbox_topic_history_visible'
        and not tgisinternal
    ) <> 1
    or exists (
      select 1
      from pg_proc function_row
      where function_row.oid in (
        'public.protect_team_inbox_topic_history()'::regprocedure,
        'public.upsert_team_inbox_case(text,text,bigint,text,text)'::regprocedure
      )
        and (
          not function_row.prosecdef
          or pg_get_userbyid(function_row.proowner) <> 'postgres'
          or function_row.proconfig is distinct from array['search_path=public, pg_temp']::text[]
        )
    )
  then
    raise exception using
      errcode = '55000',
      message = 'TEAM_INBOX_HISTORY_VISIBILITY_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if to_regprocedure('public.attach_community_comment_spam_reference()') is null
    or to_regprocedure('public.attach_community_comment_report_spam_reference()') is null
    or pg_get_functiondef('public.attach_community_comment_spam_reference()'::regprocedure)
      not like '%case when tg_table_name = ''community_comment_vote_transitions''%'
    or pg_get_functiondef('public.attach_community_comment_report_spam_reference()'::regprocedure)
      not like '%new.reporter_discord_user_id%'
    or not exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.community_comment_reports'::regclass
        and trigger_row.tgname = 'community_comment_reports_spam_reference'
        and trigger_row.tgfoid = 'public.attach_community_comment_report_spam_reference()'::regprocedure
        and not trigger_row.tgisinternal
    )
  then
    raise exception using
      errcode = '55000',
      message = 'COMMENT_SPAM_REFERENCE_TRIGGER_CORRECTION_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

create or replace function public.attach_community_comment_spam_reference()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case_id uuid;
  v_actor text;
begin
  if tg_table_name = 'community_comment_vote_transitions' then
    v_actor := new.voter_discord_user_id;
  elsif tg_table_name = 'community_comment_mutation_events' then
    v_actor := new.actor_discord_user_id;
  else
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_COMMENT_SPAM_REFERENCE_TRIGGER_TABLE_INVALID';
  end if;
  select spam_case.id into v_case_id
  from public.community_comment_spam_cases spam_case
  where spam_case.subject_discord_user_id = v_actor and spam_case.status = 'open'
  for update;
  if found then
    insert into public.community_comment_spam_comment_refs(case_id, comment_id)
    values (v_case_id, new.comment_id)
    on conflict (case_id, comment_id) do update
    set last_seen_at = transaction_timestamp(),
        reference_count = public.community_comment_spam_comment_refs.reference_count + 1;
  end if;
  return new;
end;
$function$;

alter function public.attach_community_comment_spam_reference() owner to postgres;
revoke all on function public.attach_community_comment_spam_reference()
from public, anon, authenticated, discord_bot, service_role;

do $postflight$
begin
  if pg_get_functiondef('public.attach_community_comment_spam_reference()'::regprocedure)
      not like '%if tg_table_name = ''community_comment_vote_transitions'' then%'
    or pg_get_functiondef('public.attach_community_comment_spam_reference()'::regprocedure)
      not like '%new.voter_discord_user_id%'
    or pg_get_functiondef('public.attach_community_comment_spam_reference()'::regprocedure)
      not like '%elsif tg_table_name = ''community_comment_mutation_events'' then%'
    or pg_get_functiondef('public.attach_community_comment_spam_reference()'::regprocedure)
      not like '%new.actor_discord_user_id%'
    or pg_get_functiondef('public.attach_community_comment_report_spam_reference()'::regprocedure)
      not like '%new.reporter_discord_user_id%'
    or exists (
      select 1 from pg_proc function_row
      where function_row.oid in (
        'public.attach_community_comment_spam_reference()'::regprocedure,
        'public.attach_community_comment_report_spam_reference()'::regprocedure
      ) and (
        pg_get_userbyid(function_row.proowner) <> 'postgres'
        or not function_row.prosecdef
        or not function_row.proconfig @> array['search_path=public, pg_temp']
      )
    )
    or has_function_privilege('service_role', 'public.attach_community_comment_spam_reference()', 'EXECUTE')
    or has_function_privilege('service_role', 'public.attach_community_comment_report_spam_reference()', 'EXECUTE')
    or not exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.community_comment_reports'::regclass
        and trigger_row.tgname = 'community_comment_reports_spam_reference'
        and trigger_row.tgfoid = 'public.attach_community_comment_report_spam_reference()'::regprocedure
        and not trigger_row.tgisinternal
    )
  then
    raise exception using
      errcode = '55000',
      message = 'COMMENT_SPAM_REFERENCE_TRIGGER_CORRECTION_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;

begin;

do $preflight$
begin
  if to_regprocedure(
      'public.authorize_submission_report_capability_v2(text,text)'
    ) is null
    or to_regprocedure(
      'public.list_submission_report_moderation_events_v2(text,timestamptz,uuid,integer)'
    ) is null then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_OUTCOME_HISTORY_PREDECESSOR_MISSING';
  end if;

  if to_regprocedure(
      'public.list_submission_report_outcome_events_v3(text,timestamptz,uuid,text,integer)'
    ) is not null then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_OUTCOME_HISTORY_TARGET_ALREADY_PRESENT';
  end if;

  if to_regclass('public.submission_report_case_events') is null
    or to_regclass('public.submission_report_cases') is null then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_OUTCOME_HISTORY_RELATION_MISSING';
  end if;
end;
$preflight$;

create function public.list_submission_report_outcome_events_v3(
  p_actor_discord_user_id text,
  p_before_occurred_at timestamptz default null,
  p_before_event_id uuid default null,
  p_outcome_filter text default null,
  p_limit integer default 50
)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_result jsonb;
  v_filter text := nullif(btrim(p_outcome_filter), '');
begin
  v_role := public.authorize_submission_report_capability_v2(
    p_actor_discord_user_id, 'logs.submission_report_moderation.view'
  );

  if (p_before_occurred_at is null) <> (p_before_event_id is null)
    or p_limit not between 1 and 100
    or (
      v_filter is not null
      and v_filter not in (
        'reopened',
        'action_taken',
        'no_action_current_rules',
        'insufficient_information',
        'submission_unavailable'
      )
    ) then
    raise exception using errcode = '22023',
      message = 'SUBMISSION_REPORT_OUTCOME_HISTORY_LIST_INVALID';
  end if;

  with page as (
    select event.occurred_at, event.event_id, jsonb_build_object(
      'eventId', event.event_id,
      'caseId', event.case_id,
      'caseArea', public.submission_report_case_area(event.case_id),
      'submissionId', report_case.submission_id,
      'cycleId', report_case.cycle_id,
      'eventType', event.event_type,
      'previousStatus', event.previous_status,
      'newStatus', event.new_status,
      'actorDisplayName', event.actor_display_name,
      'actorRoleKey', event.actor_role_key,
      'actorDiscordUserId', case when v_role = 'admin'
        then event.actor_discord_user_id else null end,
      'occurredAt', event.occurred_at,
      'disposition', event.disposition,
      'outcomeCode', case
        when event.event_type = 'case_reopened_by_report'
          then 'reopened_after_new_report'
        when event.disposition = 'action_taken'
          then 'action_taken_after_review'
        when event.disposition = 'no_action_current_rules'
          then 'reviewed_no_action_current_rules'
        when event.disposition = 'submission_unavailable'
          then 'closed_submission_unavailable'
        else 'included_in_completed_review'
      end,
      'note', case when v_role = 'admin' then event.note else null end,
      'caseVersion', event.case_version
    ) item
    from public.submission_report_case_events event
    join public.submission_report_cases report_case
      on report_case.case_id = event.case_id
    where event.event_type in ('case_closed', 'case_reopened_by_report')
      and (
        v_filter is null
        or (v_filter = 'reopened' and event.event_type = 'case_reopened_by_report')
        or event.disposition = v_filter
      )
      and (
        p_before_occurred_at is null
        or (event.occurred_at, event.event_id)
          < (p_before_occurred_at, p_before_event_id)
      )
    order by event.occurred_at desc, event.event_id desc
    limit p_limit + 1
  ), visible as (
    select * from page
    order by occurred_at desc, event_id desc
    limit p_limit
  )
  select jsonb_build_object(
    'events', coalesce(
      (select jsonb_agg(item order by occurred_at desc, event_id desc) from visible),
      '[]'::jsonb
    ),
    'nextCursor', case when (select count(*) from page) > p_limit then (
      select jsonb_build_object('occurredAt', occurred_at, 'eventId', event_id)
      from visible
      order by occurred_at desc, event_id desc
      offset p_limit - 1 limit 1
    ) else null end
  ) into v_result;

  return v_result;
end;
$function$;

alter function public.list_submission_report_outcome_events_v3(
  text, timestamptz, uuid, text, integer
) owner to postgres;

revoke all on function public.list_submission_report_outcome_events_v3(
  text, timestamptz, uuid, text, integer
) from public, anon, authenticated, discord_bot;
grant execute on function public.list_submission_report_outcome_events_v3(
  text, timestamptz, uuid, text, integer
) to service_role;

do $postflight$
declare
  v_function regprocedure := to_regprocedure(
    'public.list_submission_report_outcome_events_v3(text,timestamptz,uuid,text,integer)'
  );
begin
  if v_function is null
    or not exists (
      select 1
      from pg_proc function_row
      where function_row.oid = v_function
        and function_row.prosecdef
        and function_row.provolatile = 's'
        and function_row.proowner = (select oid from pg_roles where rolname = 'postgres')
        and function_row.proconfig = array['search_path=public, pg_temp']
    ) then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_OUTCOME_HISTORY_HARDENING_MISMATCH';
  end if;

  if (
      select count(*)
      from pg_proc function_row
      cross join lateral aclexplode(
        coalesce(function_row.proacl, acldefault('f', function_row.proowner))
      ) privilege_row
      where function_row.oid = v_function
        and privilege_row.privilege_type = 'EXECUTE'
    ) <> 2
    or not has_function_privilege('service_role', v_function, 'EXECUTE')
    or has_function_privilege('anon', v_function, 'EXECUTE')
    or has_function_privilege('authenticated', v_function, 'EXECUTE')
    or has_function_privilege('discord_bot', v_function, 'EXECUTE') then
    raise exception using errcode = '55000',
      message = 'SUBMISSION_REPORT_OUTCOME_HISTORY_ACL_MISMATCH';
  end if;
end;
$postflight$;

comment on function public.list_submission_report_outcome_events_v3(
  text, timestamptz, uuid, text, integer
) is 'Capability-guarded, cursor-paginated Submission Report outcome history. Claim and release mechanics remain append-only but are excluded from this normal presentation.';

commit;

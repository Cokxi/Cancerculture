begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
declare
  v_signature regprocedure :=
    to_regprocedure('public.get_user_warning_appeal_case_detail(text,uuid)');
begin
  if v_signature is null
    or (
      select function_row.provolatile <> 'v'
        or not function_row.prosecdef
        or pg_get_userbyid(function_row.proowner) <> 'postgres'
        or md5(pg_get_functiondef(function_row.oid)) <>
          'd2bd87ed651bbf8805d9269ae7a8a31a'
      from pg_proc function_row
      where function_row.oid = v_signature
    )
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_APPEAL_SOURCE_VERSION_PREFLIGHT_MISMATCH';
  end if;
end;
$preflight$;

create or replace function public.get_user_warning_appeal_case_detail(
  p_actor_discord_user_id text,
  p_case_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_generic jsonb;
  v_domain jsonb;
begin
  perform public.assert_team_inbox_topic_access(p_actor_discord_user_id, 'warning_appeals', false);
  v_generic := public.get_team_inbox_case_detail(p_actor_discord_user_id, p_case_id);
  if v_generic ->> 'outcome' <> 'found'
    or v_generic #>> '{case,topicKey}' <> 'warning_appeals'
  then return jsonb_build_object('outcome', 'not_found'); end if;
  v_generic := jsonb_set(
    v_generic,
    '{case,sourceVersion}',
    to_jsonb((
      select case_row.source_version
      from public.team_inbox_cases case_row
      where case_row.id = p_case_id
    )),
    true
  );
  select jsonb_build_object(
    'kind', 'warning_appeal',
    'appealId', appeal.public_appeal_id,
    'appealText', appeal.appeal_text,
    'appealStatus', appeal_current.status,
    'appealRowVersion', appeal_current.row_version,
    'submittedAt', appeal.submitted_at,
    'reviewedAt', appeal_current.reviewed_at,
    'reviewReason', terminal_event.review_reason,
    'warning', jsonb_build_object(
      'warningId', warning_row.public_warning_id,
      'category', warning_row.category,
      'reason', warning_row.reason,
      'issuedAt', warning_row.issued_at,
      'issuedByDisplayName', warning_row.issued_by_display_name,
      'issuedByRole', warning_row.issued_by_role_key,
      'state', warning_current.state,
      'effectiveTierDays', warning_current.effective_tier_days,
      'expiresAt', warning_current.expires_at,
      'rowVersion', warning_current.row_version,
      'sourcePublicCommentId', warning_row.source_public_comment_id,
      'sourceSubmissionId', warning_row.source_submission_id,
      'sourceCommentObjectVersion', warning_row.source_comment_object_version,
      'sourceCommentTextVersion', warning_row.source_comment_text_version,
      'sourceCommentBody', warning_row.source_comment_body
    )
  ) into v_domain
  from public.user_warning_appeals appeal
  join public.user_warning_appeal_current appeal_current on appeal_current.appeal_id = appeal.appeal_id
  join public.user_warnings warning_row on warning_row.warning_id = appeal.warning_id
  join public.user_warning_current warning_current on warning_current.warning_id = appeal.warning_id
  left join lateral (
    select event_row.review_reason from public.user_warning_appeal_events event_row
    where event_row.appeal_id = appeal.appeal_id
      and event_row.event_type in ('upheld', 'overruled')
    order by event_row.event_id desc limit 1
  ) terminal_event on true
  where appeal.team_inbox_case_id = p_case_id;
  if v_domain is null then return jsonb_build_object('outcome', 'not_found'); end if;
  return v_generic || jsonb_build_object('domain', v_domain);
end;
$function$;

alter function public.get_user_warning_appeal_case_detail(text,uuid)
  owner to postgres;

revoke all on function public.get_user_warning_appeal_case_detail(text,uuid)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.get_user_warning_appeal_case_detail(text,uuid)
  to service_role;

do $postflight$
declare
  v_signature regprocedure :=
    to_regprocedure('public.get_user_warning_appeal_case_detail(text,uuid)');
begin
  if v_signature is null
    or (
      select function_row.provolatile <> 'v'
        or not function_row.prosecdef
        or pg_get_userbyid(function_row.proowner) <> 'postgres'
        or coalesce(array_to_string(function_row.proconfig, ';'), '') <>
          'search_path=public, pg_temp'
        or position('sourceVersion' in pg_get_functiondef(function_row.oid)) = 0
        or position('case_row.source_version' in pg_get_functiondef(function_row.oid)) = 0
      from pg_proc function_row
      where function_row.oid = v_signature
    )
    or has_function_privilege('authenticated', v_signature, 'EXECUTE')
    or not has_function_privilege('service_role', v_signature, 'EXECUTE')
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_APPEAL_SOURCE_VERSION_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;

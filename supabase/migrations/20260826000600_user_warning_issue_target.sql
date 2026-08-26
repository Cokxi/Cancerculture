begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if to_regprocedure(
    'public.issue_user_warning(text,uuid,bigint,bigint,text,text,uuid)'
  ) is null
    or to_regprocedure(
      'public.authorize_user_warning_capability(text,text)'
    ) is null
    or to_regclass('public.user_warnings') is null
    or to_regclass('public.community_comments') is null
    or to_regclass('public.community_comment_text_versions') is null
    or to_regprocedure(
      'public.get_user_warning_issue_target(text,uuid)'
    ) is not null
    or (
      select count(*)
      from public.capability_catalog capability
      where capability.key = 'users.warnings.issue'
        and capability.is_active
        and capability.assignable_to_non_admin
        and capability.implementation_version = 1
        and capability.definition_hash =
          '8910867c7eb547473efaf129089bf2e0098d6f471e2057358ddd77f90818811f'
    ) <> 1
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_ISSUE_TARGET_PREFLIGHT_MISMATCH';
  end if;
end;
$preflight$;

create function public.get_user_warning_issue_target(
  p_actor_discord_user_id text,
  p_public_comment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_comment public.community_comments%rowtype;
  v_text text;
  v_submission_eligible boolean;
  v_already_warned boolean;
  v_available boolean;
begin
  if p_public_comment_id is null then
    raise exception using
      errcode = '22023',
      message = 'USER_WARNING_ISSUE_TARGET_INPUT_INVALID';
  end if;

  perform public.authorize_user_warning_capability(
    p_actor_discord_user_id,
    'users.warnings.issue'
  );

  select comment_row.*
  into v_comment
  from public.community_comments comment_row
  where comment_row.public_comment_id = p_public_comment_id;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select text_version.normalized_body
  into v_text
  from public.community_comment_text_versions text_version
  where text_version.comment_id = v_comment.id
    and text_version.version = v_comment.current_text_version;

  v_submission_eligible :=
    public.is_community_comment_submission_eligible(v_comment.submission_id);
  v_already_warned := exists (
    select 1
    from public.user_warnings warning_row
    where warning_row.source_comment_id = v_comment.id
  );
  v_available := v_comment.author_deleted_at is null
    and v_submission_eligible
    and v_text is not null;

  return jsonb_build_object(
    'outcome', 'found',
    'publicCommentId', v_comment.public_comment_id,
    'objectVersion', v_comment.object_version,
    'textVersion', v_comment.current_text_version,
    'text', case when v_available then v_text else null end,
    'available', v_available,
    'alreadyWarned', v_already_warned
  );
end;
$function$;

alter function public.get_user_warning_issue_target(text,uuid)
  owner to postgres;

revoke all on function public.get_user_warning_issue_target(text,uuid)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.get_user_warning_issue_target(text,uuid)
  to service_role;

do $security_postflight$
declare
  v_signature text :=
    'public.get_user_warning_issue_target(text,uuid)';
begin
  if to_regprocedure(v_signature) is null
    or (
      select count(*)
      from pg_proc function_row
      join pg_namespace namespace_row
        on namespace_row.oid = function_row.pronamespace
      where namespace_row.nspname = 'public'
        and function_row.proname = 'get_user_warning_issue_target'
    ) <> 1
    or not exists (
      select 1
      from pg_proc function_row
      where function_row.oid = to_regprocedure(v_signature)
        and pg_get_userbyid(function_row.proowner) = 'postgres'
        and function_row.prosecdef
        and function_row.proconfig @> array['search_path=public, pg_temp']
    )
    or has_function_privilege('anon', v_signature, 'EXECUTE')
    or has_function_privilege('authenticated', v_signature, 'EXECUTE')
    or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
    or not has_function_privilege('service_role', v_signature, 'EXECUTE')
    or exists (
      select 1
      from public.team_role_capabilities grant_row
      where grant_row.capability_key = 'users.warnings.issue'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'USER_WARNING_ISSUE_TARGET_SECURITY_MISMATCH';
  end if;
end;
$security_postflight$;

comment on function public.get_user_warning_issue_target(text,uuid) is
  'Returns only the minimum exact Comment evidence and permanent source-use state needed to review a Warning issue action. It exposes no target Discord ID, Warning history, Report or Case data.';

commit;

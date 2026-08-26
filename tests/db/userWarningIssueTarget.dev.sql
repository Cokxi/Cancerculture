\set ON_ERROR_STOP on

begin read only;

set local lock_timeout = '10s';
set local statement_timeout = '60s';

do $warning_target_contract$
declare
  v_actor text;
  v_public_comment_id uuid;
  v_expected_object_version bigint;
  v_expected_text_version bigint;
  v_expected_text text;
  v_target jsonb;
begin
  select member.discord_user_id
  into v_actor
  from public.team_members member
  where member.role = 'admin'
  order by member.discord_user_id
  limit 1;

  select
    comment_row.public_comment_id,
    comment_row.object_version,
    comment_row.current_text_version,
    text_version.normalized_body
  into
    v_public_comment_id,
    v_expected_object_version,
    v_expected_text_version,
    v_expected_text
  from public.community_comments comment_row
  join public.community_comment_text_versions text_version
    on text_version.comment_id = comment_row.id
   and text_version.version = comment_row.current_text_version
  where comment_row.author_deleted_at is null
    and text_version.normalized_body is not null
    and public.is_community_comment_submission_eligible(comment_row.submission_id)
  order by comment_row.created_at, comment_row.public_comment_id
  limit 1;

  if v_actor is null or v_public_comment_id is null then
    raise exception 'DEV_USER_WARNING_TARGET_FIXTURE_UNAVAILABLE';
  end if;

  begin
    perform public.get_user_warning_issue_target(
      'user-warning-target-unauthorized',
      v_public_comment_id
    );
    raise exception 'DEV_USER_WARNING_TARGET_CAPABILITY_DENIAL_FAILED';
  exception when sqlstate '42501' then null;
  end;

  v_target := public.get_user_warning_issue_target(
    v_actor,
    v_public_comment_id
  );

  if v_target ->> 'outcome' <> 'found'
    or (v_target ->> 'publicCommentId')::uuid <> v_public_comment_id
    or (v_target ->> 'objectVersion')::bigint <> v_expected_object_version
    or (v_target ->> 'textVersion')::bigint <> v_expected_text_version
    or v_target ->> 'text' <> v_expected_text
    or (v_target ->> 'available')::boolean is not true
    or (v_target ->> 'alreadyWarned')::boolean is not false
    or (select array_agg(key order by key) from jsonb_object_keys(v_target) key)
      <> array[
        'alreadyWarned',
        'available',
        'objectVersion',
        'outcome',
        'publicCommentId',
        'text',
        'textVersion'
      ]::text[]
  then
    raise exception 'DEV_USER_WARNING_TARGET_SHAPE_MISMATCH';
  end if;

  if exists (select 1 from public.user_warnings)
    or exists (select 1 from public.user_warning_requests)
    or exists (select 1 from public.user_warning_events)
  then
    raise exception 'DEV_USER_WARNING_TARGET_READ_MUTATED_STATE';
  end if;
end;
$warning_target_contract$;

rollback;

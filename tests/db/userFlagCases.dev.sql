\set ON_ERROR_STOP on

begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 10
    or (select count(*) from public.capability_catalog where is_active) <> 8
    or (select count(*) from public.capability_catalog where is_active and assignable_to_non_admin) <> 8
    or exists (select 1 from public.team_role_capabilities)
    or to_regclass('public.user_flag_cases') is null then
    raise exception 'DEV_USER_FLAG_TEST_PREFLIGHT_DRIFT';
  end if;
end;
$preflight$;

insert into public.user_logs (discord_user_id, current_discord_username)
values ('user-flag-rollback-target', 'user-flag-rollback-target');

set local role service_role;

do $rpc_contract$
declare
  v_actor text;
  v_first jsonb;
  v_retry jsonb;
  v_review jsonb;
  v_review_retry jsonb;
  v_case_id uuid;
  v_list jsonb;
  v_detail jsonb;
begin
  select discord_user_id into v_actor
  from public.team_members where role = 'admin'
  order by discord_user_id limit 1;

  v_first := public.create_user_flag_case(
    v_actor, 'user-flag-rollback-target', 'other',
    'Rollback-only functional flag case.', 'No persistent data.', null,
    '51000000-0000-4000-8000-000000000001'::uuid
  );
  v_retry := public.create_user_flag_case(
    v_actor, 'user-flag-rollback-target', 'other',
    'Rollback-only functional flag case.', 'No persistent data.', null,
    '51000000-0000-4000-8000-000000000001'::uuid
  );
  v_case_id := (v_first ->> 'caseId')::uuid;

  if v_first ->> 'status' <> 'open'
    or v_first ->> 'rowVersion' <> '1'
    or v_first ->> 'replayed' <> 'false'
    or v_retry ->> 'caseId' <> v_first ->> 'caseId'
    or v_retry ->> 'replayed' <> 'true'
    or (select count(*) from public.user_flag_cases where case_id = v_case_id) <> 1
    or (select count(*) from public.user_flag_events where case_id = v_case_id) <> 1
    or (select count(*) from public.user_flag_requests where result ->> 'caseId' = v_case_id::text) <> 1 then
    raise exception 'USER_FLAG_CREATE_OR_REPLAY_FAILED';
  end if;

  begin
    perform public.create_user_flag_case(
      v_actor, 'user-flag-rollback-target', 'other',
      'Different payload must conflict.', null, null,
      '51000000-0000-4000-8000-000000000001'::uuid
    );
    raise exception 'USER_FLAG_IDEMPOTENCY_CONFLICT_NOT_REJECTED';
  exception when sqlstate 'PT409' then null;
  end;

  begin
    perform public.create_user_flag_case(
      v_actor, 'user-flag-rollback-target', 'other',
      'Second open case must conflict.', null, null,
      '51000000-0000-4000-8000-000000000002'::uuid
    );
    raise exception 'USER_FLAG_DUPLICATE_OPEN_CASE_NOT_REJECTED';
  exception when sqlstate 'PT409' then null;
  end;

  v_list := public.list_user_flag_cases(v_actor);
  v_detail := public.get_user_flag_case(v_actor, v_case_id);
  if jsonb_array_length(v_list) < 1
    or v_detail ->> 'caseId' <> v_case_id::text
    or jsonb_array_length(v_detail -> 'events') <> 1 then
    raise exception 'USER_FLAG_READ_MODEL_FAILED';
  end if;

  v_review := public.review_user_flag_case(
    v_actor, v_case_id, 1, 'resolved', 'Rollback-only resolution.',
    '51000000-0000-4000-8000-000000000003'::uuid
  );
  v_review_retry := public.review_user_flag_case(
    v_actor, v_case_id, 1, 'resolved', 'Rollback-only resolution.',
    '51000000-0000-4000-8000-000000000003'::uuid
  );
  if v_review ->> 'status' <> 'resolved'
    or v_review ->> 'rowVersion' <> '2'
    or v_review_retry ->> 'replayed' <> 'true'
    or (select count(*) from public.user_flag_events where case_id = v_case_id) <> 2
    or (select count(*) from public.user_flag_requests where result ->> 'caseId' = v_case_id::text) <> 2 then
    raise exception 'USER_FLAG_REVIEW_OR_REPLAY_FAILED';
  end if;

  begin
    perform public.review_user_flag_case(
      v_actor, v_case_id, 1, 'dismissed', 'Stale review must fail.',
      '51000000-0000-4000-8000-000000000004'::uuid
    );
    raise exception 'USER_FLAG_STALE_REVIEW_NOT_REJECTED';
  exception when sqlstate 'PT409' then null;
  end;
end;
$rpc_contract$;

reset role;

do $append_only_and_acl$
declare
  v_case_id uuid;
begin
  select case_id into v_case_id from public.user_flag_cases
  where discord_user_id = 'user-flag-rollback-target';

  begin
    delete from public.user_flag_cases where case_id = v_case_id;
    raise exception 'USER_FLAG_CASE_DELETE_WAS_ALLOWED';
  exception when sqlstate '55000' then null;
  end;
  begin
    update public.user_flag_events set comment = 'changed' where case_id = v_case_id;
    raise exception 'USER_FLAG_EVENT_UPDATE_WAS_ALLOWED';
  exception when sqlstate '55000' then null;
  end;

  if has_function_privilege('anon', 'public.create_user_flag_case(text,text,text,text,text,bigint,uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.review_user_flag_case(text,uuid,bigint,text,text,uuid)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.create_user_flag_case(text,text,text,text,text,bigint,uuid)', 'EXECUTE')
    or has_table_privilege('service_role', 'public.user_flag_cases', 'INSERT,UPDATE,DELETE') then
    raise exception 'USER_FLAG_ACL_FAILED';
  end if;
end;
$append_only_and_acl$;

rollback;

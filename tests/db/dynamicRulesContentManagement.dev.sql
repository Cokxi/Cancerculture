\set ON_ERROR_STOP on

begin;

set local statement_timeout = '30s';
set local lock_timeout = '5s';

do $test$
declare
  v_admin_id text;
  v_initial_state_version bigint;
  v_initial_rules_version integer;
  v_content jsonb;
  v_result jsonb;
  v_replay jsonb;
begin
  select member_row.discord_user_id
  into v_admin_id
  from public.team_members member_row
  where member_row.role = 'admin'
  order by member_row.discord_user_id
  limit 1;

  if v_admin_id is null then
    raise exception 'DYNAMIC_RULES_TEST_ADMIN_MISSING';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = 'rules.manage'
      and is_active
      and assignable_to_non_admin
      and implementation_version = 1
      and definition_hash =
        'd7097dece0897ddcd924010a9a8cd48f427512231eaf7da77a28005536720887'
  )
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key = 'rules.manage'
    ) then
    raise exception 'DYNAMIC_RULES_TEST_CAPABILITY_MISMATCH';
  end if;

  select state_version
  into v_initial_state_version
  from public.content_documents
  where key = 'rules';

  select current_version
  into v_initial_rules_version
  from public.rules_meta
  where id = 1;

  select revision_row.content
  into v_content
  from public.content_documents document_row
  join public.content_revisions revision_row
    on revision_row.document_key = document_row.key
   and revision_row.id = document_row.published_revision_id
  where document_row.key = 'rules';

  if v_initial_state_version is null
    or v_initial_rules_version is null
    or v_content is null then
    raise exception 'DYNAMIC_RULES_TEST_BOOTSTRAP_MISMATCH';
  end if;

  v_content := jsonb_set(
    v_content,
    '{heading}',
    to_jsonb((v_content ->> 'heading') || ' DEV wording test')
  );

  v_result := public.manage_rules_content(
    v_admin_id,
    'save_draft',
    v_initial_state_version,
    v_content,
    null,
    '84000000-0000-4000-8000-000000000001'::uuid
  );

  if v_result ->> 'operation' <> 'save_draft'
    or (v_result ->> 'stateVersion')::bigint <> v_initial_state_version + 1
    or (v_result ->> 'rulesVersion')::integer <> v_initial_rules_version
    or (v_result ->> 'replayed')::boolean then
    raise exception 'DYNAMIC_RULES_TEST_SAVE_RESULT_MISMATCH';
  end if;

  v_replay := public.manage_rules_content(
    v_admin_id,
    'save_draft',
    v_initial_state_version,
    v_content,
    null,
    '84000000-0000-4000-8000-000000000001'::uuid
  );

  if not (v_replay ->> 'replayed')::boolean
    or v_replay ->> 'revisionId' <> v_result ->> 'revisionId' then
    raise exception 'DYNAMIC_RULES_TEST_REPLAY_MISMATCH';
  end if;

  begin
    perform public.manage_rules_content(
      v_admin_id,
      'save_draft',
      v_initial_state_version,
      jsonb_set(v_content, '{heading}', '"Stale request"'::jsonb),
      null,
      '84000000-0000-4000-8000-000000000002'::uuid
    );
    raise exception 'DYNAMIC_RULES_TEST_STALE_REQUEST_ACCEPTED';
  exception
    when sqlstate 'PT409' then
      if sqlerrm <> 'RULES_CONTENT_STATE_CONFLICT' then
        raise;
      end if;
  end;

  v_result := public.manage_rules_content(
    v_admin_id,
    'publish',
    v_initial_state_version + 1,
    null,
    false,
    '84000000-0000-4000-8000-000000000003'::uuid
  );

  if (v_result ->> 'materialChange')::boolean
    or (v_result ->> 'structureChanged')::boolean
    or (v_result ->> 'rulesVersion')::integer <> v_initial_rules_version then
    raise exception 'DYNAMIC_RULES_TEST_NON_MATERIAL_PUBLISH_MISMATCH';
  end if;

  v_content := jsonb_set(
    v_content,
    '{sections}',
    (v_content -> 'sections') || jsonb_build_array(
      jsonb_build_object(
        'id', 'dev-structural-test',
        'title', 'DEV Structural Test',
        'paragraphs', jsonb_build_array('Temporary transaction-only section.'),
        'bullets', '[]'::jsonb
      )
    )
  );

  v_result := public.manage_rules_content(
    v_admin_id,
    'save_draft',
    v_initial_state_version + 2,
    v_content,
    null,
    '84000000-0000-4000-8000-000000000004'::uuid
  );

  v_result := public.manage_rules_content(
    v_admin_id,
    'publish',
    v_initial_state_version + 3,
    null,
    false,
    '84000000-0000-4000-8000-000000000005'::uuid
  );

  if not (v_result ->> 'materialChange')::boolean
    or not (v_result ->> 'structureChanged')::boolean
    or (v_result ->> 'rulesVersion')::integer <> v_initial_rules_version + 1 then
    raise exception 'DYNAMIC_RULES_TEST_STRUCTURAL_PUBLISH_MISMATCH';
  end if;

  begin
    perform public.manage_rules_content(
      '999999999999999999',
      'publish',
      v_initial_state_version + 4,
      null,
      false,
      '84000000-0000-4000-8000-000000000006'::uuid
    );
    raise exception 'DYNAMIC_RULES_TEST_UNAUTHORIZED_REQUEST_ACCEPTED';
  exception
    when sqlstate '42501' then
      if sqlerrm <> 'RULES_CONTENT_FORBIDDEN' then
        raise;
      end if;
  end;

  if (
    select count(*)
    from public.content_publications
    where request_id in (
      '84000000-0000-4000-8000-000000000003'::uuid,
      '84000000-0000-4000-8000-000000000005'::uuid
    )
  ) <> 2
    or (
      select count(*)
      from public.content_management_requests
      where idempotency_key between
        '84000000-0000-4000-8000-000000000001'::uuid
        and '84000000-0000-4000-8000-000000000005'::uuid
    ) <> 4 then
    raise exception 'DYNAMIC_RULES_TEST_HISTORY_MISMATCH';
  end if;
end;
$test$;

rollback;

\set ON_ERROR_STOP on

begin;

set local statement_timeout = '30s';
set local lock_timeout = '5s';

do $test$
declare
  v_admin_id text;
  v_initial_state_version bigint;
  v_initial_rules_state_version bigint;
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
    raise exception 'DYNAMIC_FAQ_TEST_ADMIN_MISSING';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = 'faq.manage'
      and is_active
      and assignable_to_non_admin
      and implementation_version = 1
      and definition_hash =
        '7a0e2cecaf38453e42a00bbc60058f9a7793512941f2c62750d5c5537a030c93'
  )
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key = 'faq.manage'
    ) then
    raise exception 'DYNAMIC_FAQ_TEST_CAPABILITY_MISMATCH';
  end if;

  select state_version
  into v_initial_state_version
  from public.content_documents
  where key = 'faq';

  select state_version
  into v_initial_rules_state_version
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
  where document_row.key = 'faq'
    and document_row.draft_revision_id is null;

  if v_initial_state_version is null
    or v_initial_rules_state_version is null
    or v_initial_rules_version is null
    or v_content is null then
    raise exception 'DYNAMIC_FAQ_TEST_BOOTSTRAP_MISMATCH';
  end if;

  begin
    perform public.manage_faq_content(
      v_admin_id,
      v_initial_state_version,
      v_content || jsonb_build_object('html', '<script>unsafe</script>'),
      '85000000-0000-4000-8000-000000000001'::uuid
    );
    raise exception 'DYNAMIC_FAQ_TEST_INVALID_CONTENT_ACCEPTED';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'INVALID_FAQ_CONTENT_REQUEST' then
        raise;
      end if;
  end;

  v_content := jsonb_set(
    v_content,
    '{heading}',
    to_jsonb((v_content ->> 'heading') || ' DEV transaction test')
  );

  v_result := public.manage_faq_content(
    v_admin_id,
    v_initial_state_version,
    v_content,
    '85000000-0000-4000-8000-000000000002'::uuid
  );

  if v_result ->> 'operation' <> 'save_publish'
    or (v_result ->> 'stateVersion')::bigint <> v_initial_state_version + 1
    or (v_result ->> 'revisionNumber')::bigint <= 1
    or (v_result ->> 'replayed')::boolean then
    raise exception 'DYNAMIC_FAQ_TEST_PUBLISH_RESULT_MISMATCH';
  end if;

  v_replay := public.manage_faq_content(
    v_admin_id,
    v_initial_state_version,
    v_content,
    '85000000-0000-4000-8000-000000000002'::uuid
  );

  if not (v_replay ->> 'replayed')::boolean
    or v_replay ->> 'revisionId' <> v_result ->> 'revisionId' then
    raise exception 'DYNAMIC_FAQ_TEST_REPLAY_MISMATCH';
  end if;

  begin
    perform public.manage_faq_content(
      v_admin_id,
      v_initial_state_version,
      jsonb_set(v_content, '{heading}', '"Different replay"'::jsonb),
      '85000000-0000-4000-8000-000000000002'::uuid
    );
    raise exception 'DYNAMIC_FAQ_TEST_IDEMPOTENCY_CONFLICT_ACCEPTED';
  exception
    when sqlstate 'PT409' then
      if sqlerrm <> 'FAQ_CONTENT_IDEMPOTENCY_CONFLICT' then
        raise;
      end if;
  end;

  begin
    perform public.manage_faq_content(
      v_admin_id,
      v_initial_state_version,
      jsonb_set(v_content, '{heading}', '"Stale request"'::jsonb),
      '85000000-0000-4000-8000-000000000003'::uuid
    );
    raise exception 'DYNAMIC_FAQ_TEST_STALE_REQUEST_ACCEPTED';
  exception
    when sqlstate 'PT409' then
      if sqlerrm <> 'FAQ_CONTENT_STATE_CONFLICT' then
        raise;
      end if;
  end;

  begin
    perform public.manage_faq_content(
      v_admin_id,
      v_initial_state_version + 1,
      v_content,
      '85000000-0000-4000-8000-000000000004'::uuid
    );
    raise exception 'DYNAMIC_FAQ_TEST_UNCHANGED_CONTENT_ACCEPTED';
  exception
    when sqlstate 'PT409' then
      if sqlerrm <> 'FAQ_CONTENT_NO_CHANGES' then
        raise;
      end if;
  end;

  begin
    perform public.manage_faq_content(
      '999999999999999999',
      v_initial_state_version + 1,
      jsonb_set(v_content, '{heading}', '"Unauthorized"'::jsonb),
      '85000000-0000-4000-8000-000000000005'::uuid
    );
    raise exception 'DYNAMIC_FAQ_TEST_UNAUTHORIZED_REQUEST_ACCEPTED';
  exception
    when sqlstate '42501' then
      if sqlerrm <> 'FAQ_CONTENT_FORBIDDEN' then
        raise;
      end if;
  end;

  if (
    select count(*)
    from public.content_publications
    where request_id = '85000000-0000-4000-8000-000000000002'::uuid
      and document_key = 'faq'
      and requested_material_change is null
      and effective_material_change is null
      and structure_changed is null
      and previous_rules_version is null
      and rules_version is null
  ) <> 1
    or (
      select count(*)
      from public.content_management_requests
      where idempotency_key =
        '85000000-0000-4000-8000-000000000002'::uuid
        and operation = 'save_publish'
    ) <> 1
    or (
      select count(*)
      from public.admin_action_logs
      where action = 'faq_published'
        and meta ->> 'request_id' =
          '85000000-0000-4000-8000-000000000002'
    ) <> 1 then
    raise exception 'DYNAMIC_FAQ_TEST_HISTORY_MISMATCH';
  end if;

  if (select current_version from public.rules_meta where id = 1)
      <> v_initial_rules_version
    or (
      select state_version
      from public.content_documents
      where key = 'rules'
    ) <> v_initial_rules_state_version then
    raise exception 'DYNAMIC_FAQ_TEST_RULES_STATE_CHANGED';
  end if;
end;
$test$;

rollback;

begin;

do $test$
declare
  v_actor text;
  v_org public.donation_organizations%rowtype;
  v_revision public.donation_organization_revisions%rowtype;
  v_payload jsonb;
  v_result jsonb;
  v_replay jsonb;
  v_submission_id bigint;
  v_original_name text;
begin
  if (select count(*) from public.capability_catalog) <> 41
    or (select count(*) from public.capability_catalog where is_active) <> 37
    or (select count(*) from public.team_role_capabilities where capability_key = 'donation_organizations.manage') <> 0
    or (select count(*) from public.donation_organizations where state = 'active') <> 10
    or (select count(*) from public.donation_organization_revisions where published_at is not null) <> 10
  then
    raise exception 'dynamic organization DEV baseline mismatch';
  end if;

  select member.discord_user_id into v_actor
  from public.team_members member
  join public.team_roles role on role.key = member.role and role.is_active
  where member.role = 'admin'
  order by member.discord_user_id
  limit 1;
  if v_actor is null then raise exception 'admin owner context missing'; end if;

  if jsonb_array_length(public.get_donation_organization_catalog()) <> 10
    or public.get_donation_organization_catalog()::text like '%logoR2Key%'
    or public.get_donation_organization_catalog()::text like '%organizationId%'
    or public.get_donation_organization_catalog()::text like '%createdBy%'
  then
    raise exception 'public catalog DTO boundary mismatch';
  end if;

  select * into v_org from public.donation_organizations
  where public_key = 'animal-haven' for update;
  select * into v_revision from public.donation_organization_revisions
  where id = v_org.published_revision_id;
  v_payload := jsonb_build_object(
    'selectorName', v_revision.selector_name,
    'displayName', v_revision.display_name,
    'description', v_revision.description || ' Draft test.',
    'displayOrder', v_revision.display_order,
    'officialWebsiteUrl', v_revision.official_website_url,
    'givingBlockUrl', v_revision.giving_block_url,
    'officialSocialUrl', v_revision.official_social_url,
    'providerStatus', 'available',
    'selectable', true,
    'legacyLogoUrl', null,
    'logoR2Key', null,
    'reuseDraftLogo', true
  );
  v_result := public.manage_donation_organization(
    v_actor, 'save_draft', '10000000-0000-4000-8000-000000000001',
    'animal-haven', v_org.state_version, v_payload, null
  );
  if v_result ->> 'stateVersion' <> '3' or v_result ->> 'replayed' <> 'false' then
    raise exception 'draft expected-version result mismatch';
  end if;
  v_replay := public.manage_donation_organization(
    v_actor, 'save_draft', '10000000-0000-4000-8000-000000000001',
    'animal-haven', v_org.state_version, v_payload, null
  );
  if v_replay ->> 'replayed' <> 'true' then raise exception 'draft replay mismatch'; end if;

  begin
    perform public.manage_donation_organization(
      v_actor, 'save_draft', '10000000-0000-4000-8000-000000000001',
      'animal-haven', v_org.state_version + 1, v_payload, null
    );
    raise exception 'expected idempotency conflict';
  exception when unique_violation then
    if sqlerrm not like '%DONATION_ORGANIZATION_IDEMPOTENCY_CONFLICT%' then raise; end if;
  end;

  v_result := public.manage_donation_organization(
    v_actor, 'publish', '10000000-0000-4000-8000-000000000002',
    'animal-haven', 3, '{}'::jsonb, null
  );
  if v_result ->> 'stateVersion' <> '4' or v_result ->> 'state' <> 'active' then
    raise exception 'publish transition mismatch';
  end if;
  v_result := public.manage_donation_organization(
    v_actor, 'archive', '10000000-0000-4000-8000-000000000003',
    'animal-haven', 4, '{}'::jsonb, 'DEV transactional test'
  );
  if v_result ->> 'stateVersion' <> '5' or v_result ->> 'state' <> 'archived' then
    raise exception 'archive transition mismatch';
  end if;

  select reference.submission_id, reference.original_name
  into v_submission_id, v_original_name
  from public.submission_organization_references reference
  where reference.source_type = 'legacy'
  order by reference.submission_id
  limit 1;
  if v_submission_id is null then raise exception 'historical reference missing'; end if;

  begin
    perform public.manage_submission_organization_reference(
      v_actor, '20000000-0000-4000-8000-000000000001', v_submission_id,
      1, 'correct', 'Reviewed example', 'https://127.0.0.1/', 'DEV invalid URL test'
    );
    raise exception 'expected unsafe URL rejection';
  exception when invalid_parameter_value then
    if sqlerrm not like '%INVALID_ORGANIZATION_REFERENCE_CONTENT%' then raise; end if;
  end;

  v_result := public.manage_submission_organization_reference(
    v_actor, '20000000-0000-4000-8000-000000000002', v_submission_id,
    1, 'correct', 'Reviewed example', 'https://example.org/', 'DEV correction test'
  );
  if v_result ->> 'effectiveVersion' <> '2' or v_result ->> 'effectiveState' <> 'verified' then
    raise exception 'reference correction mismatch';
  end if;
  v_result := public.manage_submission_organization_reference(
    v_actor, '20000000-0000-4000-8000-000000000003', v_submission_id,
    2, 'quarantine', null, null, 'DEV quarantine test'
  );
  if v_result ->> 'effectiveVersion' <> '3' or v_result ->> 'effectiveState' <> 'quarantined' then
    raise exception 'reference quarantine mismatch';
  end if;
  if not exists (
    select 1 from public.submission_organization_references reference
    where reference.submission_id = v_submission_id
      and reference.original_name = v_original_name
      and reference.original_website_url is null
      and reference.effective_website_url is null
      and reference.effective_organization_id is null
  ) then
    raise exception 'immutable original or quarantine link boundary mismatch';
  end if;
end;
$test$;

rollback;

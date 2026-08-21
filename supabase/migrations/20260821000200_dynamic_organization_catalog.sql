begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 40
    or (select count(*) from public.capability_catalog where is_active) <> 36
    or not exists (
      select 1 from public.capability_catalog
      where key = 'community.polls.manage'
        and implementation_version = 1
        and definition_hash = '042a289cd77aca920ab6d07abec54cec1b380423c90aa3693b7fbb11537a9a7e'
        and is_active and assignable_to_non_admin
    )
    or exists (
      select 1 from public.capability_catalog
      where key = 'donation_organizations.manage'
    )
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key = 'donation_organizations.manage'
    )
    or to_regclass('public.submission_upload_operations') is null
    or to_regclass('public.submission_private_data') is null
    or to_regclass('public.submissions') is null
    or to_regprocedure(
      'public.reserve_submission_upload(uuid,uuid,text,text,text,integer,text,bigint,text,text,integer,text)'
    ) is null
    or to_regprocedure('public.commit_submission_upload(uuid,uuid,integer,integer)') is null
    or to_regprocedure('extensions.digest(bytea,text)') is null
    or exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'submission_upload_operations'
        and column_name = 'organization_source'
    )
    or exists (
      select 1 from public.submission_upload_operations
      where status in ('reserved', 'r2_uploaded')
    )
    or to_regclass('public.donation_organizations') is not null
    or to_regclass('public.donation_organization_revisions') is not null
    or to_regclass('public.donation_organization_url_claims') is not null
    or to_regclass('public.donation_organization_events') is not null
    or to_regclass('public.donation_organization_mutation_requests') is not null
    or to_regclass('public.submission_organization_references') is not null
    or to_regclass('public.submission_organization_reference_events') is not null
    or to_regclass('public.submission_organization_reference_requests') is not null
  then
    raise exception using
      errcode = '55000',
      message = 'DYNAMIC_ORGANIZATION_CATALOG_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

insert into public.capability_catalog (
  key, display_name, description, category, included_actions,
  excluded_actions, risk_level, assignable_to_non_admin, is_active,
  implementation_version, definition_hash
)
values (
  'donation_organizations.manage',
  'Manage Donation Organizations',
  'Create, review, publish, sort, deactivate, and archive versioned donation organizations and review Other references without rewriting historical Submission choices.',
  'Content',
  array[
    'View published and draft organization revisions, provider availability, selectability, managed logos, and append-only catalog history.',
    'Create or edit a versioned draft and atomically publish its public selector and overlay content without a Website deployment.',
    'Change ordering, selectability, provider availability, activation, or archival state through expected-version and idempotent transitions.',
    'Correct, verify, quarantine, or use an exact reviewed Other URL as a deduplicated draft candidate while preserving its immutable original snapshot.'
  ]::text[],
  array[
    'Automatically publishing reviewed Other entries or Community Vote results, guessing missing historical URLs, or fuzzy-merging organizations.',
    'Changing historical Submission, Winner Claim, or payout snapshots, disqualifying content because of an organization URL, or deleting referenced organizations.',
    'Exposing internal identifiers, private original Other data, storage keys, reviewer identities, or audit details on public surfaces.',
    'Managing the Giving Block operational wallet, prize pools, transfers, Claims, public payout records, roles, grants, Team membership, or Owner access.'
  ]::text[],
  'critical', true, true, 1,
  '18240d25d2183ebb17f7b1a56345ab2acc3906455d253b90cfee79cd5d6aa58d'
);

create function public.is_safe_public_https_url(p_value text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $function$
declare
  v_value text := btrim(coalesce(p_value, ''));
  v_authority text;
  v_host text;
  v_port text;
begin
  if char_length(v_value) not between 12 and 600
    or v_value !~ '^https://[^/?#]+(?:[/?#].*)?$'
    or v_value ~ '[[:space:][:cntrl:]]'
  then
    return false;
  end if;

  v_authority := split_part(substring(v_value from 9), '/', 1);
  v_authority := split_part(split_part(v_authority, '?', 1), '#', 1);
  if v_authority = '' or v_authority like '%@%' or v_authority like '[%' then
    return false;
  end if;

  v_host := lower(split_part(v_authority, ':', 1));
  v_port := nullif(split_part(v_authority, ':', 2), '');
  if v_port is not null and v_port <> '443' then
    return false;
  end if;

  if v_host = ''
    or v_host = 'localhost'
    or v_host like '%.localhost'
    or v_host like '%.local'
    or v_host like '%.internal'
    or v_host like '%.lan'
    or v_host !~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$'
    or v_host not like '%.%'
    or v_host ~ '^(0|10|127|169[.]254|192[.]168)[.]'
    or v_host ~ '^172[.](1[6-9]|2[0-9]|3[01])[.]'
    or v_host ~ '^22[4-9][.]'
    or v_host ~ '^23[0-9][.]'
    or v_host ~ '^24[0-9][.]'
    or v_host ~ '^25[0-5][.]'
  then
    return false;
  end if;

  return true;
end;
$function$;

create table public.donation_organizations (
  id uuid primary key default gen_random_uuid(),
  public_key text not null unique
    check (public_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(public_key) <= 80),
  state text not null default 'draft'
    check (state in ('draft', 'active', 'archived')),
  state_version bigint not null default 1 check (state_version > 0),
  draft_revision_id bigint,
  published_revision_id bigint,
  created_by text not null check (created_by ~ '^[0-9]+$'),
  created_at timestamptz not null default transaction_timestamp(),
  updated_by text not null check (updated_by ~ '^[0-9]+$'),
  updated_at timestamptz not null default transaction_timestamp(),
  archived_at timestamptz,
  archived_by text check (archived_by is null or archived_by ~ '^[0-9]+$'),
  constraint donation_organizations_state_consistency_check check (
    (state = 'draft' and published_revision_id is null and archived_at is null and archived_by is null)
    or (state = 'active' and published_revision_id is not null and archived_at is null and archived_by is null)
    or (state = 'archived' and archived_at is not null and archived_by is not null)
  )
);

create table public.donation_organization_revisions (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.donation_organizations(id),
  revision_number integer not null check (revision_number > 0),
  selector_name text not null check (selector_name = btrim(selector_name) and char_length(selector_name) between 2 and 120),
  display_name text not null check (display_name = btrim(display_name) and char_length(display_name) between 2 and 160),
  description text not null check (description = btrim(description) and char_length(description) between 20 and 1200),
  display_order integer not null check (display_order between 1 and 10000),
  official_website_url text not null check (public.is_safe_public_https_url(official_website_url)),
  giving_block_url text check (giving_block_url is null or public.is_safe_public_https_url(giving_block_url)),
  official_social_url text check (official_social_url is null or public.is_safe_public_https_url(official_social_url)),
  provider_status text not null check (provider_status in ('available', 'unavailable', 'unverified')),
  selectable boolean not null,
  legacy_logo_url text check (legacy_logo_url is null or public.is_safe_public_https_url(legacy_logo_url)),
  logo_r2_key text check (logo_r2_key is null or logo_r2_key ~ '^donation-organizations/logos/[0-9A-Fa-f-]{36}[.]webp$'),
  created_by text not null check (created_by ~ '^[0-9]+$'),
  created_at timestamptz not null default transaction_timestamp(),
  published_by text check (published_by is null or published_by ~ '^[0-9]+$'),
  published_at timestamptz,
  constraint donation_organization_revisions_number_unique unique (organization_id, revision_number),
  constraint donation_organization_revisions_logo_check check (num_nonnulls(legacy_logo_url, logo_r2_key) <= 1),
  constraint donation_organization_revisions_selectable_check check (not selectable or provider_status = 'available'),
  constraint donation_organization_revisions_publish_check check ((published_at is null) = (published_by is null))
);

alter table public.donation_organizations
  add constraint donation_organizations_draft_revision_fk
  foreign key (draft_revision_id) references public.donation_organization_revisions(id),
  add constraint donation_organizations_published_revision_fk
  foreign key (published_revision_id) references public.donation_organization_revisions(id);

create table public.donation_organization_url_claims (
  normalized_url text primary key check (public.is_safe_public_https_url(normalized_url)),
  organization_id uuid not null references public.donation_organizations(id),
  first_revision_id bigint not null references public.donation_organization_revisions(id),
  created_at timestamptz not null default transaction_timestamp()
);

create table public.donation_organization_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.donation_organizations(id),
  event_type text not null check (event_type in ('imported', 'draft_created', 'draft_saved', 'published', 'archived', 'draft_from_other')),
  state_version bigint not null check (state_version > 0),
  revision_id bigint references public.donation_organization_revisions(id),
  actor_discord_user_id text not null check (actor_discord_user_id ~ '^[0-9]+$'),
  reason text check (reason is null or (reason = btrim(reason) and char_length(reason) between 3 and 500)),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default transaction_timestamp()
);

create table public.donation_organization_mutation_requests (
  request_id uuid primary key,
  actor_discord_user_id text not null check (actor_discord_user_id ~ '^[0-9]+$'),
  operation text not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default transaction_timestamp()
);

create table public.submission_organization_references (
  submission_id bigint primary key references public.submissions(id),
  source_type text not null check (source_type in ('catalog', 'other', 'legacy')),
  organization_id uuid references public.donation_organizations(id),
  organization_revision_id bigint references public.donation_organization_revisions(id),
  original_name text not null check (original_name = btrim(original_name) and char_length(original_name) between 1 and 256),
  original_website_url text check (original_website_url is null or public.is_safe_public_https_url(original_website_url)),
  effective_version bigint not null default 1 check (effective_version > 0),
  effective_state text not null check (effective_state in ('verified', 'pending', 'quarantined')),
  effective_name text not null check (effective_name = btrim(effective_name) and char_length(effective_name) between 1 and 256),
  effective_website_url text check (effective_website_url is null or public.is_safe_public_https_url(effective_website_url)),
  effective_organization_id uuid references public.donation_organizations(id),
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  constraint submission_organization_reference_source_check check (
    (source_type = 'catalog' and organization_id is not null and organization_revision_id is not null and original_website_url is not null and effective_state = 'verified')
    or (source_type = 'other' and organization_id is null and organization_revision_id is null and original_website_url is not null)
    or (source_type = 'legacy' and organization_id is null and organization_revision_id is null and original_website_url is null)
  ),
  constraint submission_organization_reference_link_check check (
    (effective_state = 'verified' and effective_website_url is not null)
    or (effective_state in ('pending', 'quarantined') and effective_website_url is null and effective_organization_id is null)
  )
);

create table public.submission_organization_reference_events (
  id bigint generated always as identity primary key,
  submission_id bigint not null references public.submission_organization_references(submission_id),
  event_type text not null check (event_type in ('snapshot_created', 'verified', 'corrected', 'quarantined', 'catalog_candidate_created')),
  effective_version bigint not null check (effective_version > 0),
  actor_discord_user_id text check (actor_discord_user_id is null or actor_discord_user_id ~ '^[0-9]+$'),
  reason text check (reason is null or (reason = btrim(reason) and char_length(reason) between 3 and 500)),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default transaction_timestamp()
);

create table public.submission_organization_reference_requests (
  request_id uuid primary key,
  actor_discord_user_id text not null check (actor_discord_user_id ~ '^[0-9]+$'),
  submission_id bigint not null references public.submission_organization_references(submission_id),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default transaction_timestamp()
);

create function public.reject_organization_append_only_rewrite()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  raise exception using errcode = '55000', message = 'ORGANIZATION_APPEND_ONLY_REWRITE_FORBIDDEN';
end;
$function$;

create trigger preserve_donation_organization_events
before update or delete on public.donation_organization_events
for each row execute function public.reject_organization_append_only_rewrite();
create trigger preserve_donation_organization_requests
before update or delete on public.donation_organization_mutation_requests
for each row execute function public.reject_organization_append_only_rewrite();
create trigger preserve_submission_organization_reference_events
before update or delete on public.submission_organization_reference_events
for each row execute function public.reject_organization_append_only_rewrite();
create trigger preserve_submission_organization_reference_requests
before update or delete on public.submission_organization_reference_requests
for each row execute function public.reject_organization_append_only_rewrite();

create function public.preserve_submission_organization_original()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if new.submission_id is distinct from old.submission_id
    or new.source_type is distinct from old.source_type
    or new.organization_id is distinct from old.organization_id
    or new.organization_revision_id is distinct from old.organization_revision_id
    or new.original_name is distinct from old.original_name
    or new.original_website_url is distinct from old.original_website_url
    or new.created_at is distinct from old.created_at
  then
    raise exception using errcode = '55000', message = 'ORGANIZATION_ORIGINAL_SNAPSHOT_IMMUTABLE';
  end if;
  return new;
end;
$function$;

create trigger preserve_submission_organization_original
before update on public.submission_organization_references
for each row execute function public.preserve_submission_organization_original();

create function public.preserve_donation_organization_revision()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if old.published_at is not null
    or (to_jsonb(new) - 'published_by' - 'published_at')
      is distinct from (to_jsonb(old) - 'published_by' - 'published_at')
    or new.published_at is null
  then
    raise exception using errcode = '55000', message = 'DONATION_ORGANIZATION_REVISION_IMMUTABLE';
  end if;
  return new;
end;
$function$;

create trigger preserve_donation_organization_revision
before update on public.donation_organization_revisions
for each row execute function public.preserve_donation_organization_revision();

alter table public.submission_upload_operations
  add column organization_source text,
  add column organization_id uuid references public.donation_organizations(id),
  add column organization_revision_id bigint references public.donation_organization_revisions(id),
  add column organization_original_name text,
  add column organization_original_website_url text,
  add column organization_effective_name text,
  add column organization_effective_website_url text;

update public.submission_upload_operations operation
set
  organization_source = case when operation.charity is null then null else 'legacy' end,
  organization_original_name = operation.charity,
  organization_effective_name = operation.charity
where operation.status = 'completed';

insert into public.submission_organization_references (
  submission_id, source_type, original_name, original_website_url,
  effective_state, effective_name, effective_website_url
)
select
  private_data.submission_id, 'legacy', private_data.charity, null,
  'pending', private_data.charity, null
from public.submission_private_data private_data
where private_data.payout_choice in ('donate', 'split')
  and nullif(btrim(private_data.charity), '') is not null;

insert into public.submission_organization_reference_events (
  submission_id, event_type, effective_version, details
)
select submission_id, 'snapshot_created', 1, jsonb_build_object('source', 'legacy')
from public.submission_organization_references;

alter table public.submission_upload_operations
  add constraint submission_upload_operations_organization_binding_check check (
    organization_source is null
    or (
      payout_choice in ('donate', 'split')
      and organization_original_name = charity
      and organization_effective_name = charity
      and (
        (organization_source = 'catalog' and organization_id is not null and organization_revision_id is not null and organization_original_website_url is not null and organization_effective_website_url is not null)
        or (organization_source = 'other' and organization_id is null and organization_revision_id is null and organization_original_website_url is not null and organization_effective_website_url is null)
        or (organization_source = 'legacy' and organization_id is null and organization_revision_id is null and organization_original_website_url is null and organization_effective_website_url is null)
      )
    )
  );

create function public.assert_donation_organization_capability(p_actor_discord_user_id text)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor text := btrim(coalesce(p_actor_discord_user_id, ''));
  v_role text;
begin
  if v_actor !~ '^[0-9]+$' or char_length(v_actor) > 100 then
    raise exception using errcode = '42501', message = 'DONATION_ORGANIZATION_FORBIDDEN';
  end if;
  if not exists (
    select 1 from public.capability_catalog
    where key = 'donation_organizations.manage' and is_active
      and assignable_to_non_admin and implementation_version = 1
      and definition_hash = '18240d25d2183ebb17f7b1a56345ab2acc3906455d253b90cfee79cd5d6aa58d'
  ) then
    raise exception using errcode = '55000', message = 'DONATION_ORGANIZATION_CAPABILITY_UNAVAILABLE';
  end if;
  select member.role into v_role
  from public.team_members member
  join public.team_roles role on role.key = member.role and role.is_active
  where member.discord_user_id = v_actor;
  if not found or (v_role <> 'admin' and not exists (
    select 1 from public.team_role_capabilities grant_row
    where grant_row.role_key = v_role
      and grant_row.capability_key = 'donation_organizations.manage'
  )) then
    raise exception using errcode = '42501', message = 'DONATION_ORGANIZATION_FORBIDDEN';
  end if;
  return v_role;
end;
$function$;

create function public.donation_organization_request_fingerprint(
  p_operation text, p_public_key text, p_expected_version bigint,
  p_payload jsonb, p_reason text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $function$
  select encode(extensions.digest(convert_to(
    jsonb_build_object(
      'operation', p_operation, 'publicKey', p_public_key,
      'expectedVersion', p_expected_version, 'payload', p_payload,
      'reason', p_reason
    )::text, 'utf8'), 'sha256'), 'hex');
$function$;

create function public.manage_donation_organization(
  p_actor_discord_user_id text,
  p_operation text,
  p_request_id uuid,
  p_public_key text,
  p_expected_state_version bigint,
  p_payload jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor text := btrim(coalesce(p_actor_discord_user_id, ''));
  v_key text := lower(btrim(coalesce(p_public_key, '')));
  v_reason text := nullif(btrim(p_reason), '');
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_fingerprint text;
  v_existing_request public.donation_organization_mutation_requests%rowtype;
  v_organization public.donation_organizations%rowtype;
  v_revision public.donation_organization_revisions%rowtype;
  v_revision_number integer;
  v_result jsonb;
  v_selector_name text;
  v_display_name text;
  v_description text;
  v_official_url text;
  v_giving_block_url text;
  v_social_url text;
  v_legacy_logo_url text;
  v_logo_r2_key text;
  v_provider_status text;
  v_selectable boolean;
  v_display_order integer;
begin
  perform public.assert_donation_organization_capability(v_actor);
  if p_request_id is null
    or p_operation not in ('save_draft', 'publish', 'archive')
    or v_key !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or char_length(v_key) > 80
  then
    raise exception using errcode = '22023', message = 'INVALID_DONATION_ORGANIZATION_REQUEST';
  end if;

  v_fingerprint := public.donation_organization_request_fingerprint(
    p_operation, v_key, p_expected_state_version, v_payload, v_reason
  );
  select * into v_existing_request
  from public.donation_organization_mutation_requests
  where request_id = p_request_id;
  if found then
    if v_existing_request.actor_discord_user_id <> v_actor
      or v_existing_request.request_fingerprint <> v_fingerprint
    then
      raise exception using errcode = '23505', message = 'DONATION_ORGANIZATION_IDEMPOTENCY_CONFLICT';
    end if;
    return v_existing_request.result || jsonb_build_object('replayed', true);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('donation-organization:' || v_key, 0));
  select * into v_organization
  from public.donation_organizations
  where public_key = v_key
  for update;

  if p_operation = 'save_draft' then
    if found then
      if p_expected_state_version is null or v_organization.state_version <> p_expected_state_version then
        raise exception using errcode = '40001', message = 'DONATION_ORGANIZATION_STATE_CONFLICT';
      end if;
    elsif p_expected_state_version is distinct from 0 then
      raise exception using errcode = '40001', message = 'DONATION_ORGANIZATION_STATE_CONFLICT';
    else
      insert into public.donation_organizations (
        public_key, created_by, updated_by
      ) values (v_key, v_actor, v_actor)
      returning * into v_organization;
    end if;

    v_selector_name := nullif(btrim(v_payload ->> 'selectorName'), '');
    v_display_name := nullif(btrim(v_payload ->> 'displayName'), '');
    v_description := nullif(btrim(v_payload ->> 'description'), '');
    v_official_url := nullif(btrim(v_payload ->> 'officialWebsiteUrl'), '');
    v_giving_block_url := nullif(btrim(v_payload ->> 'givingBlockUrl'), '');
    v_social_url := nullif(btrim(v_payload ->> 'officialSocialUrl'), '');
    v_legacy_logo_url := nullif(btrim(v_payload ->> 'legacyLogoUrl'), '');
    v_logo_r2_key := nullif(btrim(v_payload ->> 'logoR2Key'), '');
    v_provider_status := nullif(btrim(v_payload ->> 'providerStatus'), '');
    v_selectable := case
      when jsonb_typeof(v_payload -> 'selectable') = 'boolean'
        then (v_payload ->> 'selectable')::boolean
      else null
    end;
    v_display_order := case
      when (v_payload ->> 'displayOrder') ~ '^[0-9]+$'
        then (v_payload ->> 'displayOrder')::integer
      else null
    end;
    if v_legacy_logo_url is null and v_logo_r2_key is null
      and v_payload ->> 'reuseDraftLogo' = 'true'
      and v_organization.draft_revision_id is not null
    then
      select revision.legacy_logo_url, revision.logo_r2_key
      into v_legacy_logo_url, v_logo_r2_key
      from public.donation_organization_revisions revision
      where revision.id = v_organization.draft_revision_id;
    end if;
    if v_selector_name is null or char_length(v_selector_name) not between 2 and 120
      or v_display_name is null or char_length(v_display_name) not between 2 and 160
      or v_description is null or char_length(v_description) not between 20 and 1200
      or not public.is_safe_public_https_url(v_official_url)
      or (v_giving_block_url is not null and not public.is_safe_public_https_url(v_giving_block_url))
      or (v_social_url is not null and not public.is_safe_public_https_url(v_social_url))
      or num_nonnulls(v_legacy_logo_url, v_logo_r2_key) > 1
      or (v_legacy_logo_url is not null and not public.is_safe_public_https_url(v_legacy_logo_url))
      or (v_logo_r2_key is not null and v_logo_r2_key !~ '^donation-organizations/logos/[0-9A-Fa-f-]{36}[.]webp$')
      or v_provider_status not in ('available', 'unavailable', 'unverified')
      or v_selectable is null or (v_selectable and v_provider_status <> 'available')
      or v_display_order not between 1 and 10000
    then
      raise exception using errcode = '22023', message = 'INVALID_DONATION_ORGANIZATION_CONTENT';
    end if;

    if exists (
      select 1 from public.donation_organization_url_claims claim
      where claim.normalized_url = v_official_url
        and claim.organization_id <> v_organization.id
    ) then
      raise exception using errcode = '23505', message = 'DONATION_ORGANIZATION_EXACT_URL_CONFLICT';
    end if;

    select coalesce(max(revision_number), 0) + 1 into v_revision_number
    from public.donation_organization_revisions
    where organization_id = v_organization.id;
    insert into public.donation_organization_revisions (
      organization_id, revision_number, selector_name, display_name,
      description, display_order, official_website_url, giving_block_url,
      official_social_url, provider_status, selectable, legacy_logo_url,
      logo_r2_key, created_by
    ) values (
      v_organization.id, v_revision_number, v_selector_name, v_display_name,
      v_description, v_display_order, v_official_url, v_giving_block_url,
      v_social_url, v_provider_status, v_selectable, v_legacy_logo_url,
      v_logo_r2_key, v_actor
    ) returning * into v_revision;

    insert into public.donation_organization_url_claims (
      normalized_url, organization_id, first_revision_id
    ) values (v_official_url, v_organization.id, v_revision.id)
    on conflict (normalized_url) do nothing;

    update public.donation_organizations organization
    set draft_revision_id = v_revision.id,
      state = organization.state,
      state_version = organization.state_version + 1,
      updated_by = v_actor, updated_at = transaction_timestamp(),
      archived_at = organization.archived_at,
      archived_by = organization.archived_by
    where organization.id = v_organization.id
    returning * into v_organization;
    insert into public.donation_organization_events (
      organization_id, event_type, state_version, revision_id,
      actor_discord_user_id, details
    ) values (
      v_organization.id,
      case when v_revision_number = 1 then 'draft_created' else 'draft_saved' end,
      v_organization.state_version, v_revision.id, v_actor, '{}'::jsonb
    );
  elsif not found then
    raise exception using errcode = 'P0002', message = 'DONATION_ORGANIZATION_NOT_FOUND';
  elsif p_expected_state_version is null or v_organization.state_version <> p_expected_state_version then
    raise exception using errcode = '40001', message = 'DONATION_ORGANIZATION_STATE_CONFLICT';
  elsif p_operation = 'publish' then
    if v_organization.draft_revision_id is null then
      raise exception using errcode = '55000', message = 'DONATION_ORGANIZATION_NO_DRAFT';
    end if;
    update public.donation_organization_revisions revision
    set published_by = coalesce(revision.published_by, v_actor),
      published_at = coalesce(revision.published_at, transaction_timestamp())
    where revision.id = v_organization.draft_revision_id
    returning * into v_revision;
    if num_nonnulls(v_revision.legacy_logo_url, v_revision.logo_r2_key) <> 1 then
      raise exception using errcode = '22023', message = 'DONATION_ORGANIZATION_LOGO_REQUIRED';
    end if;
    update public.donation_organizations organization
    set state = 'active', published_revision_id = organization.draft_revision_id,
      state_version = organization.state_version + 1,
      updated_by = v_actor, updated_at = transaction_timestamp(),
      archived_at = null, archived_by = null
    where organization.id = v_organization.id
    returning * into v_organization;
    insert into public.donation_organization_events (
      organization_id, event_type, state_version, revision_id,
      actor_discord_user_id, details
    ) values (v_organization.id, 'published', v_organization.state_version, v_revision.id, v_actor, '{}'::jsonb);
  else
    if v_reason is null or char_length(v_reason) not between 3 and 500 then
      raise exception using errcode = '22023', message = 'DONATION_ORGANIZATION_REASON_REQUIRED';
    end if;
    update public.donation_organizations organization
    set state = 'archived', state_version = organization.state_version + 1,
      updated_by = v_actor, updated_at = transaction_timestamp(),
      archived_at = transaction_timestamp(), archived_by = v_actor
    where organization.id = v_organization.id
    returning * into v_organization;
    insert into public.donation_organization_events (
      organization_id, event_type, state_version, revision_id,
      actor_discord_user_id, reason, details
    ) values (v_organization.id, 'archived', v_organization.state_version, v_organization.published_revision_id, v_actor, v_reason, '{}'::jsonb);
  end if;

  v_result := jsonb_build_object(
    'operation', p_operation, 'requestId', p_request_id,
    'publicKey', v_organization.public_key,
    'state', v_organization.state,
    'stateVersion', v_organization.state_version,
    'draftRevisionId', v_organization.draft_revision_id,
    'publishedRevisionId', v_organization.published_revision_id,
    'replayed', false
  );
  insert into public.donation_organization_mutation_requests (
    request_id, actor_discord_user_id, operation, request_fingerprint, result
  ) values (p_request_id, v_actor, p_operation, v_fingerprint, v_result);
  return v_result;
end;
$function$;

create function public.get_donation_organization_catalog()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'publicKey', organization.public_key,
    'selectorName', revision.selector_name,
    'displayName', revision.display_name,
    'description', revision.description,
    'displayOrder', revision.display_order,
    'officialWebsiteUrl', revision.official_website_url,
    'givingBlockUrl', revision.giving_block_url,
    'officialSocialUrl', revision.official_social_url,
    'providerStatus', revision.provider_status,
    'selectable', revision.selectable,
    'logoUrl', revision.legacy_logo_url,
    'hasManagedLogo', revision.logo_r2_key is not null,
    'revisionNumber', revision.revision_number
  ) order by revision.display_order, revision.display_name), '[]'::jsonb)
  from public.donation_organizations organization
  join public.donation_organization_revisions revision
    on revision.id = organization.published_revision_id
  where organization.state = 'active';
$function$;

create function public.get_donation_organization_management(p_actor_discord_user_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
begin
  perform public.assert_donation_organization_capability(p_actor_discord_user_id);
  return jsonb_build_object(
    'organizations', coalesce((select jsonb_agg(jsonb_build_object(
      'publicKey', organization.public_key, 'state', organization.state,
      'stateVersion', organization.state_version,
      'draft', case when draft.id is null then null else to_jsonb(draft) - 'organization_id' - 'logo_r2_key' - 'created_by' - 'published_by' end,
      'published', case when published.id is null then null else to_jsonb(published) - 'organization_id' - 'logo_r2_key' - 'created_by' - 'published_by' end,
      'hasManagedDraftLogo', draft.logo_r2_key is not null,
      'hasManagedPublishedLogo', published.logo_r2_key is not null
    ) order by coalesce(published.display_order, draft.display_order), organization.public_key)
    from public.donation_organizations organization
    left join public.donation_organization_revisions draft on draft.id = organization.draft_revision_id
    left join public.donation_organization_revisions published on published.id = organization.published_revision_id), '[]'::jsonb),
    'otherReferences', coalesce((select jsonb_agg(jsonb_build_object(
      'submissionId', reference.submission_id,
      'sourceType', reference.source_type,
      'originalName', reference.original_name,
      'originalWebsiteUrl', reference.original_website_url,
      'effectiveVersion', reference.effective_version,
      'effectiveState', reference.effective_state,
      'effectiveName', reference.effective_name,
      'effectiveWebsiteUrl', reference.effective_website_url
    ) order by reference.updated_at desc)
    from public.submission_organization_references reference
    where reference.source_type in ('other', 'legacy')), '[]'::jsonb)
  );
end;
$function$;

create function public.get_donation_organization_logo_source(p_public_key text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select revision.logo_r2_key
  from public.donation_organizations organization
  join public.donation_organization_revisions revision
    on revision.id = organization.published_revision_id
  where organization.public_key = p_public_key
    and organization.state = 'active'
    and revision.logo_r2_key is not null;
$function$;

create function public.get_donation_organization_draft_logo_source(
  p_actor_discord_user_id text,
  p_public_key text
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_key text;
begin
  perform public.assert_donation_organization_capability(p_actor_discord_user_id);
  select revision.logo_r2_key into v_key
  from public.donation_organizations organization
  join public.donation_organization_revisions revision
    on revision.id = organization.draft_revision_id
  where organization.public_key = p_public_key
    and revision.logo_r2_key is not null;
  return v_key;
end;
$function$;

create function public.bind_submission_upload_organization(
  p_operation_id uuid,
  p_session_id uuid,
  p_request_fingerprint text,
  p_source_type text,
  p_public_key text,
  p_other_name text,
  p_other_website_url text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_discord_user_id text;
  v_operation public.submission_upload_operations%rowtype;
  v_organization public.donation_organizations%rowtype;
  v_revision public.donation_organization_revisions%rowtype;
  v_name text := nullif(btrim(p_other_name), '');
  v_url text := nullif(btrim(p_other_website_url), '');
begin
  select session.discord_user_id into v_discord_user_id
  from public.sessions session
  where session.id = p_session_id and session.revoked_at is null;
  if not found then return jsonb_build_object('outcome', 'not_authenticated'); end if;
  select * into v_operation from public.submission_upload_operations operation
  where operation.id = p_operation_id and operation.discord_user_id = v_discord_user_id
  for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_operation.request_fingerprint <> p_request_fingerprint then
    return jsonb_build_object('outcome', 'idempotency_conflict');
  end if;
  if v_operation.status = 'completed' and v_operation.organization_source is not null then
    return jsonb_build_object('outcome', 'bound', 'replayed', true);
  end if;
  if v_operation.status <> 'reserved' then
    return jsonb_build_object('outcome', 'invalid_state');
  end if;
  if v_operation.payout_choice not in ('donate', 'split')
    or p_source_type not in ('catalog', 'other')
  then return jsonb_build_object('outcome', 'invalid_private_data'); end if;

  if p_source_type = 'catalog' then
    select organization.* into v_organization
    from public.donation_organizations organization
    where organization.public_key = p_public_key and organization.state = 'active';
    if not found then return jsonb_build_object('outcome', 'organization_unavailable'); end if;
    select revision.* into v_revision
    from public.donation_organization_revisions revision
    where revision.id = v_organization.published_revision_id
      and revision.selectable and revision.provider_status = 'available';
    if not found then return jsonb_build_object('outcome', 'organization_unavailable'); end if;
    update public.submission_upload_operations operation
    set organization_source = 'catalog', organization_id = v_organization.id,
      organization_revision_id = v_revision.id,
      organization_original_name = v_revision.selector_name,
      organization_original_website_url = v_revision.official_website_url,
      organization_effective_name = v_revision.selector_name,
      organization_effective_website_url = v_revision.official_website_url,
      charity = v_revision.selector_name, updated_at = transaction_timestamp()
    where operation.id = v_operation.id;
  else
    if v_name is null or char_length(v_name) not between 2 and 120
      or not public.is_safe_public_https_url(v_url)
    then return jsonb_build_object('outcome', 'invalid_private_data'); end if;
    update public.submission_upload_operations operation
    set organization_source = 'other', organization_id = null,
      organization_revision_id = null,
      organization_original_name = v_name,
      organization_original_website_url = v_url,
      organization_effective_name = v_name,
      organization_effective_website_url = null,
      charity = v_name, updated_at = transaction_timestamp()
    where operation.id = v_operation.id;
  end if;
  return jsonb_build_object('outcome', 'bound', 'replayed', false);
end;
$function$;

create function public.enforce_submission_upload_organization_binding()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if new.status in ('r2_uploaded', 'completed')
    and new.payout_choice in ('donate', 'split')
    and new.organization_source not in ('catalog', 'other', 'legacy')
  then
    raise exception using errcode = '23514', message = 'SUBMISSION_ORGANIZATION_BINDING_REQUIRED';
  end if;
  return new;
end;
$function$;

create trigger enforce_submission_upload_organization_binding
before insert or update on public.submission_upload_operations
for each row execute function public.enforce_submission_upload_organization_binding();

create function public.snapshot_submission_organization_reference()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_operation public.submission_upload_operations%rowtype;
begin
  if new.payout_choice not in ('donate', 'split') then return new; end if;
  select operation.* into v_operation
  from public.submission_upload_operations operation
  join public.submissions submission
    on submission.cycle_id = operation.cycle_id
    and submission.discord_user_id = operation.discord_user_id
  where submission.id = new.submission_id and operation.status = 'r2_uploaded'
  order by operation.created_at desc limit 1;
  if not found or v_operation.organization_source is null then
    raise exception using errcode = '23514', message = 'SUBMISSION_ORGANIZATION_SNAPSHOT_MISSING';
  end if;
  insert into public.submission_organization_references (
    submission_id, source_type, organization_id, organization_revision_id,
    original_name, original_website_url, effective_state, effective_name,
    effective_website_url, effective_organization_id
  ) values (
    new.submission_id, v_operation.organization_source,
    v_operation.organization_id, v_operation.organization_revision_id,
    v_operation.organization_original_name,
    v_operation.organization_original_website_url,
    case when v_operation.organization_source = 'catalog' then 'verified' else 'pending' end,
    v_operation.organization_effective_name,
    v_operation.organization_effective_website_url,
    case when v_operation.organization_source = 'catalog' then v_operation.organization_id else null end
  );
  insert into public.submission_organization_reference_events (
    submission_id, event_type, effective_version, details
  ) values (
    new.submission_id, 'snapshot_created', 1,
    jsonb_build_object('source', v_operation.organization_source)
  );
  return new;
end;
$function$;

create trigger snapshot_submission_organization_reference
after insert on public.submission_private_data
for each row execute function public.snapshot_submission_organization_reference();

create function public.manage_submission_organization_reference(
  p_actor_discord_user_id text,
  p_request_id uuid,
  p_submission_id bigint,
  p_expected_version bigint,
  p_operation text,
  p_name text,
  p_website_url text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor text := btrim(coalesce(p_actor_discord_user_id, ''));
  v_name text := nullif(btrim(p_name), '');
  v_url text := nullif(btrim(p_website_url), '');
  v_reason text := nullif(btrim(p_reason), '');
  v_reference public.submission_organization_references%rowtype;
  v_fingerprint text;
  v_request public.submission_organization_reference_requests%rowtype;
  v_result jsonb;
  v_candidate_key text;
begin
  perform public.assert_donation_organization_capability(v_actor);
  if p_request_id is null or p_submission_id is null or p_expected_version is null
    or p_operation not in ('verify', 'correct', 'quarantine', 'create_candidate')
    or v_reason is null or char_length(v_reason) not between 3 and 500
  then raise exception using errcode = '22023', message = 'INVALID_ORGANIZATION_REFERENCE_REQUEST'; end if;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'submissionId', p_submission_id, 'expectedVersion', p_expected_version,
    'operation', p_operation, 'name', v_name, 'url', v_url, 'reason', v_reason
  )::text, 'utf8'), 'sha256'), 'hex');
  select * into v_request from public.submission_organization_reference_requests
  where request_id = p_request_id;
  if found then
    if v_request.actor_discord_user_id <> v_actor or v_request.request_fingerprint <> v_fingerprint then
      raise exception using errcode = '23505', message = 'ORGANIZATION_REFERENCE_IDEMPOTENCY_CONFLICT';
    end if;
    return v_request.result || jsonb_build_object('replayed', true);
  end if;
  select * into v_reference from public.submission_organization_references
  where submission_id = p_submission_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'ORGANIZATION_REFERENCE_NOT_FOUND'; end if;
  if v_reference.effective_version <> p_expected_version then
    raise exception using errcode = '40001', message = 'ORGANIZATION_REFERENCE_STATE_CONFLICT';
  end if;
  if p_operation in ('verify', 'correct', 'create_candidate')
    and (v_name is null or char_length(v_name) not between 2 and 120 or not public.is_safe_public_https_url(v_url))
  then raise exception using errcode = '22023', message = 'INVALID_ORGANIZATION_REFERENCE_CONTENT'; end if;

  if p_operation = 'quarantine' then
    update public.submission_organization_references reference
    set effective_version = reference.effective_version + 1,
      effective_state = 'quarantined', effective_name = coalesce(v_name, reference.effective_name),
      effective_website_url = null, effective_organization_id = null,
      updated_at = transaction_timestamp()
    where submission_id = p_submission_id returning * into v_reference;
  else
    update public.submission_organization_references reference
    set effective_version = reference.effective_version + 1,
      effective_state = 'verified', effective_name = v_name,
      effective_website_url = v_url, effective_organization_id = null,
      updated_at = transaction_timestamp()
    where submission_id = p_submission_id returning * into v_reference;
  end if;

  if p_operation = 'create_candidate' then
    select organization.public_key into v_candidate_key
    from public.donation_organization_url_claims claim
    join public.donation_organizations organization on organization.id = claim.organization_id
    where claim.normalized_url = v_url;
    if not found then
      v_candidate_key := 'reviewed-other-' || p_submission_id::text;
      perform public.manage_donation_organization(
        v_actor, 'save_draft', gen_random_uuid(), v_candidate_key, 0,
        jsonb_build_object(
          'selectorName', v_name, 'displayName', v_name,
          'description', 'Draft candidate created from a reviewed Other organization. Complete this description before publication.',
          'displayOrder', 10000, 'officialWebsiteUrl', v_url,
          'givingBlockUrl', null, 'officialSocialUrl', null,
          'providerStatus', 'unverified', 'selectable', false,
          'legacyLogoUrl', null,
          'logoR2Key', null
        ), null
      );
      insert into public.donation_organization_events (
        organization_id, event_type, state_version, revision_id,
        actor_discord_user_id, reason, details
      ) select organization.id, 'draft_from_other', organization.state_version,
        organization.draft_revision_id, v_actor, v_reason,
        jsonb_build_object('submissionId', p_submission_id)
      from public.donation_organizations organization
      where organization.public_key = v_candidate_key;
    end if;
  end if;

  insert into public.submission_organization_reference_events (
    submission_id, event_type, effective_version, actor_discord_user_id,
    reason, details
  ) values (
    p_submission_id,
    case p_operation when 'verify' then 'verified' when 'correct' then 'corrected'
      when 'quarantine' then 'quarantined' else 'catalog_candidate_created' end,
    v_reference.effective_version, v_actor, v_reason,
    case when p_operation = 'create_candidate' then jsonb_build_object('candidatePublicKey', v_candidate_key) else '{}'::jsonb end
  );
  v_result := jsonb_build_object(
    'submissionId', p_submission_id, 'operation', p_operation,
    'effectiveVersion', v_reference.effective_version,
    'effectiveState', v_reference.effective_state,
    'candidatePublicKey', v_candidate_key, 'replayed', false
  );
  insert into public.submission_organization_reference_requests (
    request_id, actor_discord_user_id, submission_id, request_fingerprint, result
  ) values (p_request_id, v_actor, p_submission_id, v_fingerprint, v_result);
  return v_result;
end;
$function$;

-- Exact reviewed one-time import. The initial actor is the canonical Owner context,
-- not a capability grant and not a public identity.
create temporary table donation_organization_import_manifest (
  public_key text primary key,
  selector_name text not null,
  display_name text not null,
  description text not null,
  display_order integer not null unique,
  official_url text not null,
  giving_url text,
  social_url text,
  logo_url text not null
) on commit drop;

insert into pg_temp.donation_organization_import_manifest (
  public_key, selector_name, display_name, description, display_order,
  official_url, giving_url, social_url, logo_url
) values
  ('animal-haven', 'Animal Haven', 'Animal Haven', 'Provides shelter, rehabilitation, training, and adoption support for homeless cats and dogs in New York City and the Tri-State area.', 1, 'https://animalhaven.org/', 'https://thegivingblock.com/donate/animal-haven', 'https://x.com/AnimalHaven', 'https://cdn.cancerculture.fun/webp/charity/animal-heaven.webp'),
  ('animal-rescue-corps', 'Animal Rescue Corps, Inc.', 'Animal Rescue Corps, Inc.', 'Ends animal suffering through large-scale rescue operations, emergency sheltering, and support for communities confronting cruelty and neglect.', 2, 'https://animalrescuecorps.org/', 'https://thegivingblock.com/donate/animal-rescue-corps-inc', 'https://x.com/ARCorps', 'https://cdn.cancerculture.fun/webp/charity/animal-rescue.webp'),
  ('doctors-without-borders-usa', 'Doctors Without Borders U.S.A., Inc.', 'Doctors Without Borders U.S.A., Inc.', 'Delivers independent and impartial medical humanitarian assistance to people affected by conflict, epidemics, disasters, and limited access to care.', 3, 'https://www.doctorswithoutborders.org/', 'https://thegivingblock.com/donate/doctors-without-borders-u-s-a-inc', 'https://x.com/MSF_USA', 'https://cdn.cancerculture.fun/webp/charity/doctor-boarder.webp'),
  ('feeding-pets-of-the-homeless', 'Feeding Pets of the Homeless', 'Feeding Pets of the Homeless', 'Provides pet food, emergency veterinary care, and support for companion animals whose people are experiencing homelessness.', 4, 'https://petsofthehomeless.org/', 'https://thegivingblock.com/donate/feeding-pets-of-the-homeless', 'https://x.com/PetsofHomeless', 'https://cdn.cancerculture.fun/webp/charity/homeless-pets.webp'),
  ('institute-for-justice', 'Institute for Justice', 'Institute for Justice', 'Defends constitutional rights through public-interest litigation, advocacy, and research focused on limiting government abuse.', 5, 'https://ij.org/', 'https://thegivingblock.com/donate/institute-for-justice', 'https://x.com/IJ', 'https://cdn.cancerculture.fun/webp/charity/justicia.webp'),
  ('no-kid-hungry', 'No Kid Hungry', 'No Kid Hungry', 'Works to end childhood hunger in the United States by improving and expanding programs that connect children with healthy food.', 6, 'https://www.nokidhungry.org/', 'https://thegivingblock.com/donate/no-kid-hungry', 'https://x.com/nokidhungry', 'https://cdn.cancerculture.fun/webp/charity/no-kid.webp'),
  ('save-the-children', 'Save the Children', 'Save the Children®', 'Helps children get a healthy start, opportunities to learn, and protection from harm while responding to emergencies worldwide.', 7, 'https://www.savethechildren.org/', 'https://thegivingblock.com/donate/save-the-children', 'https://x.com/SavetheChildren', 'https://cdn.cancerculture.fun/webp/charity/save-children.webp'),
  ('sea-shepherd-conservation-society', 'Sea Shepherd Conservation Society', 'Sea Shepherd Conservation Society', 'Protects oceans and marine wildlife through direct-action campaigns, investigation, education, and collaboration with authorities.', 8, 'https://seashepherd.org/', 'https://thegivingblock.com/donate/sea-shepherd-conservation-society', 'https://x.com/SeaShepherdSSCS', 'https://cdn.cancerculture.fun/webp/charity/sea.webp'),
  ('st-jude-childrens-research-hospital', 'St. Jude Children''s Research Hospital', 'St. Jude Children''s Research Hospital', 'Advances cures and prevention for pediatric catastrophic diseases through research and treatment while sharing discoveries broadly.', 9, 'https://www.stjude.org/', 'https://thegivingblock.com/donate/st-jude-childrens-research-hospital', 'https://x.com/StJude', 'https://cdn.cancerculture.fun/webp/charity/st-jude.webp'),
  ('young-lives-vs-cancer', 'Young Lives vs Cancer', 'Young Lives vs Cancer', 'Provides specialist social work and practical, emotional, and financial support to children, young people, and families facing cancer in the UK.', 10, 'https://www.younglivesvscancer.org.uk/', 'https://thegivingblock.com/donate/young-lives-vs-cancer', 'https://x.com/YLvsCancer', 'https://cdn.cancerculture.fun/webp/charity/young-lives.webp');

insert into public.donation_organizations (
  public_key, state, state_version, created_by, updated_by
)
select public_key, 'draft', 1, '0', '0'
from pg_temp.donation_organization_import_manifest;

insert into public.donation_organization_revisions (
  organization_id, revision_number, selector_name, display_name,
  description, display_order, official_website_url, giving_block_url,
  official_social_url, provider_status, selectable, legacy_logo_url,
  created_by, published_by, published_at
)
select organization.id, 1, manifest.selector_name, manifest.display_name,
  manifest.description, manifest.display_order, manifest.official_url,
  manifest.giving_url, manifest.social_url, 'available', true,
  manifest.logo_url, '0', '0', transaction_timestamp()
from pg_temp.donation_organization_import_manifest manifest
join public.donation_organizations organization using (public_key);

update public.donation_organizations organization
set state = 'active', state_version = 2,
  draft_revision_id = revision.id,
  published_revision_id = revision.id
from public.donation_organization_revisions revision
where revision.organization_id = organization.id
  and revision.revision_number = 1;

insert into public.donation_organization_url_claims (
  normalized_url, organization_id, first_revision_id
)
select revision.official_website_url, organization.id, revision.id
from public.donation_organizations organization
join public.donation_organization_revisions revision
  on revision.id = organization.published_revision_id;

insert into public.donation_organization_events (
  organization_id, event_type, state_version, revision_id,
  actor_discord_user_id, details
)
select id, 'imported', state_version, published_revision_id, '0',
  jsonb_build_object('manifestVersion', 1)
from public.donation_organizations;

alter table public.donation_organizations enable row level security;
alter table public.donation_organization_revisions enable row level security;
alter table public.donation_organization_url_claims enable row level security;
alter table public.donation_organization_events enable row level security;
alter table public.donation_organization_mutation_requests enable row level security;
alter table public.submission_organization_references enable row level security;
alter table public.submission_organization_reference_events enable row level security;
alter table public.submission_organization_reference_requests enable row level security;

revoke all on table public.donation_organizations, public.donation_organization_revisions,
  public.donation_organization_url_claims, public.donation_organization_events,
  public.donation_organization_mutation_requests, public.submission_organization_references,
  public.submission_organization_reference_events, public.submission_organization_reference_requests
  from public, anon, authenticated, discord_bot, service_role;

alter function public.is_safe_public_https_url(text) owner to postgres;
alter function public.reject_organization_append_only_rewrite() owner to postgres;
alter function public.preserve_submission_organization_original() owner to postgres;
alter function public.preserve_donation_organization_revision() owner to postgres;
alter function public.assert_donation_organization_capability(text) owner to postgres;
alter function public.donation_organization_request_fingerprint(text,text,bigint,jsonb,text) owner to postgres;
alter function public.manage_donation_organization(text,text,uuid,text,bigint,jsonb,text) owner to postgres;
alter function public.get_donation_organization_catalog() owner to postgres;
alter function public.get_donation_organization_management(text) owner to postgres;
alter function public.get_donation_organization_logo_source(text) owner to postgres;
alter function public.get_donation_organization_draft_logo_source(text,text) owner to postgres;
alter function public.bind_submission_upload_organization(uuid,uuid,text,text,text,text,text) owner to postgres;
alter function public.enforce_submission_upload_organization_binding() owner to postgres;
alter function public.snapshot_submission_organization_reference() owner to postgres;
alter function public.manage_submission_organization_reference(text,uuid,bigint,bigint,text,text,text,text) owner to postgres;

revoke all on function public.is_safe_public_https_url(text),
  public.reject_organization_append_only_rewrite(),
  public.preserve_submission_organization_original(),
  public.preserve_donation_organization_revision(),
  public.assert_donation_organization_capability(text),
  public.donation_organization_request_fingerprint(text,text,bigint,jsonb,text),
  public.manage_donation_organization(text,text,uuid,text,bigint,jsonb,text),
  public.get_donation_organization_catalog(),
  public.get_donation_organization_management(text),
  public.get_donation_organization_logo_source(text),
  public.get_donation_organization_draft_logo_source(text,text),
  public.bind_submission_upload_organization(uuid,uuid,text,text,text,text,text),
  public.enforce_submission_upload_organization_binding(),
  public.snapshot_submission_organization_reference(),
  public.manage_submission_organization_reference(text,uuid,bigint,bigint,text,text,text,text)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.manage_donation_organization(text,text,uuid,text,bigint,jsonb,text),
  public.get_donation_organization_catalog(),
  public.get_donation_organization_management(text),
  public.get_donation_organization_logo_source(text),
  public.get_donation_organization_draft_logo_source(text,text),
  public.bind_submission_upload_organization(uuid,uuid,text,text,text,text,text),
  public.manage_submission_organization_reference(text,uuid,bigint,bigint,text,text,text,text)
  to service_role;

do $postflight$
declare
  v_signature text;
  v_service_signatures text[] := array[
    'public.manage_donation_organization(text,text,uuid,text,bigint,jsonb,text)',
    'public.get_donation_organization_catalog()',
    'public.get_donation_organization_management(text)',
    'public.get_donation_organization_logo_source(text)',
    'public.get_donation_organization_draft_logo_source(text,text)',
    'public.bind_submission_upload_organization(uuid,uuid,text,text,text,text,text)',
    'public.manage_submission_organization_reference(text,uuid,bigint,bigint,text,text,text,text)'
  ];
begin
  if (select count(*) from public.capability_catalog) <> 41
    or (select count(*) from public.capability_catalog where is_active) <> 37
    or not exists (
      select 1 from public.capability_catalog
      where key = 'donation_organizations.manage' and is_active
        and assignable_to_non_admin and implementation_version = 1
        and definition_hash = '18240d25d2183ebb17f7b1a56345ab2acc3906455d253b90cfee79cd5d6aa58d'
    )
    or exists (
      select 1 from public.team_role_capabilities
      where capability_key = 'donation_organizations.manage'
    )
    or (select count(*) from public.donation_organizations) <> 10
    or (select count(*) from public.donation_organization_revisions) <> 10
    or (select count(*) from public.donation_organization_events where event_type = 'imported') <> 10
    or exists (
      select 1 from public.donation_organizations
      where state <> 'active' or state_version <> 2
        or draft_revision_id is null or published_revision_id is null
    )
  then
    raise exception using errcode = '55000', message = 'DYNAMIC_ORGANIZATION_CATALOG_POSTFLIGHT_MISMATCH';
  end if;

  foreach v_signature in array v_service_signatures loop
    if to_regprocedure(v_signature) is null
      or not exists (
        select 1 from pg_proc function_row
        where function_row.oid = to_regprocedure(v_signature)
          and pg_get_userbyid(function_row.proowner) = 'postgres'
          and function_row.prosecdef
          and function_row.proconfig is not distinct from array['search_path=public, pg_temp']::text[]
      )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or not has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using errcode = '55000', message = 'DYNAMIC_ORGANIZATION_FUNCTION_SECURITY_MISMATCH', detail = v_signature;
    end if;
  end loop;
end;
$postflight$;

comment on table public.donation_organization_revisions is
  'Immutable catalog revisions. Publishing moves only the organization pointer; historical Submission references remain bound to their exact revision.';
comment on table public.submission_organization_references is
  'Private immutable original organization choice plus a separately versioned effective review reference. Pending or quarantined references expose no public or payout link.';
comment on function public.bind_submission_upload_organization(uuid,uuid,text,text,text,text,text) is
  'Binds one exact published selectable catalog revision or validated private Other name and HTTPS URL before the Submission media may advance to R2 uploaded.';

commit;

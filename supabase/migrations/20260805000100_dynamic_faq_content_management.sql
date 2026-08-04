begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 26
    or (select count(*) from public.capability_catalog where is_active) <> 24
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 24 then
    raise exception using
      errcode = '55000',
      message = 'FAQ_CONTENT_CAPABILITY_BASELINE_MISMATCH';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = 'rules.manage'
      and implementation_version = 1
      and definition_hash =
        'd7097dece0897ddcd924010a9a8cd48f427512231eaf7da77a28005536720887'
      and is_active
      and assignable_to_non_admin
  ) then
    raise exception using
      errcode = '55000',
      message = 'FAQ_CONTENT_PREVIOUS_CUTOVER_MISMATCH';
  end if;

  if exists (
    select 1 from public.capability_catalog where key = 'faq.manage'
  )
    or exists (
      select 1 from public.content_documents where key = 'faq'
    )
    or to_regprocedure('public.assert_faq_manager(text)') is not null
    or to_regprocedure('public.assert_faq_content_payload(jsonb)') is not null
    or to_regprocedure(
      'public.manage_faq_content(text,bigint,jsonb,uuid)'
    ) is not null then
    raise exception using
      errcode = '55000',
      message = 'FAQ_CONTENT_TARGET_ALREADY_PRESENT';
  end if;

  if to_regclass('public.content_documents') is null
    or to_regclass('public.content_revisions') is null
    or to_regclass('public.content_publications') is null
    or to_regclass('public.content_management_requests') is null
    or to_regclass('public.admin_action_logs') is null
    or to_regclass('public.team_members') is null
    or to_regclass('public.team_roles') is null
    or to_regclass('public.team_role_capabilities') is null
    or (select count(*) from public.content_documents where key = 'rules') <> 1
    or not exists (
      select 1
      from pg_constraint
      where conrelid = 'public.content_publications'::regclass
        and conname = 'content_publications_rules_version_check'
    )
    or not exists (
      select 1
      from pg_constraint
      where conrelid = 'public.content_publications'::regclass
        and conname = 'content_publications_bootstrap_shape_check'
    )
    or not exists (
      select 1
      from pg_constraint
      where conrelid = 'public.content_management_requests'::regclass
        and conname = 'content_management_requests_operation_check'
    ) then
    raise exception using
      errcode = '55000',
      message = 'FAQ_CONTENT_DEPENDENCY_MISMATCH';
  end if;
end;
$preflight$;

insert into public.capability_catalog (
  key,
  display_name,
  description,
  category,
  included_actions,
  excluded_actions,
  risk_level,
  assignable_to_non_admin,
  is_active,
  implementation_version,
  definition_hash
)
values (
  'faq.manage',
  'Manage FAQ',
  'Edit FAQ content locally, preview the exact safe public rendering, and atomically save and publish one validated immutable revision.',
  'Content',
  array[
    'View the current published FAQ in the Content area.',
    'Edit ordered FAQ sections in browser-local state and preview them without creating a server draft.',
    'Atomically save and publish one validated immutable revision with optimistic concurrency and idempotency.',
    'Invalidate the public FAQ cache after a successful publication.'
  ]::text[],
  array[
    'Creating or retaining a stored FAQ draft or a separate publish step.',
    'Managing Rules, Rules acceptance, rules_meta, Homepage Info Boxes, Coin Launch Links, or other content.',
    'Managing roles, permissions, team membership, or Owner access.',
    'Deleting or rewriting FAQ revision, request, publication, or audit history.'
  ]::text[],
  'high',
  true,
  true,
  1,
  '7a0e2cecaf38453e42a00bbc60058f9a7793512941f2c62750d5c5537a030c93'
);

alter table public.content_publications
  alter column effective_material_change drop not null,
  alter column structure_changed drop not null,
  alter column previous_rules_version drop not null,
  alter column rules_version drop not null,
  drop constraint content_publications_rules_version_check,
  drop constraint content_publications_bootstrap_shape_check,
  add constraint content_publications_document_context_check
    check (
      (
        document_key = 'rules'
        and effective_material_change is not null
        and structure_changed is not null
        and previous_rules_version is not null
        and rules_version is not null
        and previous_rules_version > 0
        and rules_version >= previous_rules_version
        and (
          (event_type = 'bootstrap' and requested_material_change is null)
          or
          (event_type = 'publish' and requested_material_change is not null)
        )
      )
      or
      (
        document_key = 'faq'
        and requested_material_change is null
        and effective_material_change is null
        and structure_changed is null
        and previous_rules_version is null
        and rules_version is null
      )
    ),
  add constraint content_publications_event_shape_check
    check (
      (
        event_type = 'bootstrap'
        and previous_revision_id is null
        and request_id is null
        and published_by_discord_user_id is null
      )
      or
      (
        event_type = 'publish'
        and previous_revision_id is not null
        and request_id is not null
        and published_by_discord_user_id is not null
      )
    );

alter table public.content_management_requests
  drop constraint content_management_requests_operation_check,
  add constraint content_management_requests_operation_check
    check (operation in ('save_draft', 'publish', 'save_publish'));

create or replace function public.assert_faq_content_payload(
  p_content jsonb
)
returns void
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_section jsonb;
  v_item jsonb;
  v_section_id text;
  v_section_ids text[] := '{}'::text[];
  v_paragraph_count integer;
  v_bullet_count integer;
begin
  if p_content is null
    or jsonb_typeof(p_content) <> 'object'
    or octet_length(p_content::text) > 100000
    or (
      select array_agg(key_name order by key_name)
      from jsonb_object_keys(p_content) key_name
    ) is distinct from array[
      'eyebrow', 'heading', 'introduction', 'schemaVersion', 'sections'
    ]::text[]
    or jsonb_typeof(p_content -> 'schemaVersion') <> 'number'
    or (p_content ->> 'schemaVersion')::numeric <> 1
    or jsonb_typeof(p_content -> 'eyebrow') <> 'string'
    or char_length(btrim(p_content ->> 'eyebrow')) not between 1 and 80
    or jsonb_typeof(p_content -> 'heading') <> 'string'
    or char_length(btrim(p_content ->> 'heading')) not between 1 and 160
    or jsonb_typeof(p_content -> 'introduction') <> 'string'
    or char_length(btrim(p_content ->> 'introduction')) not between 1 and 2000
    or jsonb_typeof(p_content -> 'sections') <> 'array'
    or jsonb_array_length(p_content -> 'sections') not between 1 and 30 then
    raise exception using
      errcode = '22023',
      message = 'INVALID_FAQ_CONTENT_REQUEST';
  end if;

  for v_section in
    select section_row.value
    from jsonb_array_elements(p_content -> 'sections') section_row(value)
  loop
    if jsonb_typeof(v_section) <> 'object'
      or (
        select array_agg(key_name order by key_name)
        from jsonb_object_keys(v_section) key_name
      ) is distinct from array[
        'bullets', 'id', 'paragraphs', 'title'
      ]::text[]
      or jsonb_typeof(v_section -> 'id') <> 'string'
      or jsonb_typeof(v_section -> 'title') <> 'string'
      or jsonb_typeof(v_section -> 'paragraphs') <> 'array'
      or jsonb_typeof(v_section -> 'bullets') <> 'array' then
      raise exception using
        errcode = '22023',
        message = 'INVALID_FAQ_CONTENT_REQUEST';
    end if;

    v_section_id := btrim(v_section ->> 'id');
    v_paragraph_count := jsonb_array_length(v_section -> 'paragraphs');
    v_bullet_count := jsonb_array_length(v_section -> 'bullets');

    if char_length(v_section_id) not between 1 and 80
      or v_section_id !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
      or v_section_id = any(v_section_ids)
      or char_length(btrim(v_section ->> 'title')) not between 1 and 160
      or v_paragraph_count > 30
      or v_bullet_count > 40
      or (v_paragraph_count = 0 and v_bullet_count = 0) then
      raise exception using
        errcode = '22023',
        message = 'INVALID_FAQ_CONTENT_REQUEST';
    end if;

    v_section_ids := array_append(v_section_ids, v_section_id);

    for v_item in
      select paragraph_row.value
      from jsonb_array_elements(v_section -> 'paragraphs') paragraph_row(value)
    loop
      if jsonb_typeof(v_item) <> 'string'
        or char_length(btrim(v_item #>> '{}')) not between 1 and 2000 then
        raise exception using
          errcode = '22023',
          message = 'INVALID_FAQ_CONTENT_REQUEST';
      end if;
    end loop;

    for v_item in
      select bullet_row.value
      from jsonb_array_elements(v_section -> 'bullets') bullet_row(value)
    loop
      if jsonb_typeof(v_item) <> 'string'
        or char_length(btrim(v_item #>> '{}')) not between 1 and 1000 then
        raise exception using
          errcode = '22023',
          message = 'INVALID_FAQ_CONTENT_REQUEST';
      end if;
    end loop;
  end loop;
end;
$function$;

alter function public.assert_faq_content_payload(jsonb) owner to postgres;
revoke all on function public.assert_faq_content_payload(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.assert_faq_manager(
  p_actor_discord_user_id text
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_actor_role text;
begin
  if nullif(v_actor_id, '') is null
    or char_length(v_actor_id) > 100
    or v_actor_id !~ '^[0-9]+$' then
    raise exception using
      errcode = '42501',
      message = 'FAQ_CONTENT_FORBIDDEN';
  end if;

  if not exists (
    select 1
    from public.capability_catalog capability_row
    where capability_row.key = 'faq.manage'
      and capability_row.is_active
      and capability_row.assignable_to_non_admin
      and capability_row.implementation_version = 1
      and capability_row.definition_hash =
        '7a0e2cecaf38453e42a00bbc60058f9a7793512941f2c62750d5c5537a030c93'
  ) then
    raise exception using
      errcode = '55000',
      message = 'FAQ_CONTENT_AUTHORIZATION_DEPENDENCY_UNAVAILABLE';
  end if;

  select member_row.role
  into v_actor_role
  from public.team_members member_row
  join public.team_roles role_row
    on role_row.key = member_row.role
   and role_row.is_active
  where member_row.discord_user_id = v_actor_id;

  if not found
    or (
      v_actor_role <> 'admin'
      and not exists (
        select 1
        from public.team_role_capabilities grant_row
        where grant_row.role_key = v_actor_role
          and grant_row.capability_key = 'faq.manage'
      )
    ) then
    raise exception using
      errcode = '42501',
      message = 'FAQ_CONTENT_FORBIDDEN';
  end if;

  return v_actor_role;
end;
$function$;

alter function public.assert_faq_manager(text) owner to postgres;
revoke all on function public.assert_faq_manager(text)
  from public, anon, authenticated, service_role;

do $bootstrap$
declare
  v_revision_id bigint;
  v_content jsonb := $json$
{
  "schemaVersion": 1,
  "eyebrow": "FAQ & Info",
  "heading": "Find answers fast.",
  "introduction": "Jump directly to what you need, payouts, wallet issues, disqualifications, and more...",
  "sections": [
    {
      "id": "wallet",
      "title": "I entered the wrong wallet address",
      "paragraphs": [
        "If you entered the wrong wallet address, lost access to your wallet, or your wallet was compromised, submit the recovery form as soon as possible.",
        "Submit your request here: https://tally.so/r/7RLXOZ",
        "There is no need to contact the team directly. All cases are handled through this form.",
        "Requests are reviewed at the end of each cycle. If your request is linked to a winning submission, we will contact you via Discord to resolve the issue.",
        "Requests from non-winning submissions are not ignored, but no action is required. You can simply provide your correct wallet details again in the next cycle.",
        "Important: This must be done before the cycle ends. Once the cycle is finalized and no request is found, the payout will be sent to the provided wallet address and cannot be reversed.",
        "You can check which wallet address you submitted in your profile under your current submission."
      ],
      "bullets": []
    },
    {
      "id": "payout",
      "title": "When do I receive my payout?",
      "paragraphs": [
        "First of all, you actually need to win.",
        "Payouts are processed after a cycle has ended and results are finalized.",
        "Before sending any rewards, we manually review if there are any open support requests (for example wallet issues) from the winner.",
        "If there are multiple winners and one of them has an open request, we will wait until the issue is resolved before processing the payout.",
        "If we contact a winner regarding an issue and receive no response within 24 hours, that winner is considered unavailable for this cycle.",
        "If there are other winners, the prize will be split between the remaining available winners.",
        "If there is only a single winner and they do not respond within 24 hours, the prize will be held and added to the next cycle.",
        "Payouts are handled as quickly as possible, but small delays can happen due to manual review and processing."
      ],
      "bullets": []
    },
    {
      "id": "disqualified",
      "title": "Why was my submission disqualified?",
      "paragraphs": [
        "Submissions may be disqualified if they violate platform rules or harm fair competition.",
        "This platform is focused on memes. Low-effort uploads such as simple social media screenshots, reposts without meaningful changes, or obvious trolling may be disqualified.",
        "Any attempt to abuse the system or bypass intended limits can also lead to disqualification.",
        "If a submission is disqualified, all votes cast for it are removed and cannot be used again in that cycle.",
        "If you believe this was a mistake, you can contact support via Discord."
      ],
      "bullets": []
    },
    {
      "id": "block",
      "title": "Why am I blocked from uploading?",
      "paragraphs": [
        "To protect the platform from spam and abuse, uploads are currently limited to a maximum file size of 4MB.",
        "Repeated failed upload attempts (for example exceeding the file size limit) or attempts to bypass submission or voting limits can trigger an automatic block.",
        "After 5 failed attempts, you will be temporarily blocked from uploading for the current cycle.",
        "This block is automatically lifted in the next cycle. There is no need to contact support.",
        "We understand that mistakes can happen, but repeated blocks may be interpreted as attempts to abuse or bypass the system.",
        "If such behavior occurs frequently, it may lead to further restrictions or a permanent ban."
      ],
      "bullets": []
    },
    {
      "id": "vote",
      "title": "Why can’t I vote for myself?",
      "paragraphs": [
        "If your meme needs your own vote to survive… it might not be that strong.",
        "Self-voting is disabled to keep the competition fair.",
        "Votes should reflect actual community preference, not self-promotion.",
        "We know the internet has a long history of people liking their own posts… but this isn’t Facebook.",
        "If your meme is good, the votes will come naturally."
      ],
      "bullets": []
    },
    {
      "id": "anonymous",
      "title": "Why are submissions anonymous?",
      "paragraphs": [
        "During an active cycle, submissions are anonymous to reduce bias.",
        "This ensures votes are based on the meme itself, not the creator.",
        "Creators are revealed after the cycle ends.",
        "Of course, we can’t stop anyone from sharing their submission with friends… but at the end of the day, the best memes tend to win anyway"
      ],
      "bullets": []
    },
    {
      "id": "ties",
      "title": "What happens if there is a tie?",
      "paragraphs": [
        "Ties are allowed and not artificially resolved.",
        "If multiple submissions have the highest vote count, they all win.",
        "Any rewards are split equally between tied winners."
      ],
      "bullets": []
    },
    {
      "id": "rewards",
      "title": "How are rewards determined?",
      "paragraphs": [
        "Rewards depend on the specific cycle and are not guaranteed.",
        "The prize pool can vary and may be higher or lower depending on participation and overall activity.",
        "Rewards are funded through the platform and its ecosystem.",
        "Winning is based entirely on community voting.",
        "All rewards are distributed after the cycle has ended and results are finalized."
      ],
      "bullets": []
    },
    {
      "id": "charity",
      "title": "How do charity, Wall of Fame & Wall of Shame work?",
      "paragraphs": [
        "Winning is great. What you do with your reward is up to you.",
        "You can keep everything, donate a portion, or split it however you like. Donations are completely optional.",
        "If you win and donate at least 1% of your reward, you will be listed on the Wall of Fame.",
        "If you win and keep 100% of your reward, you will be listed on the Wall of Shame.",
        "Before you panic, this is part of the platform’s culture and not meant as serious judgment",
        "It’s a bit of fun and a small social experiment: everyone loves to talk about generosity… until it’s their own money.",
        "No matter what you choose, your decision should be respected by others."
      ],
      "bullets": []
    },
    {
      "id": "content",
      "title": "Do I need to create original content?",
      "paragraphs": [
        "Content does not have to be fully original.",
        "However, original and creative submissions usually perform better and stand out more.",
        "Low effort reposts, simple screenshots, or unmodified content may be disqualified.",
        "We do our best to keep the competition fair, but we cannot guarantee that every non original submission will be detected immediately.",
        "If your meme has been seen a hundred times before, chances are people won’t be impressed the 101st time."
      ],
      "bullets": []
    },
    {
      "id": "socials",
      "title": "How do I verify my social media?",
      "paragraphs": [
        "Adding social media profiles is completely optional, but you can use it to promote your work and creativity.",
        "You can add your social media accounts (X, Facebook, Instagram, TikTok) directly in your user profile.",
        "By default, these profiles are marked as unverified and are only visible on your profile page.",
        "This helps prevent abuse, such as linking someone else’s account to a submission.",
        "If you want your profiles to be verified, you can submit a request in the Discord 'verify my socials' channel with the required information.",
        "Once verified, you can choose to display your socials alongside your submissions.",
        "This does not affect voting, but your socials may be shown in cycle history or winner showcases."
      ],
      "bullets": []
    },
    {
      "id": "privacy",
      "title": "What data is stored?",
      "paragraphs": [
        "We use your Discord ID for participation, moderation, and abuse prevention.",
        "Your Discord ID is used internally but is not publicly displayed on the platform.",
        "We do not store IP addresses or track your activity outside the platform.",
        "Basic actions such as submissions, votes, and moderation events are logged to ensure fairness and platform integrity.",
        "Other users can only see your public profile information, such as your Discord name, avatar, and submission history.",
        "Private data (such as wallet details or Discord ID) is only used for payouts or display purposes and is not shared publicly without your consent."
      ],
      "bullets": []
    },
    {
      "id": "rules",
      "title": "Can the rules change?",
      "paragraphs": [
        "Yes. The platform may evolve over time.",
        "If rules change, you will be notified before participating in a new cycle.",
        "You must accept updated rules before submitting again."
      ],
      "bullets": []
    }
  ]
}
$json$::jsonb;
begin
  perform public.assert_faq_content_payload(v_content);

  insert into public.content_documents (key, state_version)
  values ('faq', 1);

  insert into public.content_revisions (
    document_key,
    revision_number,
    content,
    content_hash,
    created_by_discord_user_id
  ) values (
    'faq',
    1,
    v_content,
    encode(
      extensions.digest(convert_to(v_content::text, 'UTF8'), 'sha256'),
      'hex'
    ),
    null
  )
  returning id into v_revision_id;

  update public.content_documents
  set published_revision_id = v_revision_id
  where key = 'faq';

  insert into public.content_publications (
    document_key,
    event_type,
    revision_id,
    previous_revision_id,
    requested_material_change,
    effective_material_change,
    structure_changed,
    previous_rules_version,
    rules_version,
    request_id,
    published_by_discord_user_id
  ) values (
    'faq', 'bootstrap', v_revision_id, null,
    null, null, null, null, null, null, null
  );
end;
$bootstrap$;

create or replace function public.manage_faq_content(
  p_actor_discord_user_id text,
  p_expected_state_version bigint,
  p_content jsonb,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_actor_role text;
  v_actor_type text;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_hash text;
  v_existing_result jsonb;
  v_document public.content_documents%rowtype;
  v_previous_revision_id bigint;
  v_revision_id bigint;
  v_revision_number bigint;
  v_content_hash text;
  v_published_hash text;
  v_result jsonb;
begin
  if p_idempotency_key is null
    or p_expected_state_version is null
    or p_expected_state_version <= 0
    or nullif(v_actor_id, '') is null
    or char_length(v_actor_id) > 100
    or p_content is null then
    raise exception using
      errcode = '22023',
      message = 'INVALID_FAQ_CONTENT_REQUEST';
  end if;

  v_actor_role := public.assert_faq_manager(v_actor_id);
  v_actor_type := case
    when v_actor_role = 'admin' then 'admin'
    else 'moderator'
  end;

  perform public.assert_faq_content_payload(p_content);

  v_request_payload := jsonb_build_object(
    'operationVersion', 1,
    'documentKey', 'faq',
    'actorDiscordUserId', v_actor_id,
    'operation', 'save_publish',
    'expectedStateVersion', p_expected_state_version,
    'content', p_content
  );
  v_request_hash := encode(
    extensions.digest(
      convert_to(v_request_payload::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(
    hashtextextended(p_idempotency_key::text, 0)
  );

  select request_hash, result
  into v_existing_hash, v_existing_result
  from public.content_management_requests
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing_hash = v_request_hash then
      return jsonb_set(v_existing_result, '{replayed}', 'true'::jsonb);
    end if;

    raise exception using
      errcode = 'PT409',
      message = 'FAQ_CONTENT_IDEMPOTENCY_CONFLICT';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('content-document:faq', 0)
  );

  select document_row.*
  into v_document
  from public.content_documents document_row
  where document_row.key = 'faq'
  for update;

  if not found or v_document.draft_revision_id is not null then
    raise exception using
      errcode = '55000',
      message = 'FAQ_CONTENT_DEPENDENCY_MISMATCH';
  end if;

  if v_document.state_version <> p_expected_state_version then
    raise exception using
      errcode = 'PT409',
      message = 'FAQ_CONTENT_STATE_CONFLICT';
  end if;

  v_content_hash := encode(
    extensions.digest(convert_to(p_content::text, 'UTF8'), 'sha256'),
    'hex'
  );

  select revision_row.content_hash
  into v_published_hash
  from public.content_revisions revision_row
  where revision_row.document_key = 'faq'
    and revision_row.id = v_document.published_revision_id;

  if v_published_hash is null then
    raise exception using
      errcode = '55000',
      message = 'FAQ_CONTENT_DEPENDENCY_MISMATCH';
  end if;

  if v_published_hash = v_content_hash then
    raise exception using
      errcode = 'PT409',
      message = 'FAQ_CONTENT_NO_CHANGES';
  end if;

  v_previous_revision_id := v_document.published_revision_id;

  select coalesce(max(revision_number), 0) + 1
  into v_revision_number
  from public.content_revisions
  where document_key = 'faq';

  insert into public.content_revisions (
    document_key,
    revision_number,
    content,
    content_hash,
    created_by_discord_user_id
  ) values (
    'faq',
    v_revision_number,
    p_content,
    v_content_hash,
    v_actor_id
  )
  returning id into v_revision_id;

  update public.content_documents
  set published_revision_id = v_revision_id,
      state_version = state_version + 1,
      updated_at = transaction_timestamp(),
      updated_by_discord_user_id = v_actor_id
  where key = 'faq'
  returning state_version into v_document.state_version;

  insert into public.content_publications (
    document_key,
    event_type,
    revision_id,
    previous_revision_id,
    requested_material_change,
    effective_material_change,
    structure_changed,
    previous_rules_version,
    rules_version,
    request_id,
    published_by_discord_user_id
  ) values (
    'faq', 'publish', v_revision_id, v_previous_revision_id,
    null, null, null, null, null, p_idempotency_key, v_actor_id
  );

  insert into public.admin_action_logs (
    actor_type, actor_id, action, target_type, target_id, meta
  ) values (
    v_actor_type,
    v_actor_id,
    'faq_published',
    'content_document',
    'faq',
    jsonb_build_object(
      'revision_id', v_revision_id,
      'revision_number', v_revision_number,
      'state_version', v_document.state_version,
      'authorization_capability', 'faq.manage',
      'authorization_role', v_actor_role,
      'request_id', p_idempotency_key
    )
  );

  v_result := jsonb_build_object(
    'operation', 'save_publish',
    'requestId', p_idempotency_key,
    'stateVersion', v_document.state_version,
    'revisionId', v_revision_id,
    'revisionNumber', v_revision_number,
    'replayed', false
  );

  insert into public.content_management_requests (
    idempotency_key,
    actor_discord_user_id,
    operation,
    request_hash,
    request_payload,
    result
  ) values (
    p_idempotency_key,
    v_actor_id,
    'save_publish',
    v_request_hash,
    v_request_payload,
    v_result
  );

  return v_result;
end;
$function$;

alter function public.manage_faq_content(text, bigint, jsonb, uuid)
  owner to postgres;
revoke all on function public.manage_faq_content(text, bigint, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.manage_faq_content(text, bigint, jsonb, uuid)
  to service_role;

comment on function public.manage_faq_content(text, bigint, jsonb, uuid) is
  'Authorizes faq.manage and atomically validates, saves, and publishes one immutable FAQ revision with optimistic concurrency, idempotency, append-only history, and audit. It creates no server draft and does not access Rules acceptance state.';

do $postflight$
declare
  v_bad_function_count integer;
begin
  if (select count(*) from public.capability_catalog) <> 27
    or (select count(*) from public.capability_catalog where is_active) <> 25
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 25
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'faq.manage'
        and implementation_version = 1
        and definition_hash =
          '7a0e2cecaf38453e42a00bbc60058f9a7793512941f2c62750d5c5537a030c93'
        and is_active
        and assignable_to_non_admin
    )
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key = 'faq.manage'
    )
    or (select count(*) from public.content_documents where key = 'faq') <> 1
    or (
      select count(*)
      from public.content_revisions revision_row
      join public.content_documents document_row
        on document_row.key = revision_row.document_key
       and document_row.published_revision_id = revision_row.id
      where document_row.key = 'faq'
        and document_row.draft_revision_id is null
        and document_row.state_version = 1
        and revision_row.revision_number = 1
    ) <> 1
    or (
      select count(*)
      from public.content_publications
      where document_key = 'faq'
        and event_type = 'bootstrap'
        and requested_material_change is null
        and effective_material_change is null
        and structure_changed is null
        and previous_rules_version is null
        and rules_version is null
    ) <> 1
    or exists (
      select 1
      from public.content_management_requests
      where operation = 'save_publish'
    ) then
    raise exception using
      errcode = '55000',
      message = 'FAQ_CONTENT_DATA_POSTFLIGHT_MISMATCH';
  end if;

  select count(*)
  into v_bad_function_count
  from pg_proc function_row
  join pg_namespace namespace_row
    on namespace_row.oid = function_row.pronamespace
  where namespace_row.nspname = 'public'
    and function_row.oid in (
      'public.assert_faq_content_payload(jsonb)'::regprocedure,
      'public.assert_faq_manager(text)'::regprocedure,
      'public.manage_faq_content(text,bigint,jsonb,uuid)'::regprocedure
    )
    and (
      pg_get_userbyid(function_row.proowner) <> 'postgres'
      or not function_row.prosecdef
      or function_row.proconfig is distinct from
        array['search_path=public, pg_temp']::text[]
    );

  if v_bad_function_count <> 0
    or exists (
      select 1
      from pg_class relation_row
      join pg_namespace namespace_row
        on namespace_row.oid = relation_row.relnamespace
      where namespace_row.nspname = 'public'
        and relation_row.relname in (
          'content_documents',
          'content_revisions',
          'content_publications',
          'content_management_requests'
        )
        and not relation_row.relrowsecurity
    )
    or has_table_privilege('anon', 'public.content_documents', 'select')
    or has_table_privilege('authenticated', 'public.content_documents', 'select')
    or has_table_privilege('anon', 'public.content_revisions', 'select')
    or has_table_privilege('authenticated', 'public.content_revisions', 'select')
    or has_table_privilege('anon', 'public.content_publications', 'select')
    or has_table_privilege('authenticated', 'public.content_publications', 'select')
    or has_table_privilege('service_role', 'public.content_documents', 'insert')
    or has_table_privilege('service_role', 'public.content_documents', 'update')
    or has_table_privilege('service_role', 'public.content_revisions', 'insert')
    or has_table_privilege('service_role', 'public.content_publications', 'insert')
    or has_table_privilege('service_role', 'public.content_management_requests', 'select')
    or has_function_privilege(
      'anon',
      'public.manage_faq_content(text,bigint,jsonb,uuid)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.manage_faq_content(text,bigint,jsonb,uuid)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.manage_faq_content(text,bigint,jsonb,uuid)',
      'execute'
    )
    or has_function_privilege(
      'service_role', 'public.assert_faq_manager(text)', 'execute'
    )
    or has_function_privilege(
      'service_role', 'public.assert_faq_content_payload(jsonb)', 'execute'
    ) then
    raise exception using
      errcode = '55000',
      message = 'FAQ_CONTENT_SECURITY_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;

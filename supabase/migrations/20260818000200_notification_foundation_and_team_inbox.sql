begin;

do $baseline$
begin
  if to_regclass('public.notification_category_catalog') is not null
    or to_regclass('public.notification_events') is not null
    or to_regclass('public.account_notifications') is not null
    or to_regclass('public.account_notification_preferences') is not null
    or to_regclass('public.push_subscriptions') is not null
    or to_regclass('public.push_subscription_preferences') is not null
    or to_regclass('public.push_delivery_jobs') is not null
    or to_regclass('public.notification_broadcast_jobs') is not null
    or to_regclass('public.team_inbox_topic_catalog') is not null
    or to_regclass('public.team_inbox_cases') is not null
    or to_regclass('public.team_inbox_attention_receipts') is not null
    or to_regclass('public.team_inbox_timeline_events') is not null
    or to_regclass('public.team_inbox_mutation_requests') is not null
    or to_regprocedure('public.get_own_notifications(uuid,timestamp with time zone,uuid,integer)') is not null
    or exists (
      select 1 from pg_proc function_row
      join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
      where namespace_row.nspname = 'public'
        and function_row.proname in (
          'enqueue_account_notification_event',
          'mutate_team_inbox_case',
          'claim_due_push_deliveries'
        )
    )
    or to_regprocedure('public.require_account_session(uuid)') is null
    or to_regclass('public.winner_claims') is null
    or to_regclass('public.submission_disqualification_events') is null
    or to_regclass('public.cycle_events') is null
    or to_regclass('public.capability_catalog') is null
    or (select count(*) from public.capability_catalog) <> 39
    or (select count(*) from public.capability_catalog where is_active) <> 35
  then
    raise exception using
      errcode = '55000',
      message = 'NOTIFICATION_FOUNDATION_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

create table public.notification_category_catalog (
  category_key text primary key,
  display_name text not null,
  required_in_product boolean not null,
  is_active boolean not null default true,
  created_at timestamptz not null default transaction_timestamp(),
  constraint notification_category_key_check
    check (category_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint notification_category_display_name_check
    check (char_length(display_name) between 3 and 80)
);

insert into public.notification_category_catalog (
  category_key, display_name, required_in_product, is_active
)
values
  ('cycles_voting', 'Cycles & Voting', false, true),
  ('winners_claims', 'Winners & Claims', true, true),
  ('submission_moderation', 'Submission Moderation', true, true);

create table public.notification_events (
  id uuid primary key default gen_random_uuid(),
  producer_key text not null unique,
  event_type text not null,
  category_key text not null references public.notification_category_catalog(category_key),
  audience_type text not null,
  owner_discord_user_id text,
  public_cycle_number bigint,
  deep_link text not null,
  occurred_at timestamptz not null default transaction_timestamp(),
  created_at timestamptz not null default transaction_timestamp(),
  constraint notification_event_producer_key_check
    check (char_length(producer_key) between 8 and 240),
  constraint notification_event_type_check
    check (event_type in (
      'winner_claim_required',
      'winner_donation_finalized',
      'submission_disqualified',
      'submission_reinstated',
      'cycle_results_ready'
    )),
  constraint notification_event_audience_check
    check (
      (audience_type = 'account'
        and owner_discord_user_id is not null
        and char_length(owner_discord_user_id) between 1 and 100
        and public_cycle_number is null)
      or
      (audience_type = 'broadcast'
        and owner_discord_user_id is null
        and public_cycle_number > 0)
    ),
  constraint notification_event_category_check
    check (
      (event_type in ('winner_claim_required', 'winner_donation_finalized')
        and category_key = 'winners_claims')
      or (event_type in ('submission_disqualified', 'submission_reinstated')
        and category_key = 'submission_moderation')
      or (event_type = 'cycle_results_ready'
        and category_key = 'cycles_voting')
    ),
  constraint notification_event_deep_link_check
    check (
      deep_link ~ '^/[A-Za-z0-9/_?#=&.-]{1,240}$'
      and deep_link !~ '^//'
      and deep_link !~ '[[:cntrl:]\\]'
    )
);

create table public.account_notification_preferences (
  owner_discord_user_id text not null,
  category_key text not null references public.notification_category_catalog(category_key),
  in_product_enabled boolean not null default false,
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (owner_discord_user_id, category_key),
  constraint account_notification_preference_owner_check
    check (char_length(owner_discord_user_id) between 1 and 100)
);

create table public.account_notifications (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.notification_events(id) on delete restrict,
  owner_discord_user_id text not null,
  visible_in_product boolean not null,
  read_at timestamptz,
  created_at timestamptz not null default transaction_timestamp(),
  unique (event_id, owner_discord_user_id),
  constraint account_notification_owner_check
    check (char_length(owner_discord_user_id) between 1 and 100),
  constraint account_notification_read_visibility_check
    check (visible_in_product or read_at is null)
);

create index account_notifications_owner_page_idx
  on public.account_notifications (
    owner_discord_user_id, visible_in_product, created_at desc, id desc
  );
create index account_notifications_owner_unread_idx
  on public.account_notifications (owner_discord_user_id, created_at desc)
  where visible_in_product and read_at is null;

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_discord_user_id text not null,
  session_id uuid not null references public.sessions(id) on delete restrict,
  device_id uuid not null,
  endpoint_fingerprint text not null,
  subscription_ciphertext text not null,
  subscription_nonce text not null,
  subscription_tag text not null,
  key_version integer not null,
  is_active boolean not null default true,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deactivated_at timestamptz,
  constraint push_subscription_owner_check
    check (char_length(owner_discord_user_id) between 1 and 100),
  constraint push_subscription_fingerprint_check
    check (endpoint_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint push_subscription_ciphertext_check
    check (
      char_length(subscription_ciphertext) between 24 and 16384
      and char_length(subscription_nonce) between 12 and 128
      and char_length(subscription_tag) between 12 and 128
      and key_version between 1 and 1000
    ),
  constraint push_subscription_active_state_check
    check (
      (is_active and deactivated_at is null)
      or (not is_active and deactivated_at is not null)
    )
);

create unique index push_subscriptions_active_device_idx
  on public.push_subscriptions (owner_discord_user_id, device_id)
  where is_active;
create unique index push_subscriptions_active_endpoint_idx
  on public.push_subscriptions (endpoint_fingerprint)
  where is_active;
create index push_subscriptions_active_session_idx
  on public.push_subscriptions (session_id)
  where is_active;

create table public.push_subscription_preferences (
  subscription_id uuid not null references public.push_subscriptions(id) on delete restrict,
  category_key text not null references public.notification_category_catalog(category_key),
  enabled boolean not null default false,
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (subscription_id, category_key)
);

create table public.push_delivery_jobs (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.notification_events(id) on delete restrict,
  notification_id uuid not null references public.account_notifications(id) on delete restrict,
  subscription_id uuid not null references public.push_subscriptions(id) on delete restrict,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  available_at timestamptz not null default transaction_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  terminal_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  unique (event_id, subscription_id),
  constraint push_delivery_status_check
    check (status in ('pending', 'processing', 'delivered', 'failed_permanent')),
  constraint push_delivery_attempt_check
    check (attempt_count between 0 and max_attempts and max_attempts between 1 and 10),
  constraint push_delivery_error_check
    check (
      last_error_code is null
      or (
        char_length(last_error_code) between 2 and 80
        and last_error_code ~ '^[a-z0-9_:-]+$'
      )
    ),
  constraint push_delivery_state_timestamps_check
    check (
      (status = 'pending' and lease_token is null and lease_expires_at is null
        and delivered_at is null and terminal_at is null)
      or (status = 'processing' and lease_token is not null and lease_expires_at is not null
        and delivered_at is null and terminal_at is null)
      or (status = 'delivered' and lease_token is null and lease_expires_at is null
        and delivered_at is not null and terminal_at is null)
      or (status = 'failed_permanent' and lease_token is null and lease_expires_at is null
        and delivered_at is null and terminal_at is not null)
    )
);

create index push_delivery_due_idx
  on public.push_delivery_jobs (available_at, id)
  where status = 'pending';
create index push_delivery_expired_lease_idx
  on public.push_delivery_jobs (lease_expires_at, id)
  where status = 'processing';

create table public.notification_broadcast_jobs (
  event_id uuid primary key references public.notification_events(id) on delete restrict,
  status text not null default 'pending',
  last_owner_discord_user_id text,
  processed_owner_count bigint not null default 0,
  updated_at timestamptz not null default transaction_timestamp(),
  completed_at timestamptz,
  constraint notification_broadcast_status_check
    check (status in ('pending', 'completed')),
  constraint notification_broadcast_count_check
    check (processed_owner_count >= 0),
  constraint notification_broadcast_state_check
    check (
      (status = 'pending' and completed_at is null)
      or (status = 'completed' and completed_at is not null)
    )
);

create table public.team_inbox_topic_catalog (
  topic_key text primary key,
  display_name text not null,
  is_active boolean not null default false,
  required_read_capabilities text[] not null,
  required_action_capabilities text[] not null,
  created_at timestamptz not null default transaction_timestamp(),
  activated_at timestamptz,
  constraint team_inbox_topic_key_check
    check (topic_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint team_inbox_topic_display_name_check
    check (char_length(display_name) between 3 and 80),
  constraint team_inbox_topic_capabilities_check
    check (
      cardinality(required_read_capabilities) between 1 and 8
      and cardinality(required_action_capabilities) between 1 and 8
    ),
  constraint team_inbox_topic_activation_check
    check ((is_active and activated_at is not null) or (not is_active and activated_at is null))
);

insert into public.team_inbox_topic_catalog (
  topic_key, display_name, is_active,
  required_read_capabilities, required_action_capabilities
)
values (
  'wallet_issues',
  'Wallet Issues',
  false,
  array['winners.payouts.view', 'winners.recipient_corrections.manage']::text[],
  array['winners.payouts.view', 'winners.recipient_corrections.manage']::text[]
);

create table public.team_inbox_cases (
  id uuid primary key default gen_random_uuid(),
  topic_key text not null references public.team_inbox_topic_catalog(topic_key),
  source_key text not null,
  source_version bigint not null,
  subject_discord_user_id text not null,
  subject_username_snapshot text not null,
  status text not null default 'open',
  assignee_discord_user_id text,
  assignee_display_snapshot text,
  work_version bigint not null default 1,
  row_version bigint not null default 1,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  claimed_at timestamptz,
  solved_at timestamptz,
  unique (topic_key, source_key),
  constraint team_inbox_case_source_key_check
    check (char_length(source_key) between 8 and 240),
  constraint team_inbox_case_source_version_check
    check (source_version > 0),
  constraint team_inbox_case_subject_check
    check (
      char_length(subject_discord_user_id) between 1 and 100
      and char_length(subject_username_snapshot) between 1 and 160
    ),
  constraint team_inbox_case_status_check
    check (status in ('open', 'in_progress', 'solved')),
  constraint team_inbox_case_version_check
    check (work_version > 0 and row_version > 0),
  constraint team_inbox_case_assignment_check
    check (
      (status = 'open' and assignee_discord_user_id is null
        and assignee_display_snapshot is null and claimed_at is null and solved_at is null)
      or (status = 'in_progress' and assignee_discord_user_id is not null
        and assignee_display_snapshot is not null and claimed_at is not null and solved_at is null)
      or (status = 'solved' and assignee_discord_user_id is not null
        and assignee_display_snapshot is not null and claimed_at is not null and solved_at is not null)
    )
);

create index team_inbox_cases_topic_queue_idx
  on public.team_inbox_cases (topic_key, status, updated_at desc, id desc);
create index team_inbox_cases_subject_idx
  on public.team_inbox_cases (topic_key, subject_discord_user_id, updated_at desc);

create table public.team_inbox_attention_receipts (
  case_id uuid not null references public.team_inbox_cases(id) on delete restrict,
  viewer_discord_user_id text not null,
  last_seen_attention_version bigint not null,
  first_seen_at timestamptz not null default transaction_timestamp(),
  last_seen_at timestamptz not null default transaction_timestamp(),
  primary key (case_id, viewer_discord_user_id),
  constraint team_inbox_receipt_viewer_check
    check (char_length(viewer_discord_user_id) between 1 and 100),
  constraint team_inbox_receipt_version_check
    check (last_seen_attention_version > 0)
);

create table public.team_inbox_timeline_events (
  id bigint generated always as identity primary key,
  case_id uuid not null references public.team_inbox_cases(id) on delete restrict,
  event_type text not null,
  work_version bigint not null,
  row_version bigint not null,
  actor_discord_user_id text,
  actor_display_snapshot text,
  actor_role_snapshot text,
  capability_context jsonb not null default '{}'::jsonb,
  source_version bigint,
  outcome_code text,
  bounded_note text,
  created_at timestamptz not null default transaction_timestamp(),
  constraint team_inbox_timeline_type_check
    check (event_type in (
      'created', 'claimed', 'returned', 'topic_action',
      'notification_queued', 'solved', 'reopened', 'admin_forced_release'
    )),
  constraint team_inbox_timeline_version_check
    check (work_version > 0 and row_version > 0),
  constraint team_inbox_timeline_actor_check
    check (
      (actor_discord_user_id is null and actor_display_snapshot is null and actor_role_snapshot is null)
      or (actor_discord_user_id is not null
        and char_length(actor_discord_user_id) between 1 and 100
        and actor_display_snapshot is not null
        and char_length(actor_display_snapshot) between 1 and 160
        and actor_role_snapshot is not null
        and char_length(actor_role_snapshot) between 1 and 80)
    ),
  constraint team_inbox_timeline_outcome_check
    check (
      outcome_code is null
      or (char_length(outcome_code) between 2 and 80 and outcome_code ~ '^[a-z0-9_:-]+$')
    ),
  constraint team_inbox_timeline_note_check
    check (bounded_note is null or char_length(bounded_note) between 3 and 1000)
);

create index team_inbox_timeline_case_page_idx
  on public.team_inbox_timeline_events (case_id, id desc);

create table public.team_inbox_mutation_requests (
  idempotency_key uuid primary key,
  actor_discord_user_id text not null,
  action text not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default transaction_timestamp(),
  constraint team_inbox_request_actor_check
    check (char_length(actor_discord_user_id) between 1 and 100),
  constraint team_inbox_request_action_check
    check (action in ('claim', 'return', 'force_release')),
  constraint team_inbox_request_hash_check
    check (request_hash ~ '^[a-f0-9]{64}$')
);

create function public.protect_notification_immutable_row()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'NOTIFICATION_IMMUTABLE_ROW';
end;
$function$;

create function public.protect_team_inbox_timeline_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'TEAM_INBOX_TIMELINE_IMMUTABLE';
end;
$function$;

create trigger notification_events_immutable
before update or delete on public.notification_events
for each row execute function public.protect_notification_immutable_row();

create trigger team_inbox_timeline_events_immutable
before update or delete on public.team_inbox_timeline_events
for each row execute function public.protect_team_inbox_timeline_event();

create function public.enqueue_account_notification_event(
  p_producer_key text,
  p_event_type text,
  p_category_key text,
  p_owner_discord_user_id text,
  p_deep_link text,
  p_visible_in_product boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_event public.notification_events%rowtype;
  v_notification_id uuid;
begin
  insert into public.notification_events (
    producer_key, event_type, category_key, audience_type,
    owner_discord_user_id, deep_link
  ) values (
    p_producer_key, p_event_type, p_category_key, 'account',
    p_owner_discord_user_id, p_deep_link
  )
  on conflict (producer_key) do nothing
  returning * into v_event;

  if not found then
    select * into strict v_event
    from public.notification_events
    where producer_key = p_producer_key;

    if v_event.event_type <> p_event_type
      or v_event.category_key <> p_category_key
      or v_event.audience_type <> 'account'
      or v_event.owner_discord_user_id <> p_owner_discord_user_id
      or v_event.deep_link <> p_deep_link
    then
      raise exception using
        errcode = '55000',
        message = 'NOTIFICATION_EVENT_REPLAY_MISMATCH';
    end if;
  end if;

  insert into public.account_notifications (
    event_id, owner_discord_user_id, visible_in_product
  ) values (
    v_event.id, p_owner_discord_user_id, p_visible_in_product
  )
  on conflict (event_id, owner_discord_user_id) do update
  set visible_in_product =
    public.account_notifications.visible_in_product or excluded.visible_in_product
  returning id into v_notification_id;

  insert into public.push_delivery_jobs (
    event_id, notification_id, subscription_id
  )
  select v_event.id, v_notification_id, subscription.id
  from public.push_subscriptions subscription
  join public.sessions session_row
    on session_row.id = subscription.session_id
   and session_row.revoked_at is null
  join public.push_subscription_preferences preference
    on preference.subscription_id = subscription.id
   and preference.category_key = p_category_key
   and preference.enabled
  where subscription.owner_discord_user_id = p_owner_discord_user_id
    and subscription.is_active
  on conflict (event_id, subscription_id) do nothing;

  return v_notification_id;
end;
$function$;

create function public.produce_winner_claim_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  perform public.enqueue_account_notification_event(
    'winner_claim:' || new.id::text,
    case when new.status = 'not_required'
      then 'winner_donation_finalized'
      else 'winner_claim_required'
    end,
    'winners_claims',
    new.winner_discord_user_id,
    '/my-profile/winnings/' || new.id::text,
    true
  );
  return new;
end;
$function$;

create trigger winner_claims_produce_notification
after insert on public.winner_claims
for each row execute function public.produce_winner_claim_notification();

create function public.produce_submission_moderation_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  perform public.enqueue_account_notification_event(
    'submission_disqualification_event:' || new.id::text,
    case when new.transition = 'disqualified'
      then 'submission_disqualified'
      else 'submission_reinstated'
    end,
    'submission_moderation',
    new.subject_discord_user_id,
    '/my-profile/disqualifications',
    true
  );
  return new;
end;
$function$;

create trigger submission_dq_events_produce_notification
after insert on public.submission_disqualification_events
for each row execute function public.produce_submission_moderation_notification();

create function public.produce_cycle_results_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_public_number bigint;
  v_event_id uuid;
begin
  if new.event_type <> 'cycle_completed' then
    return new;
  end if;

  select cycle.public_number into v_public_number
  from public.voting_cycles cycle
  where cycle.id = new.cycle_id;

  if v_public_number is null then
    raise exception using
      errcode = '55000',
      message = 'NOTIFICATION_CYCLE_PUBLIC_NUMBER_UNAVAILABLE';
  end if;

  insert into public.notification_events (
    producer_key, event_type, category_key, audience_type,
    public_cycle_number, deep_link, occurred_at
  ) values (
    'cycle_event:' || new.id::text,
    'cycle_results_ready', 'cycles_voting', 'broadcast',
    v_public_number, '/community-feed?cycle=' || v_public_number::text,
    new.created_at
  )
  on conflict (producer_key) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select id into strict v_event_id
    from public.notification_events
    where producer_key = 'cycle_event:' || new.id::text;
  end if;

  insert into public.notification_broadcast_jobs (event_id)
  values (v_event_id)
  on conflict (event_id) do nothing;
  return new;
end;
$function$;

create trigger cycle_events_produce_results_notification
after insert on public.cycle_events
for each row execute function public.produce_cycle_results_notification();

create function public.get_own_notification_unread_count(p_session_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_count bigint;
begin
  v_owner_id := public.require_account_session(p_session_id);
  select count(*) into v_count
  from public.account_notifications notification
  where notification.owner_discord_user_id = v_owner_id
    and notification.visible_in_product
    and notification.read_at is null;
  return least(v_count, 999);
end;
$function$;

create function public.get_own_notifications(
  p_session_id uuid,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_items jsonb;
begin
  if p_limit not between 1 and 50
    or ((p_before_created_at is null) <> (p_before_id is null))
  then
    raise exception using errcode = '22023', message = 'NOTIFICATION_PAGE_INPUT_INVALID';
  end if;

  v_owner_id := public.require_account_session(p_session_id);
  select coalesce(jsonb_agg(item.payload order by item.created_at desc, item.id desc), '[]'::jsonb)
  into v_items
  from (
    select
      notification.created_at,
      notification.id,
      jsonb_build_object(
        'id', notification.id,
        'categoryKey', event.category_key,
        'eventType', event.event_type,
        'title', case event.event_type
          when 'winner_claim_required' then 'Winner action required'
          when 'winner_donation_finalized' then 'Winner result finalized'
          when 'submission_disqualified' then 'Submission status changed'
          when 'submission_reinstated' then 'Submission status changed'
          else 'Cycle results are ready'
        end,
        'body', case event.event_type
          when 'winner_claim_required' then 'Open CancerCulture to review your winner claim.'
          when 'winner_donation_finalized' then 'Open CancerCulture to review your finalized result.'
          when 'submission_disqualified' then 'Open CancerCulture to review your submission status.'
          when 'submission_reinstated' then 'Open CancerCulture to review your submission status.'
          else 'Open CancerCulture to view the latest results.'
        end,
        'createdAt', notification.created_at,
        'readAt', notification.read_at
      ) as payload
    from public.account_notifications notification
    join public.notification_events event on event.id = notification.event_id
    where notification.owner_discord_user_id = v_owner_id
      and notification.visible_in_product
      and (
        p_before_created_at is null
        or (notification.created_at, notification.id) < (p_before_created_at, p_before_id)
      )
    order by notification.created_at desc, notification.id desc
    limit p_limit + 1
  ) item;
  return jsonb_build_object('items', v_items);
end;
$function$;

create function public.mark_own_notification_read(
  p_session_id uuid,
  p_notification_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_read_at timestamptz;
begin
  v_owner_id := public.require_account_session(p_session_id);
  update public.account_notifications notification
  set read_at = coalesce(notification.read_at, transaction_timestamp())
  where notification.id = p_notification_id
    and notification.owner_discord_user_id = v_owner_id
    and notification.visible_in_product
  returning read_at into v_read_at;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  return jsonb_build_object('outcome', 'read', 'readAt', v_read_at);
end;
$function$;

create function public.get_own_notification_destination(
  p_session_id uuid,
  p_notification_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_deep_link text;
begin
  v_owner_id := public.require_account_session(p_session_id);
  select event.deep_link into v_deep_link
  from public.account_notifications notification
  join public.notification_events event on event.id = notification.event_id
  where notification.id = p_notification_id
    and notification.owner_discord_user_id = v_owner_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  return jsonb_build_object('outcome', 'found', 'destination', v_deep_link);
end;
$function$;

create function public.get_own_notification_settings(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_categories jsonb;
begin
  v_owner_id := public.require_account_session(p_session_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'categoryKey', category.category_key,
    'displayName', category.display_name,
    'requiredInProduct', category.required_in_product,
    'inProductEnabled', category.required_in_product
      or coalesce(preference.in_product_enabled, false)
  ) order by category.category_key), '[]'::jsonb)
  into v_categories
  from public.notification_category_catalog category
  left join public.account_notification_preferences preference
    on preference.owner_discord_user_id = v_owner_id
   and preference.category_key = category.category_key
  where category.is_active;
  return jsonb_build_object('categories', v_categories);
end;
$function$;

create function public.set_own_notification_preference(
  p_session_id uuid,
  p_category_key text,
  p_in_product_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_required boolean;
begin
  v_owner_id := public.require_account_session(p_session_id);
  select required_in_product into v_required
  from public.notification_category_catalog
  where category_key = p_category_key and is_active;
  if not found then
    raise exception using errcode = '22023', message = 'NOTIFICATION_CATEGORY_INVALID';
  end if;
  if v_required and not p_in_product_enabled then
    raise exception using errcode = '22023', message = 'NOTIFICATION_REQUIRED_IN_PRODUCT';
  end if;
  insert into public.account_notification_preferences (
    owner_discord_user_id, category_key, in_product_enabled
  ) values (v_owner_id, p_category_key, p_in_product_enabled)
  on conflict (owner_discord_user_id, category_key) do update
  set in_product_enabled = excluded.in_product_enabled,
      updated_at = transaction_timestamp();
  return jsonb_build_object(
    'outcome', 'updated',
    'categoryKey', p_category_key,
    'inProductEnabled', v_required or p_in_product_enabled
  );
end;
$function$;

create function public.upsert_own_push_subscription(
  p_session_id uuid,
  p_device_id uuid,
  p_endpoint_fingerprint text,
  p_subscription_ciphertext text,
  p_subscription_nonce text,
  p_subscription_tag text,
  p_key_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_subscription_id uuid;
begin
  if p_device_id is null
    or p_endpoint_fingerprint !~ '^[a-f0-9]{64}$'
    or char_length(p_subscription_ciphertext) not between 24 and 16384
    or char_length(p_subscription_nonce) not between 12 and 128
    or char_length(p_subscription_tag) not between 12 and 128
    or p_key_version not between 1 and 1000
  then
    raise exception using errcode = '22023', message = 'PUSH_SUBSCRIPTION_INPUT_INVALID';
  end if;

  v_owner_id := public.require_account_session(p_session_id);
  perform pg_advisory_xact_lock(hashtextextended('push-device:' || p_device_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('push-endpoint:' || p_endpoint_fingerprint, 0));

  select id into v_subscription_id
  from public.push_subscriptions
  where owner_discord_user_id = v_owner_id
    and device_id = p_device_id
    and endpoint_fingerprint = p_endpoint_fingerprint
    and is_active
  for update;

  if found then
    update public.push_subscriptions
    set session_id = p_session_id,
        subscription_ciphertext = p_subscription_ciphertext,
        subscription_nonce = p_subscription_nonce,
        subscription_tag = p_subscription_tag,
        key_version = p_key_version,
        updated_at = transaction_timestamp()
    where id = v_subscription_id;
  else
    update public.push_subscriptions
    set is_active = false,
        deactivated_at = transaction_timestamp(),
        updated_at = transaction_timestamp()
    where is_active
      and (
        (owner_discord_user_id = v_owner_id and device_id = p_device_id)
        or endpoint_fingerprint = p_endpoint_fingerprint
      );

    insert into public.push_subscriptions (
      owner_discord_user_id, session_id, device_id, endpoint_fingerprint,
      subscription_ciphertext, subscription_nonce, subscription_tag, key_version
    ) values (
      v_owner_id, p_session_id, p_device_id, p_endpoint_fingerprint,
      p_subscription_ciphertext, p_subscription_nonce, p_subscription_tag, p_key_version
    ) returning id into v_subscription_id;

    insert into public.push_subscription_preferences (
      subscription_id, category_key, enabled
    )
    select v_subscription_id, category.category_key, false
    from public.notification_category_catalog category
    where category.is_active;
  end if;

  return jsonb_build_object('outcome', 'active', 'subscriptionId', v_subscription_id);
end;
$function$;

create function public.get_own_push_subscription_settings(
  p_session_id uuid,
  p_device_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_subscription_id uuid;
  v_categories jsonb;
begin
  v_owner_id := public.require_account_session(p_session_id);
  select subscription.id into v_subscription_id
  from public.push_subscriptions subscription
  join public.sessions session_row
    on session_row.id = subscription.session_id
   and session_row.revoked_at is null
  where subscription.owner_discord_user_id = v_owner_id
    and subscription.device_id = p_device_id
    and subscription.is_active;

  if v_subscription_id is null then
    return jsonb_build_object('active', false, 'categories', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'categoryKey', category.category_key,
    'displayName', category.display_name,
    'enabled', coalesce(preference.enabled, false)
  ) order by category.category_key), '[]'::jsonb)
  into v_categories
  from public.notification_category_catalog category
  left join public.push_subscription_preferences preference
    on preference.subscription_id = v_subscription_id
   and preference.category_key = category.category_key
  where category.is_active;
  return jsonb_build_object('active', true, 'categories', v_categories);
end;
$function$;

create function public.set_own_push_subscription_preference(
  p_session_id uuid,
  p_device_id uuid,
  p_category_key text,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_subscription_id uuid;
begin
  v_owner_id := public.require_account_session(p_session_id);
  if not exists (
    select 1 from public.notification_category_catalog
    where category_key = p_category_key and is_active
  ) then
    raise exception using errcode = '22023', message = 'NOTIFICATION_CATEGORY_INVALID';
  end if;
  select id into v_subscription_id
  from public.push_subscriptions
  where owner_discord_user_id = v_owner_id
    and device_id = p_device_id
    and session_id = p_session_id
    and is_active
  for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  insert into public.push_subscription_preferences (
    subscription_id, category_key, enabled
  ) values (v_subscription_id, p_category_key, p_enabled)
  on conflict (subscription_id, category_key) do update
  set enabled = excluded.enabled, updated_at = transaction_timestamp();
  return jsonb_build_object('outcome', 'updated', 'enabled', p_enabled);
end;
$function$;

create function public.deactivate_own_push_subscription(
  p_session_id uuid,
  p_device_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner_id text;
  v_count integer;
begin
  v_owner_id := public.require_account_session(p_session_id);
  update public.push_subscriptions
  set is_active = false,
      deactivated_at = transaction_timestamp(),
      updated_at = transaction_timestamp()
  where owner_discord_user_id = v_owner_id
    and session_id = p_session_id
    and device_id = p_device_id
    and is_active;
  get diagnostics v_count = row_count;
  return jsonb_build_object('outcome', 'deactivated', 'count', v_count);
end;
$function$;

create function public.process_notification_broadcast_batch(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_job public.notification_broadcast_jobs%rowtype;
  v_event public.notification_events%rowtype;
  v_owner record;
  v_notification_id uuid;
  v_count integer := 0;
begin
  if p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'NOTIFICATION_BROADCAST_LIMIT_INVALID';
  end if;
  select * into v_job
  from public.notification_broadcast_jobs
  where status = 'pending'
  order by updated_at, event_id
  for update skip locked
  limit 1;
  if not found then
    return jsonb_build_object('outcome', 'idle', 'processed', 0);
  end if;
  select * into strict v_event from public.notification_events where id = v_job.event_id;

  for v_owner in
    select candidate.owner_discord_user_id,
      bool_or(candidate.in_product_enabled) as in_product_enabled
    from (
      select preference.owner_discord_user_id, preference.in_product_enabled
      from public.account_notification_preferences preference
      where preference.category_key = v_event.category_key
        and preference.in_product_enabled
      union all
      select subscription.owner_discord_user_id, false
      from public.push_subscriptions subscription
      join public.sessions session_row
        on session_row.id = subscription.session_id and session_row.revoked_at is null
      join public.push_subscription_preferences preference
        on preference.subscription_id = subscription.id
       and preference.category_key = v_event.category_key
       and preference.enabled
      where subscription.is_active
    ) candidate
    where v_job.last_owner_discord_user_id is null
      or candidate.owner_discord_user_id > v_job.last_owner_discord_user_id
    group by candidate.owner_discord_user_id
    order by candidate.owner_discord_user_id
    limit p_limit
  loop
    insert into public.account_notifications (
      event_id, owner_discord_user_id, visible_in_product
    ) values (
      v_event.id, v_owner.owner_discord_user_id, v_owner.in_product_enabled
    )
    on conflict (event_id, owner_discord_user_id) do update
    set visible_in_product = public.account_notifications.visible_in_product
      or excluded.visible_in_product
    returning id into v_notification_id;

    insert into public.push_delivery_jobs (event_id, notification_id, subscription_id)
    select v_event.id, v_notification_id, subscription.id
    from public.push_subscriptions subscription
    join public.sessions session_row
      on session_row.id = subscription.session_id and session_row.revoked_at is null
    join public.push_subscription_preferences preference
      on preference.subscription_id = subscription.id
     and preference.category_key = v_event.category_key
     and preference.enabled
    where subscription.owner_discord_user_id = v_owner.owner_discord_user_id
      and subscription.is_active
    on conflict (event_id, subscription_id) do nothing;

    v_job.last_owner_discord_user_id := v_owner.owner_discord_user_id;
    v_count := v_count + 1;
  end loop;

  update public.notification_broadcast_jobs
  set last_owner_discord_user_id = v_job.last_owner_discord_user_id,
      processed_owner_count = processed_owner_count + v_count,
      status = case when v_count < p_limit then 'completed' else 'pending' end,
      completed_at = case when v_count < p_limit then transaction_timestamp() else null end,
      updated_at = transaction_timestamp()
  where event_id = v_job.event_id;
  return jsonb_build_object(
    'outcome', case when v_count < p_limit then 'completed' else 'pending' end,
    'processed', v_count
  );
end;
$function$;

create function public.claim_due_push_deliveries(
  p_worker_token uuid,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_items jsonb;
begin
  if p_worker_token is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'PUSH_CLAIM_INPUT_INVALID';
  end if;

  update public.push_delivery_jobs job
  set status = 'failed_permanent', lease_token = null, lease_expires_at = null,
      terminal_at = transaction_timestamp(), last_error_code = 'retry_limit',
      updated_at = transaction_timestamp()
  where job.status = 'processing'
    and job.lease_expires_at <= transaction_timestamp()
    and job.attempt_count >= job.max_attempts;

  update public.push_delivery_jobs job
  set status = 'pending', lease_token = null, lease_expires_at = null,
      available_at = transaction_timestamp(), last_error_code = 'lease_expired',
      updated_at = transaction_timestamp()
  where job.status = 'processing'
    and job.lease_expires_at <= transaction_timestamp()
    and job.attempt_count < job.max_attempts;

  update public.push_delivery_jobs job
  set status = 'failed_permanent', terminal_at = transaction_timestamp(),
      last_error_code = 'subscription_inactive', updated_at = transaction_timestamp()
  where job.status = 'pending'
    and exists (
      select 1
      from public.push_subscriptions subscription
      left join public.sessions session_row on session_row.id = subscription.session_id
      where subscription.id = job.subscription_id
        and (not subscription.is_active or session_row.revoked_at is not null)
    );

  with due as (
    select job.id
    from public.push_delivery_jobs job
    join public.push_subscriptions subscription
      on subscription.id = job.subscription_id and subscription.is_active
    join public.sessions session_row
      on session_row.id = subscription.session_id and session_row.revoked_at is null
    where job.status = 'pending'
      and job.available_at <= transaction_timestamp()
    order by job.available_at, job.id
    for update of job skip locked
    limit p_limit
  ), claimed as (
    update public.push_delivery_jobs job
    set status = 'processing',
        attempt_count = attempt_count + 1,
        lease_token = p_worker_token,
        lease_expires_at = transaction_timestamp() + interval '2 minutes',
        updated_at = transaction_timestamp()
    from due
    where job.id = due.id
    returning job.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'jobId', claimed.id,
    'leaseToken', claimed.lease_token,
    'subscriptionId', subscription.id,
    'ciphertext', subscription.subscription_ciphertext,
    'nonce', subscription.subscription_nonce,
    'tag', subscription.subscription_tag,
    'keyVersion', subscription.key_version,
    'categoryKey', event.category_key,
    'eventType', event.event_type,
    'notificationId', claimed.notification_id,
    'attemptCount', claimed.attempt_count,
    'maxAttempts', claimed.max_attempts
  ) order by claimed.id), '[]'::jsonb)
  into v_items
  from claimed
  join public.push_subscriptions subscription on subscription.id = claimed.subscription_id
  join public.notification_events event on event.id = claimed.event_id;
  return jsonb_build_object('items', v_items);
end;
$function$;

create function public.complete_push_delivery(
  p_job_id bigint,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  update public.push_delivery_jobs
  set status = 'delivered', lease_token = null, lease_expires_at = null,
      delivered_at = transaction_timestamp(), last_error_code = null,
      updated_at = transaction_timestamp()
  where id = p_job_id
    and status = 'processing'
    and lease_token = p_lease_token
    and lease_expires_at > transaction_timestamp();
  if not found then
    return jsonb_build_object('outcome', 'stale');
  end if;
  return jsonb_build_object('outcome', 'delivered');
end;
$function$;

create function public.fail_push_delivery(
  p_job_id bigint,
  p_lease_token uuid,
  p_error_code text,
  p_retryable boolean,
  p_subscription_invalid boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_job public.push_delivery_jobs%rowtype;
  v_permanent boolean;
begin
  if p_error_code !~ '^[a-z0-9_:-]{2,80}$' then
    raise exception using errcode = '22023', message = 'PUSH_FAILURE_CODE_INVALID';
  end if;
  select * into v_job from public.push_delivery_jobs
  where id = p_job_id and status = 'processing' and lease_token = p_lease_token
  for update;
  if not found then
    return jsonb_build_object('outcome', 'stale');
  end if;
  v_permanent := p_subscription_invalid or not p_retryable
    or v_job.attempt_count >= v_job.max_attempts;
  if v_permanent then
    update public.push_delivery_jobs
    set status = 'failed_permanent', lease_token = null, lease_expires_at = null,
        terminal_at = transaction_timestamp(), last_error_code = p_error_code,
        updated_at = transaction_timestamp()
    where id = p_job_id;
  else
    update public.push_delivery_jobs
    set status = 'pending', lease_token = null, lease_expires_at = null,
        available_at = transaction_timestamp()
          + make_interval(secs => least(900, 15 * (2 ^ greatest(0, attempt_count - 1)))::integer),
        last_error_code = p_error_code, updated_at = transaction_timestamp()
    where id = p_job_id;
  end if;
  if p_subscription_invalid then
    update public.push_subscriptions
    set is_active = false, deactivated_at = transaction_timestamp(),
        updated_at = transaction_timestamp()
    where id = v_job.subscription_id and is_active;
    update public.push_delivery_jobs
    set status = 'failed_permanent', terminal_at = transaction_timestamp(),
        last_error_code = 'subscription_invalid', updated_at = transaction_timestamp()
    where subscription_id = v_job.subscription_id and status = 'pending';
  end if;
  return jsonb_build_object(
    'outcome', case when v_permanent then 'failed_permanent' else 'retry_scheduled' end
  );
end;
$function$;

create function public.assert_team_inbox_topic_access(
  p_actor_discord_user_id text,
  p_topic_key text,
  p_action_access boolean
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_id text := btrim(p_actor_discord_user_id);
  v_role text;
  v_capabilities text[];
  v_capability text;
  v_expected_version integer;
  v_expected_hash text;
begin
  if v_actor_id !~ '^[0-9]{1,100}$' then
    raise exception using errcode = '42501', message = 'TEAM_INBOX_FORBIDDEN';
  end if;
  select case when p_action_access
      then topic.required_action_capabilities
      else topic.required_read_capabilities
    end
  into v_capabilities
  from public.team_inbox_topic_catalog topic
  where topic.topic_key = p_topic_key and topic.is_active;
  if not found then
    raise exception using errcode = '42501', message = 'TEAM_INBOX_TOPIC_UNAVAILABLE';
  end if;

  select member.role into v_role
  from public.team_members member
  join public.team_roles role on role.key = member.role and role.is_active
  where member.discord_user_id = v_actor_id;
  if not found then
    raise exception using errcode = '42501', message = 'TEAM_INBOX_FORBIDDEN';
  end if;

  foreach v_capability in array v_capabilities loop
    v_expected_version := case v_capability
      when 'winners.payouts.view' then 2
      when 'winners.recipient_corrections.manage' then 2
      else null
    end;
    v_expected_hash := case v_capability
      when 'winners.payouts.view'
        then '9de22d0055e9c8b6b8cb701e4f6f554aa4c241ab0cbfb0a4709ecc9841702a54'
      when 'winners.recipient_corrections.manage'
        then 'e569fa66e8f9c2794fe030c4e034ebf8a7e458c6ddccf2a868d2cac1fd5ea2bd'
      else null
    end;
    if v_expected_version is null or not exists (
      select 1 from public.capability_catalog capability
      where capability.key = v_capability
        and capability.is_active
        and capability.assignable_to_non_admin
        and capability.implementation_version = v_expected_version
        and capability.definition_hash = v_expected_hash
    ) then
      raise exception using
        errcode = '55000', message = 'TEAM_INBOX_CAPABILITY_DEPENDENCY_UNAVAILABLE';
    end if;
    if v_role <> 'admin' and not exists (
      select 1 from public.team_role_capabilities grant_row
      where grant_row.role_key = v_role
        and grant_row.capability_key = v_capability
    ) then
      raise exception using errcode = '42501', message = 'TEAM_INBOX_FORBIDDEN';
    end if;
  end loop;
  return v_role;
end;
$function$;

create function public.get_authorized_team_inbox_topics(
  p_actor_discord_user_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_topic record;
  v_items jsonb := '[]'::jsonb;
begin
  for v_topic in
    select topic_key, display_name
    from public.team_inbox_topic_catalog
    where is_active
    order by topic_key
  loop
    begin
      perform public.assert_team_inbox_topic_access(
        p_actor_discord_user_id, v_topic.topic_key, false
      );
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'topicKey', v_topic.topic_key,
        'displayName', v_topic.display_name
      ));
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  return jsonb_build_object('topics', v_items);
end;
$function$;

create function public.upsert_team_inbox_case(
  p_topic_key text,
  p_source_key text,
  p_source_version bigint,
  p_subject_discord_user_id text,
  p_subject_username_snapshot text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case public.team_inbox_cases%rowtype;
begin
  if p_source_version <= 0
    or char_length(p_source_key) not between 8 and 240
    or p_subject_discord_user_id !~ '^[0-9]{1,100}$'
    or char_length(btrim(p_subject_username_snapshot)) not between 1 and 160
    or not exists (
      select 1 from public.team_inbox_topic_catalog
      where topic_key = p_topic_key and is_active
    )
  then
    raise exception using errcode = '22023', message = 'TEAM_INBOX_SOURCE_INPUT_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'team-inbox-source:' || p_topic_key || ':' || p_source_key, 0
  ));
  select * into v_case from public.team_inbox_cases
  where topic_key = p_topic_key and source_key = p_source_key
  for update;
  if not found then
    insert into public.team_inbox_cases (
      topic_key, source_key, source_version,
      subject_discord_user_id, subject_username_snapshot
    ) values (
      p_topic_key, p_source_key, p_source_version,
      p_subject_discord_user_id, btrim(p_subject_username_snapshot)
    ) returning * into v_case;
    insert into public.team_inbox_timeline_events (
      case_id, event_type, work_version, row_version, source_version
    ) values (
      v_case.id, 'created', v_case.work_version, v_case.row_version, p_source_version
    );
    return jsonb_build_object('outcome', 'created', 'caseId', v_case.id);
  end if;
  if p_source_version <= v_case.source_version then
    return jsonb_build_object('outcome', 'replayed', 'caseId', v_case.id);
  end if;
  if v_case.status = 'solved' then
    update public.team_inbox_cases
    set source_version = p_source_version,
        subject_username_snapshot = btrim(p_subject_username_snapshot),
        status = 'open', assignee_discord_user_id = null,
        assignee_display_snapshot = null, claimed_at = null, solved_at = null,
        work_version = work_version + 1, row_version = row_version + 1,
        updated_at = transaction_timestamp()
    where id = v_case.id returning * into v_case;
    insert into public.team_inbox_timeline_events (
      case_id, event_type, work_version, row_version, source_version
    ) values (
      v_case.id, 'reopened', v_case.work_version, v_case.row_version, p_source_version
    );
    return jsonb_build_object('outcome', 'reopened', 'caseId', v_case.id);
  end if;
  update public.team_inbox_cases
  set source_version = p_source_version,
      subject_username_snapshot = btrim(p_subject_username_snapshot),
      row_version = row_version + 1,
      updated_at = transaction_timestamp()
  where id = v_case.id returning * into v_case;
  insert into public.team_inbox_timeline_events (
    case_id, event_type, work_version, row_version, source_version,
    outcome_code
  ) values (
    v_case.id, 'topic_action', v_case.work_version, v_case.row_version,
    p_source_version, 'source_updated'
  );
  return jsonb_build_object('outcome', 'updated', 'caseId', v_case.id);
end;
$function$;

create function public.get_team_inbox_overview(p_actor_discord_user_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_topics jsonb;
  v_topic record;
  v_items jsonb := '[]'::jsonb;
begin
  v_topics := public.get_authorized_team_inbox_topics(p_actor_discord_user_id);
  for v_topic in
    select value ->> 'topicKey' as topic_key, value ->> 'displayName' as display_name
    from jsonb_array_elements(v_topics -> 'topics')
  loop
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'topicKey', v_topic.topic_key,
      'displayName', v_topic.display_name,
      'newCount', (
        select count(*) from public.team_inbox_cases case_row
        left join public.team_inbox_attention_receipts receipt
          on receipt.case_id = case_row.id
         and receipt.viewer_discord_user_id = p_actor_discord_user_id
        where case_row.topic_key = v_topic.topic_key
          and case_row.status = 'open'
          and case_row.assignee_discord_user_id is null
          and coalesce(receipt.last_seen_attention_version, 0) < case_row.work_version
      ),
      'openCount', (
        select count(*) from public.team_inbox_cases
        where topic_key = v_topic.topic_key and status = 'open'
      ),
      'inProgressCount', (
        select count(*) from public.team_inbox_cases
        where topic_key = v_topic.topic_key and status = 'in_progress'
      )
    ));
  end loop;
  return jsonb_build_object('topics', v_items);
end;
$function$;

create function public.get_team_inbox_cases(
  p_actor_discord_user_id text,
  p_topic_key text,
  p_filter text default 'new',
  p_username text default null,
  p_before_updated_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_items jsonb;
begin
  perform public.assert_team_inbox_topic_access(
    p_actor_discord_user_id, p_topic_key, false
  );
  if p_filter not in ('new', 'open', 'claimed_by_me', 'in_progress', 'solved', 'all')
    or p_limit not between 1 and 50
    or ((p_before_updated_at is null) <> (p_before_id is null))
    or (p_username is not null and char_length(btrim(p_username)) not between 1 and 80)
  then
    raise exception using errcode = '22023', message = 'TEAM_INBOX_LIST_INPUT_INVALID';
  end if;
  select coalesce(jsonb_agg(item.payload order by item.updated_at desc, item.id desc), '[]'::jsonb)
  into v_items
  from (
    select case_row.updated_at, case_row.id,
      jsonb_build_object(
        'id', case_row.id,
        'topicKey', case_row.topic_key,
        'username', case_row.subject_username_snapshot,
        'status', case_row.status,
        'isNew', case_row.status = 'open'
          and case_row.assignee_discord_user_id is null
          and coalesce(receipt.last_seen_attention_version, 0) < case_row.work_version,
        'assignedToMe', case_row.assignee_discord_user_id = p_actor_discord_user_id,
        'assigneeDisplayName', case_row.assignee_display_snapshot,
        'workVersion', case_row.work_version,
        'rowVersion', case_row.row_version,
        'createdAt', case_row.created_at,
        'updatedAt', case_row.updated_at
      ) as payload
    from public.team_inbox_cases case_row
    left join public.team_inbox_attention_receipts receipt
      on receipt.case_id = case_row.id
     and receipt.viewer_discord_user_id = p_actor_discord_user_id
    where case_row.topic_key = p_topic_key
      and (p_username is null
        or case_row.subject_username_snapshot ilike '%' || btrim(p_username) || '%')
      and (p_before_updated_at is null
        or (case_row.updated_at, case_row.id) < (p_before_updated_at, p_before_id))
      and case p_filter
        when 'new' then case_row.status = 'open'
          and case_row.assignee_discord_user_id is null
          and coalesce(receipt.last_seen_attention_version, 0) < case_row.work_version
        when 'open' then case_row.status = 'open'
        when 'claimed_by_me' then case_row.status = 'in_progress'
          and case_row.assignee_discord_user_id = p_actor_discord_user_id
        when 'in_progress' then case_row.status = 'in_progress'
        when 'solved' then case_row.status = 'solved'
        else true
      end
    order by case_row.updated_at desc, case_row.id desc
    limit p_limit + 1
  ) item;
  return jsonb_build_object('items', v_items);
end;
$function$;

create function public.get_team_inbox_case_detail(
  p_actor_discord_user_id text,
  p_case_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case public.team_inbox_cases%rowtype;
  v_timeline jsonb;
begin
  select * into v_case from public.team_inbox_cases where id = p_case_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  perform public.assert_team_inbox_topic_access(
    p_actor_discord_user_id, v_case.topic_key, false
  );
  insert into public.team_inbox_attention_receipts (
    case_id, viewer_discord_user_id, last_seen_attention_version
  ) values (v_case.id, p_actor_discord_user_id, v_case.work_version)
  on conflict (case_id, viewer_discord_user_id) do update
  set last_seen_attention_version = greatest(
        public.team_inbox_attention_receipts.last_seen_attention_version,
        excluded.last_seen_attention_version
      ),
      last_seen_at = transaction_timestamp();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', timeline.id,
    'eventType', timeline.event_type,
    'workVersion', timeline.work_version,
    'rowVersion', timeline.row_version,
    'actorDisplayName', timeline.actor_display_snapshot,
    'actorRole', timeline.actor_role_snapshot,
    'outcomeCode', timeline.outcome_code,
    'note', timeline.bounded_note,
    'createdAt', timeline.created_at
  ) order by timeline.id desc), '[]'::jsonb)
  into v_timeline
  from public.team_inbox_timeline_events timeline
  where timeline.case_id = v_case.id;
  return jsonb_build_object(
    'outcome', 'found',
    'case', jsonb_build_object(
      'id', v_case.id,
      'topicKey', v_case.topic_key,
      'username', v_case.subject_username_snapshot,
      'status', v_case.status,
      'assignedToMe', v_case.assignee_discord_user_id = p_actor_discord_user_id,
      'assigneeDisplayName', v_case.assignee_display_snapshot,
      'workVersion', v_case.work_version,
      'rowVersion', v_case.row_version,
      'createdAt', v_case.created_at,
      'updatedAt', v_case.updated_at
    ),
    'timeline', v_timeline
  );
end;
$function$;

create function public.search_team_inbox_by_exact_discord_id(
  p_actor_discord_user_id text,
  p_topic_key text,
  p_exact_discord_user_id text,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_items jsonb;
begin
  perform public.assert_team_inbox_topic_access(
    p_actor_discord_user_id, p_topic_key, false
  );
  if p_exact_discord_user_id !~ '^[0-9]{1,100}$'
    or p_limit not between 1 and 50
  then
    raise exception using errcode = '22023', message = 'TEAM_INBOX_EXACT_SEARCH_INVALID';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', case_row.id,
    'topicKey', case_row.topic_key,
    'username', case_row.subject_username_snapshot,
    'status', case_row.status,
    'assignedToMe', case_row.assignee_discord_user_id = p_actor_discord_user_id,
    'assigneeDisplayName', case_row.assignee_display_snapshot,
    'workVersion', case_row.work_version,
    'rowVersion', case_row.row_version,
    'updatedAt', case_row.updated_at
  ) order by case_row.updated_at desc, case_row.id desc), '[]'::jsonb)
  into v_items
  from (
    select * from public.team_inbox_cases
    where topic_key = p_topic_key
      and subject_discord_user_id = p_exact_discord_user_id
    order by updated_at desc, id desc
    limit p_limit
  ) case_row;
  return jsonb_build_object('items', v_items);
end;
$function$;

create function public.mutate_team_inbox_case(
  p_actor_discord_user_id text,
  p_case_id uuid,
  p_idempotency_key uuid,
  p_action text,
  p_expected_state text,
  p_expected_row_version bigint,
  p_expected_work_version bigint,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case public.team_inbox_cases%rowtype;
  v_role text;
  v_actor_display text;
  v_note text := nullif(btrim(p_note), '');
  v_request_hash text;
  v_existing public.team_inbox_mutation_requests%rowtype;
  v_result jsonb;
begin
  if p_idempotency_key is null
    or p_action not in ('claim', 'return', 'force_release')
    or p_expected_state not in ('open', 'in_progress', 'solved')
    or p_expected_row_version <= 0
    or p_expected_work_version <= 0
    or (v_note is not null and char_length(v_note) not between 3 and 1000)
    or (p_action = 'force_release' and v_note is null)
  then
    raise exception using errcode = '22023', message = 'TEAM_INBOX_MUTATION_INPUT_INVALID';
  end if;
  v_request_hash := encode(extensions.digest(
    concat_ws('|', p_actor_discord_user_id, p_case_id::text, p_action,
      p_expected_state, p_expected_row_version::text,
      p_expected_work_version::text, coalesce(v_note, '')),
    'sha256'
  ), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    'team-inbox-request:' || p_idempotency_key::text, 0
  ));
  select * into v_existing from public.team_inbox_mutation_requests
  where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.actor_discord_user_id <> p_actor_discord_user_id
      or v_existing.action <> p_action
      or v_existing.request_hash <> v_request_hash
    then
      raise exception using errcode = '22023', message = 'TEAM_INBOX_IDEMPOTENCY_MISMATCH';
    end if;
    return v_existing.result;
  end if;

  select * into v_case from public.team_inbox_cases where id = p_case_id for update;
  if not found then
    v_result := jsonb_build_object('outcome', 'not_found');
  else
    v_role := public.assert_team_inbox_topic_access(
      p_actor_discord_user_id, v_case.topic_key, true
    );
    select coalesce(nullif(btrim(current_discord_username), ''), 'Team member')
    into v_actor_display
    from public.user_logs where discord_user_id = p_actor_discord_user_id;
    if v_actor_display is null then
      v_actor_display := 'Team member';
    end if;

    if v_case.status <> p_expected_state
      or v_case.row_version <> p_expected_row_version
      or v_case.work_version <> p_expected_work_version
    then
      v_result := jsonb_build_object(
        'outcome', 'stale',
        'status', v_case.status,
        'rowVersion', v_case.row_version,
        'workVersion', v_case.work_version
      );
    elsif p_action = 'claim' then
      if v_case.status <> 'open' or v_case.assignee_discord_user_id is not null then
        v_result := jsonb_build_object('outcome', 'unavailable');
      else
        update public.team_inbox_cases
        set status = 'in_progress',
            assignee_discord_user_id = p_actor_discord_user_id,
            assignee_display_snapshot = v_actor_display,
            claimed_at = transaction_timestamp(),
            row_version = row_version + 1,
            updated_at = transaction_timestamp()
        where id = v_case.id returning * into v_case;
        insert into public.team_inbox_timeline_events (
          case_id, event_type, work_version, row_version,
          actor_discord_user_id, actor_display_snapshot, actor_role_snapshot,
          capability_context
        ) values (
          v_case.id, 'claimed', v_case.work_version, v_case.row_version,
          p_actor_discord_user_id, v_actor_display, v_role,
          jsonb_build_object('topicKey', v_case.topic_key, 'access', 'action')
        );
        v_result := jsonb_build_object(
          'outcome', 'claimed', 'status', v_case.status,
          'rowVersion', v_case.row_version, 'workVersion', v_case.work_version
        );
      end if;
    elsif p_action = 'return' then
      if v_case.status <> 'in_progress'
        or v_case.assignee_discord_user_id <> p_actor_discord_user_id
      then
        raise exception using errcode = '42501', message = 'TEAM_INBOX_ASSIGNEE_REQUIRED';
      end if;
      update public.team_inbox_cases
      set status = 'open', assignee_discord_user_id = null,
          assignee_display_snapshot = null, claimed_at = null,
          work_version = work_version + 1, row_version = row_version + 1,
          updated_at = transaction_timestamp()
      where id = v_case.id returning * into v_case;
      insert into public.team_inbox_timeline_events (
        case_id, event_type, work_version, row_version,
        actor_discord_user_id, actor_display_snapshot, actor_role_snapshot,
        capability_context, bounded_note
      ) values (
        v_case.id, 'returned', v_case.work_version, v_case.row_version,
        p_actor_discord_user_id, v_actor_display, v_role,
        jsonb_build_object('topicKey', v_case.topic_key, 'access', 'action'), v_note
      );
      v_result := jsonb_build_object(
        'outcome', 'returned', 'status', v_case.status,
        'rowVersion', v_case.row_version, 'workVersion', v_case.work_version
      );
    else
      if v_role <> 'admin' then
        raise exception using errcode = '42501', message = 'TEAM_INBOX_ADMIN_REQUIRED';
      end if;
      if v_case.status <> 'in_progress' then
        v_result := jsonb_build_object('outcome', 'unavailable');
      else
        update public.team_inbox_cases
        set status = 'open', assignee_discord_user_id = null,
            assignee_display_snapshot = null, claimed_at = null,
            work_version = work_version + 1, row_version = row_version + 1,
            updated_at = transaction_timestamp()
        where id = v_case.id returning * into v_case;
        insert into public.team_inbox_timeline_events (
          case_id, event_type, work_version, row_version,
          actor_discord_user_id, actor_display_snapshot, actor_role_snapshot,
          capability_context, bounded_note
        ) values (
          v_case.id, 'admin_forced_release', v_case.work_version, v_case.row_version,
          p_actor_discord_user_id, v_actor_display, v_role,
          jsonb_build_object('topicKey', v_case.topic_key, 'access', 'owner'), v_note
        );
        v_result := jsonb_build_object(
          'outcome', 'force_released', 'status', v_case.status,
          'rowVersion', v_case.row_version, 'workVersion', v_case.work_version
        );
      end if;
    end if;
  end if;
  insert into public.team_inbox_mutation_requests (
    idempotency_key, actor_discord_user_id, action, request_hash, result
  ) values (
    p_idempotency_key, p_actor_discord_user_id, p_action, v_request_hash, v_result
  );
  return v_result;
end;
$function$;

create function public.record_team_inbox_topic_action(
  p_actor_discord_user_id text,
  p_case_id uuid,
  p_expected_row_version bigint,
  p_expected_source_version bigint,
  p_outcome_code text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case public.team_inbox_cases%rowtype;
  v_role text;
  v_actor_display text;
begin
  if p_outcome_code !~ '^[a-z0-9_:-]{2,80}$'
    or (p_note is not null and char_length(btrim(p_note)) not between 3 and 1000)
  then
    raise exception using errcode = '22023', message = 'TEAM_INBOX_ACTION_INPUT_INVALID';
  end if;
  select * into v_case from public.team_inbox_cases where id = p_case_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  v_role := public.assert_team_inbox_topic_access(
    p_actor_discord_user_id, v_case.topic_key, true
  );
  if v_case.status <> 'in_progress'
    or v_case.assignee_discord_user_id <> p_actor_discord_user_id
  then
    raise exception using errcode = '42501', message = 'TEAM_INBOX_ASSIGNEE_REQUIRED';
  end if;
  if v_case.row_version <> p_expected_row_version
    or v_case.source_version <> p_expected_source_version
  then
    return jsonb_build_object('outcome', 'stale');
  end if;
  select coalesce(nullif(btrim(current_discord_username), ''), 'Team member')
  into v_actor_display from public.user_logs
  where discord_user_id = p_actor_discord_user_id;
  update public.team_inbox_cases
  set row_version = row_version + 1, updated_at = transaction_timestamp()
  where id = v_case.id returning * into v_case;
  insert into public.team_inbox_timeline_events (
    case_id, event_type, work_version, row_version,
    actor_discord_user_id, actor_display_snapshot, actor_role_snapshot,
    capability_context, source_version, outcome_code, bounded_note
  ) values (
    v_case.id, 'topic_action', v_case.work_version, v_case.row_version,
    p_actor_discord_user_id, coalesce(v_actor_display, 'Team member'), v_role,
    jsonb_build_object('topicKey', v_case.topic_key, 'access', 'action'),
    v_case.source_version, p_outcome_code, nullif(btrim(p_note), '')
  );
  return jsonb_build_object(
    'outcome', 'recorded', 'rowVersion', v_case.row_version,
    'workVersion', v_case.work_version
  );
end;
$function$;

create function public.solve_team_inbox_case(
  p_actor_discord_user_id text,
  p_case_id uuid,
  p_expected_row_version bigint,
  p_expected_source_version bigint,
  p_outcome_code text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case public.team_inbox_cases%rowtype;
  v_role text;
  v_actor_display text;
begin
  if p_outcome_code !~ '^[a-z0-9_:-]{2,80}$'
    or (p_note is not null and char_length(btrim(p_note)) not between 3 and 1000)
  then
    raise exception using errcode = '22023', message = 'TEAM_INBOX_SOLVE_INPUT_INVALID';
  end if;
  select * into v_case from public.team_inbox_cases where id = p_case_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  v_role := public.assert_team_inbox_topic_access(
    p_actor_discord_user_id, v_case.topic_key, true
  );
  if v_case.status <> 'in_progress'
    or v_case.assignee_discord_user_id <> p_actor_discord_user_id
  then
    raise exception using errcode = '42501', message = 'TEAM_INBOX_ASSIGNEE_REQUIRED';
  end if;
  if v_case.row_version <> p_expected_row_version
    or v_case.source_version <> p_expected_source_version
  then
    return jsonb_build_object('outcome', 'stale');
  end if;
  select coalesce(nullif(btrim(current_discord_username), ''), 'Team member')
  into v_actor_display from public.user_logs
  where discord_user_id = p_actor_discord_user_id;
  update public.team_inbox_cases
  set status = 'solved', solved_at = transaction_timestamp(),
      row_version = row_version + 1, updated_at = transaction_timestamp()
  where id = v_case.id returning * into v_case;
  insert into public.team_inbox_timeline_events (
    case_id, event_type, work_version, row_version,
    actor_discord_user_id, actor_display_snapshot, actor_role_snapshot,
    capability_context, source_version, outcome_code, bounded_note
  ) values (
    v_case.id, 'solved', v_case.work_version, v_case.row_version,
    p_actor_discord_user_id, coalesce(v_actor_display, 'Team member'), v_role,
    jsonb_build_object('topicKey', v_case.topic_key, 'access', 'action'),
    v_case.source_version, p_outcome_code, nullif(btrim(p_note), '')
  );
  return jsonb_build_object(
    'outcome', 'solved', 'status', v_case.status,
    'rowVersion', v_case.row_version, 'workVersion', v_case.work_version
  );
end;
$function$;

create trigger team_inbox_mutation_requests_immutable
before update or delete on public.team_inbox_mutation_requests
for each row execute function public.protect_team_inbox_timeline_event();

alter table public.notification_category_catalog owner to postgres;
alter table public.notification_events owner to postgres;
alter table public.account_notification_preferences owner to postgres;
alter table public.account_notifications owner to postgres;
alter table public.push_subscriptions owner to postgres;
alter table public.push_subscription_preferences owner to postgres;
alter table public.push_delivery_jobs owner to postgres;
alter table public.notification_broadcast_jobs owner to postgres;
alter table public.team_inbox_topic_catalog owner to postgres;
alter table public.team_inbox_cases owner to postgres;
alter table public.team_inbox_attention_receipts owner to postgres;
alter table public.team_inbox_timeline_events owner to postgres;
alter table public.team_inbox_mutation_requests owner to postgres;

alter table public.notification_category_catalog enable row level security;
alter table public.notification_events enable row level security;
alter table public.account_notification_preferences enable row level security;
alter table public.account_notifications enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_subscription_preferences enable row level security;
alter table public.push_delivery_jobs enable row level security;
alter table public.notification_broadcast_jobs enable row level security;
alter table public.team_inbox_topic_catalog enable row level security;
alter table public.team_inbox_cases enable row level security;
alter table public.team_inbox_attention_receipts enable row level security;
alter table public.team_inbox_timeline_events enable row level security;
alter table public.team_inbox_mutation_requests enable row level security;

revoke all on table public.notification_category_catalog from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.notification_events from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.account_notification_preferences from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.account_notifications from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.push_subscriptions from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.push_subscription_preferences from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.push_delivery_jobs from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.notification_broadcast_jobs from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.team_inbox_topic_catalog from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.team_inbox_cases from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.team_inbox_attention_receipts from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.team_inbox_timeline_events from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.team_inbox_mutation_requests from public, anon, authenticated, discord_bot, service_role;
revoke all on sequence public.push_delivery_jobs_id_seq from public, anon, authenticated, discord_bot, service_role;
revoke all on sequence public.team_inbox_timeline_events_id_seq from public, anon, authenticated, discord_bot, service_role;

alter function public.protect_notification_immutable_row() owner to postgres;
alter function public.protect_team_inbox_timeline_event() owner to postgres;
alter function public.enqueue_account_notification_event(text,text,text,text,text,boolean) owner to postgres;
alter function public.produce_winner_claim_notification() owner to postgres;
alter function public.produce_submission_moderation_notification() owner to postgres;
alter function public.produce_cycle_results_notification() owner to postgres;
alter function public.get_own_notification_unread_count(uuid) owner to postgres;
alter function public.get_own_notifications(uuid,timestamptz,uuid,integer) owner to postgres;
alter function public.mark_own_notification_read(uuid,uuid) owner to postgres;
alter function public.get_own_notification_destination(uuid,uuid) owner to postgres;
alter function public.get_own_notification_settings(uuid) owner to postgres;
alter function public.set_own_notification_preference(uuid,text,boolean) owner to postgres;
alter function public.upsert_own_push_subscription(uuid,uuid,text,text,text,text,integer) owner to postgres;
alter function public.get_own_push_subscription_settings(uuid,uuid) owner to postgres;
alter function public.set_own_push_subscription_preference(uuid,uuid,text,boolean) owner to postgres;
alter function public.deactivate_own_push_subscription(uuid,uuid) owner to postgres;
alter function public.process_notification_broadcast_batch(integer) owner to postgres;
alter function public.claim_due_push_deliveries(uuid,integer) owner to postgres;
alter function public.complete_push_delivery(bigint,uuid) owner to postgres;
alter function public.fail_push_delivery(bigint,uuid,text,boolean,boolean) owner to postgres;
alter function public.assert_team_inbox_topic_access(text,text,boolean) owner to postgres;
alter function public.get_authorized_team_inbox_topics(text) owner to postgres;
alter function public.upsert_team_inbox_case(text,text,bigint,text,text) owner to postgres;
alter function public.get_team_inbox_overview(text) owner to postgres;
alter function public.get_team_inbox_cases(text,text,text,text,timestamptz,uuid,integer) owner to postgres;
alter function public.get_team_inbox_case_detail(text,uuid) owner to postgres;
alter function public.search_team_inbox_by_exact_discord_id(text,text,text,integer) owner to postgres;
alter function public.mutate_team_inbox_case(text,uuid,uuid,text,text,bigint,bigint,text) owner to postgres;
alter function public.record_team_inbox_topic_action(text,uuid,bigint,bigint,text,text) owner to postgres;
alter function public.solve_team_inbox_case(text,uuid,bigint,bigint,text,text) owner to postgres;

revoke all on function public.protect_notification_immutable_row() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.protect_team_inbox_timeline_event() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.enqueue_account_notification_event(text,text,text,text,text,boolean) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.produce_winner_claim_notification() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.produce_submission_moderation_notification() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.produce_cycle_results_notification() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_notification_unread_count(uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_notifications(uuid,timestamptz,uuid,integer) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.mark_own_notification_read(uuid,uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_notification_destination(uuid,uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_notification_settings(uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.set_own_notification_preference(uuid,text,boolean) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.upsert_own_push_subscription(uuid,uuid,text,text,text,text,integer) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_own_push_subscription_settings(uuid,uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.set_own_push_subscription_preference(uuid,uuid,text,boolean) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.deactivate_own_push_subscription(uuid,uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.process_notification_broadcast_batch(integer) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.claim_due_push_deliveries(uuid,integer) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.complete_push_delivery(bigint,uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.fail_push_delivery(bigint,uuid,text,boolean,boolean) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.assert_team_inbox_topic_access(text,text,boolean) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_authorized_team_inbox_topics(text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.upsert_team_inbox_case(text,text,bigint,text,text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_team_inbox_overview(text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_team_inbox_cases(text,text,text,text,timestamptz,uuid,integer) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_team_inbox_case_detail(text,uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.search_team_inbox_by_exact_discord_id(text,text,text,integer) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.mutate_team_inbox_case(text,uuid,uuid,text,text,bigint,bigint,text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.record_team_inbox_topic_action(text,uuid,bigint,bigint,text,text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.solve_team_inbox_case(text,uuid,bigint,bigint,text,text) from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_own_notification_unread_count(uuid) to service_role;
grant execute on function public.get_own_notifications(uuid,timestamptz,uuid,integer) to service_role;
grant execute on function public.mark_own_notification_read(uuid,uuid) to service_role;
grant execute on function public.get_own_notification_destination(uuid,uuid) to service_role;
grant execute on function public.get_own_notification_settings(uuid) to service_role;
grant execute on function public.set_own_notification_preference(uuid,text,boolean) to service_role;
grant execute on function public.upsert_own_push_subscription(uuid,uuid,text,text,text,text,integer) to service_role;
grant execute on function public.get_own_push_subscription_settings(uuid,uuid) to service_role;
grant execute on function public.set_own_push_subscription_preference(uuid,uuid,text,boolean) to service_role;
grant execute on function public.deactivate_own_push_subscription(uuid,uuid) to service_role;
grant execute on function public.process_notification_broadcast_batch(integer) to service_role;
grant execute on function public.claim_due_push_deliveries(uuid,integer) to service_role;
grant execute on function public.complete_push_delivery(bigint,uuid) to service_role;
grant execute on function public.fail_push_delivery(bigint,uuid,text,boolean,boolean) to service_role;
grant execute on function public.get_authorized_team_inbox_topics(text) to service_role;
grant execute on function public.upsert_team_inbox_case(text,text,bigint,text,text) to service_role;
grant execute on function public.get_team_inbox_overview(text) to service_role;
grant execute on function public.get_team_inbox_cases(text,text,text,text,timestamptz,uuid,integer) to service_role;
grant execute on function public.get_team_inbox_case_detail(text,uuid) to service_role;
grant execute on function public.search_team_inbox_by_exact_discord_id(text,text,text,integer) to service_role;
grant execute on function public.mutate_team_inbox_case(text,uuid,uuid,text,text,bigint,bigint,text) to service_role;
grant execute on function public.record_team_inbox_topic_action(text,uuid,bigint,bigint,text,text) to service_role;
grant execute on function public.solve_team_inbox_case(text,uuid,bigint,bigint,text,text) to service_role;

do $postflight$
declare
  v_expected_functions text[] := array[
    'protect_notification_immutable_row', 'protect_team_inbox_timeline_event',
    'enqueue_account_notification_event', 'produce_winner_claim_notification',
    'produce_submission_moderation_notification', 'produce_cycle_results_notification',
    'get_own_notification_unread_count', 'get_own_notifications',
    'mark_own_notification_read', 'get_own_notification_destination',
    'get_own_notification_settings', 'set_own_notification_preference',
    'upsert_own_push_subscription', 'get_own_push_subscription_settings',
    'set_own_push_subscription_preference', 'deactivate_own_push_subscription',
    'process_notification_broadcast_batch', 'claim_due_push_deliveries',
    'complete_push_delivery', 'fail_push_delivery',
    'assert_team_inbox_topic_access', 'get_authorized_team_inbox_topics',
    'upsert_team_inbox_case', 'get_team_inbox_overview', 'get_team_inbox_cases',
    'get_team_inbox_case_detail', 'search_team_inbox_by_exact_discord_id',
    'mutate_team_inbox_case', 'record_team_inbox_topic_action',
    'solve_team_inbox_case'
  ]::text[];
  v_name text;
begin
  foreach v_name in array v_expected_functions loop
    if (select count(*) from pg_proc function_row
        join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
        where namespace_row.nspname = 'public' and function_row.proname = v_name) <> 1
      or exists (
        select 1 from pg_proc function_row
        join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
        where namespace_row.nspname = 'public' and function_row.proname = v_name
          and (not function_row.prosecdef
            or pg_get_userbyid(function_row.proowner) <> 'postgres'
            or function_row.proconfig is distinct from array['search_path=public, pg_temp']::text[])
      )
    then
      raise exception using errcode = '55000', message = 'NOTIFICATION_FUNCTION_HARDENING_MISMATCH:' || v_name;
    end if;
  end loop;
  if exists (
    select 1 from pg_class relation
    join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
    where namespace_row.nspname = 'public'
      and relation.relname = any(array[
        'notification_category_catalog', 'notification_events',
        'account_notification_preferences', 'account_notifications',
        'push_subscriptions', 'push_subscription_preferences',
        'push_delivery_jobs', 'notification_broadcast_jobs',
        'team_inbox_topic_catalog', 'team_inbox_cases',
        'team_inbox_attention_receipts', 'team_inbox_timeline_events',
        'team_inbox_mutation_requests'
      ]::text[])
      and (not relation.relrowsecurity or pg_get_userbyid(relation.relowner) <> 'postgres')
  )
    or (select count(*) from public.capability_catalog) <> 39
    or (select count(*) from public.capability_catalog where is_active) <> 35
    or not exists (
      select 1 from public.team_inbox_topic_catalog
      where topic_key = 'wallet_issues' and not is_active and activated_at is null
    )
  then
    raise exception using errcode = '55000', message = 'NOTIFICATION_FOUNDATION_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;

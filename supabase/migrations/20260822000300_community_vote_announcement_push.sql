begin;

do $baseline$
begin
  if to_regclass('public.community_poll_announcements') is not null
    or to_regprocedure('public.announce_community_poll(text,uuid,uuid,bigint)') is not null
    or to_regprocedure('public.get_current_community_poll_announcement(text)') is not null
    or not exists (
      select 1 from public.capability_catalog
      where key = 'community.polls.manage' and is_active
    )
    or not exists (
      select 1 from public.notification_category_catalog
      where category_key = 'cycles_voting' and push_available
    )
  then
    raise exception using errcode = '55000',
      message = 'COMMUNITY_VOTE_ANNOUNCEMENT_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

insert into public.notification_category_catalog(
  category_key, display_name, required_in_product, is_active,
  description, default_in_product_enabled, in_product_available, push_available
) values (
  'community_votes', 'Community Votes', false, true,
  'Get a Push when the Team explicitly announces an active Community Vote.',
  false, false, true
);

insert into public.push_subscription_preferences(subscription_id, category_key, enabled)
select subscription.id, 'community_votes', false
from public.push_subscriptions subscription
on conflict (subscription_id, category_key) do nothing;

create table public.community_poll_announcements (
  poll_id uuid primary key references public.community_polls(id),
  announced_by_discord_user_id text not null
    check (announced_by_discord_user_id ~ '^[0-9]+$'
      and char_length(announced_by_discord_user_id) <= 100),
  request_id uuid not null unique,
  announced_at timestamptz not null default transaction_timestamp()
);

alter table public.community_poll_announcements enable row level security;
alter table public.community_poll_announcements owner to postgres;
revoke all on table public.community_poll_announcements
  from public, anon, authenticated, discord_bot, service_role;

create trigger community_poll_announcements_no_update
before update or delete on public.community_poll_announcements
for each row execute function public.protect_community_poll_append_only();

alter table public.community_poll_admin_events
  drop constraint community_poll_admin_events_event_type_check;
alter table public.community_poll_admin_events
  add constraint community_poll_admin_events_event_type_check check (event_type in (
    'created', 'activated', 'announced', 'closed', 'aborted', 'replaced',
    'replacement_created', 'runoff_created'
  ));

alter table public.community_poll_mutation_requests
  drop constraint community_poll_mutation_requests_action_check;
alter table public.community_poll_mutation_requests
  add constraint community_poll_mutation_requests_action_check check (action in (
    'create', 'activate', 'announce', 'close', 'abort', 'replace'
  ));

alter table public.notification_events
  drop constraint notification_event_type_check,
  drop constraint notification_event_category_check,
  drop constraint notification_event_audience_check;

alter table public.notification_events
  add constraint notification_event_type_check check (event_type in (
    'winner_claim_required', 'winner_correction_ready', 'winner_donation_finalized',
    'winner_payout_sent', 'donation_recipient_change_required',
    'submission_disqualified', 'submission_reinstated',
    'cycle_started', 'cycle_submission_ending_15m', 'cycle_submission_ending_10m',
    'cycle_submission_ending_5m', 'cycle_submission_ended',
    'cycle_voting_ending_15m', 'cycle_voting_ending_10m',
    'cycle_voting_ending_5m', 'cycle_voting_ended', 'cycle_results_ready',
    'community_vote_announced',
    'wallet_issue_received', 'wallet_issue_correction_ready', 'wallet_issue_resolved'
  )),
  add constraint notification_event_category_check check (
    (event_type in (
      'winner_claim_required', 'winner_correction_ready', 'winner_donation_finalized',
      'winner_payout_sent', 'donation_recipient_change_required'
    ) and category_key = 'winners_claims')
    or (event_type in ('submission_disqualified', 'submission_reinstated')
      and category_key = 'submission_moderation')
    or (event_type in (
      'cycle_started', 'cycle_submission_ending_15m', 'cycle_submission_ending_10m',
      'cycle_submission_ending_5m', 'cycle_submission_ended',
      'cycle_voting_ending_15m', 'cycle_voting_ending_10m',
      'cycle_voting_ending_5m', 'cycle_voting_ended', 'cycle_results_ready'
    ) and category_key = 'cycles_voting')
    or (event_type = 'community_vote_announced' and category_key = 'community_votes')
    or (event_type in (
      'wallet_issue_received', 'wallet_issue_correction_ready', 'wallet_issue_resolved'
    ) and category_key = 'wallet_issues')
  ),
  add constraint notification_event_audience_check check (
    (audience_type = 'account'
      and owner_discord_user_id is not null
      and char_length(owner_discord_user_id) between 1 and 100
      and public_cycle_number is null)
    or (audience_type = 'broadcast'
      and owner_discord_user_id is null
      and (
        (event_type = 'community_vote_announced' and public_cycle_number is null)
        or (event_type <> 'community_vote_announced' and public_cycle_number > 0)
      ))
  );

create function public.announce_community_poll(
  p_actor_discord_user_id text,
  p_poll_public_id uuid,
  p_request_id uuid,
  p_expected_poll_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_role text := public.assert_community_poll_capability(p_actor_discord_user_id);
  v_hash text;
  v_existing public.community_poll_mutation_requests%rowtype;
  v_poll public.community_polls%rowtype;
  v_event_id uuid;
  v_response jsonb;
begin
  if p_request_id is null or p_poll_public_id is null
    or p_expected_poll_version is null or p_expected_poll_version <= 0
  then
    raise exception using errcode = '22023', message = 'COMMUNITY_POLL_REQUEST_INVALID';
  end if;
  v_hash := encode(extensions.digest(convert_to(
    concat_ws('|', p_poll_public_id, p_expected_poll_version), 'UTF8'
  ), 'sha256'), 'hex');
  select * into v_existing from public.community_poll_mutation_requests
  where actor_discord_user_id = btrim(p_actor_discord_user_id)
    and request_id = p_request_id and action = 'announce';
  if found then
    if v_existing.request_hash <> v_hash then
      raise exception using errcode = '22023', message = 'COMMUNITY_POLL_REQUEST_CONFLICT';
    end if;
    return v_existing.response;
  end if;

  select * into v_poll from public.community_polls
  where public_id = p_poll_public_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_poll.row_version <> p_expected_poll_version then
    return jsonb_build_object('outcome', 'stale');
  end if;
  if v_poll.status <> 'active' or v_poll.deadline_at <= transaction_timestamp() then
    return jsonb_build_object('outcome', 'invalid_state');
  end if;
  if exists (select 1 from public.community_poll_announcements where poll_id = v_poll.id) then
    return jsonb_build_object('outcome', 'already_announced');
  end if;

  insert into public.community_poll_announcements(
    poll_id, announced_by_discord_user_id, request_id
  ) values (v_poll.id, btrim(p_actor_discord_user_id), p_request_id);
  insert into public.community_poll_admin_events(
    poll_id, event_type, actor_discord_user_id, actor_role,
    request_id, poll_version, details
  ) values (
    v_poll.id, 'announced', btrim(p_actor_discord_user_id), v_role,
    p_request_id, v_poll.row_version,
    jsonb_build_object('deadlineAt', v_poll.deadline_at)
  );
  insert into public.notification_events(
    producer_key, event_type, category_key, audience_type,
    deep_link, occurred_at
  ) values (
    'community-poll-announcement:' || v_poll.public_id::text,
    'community_vote_announced', 'community_votes', 'broadcast',
    '/community-votes/' || v_poll.public_id::text, transaction_timestamp()
  ) returning id into v_event_id;
  insert into public.notification_broadcast_jobs(event_id) values (v_event_id);

  v_response := jsonb_build_object(
    'outcome', 'announced', 'pollPublicId', v_poll.public_id,
    'rowVersion', v_poll.row_version
  );
  insert into public.community_poll_mutation_requests values (
    btrim(p_actor_discord_user_id), p_request_id, 'announce',
    p_poll_public_id, v_hash, v_response, transaction_timestamp()
  );
  return v_response;
end;
$function$;

create function public.get_current_community_poll_announcement(
  p_viewer_discord_user_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_poll public.community_polls%rowtype;
  v_poll_json jsonb;
begin
  select poll.* into v_poll
  from public.community_poll_announcements announcement
  join public.community_polls poll on poll.id = announcement.poll_id
  where poll.status = 'active'
    and poll.deadline_at > transaction_timestamp()
  order by announcement.announced_at desc
  limit 1;
  if not found then return jsonb_build_object('outcome', 'none'); end if;
  v_poll_json := public.build_community_poll_json(v_poll.id, p_viewer_discord_user_id);
  if coalesce((v_poll_json ->> 'participated')::boolean, false) then
    return jsonb_build_object('outcome', 'none');
  end if;
  return jsonb_build_object(
    'outcome', 'available',
    'pollPublicId', v_poll.public_id,
    'question', v_poll.question,
    'deadlineAt', v_poll.deadline_at
  );
end;
$function$;

create or replace function public.get_community_poll_management(
  p_actor_discord_user_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_role text := public.assert_community_poll_capability(p_actor_discord_user_id);
  v_polls jsonb;
  v_events jsonb;
  v_announcements jsonb;
begin
  select coalesce(jsonb_agg(public.build_community_poll_json(id, p_actor_discord_user_id)
    order by created_at desc, public_id), '[]'::jsonb)
  into v_polls from public.community_polls;
  select coalesce(jsonb_agg(jsonb_build_object(
    'eventId', event.id, 'pollPublicId', poll.public_id,
    'eventType', event.event_type,
    'actorDiscordUserId', event.actor_discord_user_id,
    'actorRole', event.actor_role, 'pollVersion', event.poll_version,
    'details', event.details, 'occurredAt', event.occurred_at
  ) order by event.occurred_at desc, event.id desc), '[]'::jsonb)
  into v_events from public.community_poll_admin_events event
  join public.community_polls poll on poll.id = event.poll_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'pollPublicId', poll.public_id,
    'announcedAt', announcement.announced_at
  ) order by announcement.announced_at desc), '[]'::jsonb)
  into v_announcements from public.community_poll_announcements announcement
  join public.community_polls poll on poll.id = announcement.poll_id;
  return jsonb_build_object(
    'serverNow', transaction_timestamp(), 'actorRole', v_role,
    'polls', v_polls, 'events', v_events, 'announcements', v_announcements
  );
end;
$function$;

alter function public.announce_community_poll(text,uuid,uuid,bigint) owner to postgres;
alter function public.get_current_community_poll_announcement(text) owner to postgres;
alter function public.get_community_poll_management(text) owner to postgres;
revoke all on function public.announce_community_poll(text,uuid,uuid,bigint)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_current_community_poll_announcement(text)
  from public, anon, authenticated, discord_bot, service_role;
grant execute on function public.announce_community_poll(text,uuid,uuid,bigint)
  to service_role;
grant execute on function public.get_current_community_poll_announcement(text)
  to service_role;

comment on table public.community_poll_announcements is
  'One immutable explicit public announcement per active Community poll. Activation alone never creates a Push or Homepage announcement.';

do $postflight$
begin
  if not exists (
      select 1 from public.notification_category_catalog
      where category_key = 'community_votes' and push_available
        and not in_product_available and not default_in_product_enabled
    )
    or position('community_vote_announced' in pg_get_constraintdef(
      (select oid from pg_constraint where conrelid = 'public.notification_events'::regclass
        and conname = 'notification_event_type_check')
    )) = 0
    or not has_function_privilege('service_role',
      'public.announce_community_poll(text,uuid,uuid,bigint)', 'EXECUTE')
    or has_function_privilege('authenticated',
      'public.announce_community_poll(text,uuid,uuid,bigint)', 'EXECUTE')
    or not has_function_privilege('service_role',
      'public.get_current_community_poll_announcement(text)', 'EXECUTE')
  then
    raise exception using errcode = '55000',
      message = 'COMMUNITY_VOTE_ANNOUNCEMENT_POSTFLIGHT_FAILED';
  end if;
end;
$postflight$;

commit;

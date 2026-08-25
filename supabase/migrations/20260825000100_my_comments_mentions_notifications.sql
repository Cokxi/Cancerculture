begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if public.get_community_comment_release_state() <> 'off'
    or (select count(*) from public.capability_catalog) <> 49
    or (select count(*) from public.capability_catalog where is_active) <> 45
    or to_regclass('public.community_comments') is null
    or to_regclass('public.community_comment_mention_lifecycle') is null
    or to_regclass('public.notification_category_catalog') is null
    or to_regclass('public.notification_events') is null
    or to_regclass('public.account_notifications') is null
    or to_regclass('public.push_delivery_jobs') is null
    or to_regprocedure('public.enqueue_account_notification_event(text,text,text,text,text,boolean)') is null
    or to_regprocedure('public.resolve_account_notification_visibility(text,text)') is null
    or to_regprocedure('public.get_own_notifications(uuid,timestamp with time zone,uuid,integer)') is null
    or to_regclass('public.community_comment_mention_owner_states') is not null
    or to_regclass('public.community_comment_owner_mutation_requests') is not null
    or exists (
      select 1 from public.notification_category_catalog
      where category_key in ('comment_replies', 'comment_mentions')
    )
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'community_comments'
        and column_name = 'team_removed_at'
    )
  then
    raise exception using errcode = '55000',
      message = 'MY_COMMENTS_MENTIONS_NOTIFICATION_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

insert into public.notification_category_catalog (
  category_key, display_name, required_in_product, is_active,
  description, default_in_product_enabled, in_product_available, push_available
) values
  (
    'comment_replies', 'Comment replies', false, true,
    'Get an in-app notification when another member replies to your comment.',
    true, true, true
  ),
  (
    'comment_mentions', 'Comment mentions', false, true,
    'Get an in-app notification when another member mentions you in a comment.',
    true, true, true
  );

insert into public.push_subscription_preferences (
  subscription_id, category_key, enabled
)
select subscription.id, category.category_key, false
from public.push_subscriptions subscription
cross join (
  values ('comment_replies'::text), ('comment_mentions'::text)
) category(category_key)
on conflict (subscription_id, category_key) do nothing;

alter table public.notification_events
  drop constraint notification_event_type_check,
  drop constraint notification_event_category_check;

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
    'wallet_issue_received', 'wallet_issue_correction_ready', 'wallet_issue_resolved',
    'comment_reply', 'comment_mention'
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
    or (event_type = 'comment_reply' and category_key = 'comment_replies')
    or (event_type = 'comment_mention' and category_key = 'comment_mentions')
  );

create table public.community_comment_mention_owner_states (
  comment_id uuid not null,
  owner_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  viewed_at timestamptz,
  dismissed_at timestamptz,
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (comment_id, owner_discord_user_id),
  foreign key (comment_id, owner_discord_user_id)
    references public.community_comment_mention_lifecycle(
      comment_id, target_discord_user_id
    ) on delete restrict
);

create table public.community_comment_owner_mutation_requests (
  owner_discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  request_id uuid not null,
  operation text not null check (operation in (
    'mention_view', 'mention_mark_all_viewed', 'mention_dismiss'
  )),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  receipt jsonb not null check (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz not null default transaction_timestamp(),
  primary key (owner_discord_user_id, request_id)
);

create index community_comment_mentions_owner_page_idx
  on public.community_comment_mention_lifecycle (
    target_discord_user_id, first_mentioned_at desc, id desc
  );

alter table public.community_comment_mention_owner_states enable row level security;
alter table public.community_comment_owner_mutation_requests enable row level security;
alter table public.community_comment_mention_owner_states owner to postgres;
alter table public.community_comment_owner_mutation_requests owner to postgres;

revoke all on table public.community_comment_mention_owner_states,
  public.community_comment_owner_mutation_requests
from public, anon, authenticated, discord_bot, service_role;

create trigger community_comment_owner_mutation_requests_no_update
before update or delete on public.community_comment_owner_mutation_requests
for each row execute function public.protect_community_comment_append_only();

create function public.build_own_community_comment_item(p_comment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select jsonb_build_object(
    'publicCommentId', comment_row.public_comment_id,
    'createdAt', comment_row.created_at,
    'edited', comment_row.edited_at is not null,
    'isReply', comment_row.root_comment_id is not null,
    'status', case
      when comment_row.author_deleted_at is not null then 'author_deleted'
      when comment_row.team_removed_at is not null then 'team_removed'
      when not public.is_community_comment_submission_eligible(comment_row.submission_id)
        or public.get_community_comment_release_state() = 'off' then 'unavailable'
      else 'available'
    end,
    'body', case
      when comment_row.author_deleted_at is null
        and comment_row.team_removed_at is null
        and public.is_community_comment_submission_eligible(comment_row.submission_id)
        and public.get_community_comment_release_state() <> 'off'
      then text_version.normalized_body
      else null
    end,
    'submissionContext', case
      when cycle.public_number is not null then 'Cycle #' || cycle.public_number::text
      else 'Submission unavailable'
    end,
    'destinationHref', case
      when comment_row.author_deleted_at is null
        and comment_row.team_removed_at is null
        and public.is_community_comment_submission_eligible(comment_row.submission_id)
        and public.get_community_comment_release_state() <> 'off'
      then '/spread/' || comment_row.submission_id::text
        || '?comment=' || comment_row.public_comment_id::text
      else null
    end
  )
  from public.community_comments comment_row
  join public.community_comment_text_versions text_version
    on text_version.comment_id = comment_row.id
   and text_version.version = comment_row.current_text_version
  join public.submissions submission on submission.id = comment_row.submission_id
  join public.voting_cycles cycle on cycle.id = submission.cycle_id
  where comment_row.id = p_comment_id;
$function$;

create function public.get_own_community_comments(
  p_session_id uuid,
  p_snapshot_at timestamptz default null,
  p_before_created_at timestamptz default null,
  p_before_public_comment_id uuid default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text;
  v_now timestamptz := transaction_timestamp();
  v_snapshot timestamptz := coalesce(p_snapshot_at, transaction_timestamp());
  v_items jsonb;
begin
  if p_limit not between 1 and 20
    or v_snapshot > v_now
    or ((p_before_created_at is null) <> (p_before_public_comment_id is null))
  then
    raise exception using errcode = '22023',
      message = 'MY_COMMENTS_PAGE_INPUT_INVALID';
  end if;

  v_owner := public.require_account_session(p_session_id);
  select coalesce(jsonb_agg(item.payload order by item.created_at desc, item.public_comment_id desc), '[]'::jsonb)
  into v_items
  from (
    select comment_row.created_at, comment_row.public_comment_id,
      public.build_own_community_comment_item(comment_row.id) as payload
    from public.community_comments comment_row
    where comment_row.author_discord_user_id = v_owner
      and comment_row.created_at <= v_snapshot
      and (
        p_before_created_at is null
        or (comment_row.created_at, comment_row.public_comment_id)
          < (p_before_created_at, p_before_public_comment_id)
      )
    order by comment_row.created_at desc, comment_row.public_comment_id desc
    limit p_limit + 1
  ) item;

  return jsonb_build_object('snapshotAt', v_snapshot, 'items', v_items);
end;
$function$;

create function public.build_own_community_mention_item(
  p_mention_id uuid,
  p_owner_discord_user_id text
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select jsonb_build_object(
    'mentionId', lifecycle.id,
    'firstMentionedAt', lifecycle.first_mentioned_at,
    'commentCreatedAt', comment_row.created_at,
    'isReply', comment_row.root_comment_id is not null,
    'viewedAt', owner_state.viewed_at,
    'stateVersion', coalesce(owner_state.version, 0),
    'status', case
      when comment_row.author_deleted_at is not null then 'author_deleted'
      when comment_row.team_removed_at is not null then 'team_removed'
      when not public.is_community_comment_submission_eligible(comment_row.submission_id)
        or public.get_community_comment_release_state() = 'off' then 'unavailable'
      else 'available'
    end,
    'body', case
      when comment_row.author_deleted_at is null
        and comment_row.team_removed_at is null
        and public.is_community_comment_submission_eligible(comment_row.submission_id)
        and public.get_community_comment_release_state() <> 'off'
      then text_version.normalized_body
      else null
    end,
    'submissionContext', case
      when cycle.public_number is not null then 'Cycle #' || cycle.public_number::text
      else 'Submission unavailable'
    end,
    'destinationHref', case
      when comment_row.author_deleted_at is null
        and comment_row.team_removed_at is null
        and public.is_community_comment_submission_eligible(comment_row.submission_id)
        and public.get_community_comment_release_state() <> 'off'
      then '/spread/' || comment_row.submission_id::text
        || '?comment=' || comment_row.public_comment_id::text
      else null
    end
  )
  from public.community_comment_mention_lifecycle lifecycle
  join public.community_comments comment_row on comment_row.id = lifecycle.comment_id
  join public.community_comment_text_versions text_version
    on text_version.comment_id = comment_row.id
   and text_version.version = comment_row.current_text_version
  join public.submissions submission on submission.id = comment_row.submission_id
  join public.voting_cycles cycle on cycle.id = submission.cycle_id
  left join public.community_comment_mention_owner_states owner_state
    on owner_state.comment_id = lifecycle.comment_id
   and owner_state.owner_discord_user_id = lifecycle.target_discord_user_id
  where lifecycle.id = p_mention_id
    and lifecycle.target_discord_user_id = p_owner_discord_user_id;
$function$;

create function public.get_own_community_mentions(
  p_session_id uuid,
  p_snapshot_at timestamptz default null,
  p_before_first_mentioned_at timestamptz default null,
  p_before_mention_id uuid default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text;
  v_now timestamptz := transaction_timestamp();
  v_snapshot timestamptz := coalesce(p_snapshot_at, transaction_timestamp());
  v_items jsonb;
begin
  if p_limit not between 1 and 20
    or v_snapshot > v_now
    or ((p_before_first_mentioned_at is null) <> (p_before_mention_id is null))
  then
    raise exception using errcode = '22023',
      message = 'MY_MENTIONS_PAGE_INPUT_INVALID';
  end if;

  v_owner := public.require_account_session(p_session_id);
  select coalesce(jsonb_agg(item.payload order by item.first_mentioned_at desc, item.id desc), '[]'::jsonb)
  into v_items
  from (
    select lifecycle.first_mentioned_at, lifecycle.id,
      public.build_own_community_mention_item(lifecycle.id, v_owner) as payload
    from public.community_comment_mention_lifecycle lifecycle
    left join public.community_comment_mention_owner_states owner_state
      on owner_state.comment_id = lifecycle.comment_id
     and owner_state.owner_discord_user_id = lifecycle.target_discord_user_id
    where lifecycle.target_discord_user_id = v_owner
      and lifecycle.first_mentioned_at <= v_snapshot
      and owner_state.dismissed_at is null
      and (
        p_before_first_mentioned_at is null
        or (lifecycle.first_mentioned_at, lifecycle.id)
          < (p_before_first_mentioned_at, p_before_mention_id)
      )
    order by lifecycle.first_mentioned_at desc, lifecycle.id desc
    limit p_limit + 1
  ) item;

  return jsonb_build_object('snapshotAt', v_snapshot, 'items', v_items);
end;
$function$;

create function public.hash_community_comment_owner_request(p_payload jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $function$
  select encode(extensions.digest(convert_to(p_payload::text, 'utf8'), 'sha256'), 'hex');
$function$;

create function public.get_community_comment_owner_request_replay(
  p_owner_discord_user_id text,
  p_request_id uuid,
  p_operation text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_request public.community_comment_owner_mutation_requests%rowtype;
begin
  select * into v_request
  from public.community_comment_owner_mutation_requests request_row
  where request_row.owner_discord_user_id = p_owner_discord_user_id
    and request_row.request_id = p_request_id;
  if not found then return null; end if;
  if v_request.operation <> p_operation or v_request.request_hash <> p_request_hash then
    raise exception using errcode = '55000', message = 'COMMENT_OWNER_REQUEST_REUSED';
  end if;
  return v_request.receipt || jsonb_build_object('replayed', true);
end;
$function$;

create function public.mark_own_community_mention_viewed(
  p_session_id uuid,
  p_mention_id uuid,
  p_expected_version bigint,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text;
  v_lifecycle public.community_comment_mention_lifecycle%rowtype;
  v_state public.community_comment_mention_owner_states%rowtype;
  v_hash text;
  v_replay jsonb;
  v_receipt jsonb;
begin
  if p_mention_id is null or p_request_id is null or p_expected_version < 0 then
    raise exception using errcode = '22023', message = 'MY_MENTION_VIEW_INPUT_INVALID';
  end if;
  v_owner := public.require_account_session(p_session_id);
  v_hash := public.hash_community_comment_owner_request(jsonb_build_object(
    'operation', 'mention_view', 'mentionId', p_mention_id,
    'expectedVersion', p_expected_version
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'comment-owner-request:' || v_owner || ':' || p_request_id::text, 0
  ));
  v_replay := public.get_community_comment_owner_request_replay(
    v_owner, p_request_id, 'mention_view', v_hash
  );
  if v_replay is not null then return v_replay; end if;

  select * into v_lifecycle
  from public.community_comment_mention_lifecycle lifecycle
  where lifecycle.id = p_mention_id
    and lifecycle.target_discord_user_id = v_owner;
  if not found then
    v_receipt := jsonb_build_object('outcome', 'not_found', 'replayed', false);
  else
    select * into v_state
    from public.community_comment_mention_owner_states owner_state
    where owner_state.comment_id = v_lifecycle.comment_id
      and owner_state.owner_discord_user_id = v_owner
    for update;
    if coalesce(v_state.version, 0) <> p_expected_version then
      v_receipt := jsonb_build_object(
        'outcome', 'stale_state', 'stateVersion', coalesce(v_state.version, 0),
        'replayed', false
      );
    elsif v_state.comment_id is null then
      insert into public.community_comment_mention_owner_states (
        comment_id, owner_discord_user_id, viewed_at
      ) values (
        v_lifecycle.comment_id, v_owner, transaction_timestamp()
      ) returning * into v_state;
      v_receipt := jsonb_build_object(
        'outcome', 'viewed', 'viewedAt', v_state.viewed_at,
        'stateVersion', v_state.version, 'replayed', false
      );
    else
      update public.community_comment_mention_owner_states
      set viewed_at = coalesce(viewed_at, transaction_timestamp()),
          version = case when viewed_at is null then version + 1 else version end,
          updated_at = case when viewed_at is null then transaction_timestamp() else updated_at end
      where comment_id = v_lifecycle.comment_id
        and owner_discord_user_id = v_owner
      returning * into v_state;
      v_receipt := jsonb_build_object(
        'outcome', 'viewed', 'viewedAt', v_state.viewed_at,
        'stateVersion', v_state.version, 'replayed', false
      );
    end if;
  end if;

  insert into public.community_comment_owner_mutation_requests (
    owner_discord_user_id, request_id, operation, request_hash, receipt
  ) values (v_owner, p_request_id, 'mention_view', v_hash, v_receipt);
  return v_receipt;
end;
$function$;

create function public.mark_all_own_community_mentions_viewed(
  p_session_id uuid,
  p_snapshot_at timestamptz,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text;
  v_hash text;
  v_replay jsonb;
  v_count integer;
  v_receipt jsonb;
begin
  if p_snapshot_at is null or p_snapshot_at > transaction_timestamp() or p_request_id is null then
    raise exception using errcode = '22023', message = 'MY_MENTIONS_MARK_ALL_INPUT_INVALID';
  end if;
  v_owner := public.require_account_session(p_session_id);
  v_hash := public.hash_community_comment_owner_request(jsonb_build_object(
    'operation', 'mention_mark_all_viewed', 'snapshotAt', p_snapshot_at
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'comment-owner-request:' || v_owner || ':' || p_request_id::text, 0
  ));
  v_replay := public.get_community_comment_owner_request_replay(
    v_owner, p_request_id, 'mention_mark_all_viewed', v_hash
  );
  if v_replay is not null then return v_replay; end if;

  insert into public.community_comment_mention_owner_states (
    comment_id, owner_discord_user_id, viewed_at
  )
  select lifecycle.comment_id, v_owner, transaction_timestamp()
  from public.community_comment_mention_lifecycle lifecycle
  where lifecycle.target_discord_user_id = v_owner
    and lifecycle.first_mentioned_at <= p_snapshot_at
  on conflict (comment_id, owner_discord_user_id) do update
  set viewed_at = coalesce(
        public.community_comment_mention_owner_states.viewed_at,
        excluded.viewed_at
      ),
      version = case
        when public.community_comment_mention_owner_states.viewed_at is null
          then public.community_comment_mention_owner_states.version + 1
        else public.community_comment_mention_owner_states.version
      end,
      updated_at = case
        when public.community_comment_mention_owner_states.viewed_at is null
          then transaction_timestamp()
        else public.community_comment_mention_owner_states.updated_at
      end;
  get diagnostics v_count = row_count;

  v_receipt := jsonb_build_object(
    'outcome', 'viewed', 'snapshotAt', p_snapshot_at,
    'updatedCount', v_count, 'replayed', false
  );
  insert into public.community_comment_owner_mutation_requests (
    owner_discord_user_id, request_id, operation, request_hash, receipt
  ) values (v_owner, p_request_id, 'mention_mark_all_viewed', v_hash, v_receipt);
  return v_receipt;
end;
$function$;

create function public.dismiss_own_community_mention(
  p_session_id uuid,
  p_mention_id uuid,
  p_expected_version bigint,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text;
  v_lifecycle public.community_comment_mention_lifecycle%rowtype;
  v_state public.community_comment_mention_owner_states%rowtype;
  v_hash text;
  v_replay jsonb;
  v_receipt jsonb;
begin
  if p_mention_id is null or p_request_id is null or p_expected_version < 0 then
    raise exception using errcode = '22023', message = 'MY_MENTION_DISMISS_INPUT_INVALID';
  end if;
  v_owner := public.require_account_session(p_session_id);
  v_hash := public.hash_community_comment_owner_request(jsonb_build_object(
    'operation', 'mention_dismiss', 'mentionId', p_mention_id,
    'expectedVersion', p_expected_version
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'comment-owner-request:' || v_owner || ':' || p_request_id::text, 0
  ));
  v_replay := public.get_community_comment_owner_request_replay(
    v_owner, p_request_id, 'mention_dismiss', v_hash
  );
  if v_replay is not null then return v_replay; end if;

  select * into v_lifecycle
  from public.community_comment_mention_lifecycle lifecycle
  where lifecycle.id = p_mention_id
    and lifecycle.target_discord_user_id = v_owner;
  if not found then
    v_receipt := jsonb_build_object('outcome', 'not_found', 'replayed', false);
  else
    select * into v_state
    from public.community_comment_mention_owner_states owner_state
    where owner_state.comment_id = v_lifecycle.comment_id
      and owner_state.owner_discord_user_id = v_owner
    for update;
    if coalesce(v_state.version, 0) <> p_expected_version then
      v_receipt := jsonb_build_object(
        'outcome', 'stale_state', 'stateVersion', coalesce(v_state.version, 0),
        'replayed', false
      );
    elsif v_state.comment_id is null then
      insert into public.community_comment_mention_owner_states (
        comment_id, owner_discord_user_id, dismissed_at
      ) values (
        v_lifecycle.comment_id, v_owner, transaction_timestamp()
      ) returning * into v_state;
      v_receipt := jsonb_build_object(
        'outcome', 'dismissed', 'stateVersion', v_state.version, 'replayed', false
      );
    else
      update public.community_comment_mention_owner_states
      set dismissed_at = coalesce(dismissed_at, transaction_timestamp()),
          version = case when dismissed_at is null then version + 1 else version end,
          updated_at = case when dismissed_at is null then transaction_timestamp() else updated_at end
      where comment_id = v_lifecycle.comment_id
        and owner_discord_user_id = v_owner
      returning * into v_state;
      v_receipt := jsonb_build_object(
        'outcome', 'dismissed', 'stateVersion', v_state.version, 'replayed', false
      );
    end if;
  end if;

  insert into public.community_comment_owner_mutation_requests (
    owner_discord_user_id, request_id, operation, request_hash, receipt
  ) values (v_owner, p_request_id, 'mention_dismiss', v_hash, v_receipt);
  return v_receipt;
end;
$function$;

create function public.get_own_community_comment_destination(
  p_session_id uuid,
  p_public_comment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text;
  v_comment public.community_comments%rowtype;
begin
  v_owner := public.require_account_session(p_session_id);
  select * into v_comment
  from public.community_comments comment_row
  where comment_row.public_comment_id = p_public_comment_id
    and comment_row.author_discord_user_id = v_owner;
  if not found or v_comment.author_deleted_at is not null
    or v_comment.team_removed_at is not null
    or public.get_community_comment_release_state() = 'off'
    or not public.is_community_comment_submission_eligible(v_comment.submission_id)
  then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  return jsonb_build_object(
    'outcome', 'found',
    'destination', '/spread/' || v_comment.submission_id::text
      || '?comment=' || v_comment.public_comment_id::text
  );
end;
$function$;

create function public.get_own_community_mention_destination(
  p_session_id uuid,
  p_mention_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text;
  v_comment public.community_comments%rowtype;
begin
  v_owner := public.require_account_session(p_session_id);
  select comment_row.* into v_comment
  from public.community_comment_mention_lifecycle lifecycle
  join public.community_comments comment_row on comment_row.id = lifecycle.comment_id
  where lifecycle.id = p_mention_id
    and lifecycle.target_discord_user_id = v_owner;
  if not found or v_comment.author_deleted_at is not null
    or v_comment.team_removed_at is not null
    or public.get_community_comment_release_state() = 'off'
    or not public.is_community_comment_submission_eligible(v_comment.submission_id)
  then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  return jsonb_build_object(
    'outcome', 'found',
    'destination', '/spread/' || v_comment.submission_id::text
      || '?comment=' || v_comment.public_comment_id::text
  );
end;
$function$;

create function public.produce_community_comment_reply_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_target_owner text;
  v_visible boolean;
begin
  if new.reply_target_comment_id is null then return new; end if;
  select target.author_discord_user_id into strict v_target_owner
  from public.community_comments target
  where target.id = new.reply_target_comment_id;
  if v_target_owner = new.author_discord_user_id then return new; end if;
  v_visible := coalesce(public.resolve_account_notification_visibility(
    v_target_owner, 'comment_replies'
  ), false);
  perform public.enqueue_account_notification_event(
    'comment-reply:' || new.public_comment_id::text,
    'comment_reply', 'comment_replies', v_target_owner,
    '/my-profile/comments/open/' || new.public_comment_id::text,
    v_visible
  );
  return new;
end;
$function$;

create function public.produce_community_comment_mention_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_comment public.community_comments%rowtype;
  v_reply_target_owner text;
  v_visible boolean;
begin
  select * into strict v_comment
  from public.community_comments comment_row where comment_row.id = new.comment_id;
  if new.target_discord_user_id = v_comment.author_discord_user_id then return new; end if;
  if v_comment.reply_target_comment_id is not null then
    select target.author_discord_user_id into strict v_reply_target_owner
    from public.community_comments target
    where target.id = v_comment.reply_target_comment_id;
    if new.target_discord_user_id = v_reply_target_owner then return new; end if;
  end if;
  v_visible := coalesce(public.resolve_account_notification_visibility(
    new.target_discord_user_id, 'comment_mentions'
  ), false);
  perform public.enqueue_account_notification_event(
    'comment-mention:' || new.id::text,
    'comment_mention', 'comment_mentions', new.target_discord_user_id,
    '/my-profile/mentions/open/' || new.id::text,
    v_visible
  );
  return new;
end;
$function$;

create trigger community_comment_reply_notification_after_insert
after insert on public.community_comments
for each row execute function public.produce_community_comment_reply_notification();

create trigger community_comment_mention_notification_after_insert
after insert on public.community_comment_mention_lifecycle
for each row execute function public.produce_community_comment_mention_notification();

create or replace function public.get_own_notifications(
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
declare v_owner_id text; v_items jsonb;
begin
  if p_limit not between 1 and 50 or ((p_before_created_at is null) <> (p_before_id is null)) then
    raise exception using errcode = '22023', message = 'NOTIFICATION_PAGE_INPUT_INVALID';
  end if;
  v_owner_id := public.require_account_session(p_session_id);
  select coalesce(jsonb_agg(item.payload order by item.created_at desc, item.id desc), '[]'::jsonb)
  into v_items from (
    select notification.created_at, notification.id, jsonb_build_object(
      'id', notification.id, 'categoryKey', event.category_key, 'eventType', event.event_type,
      'title', case event.event_type
        when 'winner_claim_required' then 'Winner claim required'
        when 'winner_correction_ready' then 'Winner claim ready'
        when 'winner_donation_finalized' then 'Winner result finalized'
        when 'winner_payout_sent' then 'Prize sent'
        when 'donation_recipient_change_required' then 'Choose another charity'
        when 'submission_disqualified' then 'Submission disqualified'
        when 'submission_reinstated' then 'Submission restored'
        when 'wallet_issue_received' then 'Wallet issue received'
        when 'wallet_issue_correction_ready' then 'Wallet correction ready'
        when 'wallet_issue_resolved' then 'Wallet issue resolved'
        when 'comment_reply' then 'New comment reply'
        when 'comment_mention' then 'New comment mention'
        else 'Cycle results are ready' end,
      'body', coalesce(event.public_body, case event.event_type
        when 'winner_claim_required' then 'Review and confirm your winner claim.'
        when 'winner_correction_ready' then 'Review the full recipient and confirm your Claim within 24 hours.'
        when 'winner_donation_finalized' then 'View your finalized winner result.'
        when 'winner_payout_sent' then 'Your prize payout has been recorded as sent.'
        when 'submission_disqualified' then 'View your moderation history for details.'
        when 'submission_reinstated' then 'View your moderation history for details.'
        when 'wallet_issue_received' then 'Your winning-Submission report is ready for Team review.'
        when 'wallet_issue_correction_ready' then 'Review the full recipient and confirm your Claim within 24 hours.'
        when 'wallet_issue_resolved' then 'Review the current recipient and confirm your Claim within 24 hours.'
        when 'comment_reply' then 'You have a new reply.'
        when 'comment_mention' then 'You were mentioned.'
        else 'View the finalized Cycle results.' end),
      'actionLabel', case event.event_type
        when 'winner_claim_required' then 'Review claim'
        when 'winner_correction_ready' then 'Review claim'
        when 'winner_donation_finalized' then 'View result'
        when 'winner_payout_sent' then 'View payout'
        when 'donation_recipient_change_required' then 'Choose charity'
        when 'submission_disqualified' then 'View details'
        when 'submission_reinstated' then 'View details'
        when 'wallet_issue_received' then 'View claim'
        when 'wallet_issue_correction_ready' then 'Review claim'
        when 'wallet_issue_resolved' then 'Review claim'
        when 'comment_reply' then 'View reply'
        when 'comment_mention' then 'View mention'
        else 'View results' end,
      'createdAt', notification.created_at, 'readAt', notification.read_at
    ) payload
    from public.account_notifications notification
    join public.notification_events event on event.id = notification.event_id
    where notification.owner_discord_user_id = v_owner_id
      and notification.visible_in_product
      and (notification.read_at is null or notification.read_at > transaction_timestamp() - interval '3 days')
      and (p_before_created_at is null
        or (notification.created_at, notification.id) < (p_before_created_at, p_before_id))
    order by notification.created_at desc, notification.id desc limit p_limit + 1
  ) item;
  return jsonb_build_object('items', v_items);
end;
$function$;

alter function public.build_own_community_comment_item(uuid) owner to postgres;
alter function public.get_own_community_comments(uuid,timestamptz,timestamptz,uuid,integer) owner to postgres;
alter function public.build_own_community_mention_item(uuid,text) owner to postgres;
alter function public.get_own_community_mentions(uuid,timestamptz,timestamptz,uuid,integer) owner to postgres;
alter function public.hash_community_comment_owner_request(jsonb) owner to postgres;
alter function public.get_community_comment_owner_request_replay(text,uuid,text,text) owner to postgres;
alter function public.mark_own_community_mention_viewed(uuid,uuid,bigint,uuid) owner to postgres;
alter function public.mark_all_own_community_mentions_viewed(uuid,timestamptz,uuid) owner to postgres;
alter function public.dismiss_own_community_mention(uuid,uuid,bigint,uuid) owner to postgres;
alter function public.get_own_community_comment_destination(uuid,uuid) owner to postgres;
alter function public.get_own_community_mention_destination(uuid,uuid) owner to postgres;
alter function public.produce_community_comment_reply_notification() owner to postgres;
alter function public.produce_community_comment_mention_notification() owner to postgres;
alter function public.get_own_notifications(uuid,timestamptz,uuid,integer) owner to postgres;

revoke all on function public.build_own_community_comment_item(uuid),
  public.get_own_community_comments(uuid,timestamptz,timestamptz,uuid,integer),
  public.build_own_community_mention_item(uuid,text),
  public.get_own_community_mentions(uuid,timestamptz,timestamptz,uuid,integer),
  public.hash_community_comment_owner_request(jsonb),
  public.get_community_comment_owner_request_replay(text,uuid,text,text),
  public.mark_own_community_mention_viewed(uuid,uuid,bigint,uuid),
  public.mark_all_own_community_mentions_viewed(uuid,timestamptz,uuid),
  public.dismiss_own_community_mention(uuid,uuid,bigint,uuid),
  public.get_own_community_comment_destination(uuid,uuid),
  public.get_own_community_mention_destination(uuid,uuid),
  public.produce_community_comment_reply_notification(),
  public.produce_community_comment_mention_notification()
from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_own_community_comments(uuid,timestamptz,timestamptz,uuid,integer),
  public.get_own_community_mentions(uuid,timestamptz,timestamptz,uuid,integer),
  public.mark_own_community_mention_viewed(uuid,uuid,bigint,uuid),
  public.mark_all_own_community_mentions_viewed(uuid,timestamptz,uuid),
  public.dismiss_own_community_mention(uuid,uuid,bigint,uuid),
  public.get_own_community_comment_destination(uuid,uuid),
  public.get_own_community_mention_destination(uuid,uuid)
to service_role;

do $postflight$
declare
  v_function record;
begin
  if (select count(*) from public.notification_category_catalog
      where category_key in ('comment_replies', 'comment_mentions')
        and is_active and default_in_product_enabled
        and in_product_available and push_available) <> 2
    or (select count(*) from public.push_subscription_preferences preference
        join public.push_subscriptions subscription on subscription.id = preference.subscription_id
        where preference.category_key in ('comment_replies', 'comment_mentions')
          and preference.enabled) <> 0
    or not exists (
      select 1 from pg_constraint
      where conrelid = 'public.notification_events'::regclass
        and conname = 'notification_event_type_check'
        and pg_get_constraintdef(oid) like '%comment_reply%comment_mention%'
    )
    or not exists (
      select 1 from pg_trigger
      where tgrelid = 'public.community_comments'::regclass
        and tgname = 'community_comment_reply_notification_after_insert'
        and not tgisinternal
    )
    or not exists (
      select 1 from pg_trigger
      where tgrelid = 'public.community_comment_mention_lifecycle'::regclass
        and tgname = 'community_comment_mention_notification_after_insert'
        and not tgisinternal
    )
    or not (select relrowsecurity from pg_class where oid = 'public.community_comment_mention_owner_states'::regclass)
    or not (select relrowsecurity from pg_class where oid = 'public.community_comment_owner_mutation_requests'::regclass)
    or has_table_privilege('service_role', 'public.community_comment_mention_owner_states', 'SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated', 'public.community_comment_mention_owner_states', 'SELECT,INSERT,UPDATE,DELETE')
  then
    raise exception using errcode = '55000',
      message = 'MY_COMMENTS_MENTIONS_NOTIFICATION_POSTFLIGHT_MISMATCH';
  end if;

  for v_function in
    select function_row.oid,
      function_row.oid::regprocedure::text as signature,
      function_row.prosecdef,
      pg_get_userbyid(function_row.proowner) as owner_name,
      function_row.proconfig
    from pg_proc function_row
    join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname in (
        'get_own_community_comments', 'get_own_community_mentions',
        'mark_own_community_mention_viewed', 'mark_all_own_community_mentions_viewed',
        'dismiss_own_community_mention', 'get_own_community_comment_destination',
        'get_own_community_mention_destination'
      )
  loop
    if not v_function.prosecdef
      or v_function.owner_name <> 'postgres'
      or v_function.proconfig is distinct from array['search_path=public, pg_temp']::text[]
      or not has_function_privilege('service_role', v_function.oid, 'EXECUTE')
      or has_function_privilege('public', v_function.oid, 'EXECUTE')
      or has_function_privilege('anon', v_function.oid, 'EXECUTE')
      or has_function_privilege('authenticated', v_function.oid, 'EXECUTE')
      or has_function_privilege('discord_bot', v_function.oid, 'EXECUTE')
    then
      raise exception using errcode = '55000',
        message = 'MY_COMMENTS_MENTIONS_NOTIFICATION_POSTFLIGHT_MISMATCH';
    end if;
  end loop;
end;
$postflight$;

comment on table public.community_comment_mention_owner_states is
  'Mutable owner-only viewed and dismissed projection for immutable Comment Mention lifecycle facts.';
comment on table public.community_comment_owner_mutation_requests is
  'Append-only replay receipts for owner Mention viewed and dismissed mutations.';
comment on function public.get_own_community_comments(uuid,timestamptz,timestamptz,uuid,integer) is
  'Returns a bounded owner-only creation-ordered My Comments projection without internal identifiers.';
comment on function public.get_own_community_mentions(uuid,timestamptz,timestamptz,uuid,integer) is
  'Returns a bounded owner-only immutable-lifecycle My Mentions projection independent of notification preferences.';

commit;

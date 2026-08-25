begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if public.get_community_comment_release_state() <> 'off'
    or to_regprocedure('public.get_own_community_mentions(uuid,timestamp with time zone,timestamp with time zone,uuid,integer)') is null
    or to_regprocedure('public.mark_own_community_mention_viewed(uuid,uuid,bigint,uuid)') is null
    or to_regprocedure('public.mark_all_own_community_mentions_viewed(uuid,timestamp with time zone,uuid)') is null
    or to_regprocedure('public.dismiss_own_community_mention(uuid,uuid,bigint,uuid)') is null
    or to_regprocedure('public.get_own_community_mention_destination(uuid,uuid)') is null
    or to_regprocedure('public.mark_own_community_mention_viewed_v1(uuid,uuid,bigint,uuid)') is not null
    or to_regprocedure('public.dismiss_own_community_mention_v1(uuid,uuid,bigint,uuid)') is not null
    or to_regprocedure('public.get_own_community_mention_destination_v1(uuid,uuid)') is not null
  then
    raise exception using errcode = '55000',
      message = 'MY_MENTIONS_SELF_SUPPRESSION_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

create or replace function public.get_own_community_mentions(
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
    join public.community_comments comment_row on comment_row.id = lifecycle.comment_id
    left join public.community_comment_mention_owner_states owner_state
      on owner_state.comment_id = lifecycle.comment_id
     and owner_state.owner_discord_user_id = lifecycle.target_discord_user_id
    where lifecycle.target_discord_user_id = v_owner
      and comment_row.author_discord_user_id <> v_owner
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

alter function public.mark_own_community_mention_viewed(uuid,uuid,bigint,uuid)
  rename to mark_own_community_mention_viewed_v1;
alter function public.dismiss_own_community_mention(uuid,uuid,bigint,uuid)
  rename to dismiss_own_community_mention_v1;
alter function public.get_own_community_mention_destination(uuid,uuid)
  rename to get_own_community_mention_destination_v1;

revoke all on function public.mark_own_community_mention_viewed_v1(uuid,uuid,bigint,uuid),
  public.dismiss_own_community_mention_v1(uuid,uuid,bigint,uuid),
  public.get_own_community_mention_destination_v1(uuid,uuid)
from public, anon, authenticated, discord_bot, service_role;

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
declare v_owner text;
begin
  v_owner := public.require_account_session(p_session_id);
  if not exists (
    select 1
    from public.community_comment_mention_lifecycle lifecycle
    join public.community_comments comment_row on comment_row.id = lifecycle.comment_id
    where lifecycle.id = p_mention_id
      and lifecycle.target_discord_user_id = v_owner
      and comment_row.author_discord_user_id <> v_owner
  ) then
    return jsonb_build_object('outcome', 'not_found', 'replayed', false);
  end if;
  return public.mark_own_community_mention_viewed_v1(
    p_session_id, p_mention_id, p_expected_version, p_request_id
  );
end;
$function$;

create or replace function public.mark_all_own_community_mentions_viewed(
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
  join public.community_comments comment_row on comment_row.id = lifecycle.comment_id
  where lifecycle.target_discord_user_id = v_owner
    and comment_row.author_discord_user_id <> v_owner
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
declare v_owner text;
begin
  v_owner := public.require_account_session(p_session_id);
  if not exists (
    select 1
    from public.community_comment_mention_lifecycle lifecycle
    join public.community_comments comment_row on comment_row.id = lifecycle.comment_id
    where lifecycle.id = p_mention_id
      and lifecycle.target_discord_user_id = v_owner
      and comment_row.author_discord_user_id <> v_owner
  ) then
    return jsonb_build_object('outcome', 'not_found', 'replayed', false);
  end if;
  return public.dismiss_own_community_mention_v1(
    p_session_id, p_mention_id, p_expected_version, p_request_id
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
declare v_owner text;
begin
  v_owner := public.require_account_session(p_session_id);
  if not exists (
    select 1
    from public.community_comment_mention_lifecycle lifecycle
    join public.community_comments comment_row on comment_row.id = lifecycle.comment_id
    where lifecycle.id = p_mention_id
      and lifecycle.target_discord_user_id = v_owner
      and comment_row.author_discord_user_id <> v_owner
  ) then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  return public.get_own_community_mention_destination_v1(p_session_id, p_mention_id);
end;
$function$;

alter function public.get_own_community_mentions(uuid,timestamptz,timestamptz,uuid,integer) owner to postgres;
alter function public.mark_own_community_mention_viewed(uuid,uuid,bigint,uuid) owner to postgres;
alter function public.mark_all_own_community_mentions_viewed(uuid,timestamptz,uuid) owner to postgres;
alter function public.dismiss_own_community_mention(uuid,uuid,bigint,uuid) owner to postgres;
alter function public.get_own_community_mention_destination(uuid,uuid) owner to postgres;

revoke all on function public.get_own_community_mentions(uuid,timestamptz,timestamptz,uuid,integer),
  public.mark_own_community_mention_viewed(uuid,uuid,bigint,uuid),
  public.mark_all_own_community_mentions_viewed(uuid,timestamptz,uuid),
  public.dismiss_own_community_mention(uuid,uuid,bigint,uuid),
  public.get_own_community_mention_destination(uuid,uuid)
from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_own_community_mentions(uuid,timestamptz,timestamptz,uuid,integer),
  public.mark_own_community_mention_viewed(uuid,uuid,bigint,uuid),
  public.mark_all_own_community_mentions_viewed(uuid,timestamptz,uuid),
  public.dismiss_own_community_mention(uuid,uuid,bigint,uuid),
  public.get_own_community_mention_destination(uuid,uuid)
to service_role;

do $postflight$
declare
  v_signature regprocedure;
  v_definition text;
begin
  foreach v_signature in array array[
    'public.get_own_community_mentions(uuid,timestamp with time zone,timestamp with time zone,uuid,integer)'::regprocedure,
    'public.mark_own_community_mention_viewed(uuid,uuid,bigint,uuid)'::regprocedure,
    'public.mark_all_own_community_mentions_viewed(uuid,timestamp with time zone,uuid)'::regprocedure,
    'public.dismiss_own_community_mention(uuid,uuid,bigint,uuid)'::regprocedure,
    'public.get_own_community_mention_destination(uuid,uuid)'::regprocedure
  ] loop
    v_definition := pg_get_functiondef(v_signature);
    if position('author_discord_user_id <> v_owner' in v_definition) = 0
      or not has_function_privilege('service_role', v_signature, 'EXECUTE')
      or has_function_privilege('public', v_signature, 'EXECUTE')
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or exists (
        select 1 from pg_proc function_row
        where function_row.oid = v_signature
          and (
            not function_row.prosecdef
            or pg_get_userbyid(function_row.proowner) <> 'postgres'
            or function_row.proconfig is distinct from array['search_path=public, pg_temp']::text[]
          )
      )
    then
      raise exception using errcode = '55000',
        message = 'MY_MENTIONS_SELF_SUPPRESSION_POSTFLIGHT_MISMATCH';
    end if;
  end loop;

  if (select count(*) from pg_proc function_row
      join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
      where namespace_row.nspname = 'public'
        and function_row.proname in (
          'get_own_community_mentions', 'mark_own_community_mention_viewed',
          'mark_all_own_community_mentions_viewed', 'dismiss_own_community_mention',
          'get_own_community_mention_destination'
        )) <> 5
  then
    raise exception using errcode = '55000',
      message = 'MY_MENTIONS_SELF_SUPPRESSION_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;

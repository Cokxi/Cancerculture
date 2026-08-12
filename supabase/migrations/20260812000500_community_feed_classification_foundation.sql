begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

lock table public.voting_cycles in share row exclusive mode;
lock table public.cycle_results in share row exclusive mode;
lock table public.submissions in share row exclusive mode;
lock table public.submission_upload_operations in share row exclusive mode;

create temporary table community_feed_foundation_preflight on commit drop as
select
  (select count(*) from public.capability_catalog) as capability_count,
  (select count(*) from public.team_role_capabilities) as grant_count,
  (select count(*) from public.cycle_results) as result_count,
  (select count(*) from public.submissions) as submission_count;

do $preflight$
declare
  v_finalize_count integer;
  v_managed_finalize_count integer;
  v_commit_count integer;
  v_cycle_results_nonselect_grantees text[];
  v_cycle_results_select_grantees text[];
begin
  select count(*)
  into v_finalize_count
  from pg_proc function_row
  join pg_namespace namespace_row
    on namespace_row.oid = function_row.pronamespace
  where namespace_row.nspname = 'public'
    and function_row.proname = 'finalize_cycle';

  select count(*)
  into v_managed_finalize_count
  from pg_proc function_row
  join pg_namespace namespace_row
    on namespace_row.oid = function_row.pronamespace
  where namespace_row.nspname = 'public'
    and function_row.proname = 'finalize_cycle_managed';

  select count(*)
  into v_commit_count
  from pg_proc function_row
  join pg_namespace namespace_row
    on namespace_row.oid = function_row.pronamespace
  where namespace_row.nspname = 'public'
    and function_row.proname = 'commit_submission_upload';

  select array_agg(grantee_name order by grantee_name)
  into v_cycle_results_nonselect_grantees
  from (
    select distinct case
      when privilege.grantee = 0 then 'PUBLIC'
      else pg_get_userbyid(privilege.grantee)
    end as grantee_name
    from pg_class class_row
    cross join lateral aclexplode(coalesce(
      class_row.relacl,
      acldefault('r', class_row.relowner)
    )) privilege
    where class_row.oid = 'public.cycle_results'::regclass
      and privilege.privilege_type <> 'SELECT'
  ) grantee;

  select array_agg(grantee_name order by grantee_name)
  into v_cycle_results_select_grantees
  from (
    select distinct case
      when privilege.grantee = 0 then 'PUBLIC'
      else pg_get_userbyid(privilege.grantee)
    end as grantee_name
    from pg_class class_row
    cross join lateral aclexplode(coalesce(
      class_row.relacl,
      acldefault('r', class_row.relowner)
    )) privilege
    where class_row.oid = 'public.cycle_results'::regclass
      and privilege.privilege_type = 'SELECT'
  ) grantee;

  if to_regclass('public.voting_cycles') is null
    or to_regclass('public.cycle_results') is null
    or to_regclass('public.submissions') is null
    or to_regclass('public.submission_upload_operations') is null
    or to_regprocedure('public.finalize_cycle(bigint,text)') is null
    or to_regprocedure('public.finalize_cycle_managed(bigint,text)') is null
    or to_regprocedure(
      'public.commit_submission_upload(uuid,uuid,text,text,integer,text)'
    ) is null
    or v_finalize_count <> 1
    or v_managed_finalize_count <> 1
    or v_commit_count <> 1 then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_FUNCTION_BASELINE_MISMATCH';
  end if;

  if (
      select pg_get_userbyid(class_row.relowner)
      from pg_class class_row
      where class_row.oid = 'public.cycle_results'::regclass
    ) <> 'postgres'
    or v_cycle_results_nonselect_grantees is distinct from
      array['postgres', 'service_role']::text[]
    or v_cycle_results_select_grantees is distinct from
      array['postgres', 'service_role']::text[] then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_CYCLE_RESULTS_ACL_BASELINE_MISMATCH';
  end if;

  if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'cycle_results' and column_name in (
            'feed_trash',
            'feed_classification_version',
            'is_disqualified_at_finalization'
          ))
          or (table_name = 'submissions' and column_name in (
            'media_width', 'media_height'
          ))
        )
    )
    or to_regclass('public.cycle_results_feed_all_cursor_idx') is not null
    or to_regclass('public.cycle_results_feed_trash_cursor_idx') is not null
    or to_regclass('public.cycle_results_feed_top10_cursor_idx') is not null
    or to_regclass('public.submissions_live_feed_cursor_idx') is not null
    or to_regprocedure(
      'public.prevent_cycle_result_snapshot_mutation()'
    ) is not null
    or to_regprocedure(
      'public.commit_submission_upload(uuid,uuid,text,text,integer,text,integer,integer)'
    ) is not null then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_TARGET_ALREADY_PRESENT';
  end if;

  if exists (
      select 1
      from public.cycle_results result_row
      where result_row.final_vote_count is null
        or result_row.rank_in_cycle is null
        or result_row.tie_group is null
        or result_row.finalized_at is null
        or result_row.feed_eligible is null
        or result_row.public_visibility_status_at_finalization is null
    ) then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_RESULT_SNAPSHOT_BASELINE_MISMATCH';
  end if;

  if exists (
      select 1
      from public.submission_upload_operations operation
      where operation.status in ('reserved', 'r2_uploaded')
    ) then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_ACTIVE_UPLOAD_PRESENT';
  end if;
end;
$preflight$;

alter table public.submissions
  add column media_width integer,
  add column media_height integer;

alter table public.submissions
  add constraint submissions_media_dimensions_check
  check (
    (media_width is null and media_height is null)
    or (
      media_width between 1 and 2400
      and media_height between 1 and 16383
      and media_width::bigint * media_height::bigint <= 24000000
    )
  );

comment on column public.submissions.media_width is
  'Validated width of the canonical processed Submission WebP. Legacy rows may retain a null width/height pair.';
comment on column public.submissions.media_height is
  'Validated height of the canonical processed Submission WebP. Legacy rows may retain a null width/height pair.';

alter table public.cycle_results
  add column feed_trash boolean,
  add column feed_classification_version integer,
  add column is_disqualified_at_finalization boolean;

with positive_tier_sizes as (
  select
    result_row.cycle_id,
    result_row.final_vote_count,
    count(*)::integer as tier_size
  from public.cycle_results result_row
  where result_row.final_vote_count > 0
  group by result_row.cycle_id, result_row.final_vote_count
), positive_tiers as (
  select
    tier.cycle_id,
    tier.final_vote_count,
    sum(tier.tier_size) over (
      partition by tier.cycle_id
      order by tier.final_vote_count asc
      rows between unbounded preceding and current row
    )::integer as cumulative_size,
    sum(tier.tier_size) over (
      partition by tier.cycle_id
    )::integer as positive_submission_count
  from positive_tier_sizes tier
)
update public.cycle_results result_row
set
  feed_eligible = result_row.final_vote_count > 0,
  feed_trash = coalesce((
    select positive_tier.cumulative_size <=
      floor(positive_tier.positive_submission_count * 0.10)::integer
    from positive_tiers positive_tier
    where positive_tier.cycle_id = result_row.cycle_id
      and positive_tier.final_vote_count = result_row.final_vote_count
  ), false),
  feed_classification_version = 1,
  is_disqualified_at_finalization = false;

alter table public.cycle_results
  alter column final_vote_count set not null,
  alter column rank_in_cycle set not null,
  alter column tie_group set not null,
  alter column finalized_at set not null,
  alter column feed_eligible set not null,
  alter column feed_trash set not null,
  alter column feed_classification_version set not null,
  alter column is_disqualified_at_finalization set not null,
  alter column public_visibility_status_at_finalization set not null;

alter table public.cycle_results
  add constraint cycle_results_feed_classification_version_check
    check (feed_classification_version >= 1),
  add constraint cycle_results_feed_positive_check
    check (
      feed_eligible = (
        final_vote_count > 0
        and not is_disqualified_at_finalization
      )
    ),
  add constraint cycle_results_feed_trash_check
    check (not feed_trash or feed_eligible);

comment on column public.cycle_results.feed_eligible is
  'Immutable positive-Vote competition eligibility captured at finalization. Current visibility and DQ remain separate delivery checks.';
comment on column public.cycle_results.feed_trash is
  'Immutable Cycle-relative lower-ten-percent classification. Complete Vote tiers only; Zero-Vote rows are always false.';
comment on column public.cycle_results.feed_classification_version is
  'Version of the immutable finalized Feed classification contract.';
comment on column public.cycle_results.is_disqualified_at_finalization is
  'DQ snapshot for audit and delivery-boundary clarity. Current Submission DQ remains authoritative at read time.';

create function public.prevent_cycle_result_snapshot_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if new.final_vote_count is distinct from old.final_vote_count
    or new.rank_in_cycle is distinct from old.rank_in_cycle
    or new.tie_group is distinct from old.tie_group
    or new.finalized_at is distinct from old.finalized_at
    or new.feed_eligible is distinct from old.feed_eligible
    or new.feed_trash is distinct from old.feed_trash
    or new.feed_classification_version is distinct from
      old.feed_classification_version
    or new.is_disqualified_at_finalization is distinct from
      old.is_disqualified_at_finalization
    or new.public_visibility_status_at_finalization is distinct from
      old.public_visibility_status_at_finalization then
    raise exception using
      errcode = '55000',
      message = 'CYCLE_RESULT_SNAPSHOT_IS_IMMUTABLE';
  end if;

  return new;
end;
$function$;

alter function public.prevent_cycle_result_snapshot_mutation()
  owner to postgres;
revoke all on function public.prevent_cycle_result_snapshot_mutation()
  from public, anon, authenticated, service_role, discord_bot;

create trigger cycle_results_snapshot_immutable
before update of
  final_vote_count,
  rank_in_cycle,
  tie_group,
  finalized_at,
  feed_eligible,
  feed_trash,
  feed_classification_version,
  is_disqualified_at_finalization,
  public_visibility_status_at_finalization
on public.cycle_results
for each row execute function
  public.prevent_cycle_result_snapshot_mutation();

revoke all on table public.cycle_results
  from public, anon, authenticated, service_role, discord_bot;
grant select on table public.cycle_results to service_role;

drop index if exists public.cycle_results_feed_cursor_idx;

create index cycle_results_feed_all_cursor_idx
  on public.cycle_results (
    finalized_at desc,
    cycle_id desc,
    rank_in_cycle asc,
    submission_id asc
  )
  where feed_eligible and not feed_trash;

create index cycle_results_feed_trash_cursor_idx
  on public.cycle_results (
    finalized_at desc,
    cycle_id desc,
    rank_in_cycle asc,
    submission_id asc
  )
  where feed_eligible and feed_trash;

create index cycle_results_feed_top10_cursor_idx
  on public.cycle_results (
    finalized_at desc,
    cycle_id desc,
    rank_in_cycle asc,
    submission_id asc
  )
  where feed_eligible and rank_in_cycle <= 10;

create index submissions_live_feed_cursor_idx
  on public.submissions (
    cycle_id,
    created_at desc,
    id desc
  )
  where public_visibility_status = 'visible'
    and coalesce(is_disqualified, false) = false;

create or replace function public.finalize_cycle(
  p_cycle_id bigint,
  p_actor_discord_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_initial_status text;
  v_finalized_at timestamptz := transaction_timestamp();
  v_ranked_submission_count integer := 0;
  v_winner_count integer := 0;
  v_highest_rank integer := 0;
begin
  if p_cycle_id is null or p_cycle_id <= 0 then
    raise exception using message = 'INVALID_CYCLE_ID';
  end if;

  if p_actor_discord_user_id is null
    or btrim(p_actor_discord_user_id) = '' then
    raise exception using message = 'INVALID_FINALIZATION_ACTOR';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cycle-finalization:' || p_cycle_id::text, 0)
  );

  select status::text
  into v_initial_status
  from public.voting_cycles
  where id = p_cycle_id
  for update;

  if not found then
    raise exception using message = 'CYCLE_NOT_FOUND';
  end if;

  if v_initial_status = 'finished' then
    select
      count(*)::integer,
      count(*) filter (where is_winner = true)::integer,
      coalesce(max(rank_in_cycle), 0)::integer
    into
      v_ranked_submission_count,
      v_winner_count,
      v_highest_rank
    from public.cycle_results
    where cycle_id = p_cycle_id;

    if v_ranked_submission_count = 0
      or exists (
        select 1
        from public.cycle_results result_row
        where result_row.cycle_id = p_cycle_id
          and (
            result_row.final_vote_count is null
            or result_row.rank_in_cycle is null
            or result_row.tie_group is null
            or result_row.finalized_at is null
            or result_row.feed_eligible is null
            or result_row.feed_trash is null
            or result_row.feed_classification_version <> 1
            or result_row.is_disqualified_at_finalization is null
            or result_row.public_visibility_status_at_finalization is null
            or result_row.feed_eligible is distinct from (
              result_row.final_vote_count > 0
              and not result_row.is_disqualified_at_finalization
            )
            or (result_row.feed_trash and not result_row.feed_eligible)
          )
      ) then
      raise exception using
        message = 'FINALIZED_RESULT_SNAPSHOT_INCOMPLETE';
    end if;

    return jsonb_build_object(
      'cycleId', p_cycle_id,
      'finalStatus', 'finished',
      'rankedSubmissionCount', v_ranked_submission_count,
      'winnerCount', v_winner_count,
      'highestRank', v_highest_rank,
      'alreadyFinalized', true
    );
  end if;

  if v_initial_status not in (
    'voting_closed',
    'finalizing',
    'active'
  ) then
    raise exception using
      message = 'INVALID_CYCLE_STATE',
      detail = 'Cycle status is ' || v_initial_status;
  end if;

  update public.voting_cycles
  set status = 'finalizing'
  where id = p_cycle_id;

  insert into public.cycle_events (
    cycle_id,
    event_type,
    actor_type,
    actor_discord_user_id,
    payload
  )
  select
    p_cycle_id,
    'cycle_finalizing',
    'admin',
    p_actor_discord_user_id,
    jsonb_build_object(
      'phase', 'finalizing',
      'recovery', v_initial_status = 'finalizing'
    )
  where not exists (
    select 1
    from public.cycle_events
    where cycle_id = p_cycle_id
      and event_type = 'cycle_finalizing'
  );

  delete from public.winner_public_profiles
  where cycle_id = p_cycle_id;

  delete from public.cycle_results
  where cycle_id = p_cycle_id;

  with vote_totals as (
    select
      submission.id as submission_id,
      count(vote.id)::integer as final_vote_count,
      coalesce(
        nullif(btrim(submission.public_visibility_status), ''),
        'visible'
      ) as visibility_status
    from public.submissions submission
    left join public.votes vote
      on vote.cycle_id = p_cycle_id
      and vote.submission_id = submission.id
    where submission.cycle_id = p_cycle_id
      and coalesce(submission.is_disqualified, false) = false
    group by submission.id, submission.public_visibility_status
  ), ranked as (
    select
      submission_id,
      final_vote_count,
      dense_rank() over (
        order by final_vote_count desc
      )::integer as dense_rank,
      visibility_status
    from vote_totals
  ), positive_tier_sizes as (
    select
      final_vote_count,
      count(*)::integer as tier_size
    from ranked
    where final_vote_count > 0
    group by final_vote_count
  ), positive_tiers as (
    select
      final_vote_count,
      sum(tier_size) over (
        order by final_vote_count asc
        rows between unbounded preceding and current row
      )::integer as cumulative_size,
      sum(tier_size) over ()::integer as positive_submission_count
    from positive_tier_sizes
  )
  insert into public.cycle_results (
    cycle_id,
    submission_id,
    vote_count,
    is_winner,
    rank,
    final_vote_count,
    rank_in_cycle,
    tie_group,
    finalized_at,
    feed_eligible,
    feed_trash,
    feed_classification_version,
    is_disqualified_at_finalization,
    public_visibility_status_at_finalization
  )
  select
    p_cycle_id,
    ranked.submission_id,
    ranked.final_vote_count,
    ranked.dense_rank = 1,
    ranked.dense_rank,
    ranked.final_vote_count,
    ranked.dense_rank,
    ranked.dense_rank,
    v_finalized_at,
    ranked.final_vote_count > 0,
    coalesce(
      positive_tier.cumulative_size <=
        floor(positive_tier.positive_submission_count * 0.10)::integer,
      false
    ),
    1,
    false,
    ranked.visibility_status
  from ranked
  left join positive_tiers positive_tier
    on positive_tier.final_vote_count = ranked.final_vote_count;

  get diagnostics v_ranked_submission_count = row_count;

  if v_ranked_submission_count = 0 then
    raise exception using
      message = 'NO_COMPETITION_ELIGIBLE_SUBMISSIONS';
  end if;

  select
    count(*) filter (where rank_in_cycle = 1)::integer,
    coalesce(max(rank_in_cycle), 0)::integer
  into v_winner_count, v_highest_rank
  from public.cycle_results
  where cycle_id = p_cycle_id;

  if v_winner_count = 0 then
    raise exception using message = 'NO_FINALIZATION_WINNER';
  end if;

  if exists (
    select 1
    from public.cycle_results result_row
    where result_row.cycle_id = p_cycle_id
      and result_row.rank_in_cycle = 1
      and not exists (
        select 1
        from public.submission_private_data private_data
        where private_data.submission_id = result_row.submission_id
      )
  ) then
    raise exception using message = 'WINNER_PRIVATE_DATA_MISSING';
  end if;

  insert into public.winner_public_profiles (
    cycle_id,
    submission_id,
    x_username,
    wallet_address,
    payout_choice,
    split_percent,
    charity,
    win_share,
    wall,
    vote_count,
    r2_key
  )
  select
    p_cycle_id,
    result_row.submission_id,
    coalesce(
      private_data.x_username,
      submission.discord_username_at_upload,
      'unknown'
    ),
    private_data.wallet_address,
    private_data.payout_choice,
    private_data.split_percent,
    private_data.charity,
    1.0 / v_winner_count,
    case
      when private_data.payout_choice = 'donate' then 'fame'
      when private_data.payout_choice = 'split'
        and coalesce(private_data.split_percent, 100) < 100
      then 'fame'
      else 'shame'
    end,
    result_row.final_vote_count,
    submission.r2_key
  from public.cycle_results result_row
  join public.submissions submission
    on submission.id = result_row.submission_id
  join lateral (
    select
      private_row.x_username,
      private_row.wallet_address,
      private_row.payout_choice,
      private_row.split_percent,
      private_row.charity
    from public.submission_private_data private_row
    where private_row.submission_id = result_row.submission_id
    order by private_row.id desc
    limit 1
  ) as private_data on true
  where result_row.cycle_id = p_cycle_id
    and result_row.rank_in_cycle = 1;

  update public.voting_cycles
  set
    status = 'finished',
    winners_published = true,
    finalized_at = v_finalized_at,
    results_published_at = v_finalized_at,
    ended_at = coalesce(ended_at, v_finalized_at)
  where id = p_cycle_id;

  update public.cycle_sponsorships
  set
    ends_at = coalesce(ends_at, v_finalized_at),
    updated_at = v_finalized_at
  where cycle_id = p_cycle_id;

  update public.app_config
  set value = null
  where key in ('cycle_end_at', 'cycle_theme');

  insert into public.cycle_events (
    cycle_id,
    event_type,
    actor_type,
    actor_discord_user_id,
    payload
  )
  select
    p_cycle_id,
    'cycle_completed',
    'admin',
    p_actor_discord_user_id,
    jsonb_build_object(
      'phase', 'finished',
      'finalized_at', v_finalized_at,
      'ranked_submissions', v_ranked_submission_count,
      'winners', v_winner_count,
      'highest_rank', v_highest_rank
    )
  where not exists (
    select 1
    from public.cycle_events
    where cycle_id = p_cycle_id
      and event_type = 'cycle_completed'
  );

  insert into public.admin_action_logs (
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    meta
  )
  select
    'admin',
    p_actor_discord_user_id,
    'cycle_finalized',
    'cycle',
    p_cycle_id::text,
    jsonb_build_object(
      'ranked_submissions', v_ranked_submission_count,
      'winners', v_winner_count,
      'highest_rank', v_highest_rank,
      'finalized_at', v_finalized_at,
      'feed_classification_version', 1
    )
  where not exists (
    select 1
    from public.admin_action_logs
    where action = 'cycle_finalized'
      and target_type = 'cycle'
      and target_id = p_cycle_id::text
  );

  return jsonb_build_object(
    'cycleId', p_cycle_id,
    'finalStatus', 'finished',
    'rankedSubmissionCount', v_ranked_submission_count,
    'winnerCount', v_winner_count,
    'highestRank', v_highest_rank,
    'alreadyFinalized', false
  );
end;
$function$;

alter function public.finalize_cycle(bigint, text) owner to postgres;
revoke all on function public.finalize_cycle(bigint, text)
  from public, anon, authenticated, service_role, discord_bot;

comment on function public.finalize_cycle(bigint, text) is
  'Transactionally finalizes one voting_closed/finalizing Cycle and atomically freezes positive-Vote Feed eligibility, dense rank, tie-safe Trash, classification version, and audit snapshots.';

drop function public.commit_submission_upload(
  uuid, uuid, text, text, integer, text
);

create function public.commit_submission_upload(
  p_operation_id uuid,
  p_session_id uuid,
  p_wallet_address text,
  p_payout_choice text,
  p_split_percent integer,
  p_charity text,
  p_media_width integer,
  p_media_height integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz;
  v_discord_user_id text;
  v_operation public.submission_upload_operations%rowtype;
  v_cycle public.voting_cycles%rowtype;
  v_user public.user_logs%rowtype;
  v_membership public.discord_member_state%rowtype;
  v_rules_version integer;
  v_submission_id bigint;
  v_social_snapshot_count integer := 0;
  v_wallet_address text := coalesce(btrim(p_wallet_address), '');
  v_charity text := nullif(btrim(p_charity), '');
  v_used integer;
  v_last_completed_at timestamptz;
  v_next_allowed_at timestamptz;
  v_cooldown_remaining integer := 0;
begin
  if p_operation_id is null or p_session_id is null then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  if p_media_width is null
    or p_media_height is null
    or p_media_width not between 1 and 2400
    or p_media_height not between 1 and 16383
    or p_media_width::bigint * p_media_height::bigint > 24000000 then
    return jsonb_build_object('outcome', 'invalid_media_metadata');
  end if;

  if p_payout_choice is null
    or p_payout_choice not in ('keep', 'donate', 'split')
    or length(v_wallet_address) > 512
    or length(coalesce(v_charity, '')) > 256
    or (
      p_payout_choice = 'keep'
      and (
        v_wallet_address = ''
        or p_split_percent is not null
        or v_charity is not null
      )
    )
    or (
      p_payout_choice = 'donate'
      and (
        v_wallet_address <> ''
        or p_split_percent is not null
        or v_charity is null
      )
    )
    or (
      p_payout_choice = 'split'
      and (
        v_wallet_address = ''
        or p_split_percent is null
        or p_split_percent <= 0
        or p_split_percent >= 100
        or v_charity is null
      )
    ) then
    return jsonb_build_object('outcome', 'invalid_private_data');
  end if;

  select session.discord_user_id
  into v_discord_user_id
  from public.sessions session
  where session.id = p_session_id
    and session.revoked_at is null;

  if not found then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select operation.*
  into v_operation
  from public.submission_upload_operations operation
  where operation.id = p_operation_id
    and operation.discord_user_id = v_discord_user_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_operation.status = 'completed' then
    return jsonb_build_object(
      'outcome', 'already_completed',
      'operationId', v_operation.id,
      'cycleId', v_operation.cycle_id,
      'submissionId', v_operation.submission_id
    );
  end if;

  if v_operation.status <> 'r2_uploaded' then
    return jsonb_build_object(
      'outcome', 'invalid_state',
      'status', v_operation.status
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'submission-upload-user-cycle:' ||
      v_discord_user_id || ':' || v_operation.cycle_id::text,
      0
    )
  );

  select cycle.*
  into v_cycle
  from public.voting_cycles cycle
  where cycle.id = v_operation.cycle_id
  for update;

  if not found or v_cycle.status::text not in ('submission_open', 'active') then
    return jsonb_build_object('outcome', 'cycle_not_open');
  end if;

  v_now := clock_timestamp();

  select users.*
  into v_user
  from public.user_logs users
  where users.discord_user_id = v_discord_user_id;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  if v_user.is_banned then
    return jsonb_build_object('outcome', 'banned');
  end if;

  if coalesce(v_user.upload_fail_count, 0) >= 5 then
    return jsonb_build_object('outcome', 'rate_limited');
  end if;

  select rules.current_version
  into v_rules_version
  from public.rules_meta rules
  where rules.id = 1;

  if not found then
    return jsonb_build_object('outcome', 'dependency_unavailable');
  end if;

  if v_user.accepted_rules_version is distinct from v_rules_version then
    return jsonb_build_object('outcome', 'rules_not_accepted');
  end if;

  select membership.*
  into v_membership
  from public.discord_member_state membership
  where membership.discord_user_id = v_discord_user_id;

  if not found or not coalesce(v_membership.is_in_discord, false) then
    return jsonb_build_object('outcome', 'not_in_discord');
  end if;

  if v_membership.discord_joined_at is null
    or v_membership.discord_joined_at > v_now - interval '10 minutes' then
    return jsonb_build_object('outcome', 'joined_too_recently');
  end if;

  select count(*)::integer
  into v_used
  from public.submissions submission
  where submission.cycle_id = v_operation.cycle_id
    and submission.discord_user_id = v_discord_user_id;

  if v_used >= v_cycle.submissions_per_user then
    return jsonb_build_object(
      'outcome', 'upload_limit_reached',
      'used', v_used,
      'limit', v_cycle.submissions_per_user,
      'remaining', 0
    );
  end if;

  select max(operation.completed_at)
  into v_last_completed_at
  from public.submission_upload_operations operation
  where operation.discord_user_id = v_discord_user_id
    and operation.cycle_id = v_operation.cycle_id
    and operation.status = 'completed';

  if v_last_completed_at is not null then
    v_next_allowed_at := v_last_completed_at
      + make_interval(secs => v_cycle.upload_success_cooldown_seconds);
    v_cooldown_remaining := greatest(
      0,
      ceil(extract(epoch from (v_next_allowed_at - v_now)))::integer
    );
  end if;

  if v_cooldown_remaining > 0 then
    return jsonb_build_object(
      'outcome', 'cooldown_active',
      'used', v_used,
      'limit', v_cycle.submissions_per_user,
      'remaining', v_cycle.submissions_per_user - v_used,
      'cooldownRemainingSeconds', v_cooldown_remaining,
      'nextUploadAllowedAt', v_next_allowed_at
    );
  end if;

  if v_operation.storage_provider <> 'r2'
    or v_operation.storage_key !~ (
      '^' || v_operation.cycle_id::text || '/[0-9A-Fa-f-]{36}[.]webp$'
    )
    or v_operation.media_type <> 'image/webp'
    or v_operation.media_bytes <= 0
    or v_operation.content_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('outcome', 'invalid_media_metadata');
  end if;

  insert into public.submissions (
    cycle_id,
    discord_user_id,
    r2_key,
    discord_username_at_upload,
    media_width,
    media_height
  ) values (
    v_operation.cycle_id,
    v_discord_user_id,
    v_operation.storage_key,
    coalesce(v_user.current_discord_username, 'unknown'),
    p_media_width,
    p_media_height
  )
  returning id into v_submission_id;

  insert into public.submission_private_data (
    submission_id,
    x_username,
    wallet_address,
    payout_choice,
    split_percent,
    charity
  ) values (
    v_submission_id,
    null,
    v_wallet_address,
    p_payout_choice,
    case when p_payout_choice = 'split' then p_split_percent else null end,
    case when p_payout_choice in ('donate', 'split') then v_charity else null end
  );

  if v_user.show_socials_on_submissions then
    insert into public.submission_social_links (
      submission_id,
      discord_user_id,
      platform,
      display_label,
      profile_url,
      is_verified_snapshot,
      source_user_social_link_id
    )
    select
      v_submission_id,
      v_discord_user_id,
      social.platform,
      case
        when nullif(btrim(social.handle), '') is not null
          and not (
            social.platform = 'facebook'
            and social.handle like 'id:%'
          )
          then social.handle
        else social.profile_url
      end,
      social.profile_url,
      true,
      social.id
    from public.user_social_links social
    where social.discord_user_id = v_discord_user_id
      and social.is_verified = true
    order by social.created_at, social.id;

    get diagnostics v_social_snapshot_count = row_count;
  end if;

  insert into public.upload_logs (
    cycle_id,
    discord_user_id,
    submission_id,
    status,
    reason
  ) values (
    v_operation.cycle_id::text,
    v_discord_user_id,
    v_submission_id::text,
    'success',
    null
  );

  update public.submission_upload_operations operation
  set
    status = 'completed',
    submission_id = v_submission_id,
    cleanup_required = false,
    last_error_code = null,
    updated_at = v_now,
    last_attempt_at = v_now,
    completed_at = v_now
  where operation.id = v_operation.id;

  v_used := v_used + 1;
  v_next_allowed_at := v_now
    + make_interval(secs => v_cycle.upload_success_cooldown_seconds);

  return jsonb_build_object(
    'outcome', 'completed',
    'operationId', v_operation.id,
    'cycleId', v_operation.cycle_id,
    'submissionId', v_submission_id,
    'socialSnapshotCount', v_social_snapshot_count,
    'used', v_used,
    'limit', v_cycle.submissions_per_user,
    'remaining', greatest(v_cycle.submissions_per_user - v_used, 0),
    'cooldownRemainingSeconds', case
      when v_used < v_cycle.submissions_per_user
        then v_cycle.upload_success_cooldown_seconds
      else 0
    end,
    'nextUploadAllowedAt', case
      when v_used < v_cycle.submissions_per_user then v_next_allowed_at
      else null
    end
  );
end;
$function$;

alter function public.commit_submission_upload(
  uuid, uuid, text, text, integer, text, integer, integer
) owner to postgres;
revoke all on function public.commit_submission_upload(
  uuid, uuid, text, text, integer, text, integer, integer
) from public, anon, authenticated, service_role, discord_bot;
grant execute on function public.commit_submission_upload(
  uuid, uuid, text, text, integer, text, integer, integer
) to service_role;

comment on function public.commit_submission_upload(
  uuid, uuid, text, text, integer, text, integer, integer
) is
  'Atomically commits one validated processed Submission medium, including its authoritative WebP dimensions, while preserving quota, cooldown, participation, replay, Social snapshot, and audit contracts.';

do $postflight$
declare
  v_bad_security_count integer;
  v_finalize_count integer;
  v_managed_finalize_count integer;
  v_commit_count integer;
  v_finalize_grantees text[];
  v_managed_finalize_grantees text[];
  v_commit_grantees text[];
  v_snapshot_guard_grantees text[];
  v_cycle_results_nonselect_grantees text[];
  v_cycle_results_select_grantees text[];
begin
  select count(*)
  into v_finalize_count
  from pg_proc function_row
  join pg_namespace namespace_row
    on namespace_row.oid = function_row.pronamespace
  where namespace_row.nspname = 'public'
    and function_row.proname = 'finalize_cycle';

  select count(*)
  into v_managed_finalize_count
  from pg_proc function_row
  join pg_namespace namespace_row
    on namespace_row.oid = function_row.pronamespace
  where namespace_row.nspname = 'public'
    and function_row.proname = 'finalize_cycle_managed';

  select count(*)
  into v_commit_count
  from pg_proc function_row
  join pg_namespace namespace_row
    on namespace_row.oid = function_row.pronamespace
  where namespace_row.nspname = 'public'
    and function_row.proname = 'commit_submission_upload';

  select count(*)
  into v_bad_security_count
  from pg_proc function_row
  join pg_namespace namespace_row
    on namespace_row.oid = function_row.pronamespace
  where function_row.oid in (
      'public.finalize_cycle(bigint,text)'::regprocedure,
      'public.finalize_cycle_managed(bigint,text)'::regprocedure,
      'public.commit_submission_upload(uuid,uuid,text,text,integer,text,integer,integer)'::regprocedure
    )
    and (
      namespace_row.nspname <> 'public'
      or pg_get_userbyid(function_row.proowner) <> 'postgres'
      or not function_row.prosecdef
      or function_row.proconfig is distinct from
        array['search_path=public, pg_temp']::text[]
    );

  if v_finalize_count <> 1
    or v_managed_finalize_count <> 1
    or v_commit_count <> 1
    or v_bad_security_count <> 0
    or to_regprocedure(
      'public.commit_submission_upload(uuid,uuid,text,text,integer,text)'
    ) is not null
    or to_regprocedure(
      'public.commit_submission_upload(uuid,uuid,text,text,integer,text,integer,integer)'
    ) is null then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_OVERLOAD_OR_SECURITY_POSTFLIGHT_FAILED';
  end if;

  if not exists (
      select 1
      from pg_proc function_row
      join pg_namespace namespace_row
        on namespace_row.oid = function_row.pronamespace
      where function_row.oid =
        'public.prevent_cycle_result_snapshot_mutation()'::regprocedure
        and namespace_row.nspname = 'public'
        and pg_get_userbyid(function_row.proowner) = 'postgres'
        and not function_row.prosecdef
        and function_row.proconfig is not distinct from
          array['search_path=public, pg_temp']::text[]
    )
    or not exists (
      select 1
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.cycle_results'::regclass
        and trigger_row.tgname = 'cycle_results_snapshot_immutable'
        and trigger_row.tgenabled = 'O'
        and not trigger_row.tgisinternal
    )
    or has_function_privilege(
      'anon', 'public.prevent_cycle_result_snapshot_mutation()', 'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.prevent_cycle_result_snapshot_mutation()',
      'execute'
    )
    or has_function_privilege(
      'service_role',
      'public.prevent_cycle_result_snapshot_mutation()',
      'execute'
    )
    or has_function_privilege(
      'discord_bot',
      'public.prevent_cycle_result_snapshot_mutation()',
      'execute'
    ) then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_IMMUTABILITY_POSTFLIGHT_FAILED';
  end if;

  select array_agg(grantee_name order by grantee_name)
  into v_finalize_grantees
  from (
    select distinct case
      when privilege.grantee = 0 then 'PUBLIC'
      else pg_get_userbyid(privilege.grantee)
    end as grantee_name
    from pg_proc function_row
    cross join lateral aclexplode(coalesce(
      function_row.proacl,
      acldefault('f', function_row.proowner)
    )) privilege
    where function_row.oid =
      'public.finalize_cycle(bigint,text)'::regprocedure
      and privilege.privilege_type = 'EXECUTE'
  ) grantee;

  select array_agg(grantee_name order by grantee_name)
  into v_managed_finalize_grantees
  from (
    select distinct case
      when privilege.grantee = 0 then 'PUBLIC'
      else pg_get_userbyid(privilege.grantee)
    end as grantee_name
    from pg_proc function_row
    cross join lateral aclexplode(coalesce(
      function_row.proacl,
      acldefault('f', function_row.proowner)
    )) privilege
    where function_row.oid =
      'public.finalize_cycle_managed(bigint,text)'::regprocedure
      and privilege.privilege_type = 'EXECUTE'
  ) grantee;

  select array_agg(grantee_name order by grantee_name)
  into v_commit_grantees
  from (
    select distinct case
      when privilege.grantee = 0 then 'PUBLIC'
      else pg_get_userbyid(privilege.grantee)
    end as grantee_name
    from pg_proc function_row
    cross join lateral aclexplode(coalesce(
      function_row.proacl,
      acldefault('f', function_row.proowner)
    )) privilege
    where function_row.oid =
      'public.commit_submission_upload(uuid,uuid,text,text,integer,text,integer,integer)'::regprocedure
      and privilege.privilege_type = 'EXECUTE'
  ) grantee;

  select array_agg(grantee_name order by grantee_name)
  into v_snapshot_guard_grantees
  from (
    select distinct case
      when privilege.grantee = 0 then 'PUBLIC'
      else pg_get_userbyid(privilege.grantee)
    end as grantee_name
    from pg_proc function_row
    cross join lateral aclexplode(coalesce(
      function_row.proacl,
      acldefault('f', function_row.proowner)
    )) privilege
    where function_row.oid =
      'public.prevent_cycle_result_snapshot_mutation()'::regprocedure
      and privilege.privilege_type = 'EXECUTE'
  ) grantee;

  if v_finalize_grantees is distinct from array['postgres']::text[]
    or v_managed_finalize_grantees is distinct from
      array['postgres', 'service_role']::text[]
    or v_commit_grantees is distinct from
      array['postgres', 'service_role']::text[]
    or v_snapshot_guard_grantees is distinct from
      array['postgres']::text[] then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_EXACT_FUNCTION_ACL_POSTFLIGHT_FAILED';
  end if;

  select array_agg(grantee_name order by grantee_name)
  into v_cycle_results_nonselect_grantees
  from (
    select distinct case
      when privilege.grantee = 0 then 'PUBLIC'
      else pg_get_userbyid(privilege.grantee)
    end as grantee_name
    from pg_class class_row
    cross join lateral aclexplode(coalesce(
      class_row.relacl,
      acldefault('r', class_row.relowner)
    )) privilege
    where class_row.oid = 'public.cycle_results'::regclass
      and privilege.privilege_type <> 'SELECT'
  ) grantee;

  select array_agg(grantee_name order by grantee_name)
  into v_cycle_results_select_grantees
  from (
    select distinct case
      when privilege.grantee = 0 then 'PUBLIC'
      else pg_get_userbyid(privilege.grantee)
    end as grantee_name
    from pg_class class_row
    cross join lateral aclexplode(coalesce(
      class_row.relacl,
      acldefault('r', class_row.relowner)
    )) privilege
    where class_row.oid = 'public.cycle_results'::regclass
      and privilege.privilege_type = 'SELECT'
  ) grantee;

  if (
      select pg_get_userbyid(class_row.relowner)
      from pg_class class_row
      where class_row.oid = 'public.cycle_results'::regclass
    ) <> 'postgres'
    or v_cycle_results_nonselect_grantees is distinct from
      array['postgres']::text[]
    or v_cycle_results_select_grantees is distinct from
      array['postgres', 'service_role']::text[]
    or has_table_privilege(
      'service_role', 'public.cycle_results', 'INSERT,UPDATE,DELETE,TRUNCATE'
    ) then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_EXACT_TABLE_ACL_POSTFLIGHT_FAILED';
  end if;

  if has_function_privilege(
      'anon', 'public.finalize_cycle(bigint,text)', 'execute'
    )
    or has_function_privilege(
      'authenticated', 'public.finalize_cycle(bigint,text)', 'execute'
    )
    or has_function_privilege(
      'service_role', 'public.finalize_cycle(bigint,text)', 'execute'
    )
    or has_function_privilege(
      'discord_bot', 'public.finalize_cycle(bigint,text)', 'execute'
    )
    or has_function_privilege(
      'anon',
      'public.commit_submission_upload(uuid,uuid,text,text,integer,text,integer,integer)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.commit_submission_upload(uuid,uuid,text,text,integer,text,integer,integer)',
      'execute'
    )
    or has_function_privilege(
      'discord_bot',
      'public.commit_submission_upload(uuid,uuid,text,text,integer,text,integer,integer)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.commit_submission_upload(uuid,uuid,text,text,integer,text,integer,integer)',
      'execute'
    )
    or not has_function_privilege(
      'service_role', 'public.finalize_cycle_managed(bigint,text)', 'execute'
    ) then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_FUNCTION_ACL_POSTFLIGHT_FAILED';
  end if;

  if (select count(*) from public.capability_catalog) <>
      (select capability_count from community_feed_foundation_preflight)
    or (select count(*) from public.team_role_capabilities) <>
      (select grant_count from community_feed_foundation_preflight)
    or (select count(*) from public.cycle_results) <>
      (select result_count from community_feed_foundation_preflight)
    or (select count(*) from public.submissions) <>
      (select submission_count from community_feed_foundation_preflight) then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_FACT_OR_GRANT_POSTFLIGHT_FAILED';
  end if;

  if exists (
      select 1
      from public.cycle_results result_row
      where result_row.feed_classification_version <> 1
        or result_row.feed_eligible is distinct from (
          result_row.final_vote_count > 0
          and not result_row.is_disqualified_at_finalization
        )
        or (result_row.feed_trash and not result_row.feed_eligible)
    )
    or exists (
      with positive_tier_sizes as (
        select
          result_row.cycle_id,
          result_row.final_vote_count,
          count(*)::integer as tier_size
        from public.cycle_results result_row
        where result_row.final_vote_count > 0
        group by result_row.cycle_id, result_row.final_vote_count
      ), positive_tiers as (
        select
          tier.cycle_id,
          tier.final_vote_count,
          sum(tier.tier_size) over (
            partition by tier.cycle_id
            order by tier.final_vote_count asc
            rows between unbounded preceding and current row
          )::integer as cumulative_size,
          sum(tier.tier_size) over (
            partition by tier.cycle_id
          )::integer as positive_submission_count
        from positive_tier_sizes tier
      )
      select 1
      from public.cycle_results result_row
      left join positive_tiers tier
        on tier.cycle_id = result_row.cycle_id
       and tier.final_vote_count = result_row.final_vote_count
      where result_row.feed_trash is distinct from coalesce(
        tier.cumulative_size <=
          floor(tier.positive_submission_count * 0.10)::integer,
        false
      )
    ) then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_CLASSIFICATION_POSTFLIGHT_FAILED';
  end if;

  if to_regclass('public.cycle_results_feed_all_cursor_idx') is null
    or to_regclass('public.cycle_results_feed_trash_cursor_idx') is null
    or to_regclass('public.cycle_results_feed_top10_cursor_idx') is null
    or to_regclass('public.submissions_live_feed_cursor_idx') is null
    or to_regclass('public.cycle_results_feed_cursor_idx') is not null then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_INDEX_POSTFLIGHT_FAILED';
  end if;

  if position(
      '(finalized_at DESC, cycle_id DESC, rank_in_cycle, submission_id)'
      in pg_get_indexdef(
        'public.cycle_results_feed_all_cursor_idx'::regclass
      )
    ) = 0
    or position(
      'feed_eligible AND (NOT feed_trash)'
      in pg_get_indexdef(
        'public.cycle_results_feed_all_cursor_idx'::regclass
      )
    ) = 0
    or position(
      '(finalized_at DESC, cycle_id DESC, rank_in_cycle, submission_id)'
      in pg_get_indexdef(
        'public.cycle_results_feed_trash_cursor_idx'::regclass
      )
    ) = 0
    or position(
      'feed_eligible AND feed_trash'
      in pg_get_indexdef(
        'public.cycle_results_feed_trash_cursor_idx'::regclass
      )
    ) = 0
    or position(
      '(finalized_at DESC, cycle_id DESC, rank_in_cycle, submission_id)'
      in pg_get_indexdef(
        'public.cycle_results_feed_top10_cursor_idx'::regclass
      )
    ) = 0
    or position(
      '(feed_eligible AND (rank_in_cycle <= 10))'
      in pg_get_indexdef(
        'public.cycle_results_feed_top10_cursor_idx'::regclass
      )
    ) = 0
    or position(
      '(cycle_id, created_at DESC, id DESC)'
      in pg_get_indexdef(
        'public.submissions_live_feed_cursor_idx'::regclass
      )
    ) = 0
    or position(
      $predicate$((public_visibility_status = 'visible'::text) AND (COALESCE(is_disqualified, false) = false))$predicate$
      in pg_get_indexdef(
        'public.submissions_live_feed_cursor_idx'::regclass
      )
    ) = 0 then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_FEED_INDEX_DEFINITION_POSTFLIGHT_FAILED';
  end if;
end;
$postflight$;

commit;

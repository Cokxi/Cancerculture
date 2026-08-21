begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 39
    or (select count(*) from public.capability_catalog where is_active) <> 35
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'winners.recipient_corrections.manage'
        and implementation_version = 2
        and definition_hash =
          'e569fa66e8f9c2794fe030c4e034ebf8a7e458c6ddccf2a868d2cac1fd5ea2bd'
        and is_active
        and assignable_to_non_admin
    )
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key = 'community.polls.manage'
    )
    or to_regprocedure('extensions.hmac(bytea,bytea,text)') is null
    or to_regprocedure('extensions.gen_random_bytes(integer)') is null
    or to_regclass('public.sessions') is null
    or to_regclass('public.user_logs') is null
    or to_regclass('public.discord_member_state') is null
    or to_regprocedure('public.get_cancerculture_session_access(uuid)') is null
    or to_regclass('public.community_polls') is not null
    or to_regclass('public.community_poll_options') is not null
    or to_regclass('public.community_poll_participation_keys') is not null
    or to_regclass('public.community_poll_participants') is not null
    or to_regclass('public.community_poll_admin_events') is not null
    or to_regclass('public.community_poll_mutation_requests') is not null
    or exists (
      select 1 from public.capability_catalog
      where key = 'community.polls.manage'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'COMMUNITY_POLLS_BASELINE_MISMATCH';
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
  'community.polls.manage',
  'Manage Community Polls',
  'Create, activate, close, abort, replace, and review generic Community polls with immutable live content, automatic tie runoffs, and append-only administration history.',
  'Community',
  array[
    'Create a bounded draft with a question, explanatory context, two to eight ordered options, and an allowlisted duration.',
    'Activate an immutable poll, close it after its database deadline, and create a linked 24-hour runoff automatically when the lead is tied.',
    'Abort or replace a poll through expected-version, idempotent, append-only audited transitions.',
    'Review the protected poll administration history without access to a voter identity or voter-to-option list.'
  ]::text[],
  array[
    'Seeing live results before the managing account has voted or seeing who voted for an option.',
    'Changing or withdrawing a vote, editing an activated poll, choosing an Admin tiebreak, or changing a completed result.',
    'Publishing Homepage Info Boxes, configuring Push, managing notification preferences, or sending Production notifications.',
    'Transferring SOL, changing Wallets, prize pools, Claims, payout data, organizations, or public payout records.',
    'Managing roles, grants, Team membership, Owner access, or unrelated content and logs.'
  ]::text[],
  'high',
  true,
  true,
  1,
  '042a289cd77aca920ab6d07abec54cec1b380423c90aa3693b7fbb11537a9a7e'
);

create table public.community_polls (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null unique default gen_random_uuid(),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'closed', 'aborted', 'replaced')),
  row_version bigint not null default 1 check (row_version > 0),
  question text not null
    check (char_length(question) between 10 and 300 and question = btrim(question)),
  context text not null default ''
    check (char_length(context) <= 3000 and context = btrim(context)),
  duration_hours integer not null default 24
    check (duration_hours in (24, 48, 72, 168)),
  root_poll_id uuid not null,
  parent_poll_id uuid,
  replacement_for_poll_id uuid,
  created_by text not null
    check (created_by ~ '^[0-9]+$' and char_length(created_by) <= 100),
  created_at timestamptz not null default transaction_timestamp(),
  activated_at timestamptz,
  deadline_at timestamptz,
  closed_at timestamptz,
  outcome text check (outcome in ('winner', 'runoff', 'no_result', 'aborted', 'replaced')),
  winning_option_id uuid,
  tally_updated_at timestamptz,
  constraint community_polls_timing_state_check check (
    (status = 'draft' and activated_at is null and deadline_at is null and closed_at is null and outcome is null)
    or (status = 'active' and activated_at is not null and deadline_at > activated_at and closed_at is null and outcome is null)
    or (status = 'closed' and activated_at is not null and deadline_at > activated_at and closed_at is not null and outcome in ('winner', 'runoff', 'no_result'))
    or (status in ('aborted', 'replaced') and closed_at is not null and outcome = status)
  ),
  constraint community_polls_winner_state_check check (
    (outcome = 'winner' and winning_option_id is not null)
    or (outcome is distinct from 'winner' and winning_option_id is null)
  ),
  constraint community_polls_parent_shape_check check (
    parent_poll_id is null or parent_poll_id <> id
  ),
  constraint community_polls_replacement_shape_check check (
    replacement_for_poll_id is null or replacement_for_poll_id <> id
  )
);

alter table public.community_polls
  add constraint community_polls_root_poll_fk
  foreign key (root_poll_id) references public.community_polls(id),
  add constraint community_polls_parent_poll_fk
  foreign key (parent_poll_id) references public.community_polls(id),
  add constraint community_polls_replacement_for_poll_fk
  foreign key (replacement_for_poll_id) references public.community_polls(id);

create unique index community_polls_one_replacement_idx
  on public.community_polls(replacement_for_poll_id)
  where replacement_for_poll_id is not null;
create index community_polls_active_deadline_idx
  on public.community_polls(deadline_at, public_id)
  where status = 'active';
create index community_polls_history_idx
  on public.community_polls(closed_at desc, public_id)
  where status in ('closed', 'aborted', 'replaced');

create table public.community_poll_options (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null unique default gen_random_uuid(),
  poll_id uuid not null references public.community_polls(id),
  display_order integer not null check (display_order between 1 and 8),
  label text not null
    check (char_length(label) between 1 and 160 and label = btrim(label)),
  vote_count bigint not null default 0 check (vote_count >= 0),
  tally_updated_at timestamptz,
  unique (poll_id, display_order)
);

create unique index community_poll_options_unique_label_idx
  on public.community_poll_options(poll_id, lower(label));

alter table public.community_polls
  add constraint community_polls_winning_option_fk
  foreign key (winning_option_id) references public.community_poll_options(id);

create table public.community_poll_participation_keys (
  poll_id uuid primary key references public.community_polls(id),
  secret bytea not null check (octet_length(secret) = 32),
  created_at timestamptz not null default transaction_timestamp()
);

create table public.community_poll_participants (
  poll_id uuid not null references public.community_polls(id),
  participant_digest text not null check (participant_digest ~ '^[0-9a-f]{64}$'),
  request_id uuid not null,
  participated_at timestamptz not null default transaction_timestamp(),
  primary key (poll_id, participant_digest)
);

create index community_poll_participants_time_idx
  on public.community_poll_participants(poll_id, participated_at);

create table public.community_poll_admin_events (
  id bigint generated always as identity primary key,
  poll_id uuid not null references public.community_polls(id),
  event_type text not null check (event_type in (
    'created', 'activated', 'closed', 'aborted', 'replaced', 'replacement_created', 'runoff_created'
  )),
  actor_discord_user_id text not null
    check (actor_discord_user_id ~ '^[0-9]+$' and char_length(actor_discord_user_id) <= 100),
  actor_role text not null check (char_length(actor_role) between 3 and 64),
  request_id uuid not null,
  poll_version bigint not null check (poll_version > 0),
  details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 4000),
  occurred_at timestamptz not null default transaction_timestamp(),
  unique (poll_id, event_type, request_id)
);

create index community_poll_admin_events_poll_idx
  on public.community_poll_admin_events(poll_id, occurred_at, id);

create table public.community_poll_mutation_requests (
  actor_discord_user_id text not null
    check (actor_discord_user_id ~ '^[0-9]+$' and char_length(actor_discord_user_id) <= 100),
  request_id uuid not null,
  action text not null check (action in ('create', 'activate', 'close', 'abort', 'replace')),
  target_public_id uuid,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default transaction_timestamp(),
  primary key (actor_discord_user_id, request_id, action)
);

alter table public.community_polls enable row level security;
alter table public.community_poll_options enable row level security;
alter table public.community_poll_participation_keys enable row level security;
alter table public.community_poll_participants enable row level security;
alter table public.community_poll_admin_events enable row level security;
alter table public.community_poll_mutation_requests enable row level security;

revoke all on table public.community_polls from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.community_poll_options from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.community_poll_participation_keys from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.community_poll_participants from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.community_poll_admin_events from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.community_poll_mutation_requests from public, anon, authenticated, discord_bot, service_role;
revoke all on sequence public.community_poll_admin_events_id_seq from public, anon, authenticated, discord_bot, service_role;

create function public.protect_community_poll_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  raise exception using errcode = '55000', message = 'COMMUNITY_POLL_HISTORY_IS_APPEND_ONLY';
end;
$function$;

create function public.protect_community_poll_row()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'COMMUNITY_POLL_DELETE_FORBIDDEN';
  end if;

  if old.status = 'active'
    and new.status = old.status
    and new.row_version = old.row_version
    and new.tally_updated_at is not null
    and (old.tally_updated_at is null or new.tally_updated_at >= old.tally_updated_at)
    and new.public_id = old.public_id
    and new.question = old.question
    and new.context = old.context
    and new.duration_hours = old.duration_hours
    and new.root_poll_id = old.root_poll_id
    and new.parent_poll_id is not distinct from old.parent_poll_id
    and new.replacement_for_poll_id is not distinct from old.replacement_for_poll_id
    and new.created_by = old.created_by
    and new.created_at = old.created_at
    and new.activated_at = old.activated_at
    and new.deadline_at = old.deadline_at
    and new.closed_at is not distinct from old.closed_at
    and new.outcome is not distinct from old.outcome
    and new.winning_option_id is not distinct from old.winning_option_id
  then
    return new;
  end if;

  if old.status <> 'draft' and (
    new.public_id is distinct from old.public_id
    or new.question is distinct from old.question
    or new.context is distinct from old.context
    or new.duration_hours is distinct from old.duration_hours
    or new.root_poll_id is distinct from old.root_poll_id
    or new.parent_poll_id is distinct from old.parent_poll_id
    or new.replacement_for_poll_id is distinct from old.replacement_for_poll_id
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or new.activated_at is distinct from old.activated_at
    or new.deadline_at is distinct from old.deadline_at
  ) then
    raise exception using errcode = '55000', message = 'COMMUNITY_POLL_ACTIVATED_CONTENT_IMMUTABLE';
  end if;

  if new.row_version <> old.row_version + 1 then
    raise exception using errcode = '55000', message = 'COMMUNITY_POLL_VERSION_INVALID';
  end if;

  return new;
end;
$function$;

create function public.protect_community_poll_option()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_status text;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'COMMUNITY_POLL_OPTION_DELETE_FORBIDDEN';
  end if;

  select status into v_status from public.community_polls where id = old.poll_id;
  if v_status <> 'active'
    or new.id is distinct from old.id
    or new.public_id is distinct from old.public_id
    or new.poll_id is distinct from old.poll_id
    or new.display_order is distinct from old.display_order
    or new.label is distinct from old.label
    or new.vote_count <> old.vote_count + 1
    or new.tally_updated_at is null
    or new.tally_updated_at < old.tally_updated_at
  then
    raise exception using errcode = '55000', message = 'COMMUNITY_POLL_OPTION_IMMUTABLE';
  end if;

  return new;
end;
$function$;

create trigger community_polls_protect_update
before update on public.community_polls
for each row execute function public.protect_community_poll_row();
create trigger community_polls_protect_delete
before delete on public.community_polls
for each row execute function public.protect_community_poll_row();
create trigger community_poll_options_protect_update
before update on public.community_poll_options
for each row execute function public.protect_community_poll_option();
create trigger community_poll_options_protect_delete
before delete on public.community_poll_options
for each row execute function public.protect_community_poll_option();
create trigger community_poll_participation_keys_no_update
before update or delete on public.community_poll_participation_keys
for each row execute function public.protect_community_poll_append_only();
create trigger community_poll_participants_no_update
before update or delete on public.community_poll_participants
for each row execute function public.protect_community_poll_append_only();
create trigger community_poll_admin_events_no_update
before update or delete on public.community_poll_admin_events
for each row execute function public.protect_community_poll_append_only();
create trigger community_poll_mutation_requests_no_update
before update or delete on public.community_poll_mutation_requests
for each row execute function public.protect_community_poll_append_only();

create function public.assert_community_poll_capability(
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
    or v_actor_id !~ '^[0-9]+$'
  then
    raise exception using errcode = '42501', message = 'COMMUNITY_POLL_CAPABILITY_FORBIDDEN';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = 'community.polls.manage'
      and is_active
      and assignable_to_non_admin
      and implementation_version = 1
      and definition_hash = '042a289cd77aca920ab6d07abec54cec1b380423c90aa3693b7fbb11537a9a7e'
  ) then
    raise exception using errcode = '55000', message = 'COMMUNITY_POLL_CAPABILITY_DEPENDENCY_UNAVAILABLE';
  end if;

  select member.role into v_actor_role
  from public.team_members member
  join public.team_roles role on role.key = member.role and role.is_active
  where member.discord_user_id = v_actor_id;

  if not found or (
    v_actor_role <> 'admin'
    and not exists (
      select 1
      from public.team_role_capabilities grant_row
      where grant_row.role_key = v_actor_role
        and grant_row.capability_key = 'community.polls.manage'
    )
  ) then
    raise exception using errcode = '42501', message = 'COMMUNITY_POLL_CAPABILITY_FORBIDDEN';
  end if;

  return v_actor_role;
end;
$function$;

create function public.validate_community_poll_options(p_options jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $function$
declare
  v_options jsonb;
begin
  if p_options is null or jsonb_typeof(p_options) <> 'array' then
    raise exception using errcode = '22023', message = 'COMMUNITY_POLL_OPTIONS_INVALID';
  end if;

  if jsonb_array_length(p_options) not between 2 and 8
    or exists (
      select 1 from jsonb_array_elements(p_options) item
      where jsonb_typeof(item) <> 'string'
        or char_length(btrim(item #>> '{}')) not between 1 and 160
    )
  then
    raise exception using errcode = '22023', message = 'COMMUNITY_POLL_OPTIONS_INVALID';
  end if;

  select jsonb_agg(to_jsonb(label) order by ordinal)
  into v_options
  from (
    select btrim(item.value) as label, item.ordinality as ordinal
    from jsonb_array_elements_text(p_options) with ordinality item(value, ordinality)
  ) normalized;

  if (
    select count(distinct lower(item #>> '{}'))
    from jsonb_array_elements(v_options) item
  ) <> jsonb_array_length(v_options) then
    raise exception using errcode = '22023', message = 'COMMUNITY_POLL_OPTIONS_DUPLICATE';
  end if;

  return v_options;
end;
$function$;

create function public.insert_community_poll_draft(
  p_actor_discord_user_id text,
  p_question text,
  p_context text,
  p_duration_hours integer,
  p_options jsonb,
  p_root_poll_id uuid default null,
  p_parent_poll_id uuid default null,
  p_replacement_for_poll_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_poll_id uuid := gen_random_uuid();
  v_options jsonb := public.validate_community_poll_options(p_options);
begin
  if char_length(btrim(coalesce(p_question, ''))) not between 10 and 300
    or char_length(btrim(coalesce(p_context, ''))) > 3000
    or p_duration_hours not in (24, 48, 72, 168)
  then
    raise exception using errcode = '22023', message = 'COMMUNITY_POLL_INPUT_INVALID';
  end if;

  insert into public.community_polls (
    id, question, context, duration_hours, root_poll_id, parent_poll_id,
    replacement_for_poll_id, created_by
  ) values (
    v_poll_id, btrim(p_question), btrim(coalesce(p_context, '')), p_duration_hours,
    coalesce(p_root_poll_id, v_poll_id), p_parent_poll_id,
    p_replacement_for_poll_id, btrim(p_actor_discord_user_id)
  );

  insert into public.community_poll_participation_keys (poll_id, secret)
  values (v_poll_id, extensions.gen_random_bytes(32));

  insert into public.community_poll_options (poll_id, display_order, label)
  select v_poll_id, item.ordinality::integer, item.value
  from jsonb_array_elements_text(v_options) with ordinality item(value, ordinality);

  return v_poll_id;
end;
$function$;

create function public.build_community_poll_json(
  p_poll_id uuid,
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
  v_digest text;
  v_participated boolean := false;
  v_results_visible boolean;
  v_total bigint := 0;
  v_options jsonb;
  v_parent_public_id uuid;
  v_root_public_id uuid;
  v_replacement_public_id uuid;
  v_winner_public_id uuid;
begin
  select * into v_poll from public.community_polls where id = p_poll_id;
  if not found then return null; end if;

  if nullif(btrim(coalesce(p_viewer_discord_user_id, '')), '') is not null then
    select encode(extensions.hmac(
      convert_to(btrim(p_viewer_discord_user_id), 'UTF8'), key.secret, 'sha256'
    ), 'hex') into v_digest
    from public.community_poll_participation_keys key
    where key.poll_id = v_poll.id;

    select exists (
      select 1 from public.community_poll_participants participant
      where participant.poll_id = v_poll.id
        and participant.participant_digest = v_digest
    ) into v_participated;
  end if;

  v_results_visible := v_poll.status not in ('draft', 'active') or v_participated;
  select coalesce(sum(vote_count), 0) into v_total
  from public.community_poll_options where poll_id = v_poll.id;

  select jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object(
      'publicId', option.public_id,
      'label', option.label,
      'displayOrder', option.display_order,
      'voteCount', case when v_results_visible then option.vote_count else null end,
      'percentage', case
        when not v_results_visible then null
        when v_total = 0 then 0
        else round(option.vote_count * 100.0 / v_total, 1)
      end
    )) order by option.display_order
  ) into v_options
  from public.community_poll_options option where option.poll_id = v_poll.id;

  select public_id into v_parent_public_id from public.community_polls where id = v_poll.parent_poll_id;
  select public_id into v_root_public_id from public.community_polls where id = v_poll.root_poll_id;
  select public_id into v_replacement_public_id
  from public.community_polls where replacement_for_poll_id = v_poll.id;
  select public_id into v_winner_public_id
  from public.community_poll_options where id = v_poll.winning_option_id;

  return jsonb_strip_nulls(jsonb_build_object(
    'publicId', v_poll.public_id,
    'status', v_poll.status,
    'rowVersion', v_poll.row_version,
    'question', v_poll.question,
    'context', v_poll.context,
    'durationHours', v_poll.duration_hours,
    'createdAt', v_poll.created_at,
    'activatedAt', v_poll.activated_at,
    'deadlineAt', v_poll.deadline_at,
    'closedAt', v_poll.closed_at,
    'outcome', v_poll.outcome,
    'rootPollPublicId', v_root_public_id,
    'parentPollPublicId', v_parent_public_id,
    'replacementPollPublicId', v_replacement_public_id,
    'winningOptionPublicId', v_winner_public_id,
    'participated', v_participated,
    'resultsVisible', v_results_visible,
    'votingOpen', v_poll.status = 'active' and transaction_timestamp() < v_poll.deadline_at,
    'totalVotes', case when v_results_visible then v_total else null end,
    'lastUpdatedAt', case when v_results_visible then coalesce(v_poll.tally_updated_at, v_poll.activated_at, v_poll.created_at) else null end,
    'options', coalesce(v_options, '[]'::jsonb)
  ));
end;
$function$;

create function public.get_community_poll_index(
  p_viewer_discord_user_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_active jsonb;
  v_history jsonb;
begin
  select coalesce(jsonb_agg(public.build_community_poll_json(id, p_viewer_discord_user_id)
    order by deadline_at, public_id), '[]'::jsonb)
  into v_active
  from public.community_polls where status = 'active';

  select coalesce(jsonb_agg(public.build_community_poll_json(id, p_viewer_discord_user_id)
    order by closed_at desc, public_id), '[]'::jsonb)
  into v_history
  from public.community_polls where status in ('closed', 'aborted', 'replaced');

  return jsonb_build_object(
    'serverNow', transaction_timestamp(),
    'activePolls', v_active,
    'historyPolls', v_history
  );
end;
$function$;

create function public.get_community_poll(
  p_poll_public_id uuid,
  p_viewer_discord_user_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_poll_id uuid;
begin
  select id into v_poll_id from public.community_polls
  where public_id = p_poll_public_id and status <> 'draft';
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  return jsonb_build_object(
    'outcome', 'ok',
    'serverNow', transaction_timestamp(),
    'poll', public.build_community_poll_json(v_poll_id, p_viewer_discord_user_id)
  );
end;
$function$;

create function public.cast_community_poll_vote(
  p_session_id uuid,
  p_poll_public_id uuid,
  p_option_public_id uuid,
  p_request_id uuid,
  p_expected_poll_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_access jsonb;
  v_actor_id text;
  v_poll public.community_polls%rowtype;
  v_option public.community_poll_options%rowtype;
  v_digest text;
  v_total bigint;
begin
  if p_session_id is null or p_poll_public_id is null or p_option_public_id is null
    or p_request_id is null or p_expected_poll_version is null or p_expected_poll_version <= 0
  then
    return jsonb_build_object('outcome', 'invalid_input');
  end if;

  v_access := public.get_cancerculture_session_access(p_session_id);
  if v_access ->> 'outcome' <> 'allowed' then
    return jsonb_build_object('outcome', v_access ->> 'outcome');
  end if;
  v_actor_id := v_access ->> 'discordUserId';

  select * into v_poll from public.community_polls
  where public_id = p_poll_public_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_poll.row_version <> p_expected_poll_version then
    return jsonb_build_object('outcome', 'stale');
  end if;
  if v_poll.status <> 'active' then
    return jsonb_build_object('outcome', 'not_active');
  end if;
  if transaction_timestamp() >= v_poll.deadline_at then
    return jsonb_build_object('outcome', 'deadline_passed');
  end if;

  select * into v_option from public.community_poll_options
  where poll_id = v_poll.id and public_id = p_option_public_id;
  if not found then return jsonb_build_object('outcome', 'option_not_found'); end if;

  select encode(extensions.hmac(
    convert_to(v_actor_id, 'UTF8'), key.secret, 'sha256'
  ), 'hex') into v_digest
  from public.community_poll_participation_keys key where key.poll_id = v_poll.id;

  begin
    insert into public.community_poll_participants (
      poll_id, participant_digest, request_id
    ) values (v_poll.id, v_digest, p_request_id);
  exception when unique_violation then
    return jsonb_build_object(
      'outcome', 'already_participated',
      'poll', public.build_community_poll_json(v_poll.id, v_actor_id)
    );
  end;

  update public.community_poll_options
  set vote_count = vote_count + 1, tally_updated_at = transaction_timestamp()
  where id = v_option.id;
  update public.community_polls
  set tally_updated_at = transaction_timestamp()
  where id = v_poll.id;

  select sum(vote_count) into v_total from public.community_poll_options where poll_id = v_poll.id;
  return jsonb_build_object(
    'outcome', 'voted',
    'selectedOption', jsonb_build_object('publicId', v_option.public_id, 'label', v_option.label),
    'poll', public.build_community_poll_json(v_poll.id, v_actor_id),
    'totalVotes', v_total
  );
end;
$function$;

create function public.create_community_poll(
  p_actor_discord_user_id text,
  p_request_id uuid,
  p_question text,
  p_context text,
  p_duration_hours integer,
  p_options jsonb
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
  v_poll_id uuid;
  v_poll public.community_polls%rowtype;
  v_response jsonb;
begin
  if p_request_id is null then raise exception using errcode = '22023', message = 'COMMUNITY_POLL_REQUEST_INVALID'; end if;
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'question', p_question, 'context', p_context, 'durationHours', p_duration_hours,
    'options', p_options
  )::text, 'UTF8'), 'sha256'), 'hex');
  select * into v_existing from public.community_poll_mutation_requests
  where actor_discord_user_id = btrim(p_actor_discord_user_id)
    and request_id = p_request_id and action = 'create';
  if found then
    if v_existing.request_hash <> v_hash then raise exception using errcode = '22023', message = 'COMMUNITY_POLL_REQUEST_CONFLICT'; end if;
    return v_existing.response;
  end if;

  v_poll_id := public.insert_community_poll_draft(
    p_actor_discord_user_id, p_question, p_context, p_duration_hours, p_options
  );
  select * into v_poll from public.community_polls where id = v_poll_id;
  insert into public.community_poll_admin_events (
    poll_id, event_type, actor_discord_user_id, actor_role, request_id, poll_version
  ) values (v_poll.id, 'created', btrim(p_actor_discord_user_id), v_role, p_request_id, v_poll.row_version);
  v_response := jsonb_build_object('outcome', 'created', 'pollPublicId', v_poll.public_id, 'rowVersion', v_poll.row_version);
  insert into public.community_poll_mutation_requests values (
    btrim(p_actor_discord_user_id), p_request_id, 'create', null, v_hash, v_response, transaction_timestamp()
  );
  return v_response;
end;
$function$;

create function public.activate_community_poll(
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
  v_hash text := encode(extensions.digest(convert_to(concat_ws('|', p_poll_public_id, p_expected_poll_version), 'UTF8'), 'sha256'), 'hex');
  v_existing public.community_poll_mutation_requests%rowtype;
  v_poll public.community_polls%rowtype;
  v_response jsonb;
begin
  if p_request_id is null or p_poll_public_id is null or p_expected_poll_version is null then raise exception using errcode = '22023', message = 'COMMUNITY_POLL_REQUEST_INVALID'; end if;
  select * into v_existing from public.community_poll_mutation_requests
  where actor_discord_user_id = btrim(p_actor_discord_user_id) and request_id = p_request_id and action = 'activate';
  if found then
    if v_existing.request_hash <> v_hash then raise exception using errcode = '22023', message = 'COMMUNITY_POLL_REQUEST_CONFLICT'; end if;
    return v_existing.response;
  end if;
  select * into v_poll from public.community_polls where public_id = p_poll_public_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_poll.row_version <> p_expected_poll_version then return jsonb_build_object('outcome', 'stale'); end if;
  if v_poll.status <> 'draft' then return jsonb_build_object('outcome', 'invalid_state'); end if;
  update public.community_polls set
    status = 'active', row_version = row_version + 1,
    activated_at = transaction_timestamp(),
    deadline_at = transaction_timestamp() + make_interval(hours => duration_hours)
  where id = v_poll.id returning * into v_poll;
  insert into public.community_poll_admin_events (
    poll_id, event_type, actor_discord_user_id, actor_role, request_id, poll_version, details
  ) values (v_poll.id, 'activated', btrim(p_actor_discord_user_id), v_role, p_request_id, v_poll.row_version,
    jsonb_build_object('deadlineAt', v_poll.deadline_at, 'durationHours', v_poll.duration_hours));
  v_response := jsonb_build_object('outcome', 'activated', 'pollPublicId', v_poll.public_id,
    'rowVersion', v_poll.row_version, 'deadlineAt', v_poll.deadline_at);
  insert into public.community_poll_mutation_requests values (
    btrim(p_actor_discord_user_id), p_request_id, 'activate', p_poll_public_id, v_hash, v_response, transaction_timestamp()
  );
  return v_response;
end;
$function$;

create function public.close_community_poll(
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
  v_hash text := encode(extensions.digest(convert_to(concat_ws('|', p_poll_public_id, p_expected_poll_version), 'UTF8'), 'sha256'), 'hex');
  v_existing public.community_poll_mutation_requests%rowtype;
  v_poll public.community_polls%rowtype;
  v_total bigint;
  v_max bigint;
  v_leaders integer;
  v_winner_id uuid;
  v_runoff_id uuid;
  v_runoff public.community_polls%rowtype;
  v_runoff_options jsonb;
  v_outcome text;
  v_response jsonb;
begin
  if p_request_id is null or p_poll_public_id is null or p_expected_poll_version is null then raise exception using errcode = '22023', message = 'COMMUNITY_POLL_REQUEST_INVALID'; end if;
  select * into v_existing from public.community_poll_mutation_requests
  where actor_discord_user_id = btrim(p_actor_discord_user_id) and request_id = p_request_id and action = 'close';
  if found then
    if v_existing.request_hash <> v_hash then raise exception using errcode = '22023', message = 'COMMUNITY_POLL_REQUEST_CONFLICT'; end if;
    return v_existing.response;
  end if;
  select * into v_poll from public.community_polls where public_id = p_poll_public_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_poll.row_version <> p_expected_poll_version then return jsonb_build_object('outcome', 'stale'); end if;
  if v_poll.status <> 'active' then return jsonb_build_object('outcome', 'invalid_state'); end if;
  if transaction_timestamp() < v_poll.deadline_at then return jsonb_build_object('outcome', 'deadline_not_reached'); end if;

  select coalesce(sum(vote_count), 0), coalesce(max(vote_count), 0)
  into v_total, v_max from public.community_poll_options where poll_id = v_poll.id;
  if v_total = 0 then
    v_outcome := 'no_result';
  else
    select count(*), (array_agg(id order by display_order))[1] into v_leaders, v_winner_id
    from public.community_poll_options where poll_id = v_poll.id and vote_count = v_max;
    if v_leaders = 1 then
      v_outcome := 'winner';
    else
      v_outcome := 'runoff';
      select jsonb_agg(to_jsonb(label) order by display_order) into v_runoff_options
      from public.community_poll_options where poll_id = v_poll.id and vote_count = v_max;
      v_runoff_id := public.insert_community_poll_draft(
        p_actor_discord_user_id, v_poll.question, v_poll.context, 24, v_runoff_options,
        v_poll.root_poll_id, v_poll.id, null
      );
      update public.community_polls set
        status = 'active', row_version = row_version + 1,
        activated_at = transaction_timestamp(), deadline_at = transaction_timestamp() + interval '24 hours'
      where id = v_runoff_id returning * into v_runoff;
      insert into public.community_poll_admin_events (
        poll_id, event_type, actor_discord_user_id, actor_role, request_id, poll_version, details
      ) values (v_runoff.id, 'runoff_created', btrim(p_actor_discord_user_id), v_role, p_request_id,
        v_runoff.row_version, jsonb_build_object('parentPollPublicId', v_poll.public_id, 'deadlineAt', v_runoff.deadline_at));
    end if;
  end if;

  update public.community_polls set
    status = 'closed', row_version = row_version + 1, closed_at = transaction_timestamp(),
    outcome = v_outcome, winning_option_id = case when v_outcome = 'winner' then v_winner_id else null end
  where id = v_poll.id returning * into v_poll;
  insert into public.community_poll_admin_events (
    poll_id, event_type, actor_discord_user_id, actor_role, request_id, poll_version, details
  ) values (v_poll.id, 'closed', btrim(p_actor_discord_user_id), v_role, p_request_id, v_poll.row_version,
    jsonb_strip_nulls(jsonb_build_object('outcome', v_outcome, 'totalVotes', v_total,
      'runoffPollPublicId', v_runoff.public_id)));
  v_response := jsonb_strip_nulls(jsonb_build_object('outcome', 'closed', 'result', v_outcome,
    'pollPublicId', v_poll.public_id, 'rowVersion', v_poll.row_version, 'runoffPollPublicId', v_runoff.public_id));
  insert into public.community_poll_mutation_requests values (
    btrim(p_actor_discord_user_id), p_request_id, 'close', p_poll_public_id, v_hash, v_response, transaction_timestamp()
  );
  return v_response;
end;
$function$;

create function public.abort_community_poll(
  p_actor_discord_user_id text,
  p_poll_public_id uuid,
  p_request_id uuid,
  p_expected_poll_version bigint,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_role text := public.assert_community_poll_capability(p_actor_discord_user_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_hash text;
  v_existing public.community_poll_mutation_requests%rowtype;
  v_poll public.community_polls%rowtype;
  v_response jsonb;
begin
  if p_request_id is null or p_poll_public_id is null or p_expected_poll_version is null
    or char_length(v_reason) not between 10 and 500 then raise exception using errcode = '22023', message = 'COMMUNITY_POLL_REQUEST_INVALID'; end if;
  v_hash := encode(extensions.digest(convert_to(concat_ws('|', p_poll_public_id, p_expected_poll_version, v_reason), 'UTF8'), 'sha256'), 'hex');
  select * into v_existing from public.community_poll_mutation_requests
  where actor_discord_user_id = btrim(p_actor_discord_user_id) and request_id = p_request_id and action = 'abort';
  if found then
    if v_existing.request_hash <> v_hash then raise exception using errcode = '22023', message = 'COMMUNITY_POLL_REQUEST_CONFLICT'; end if;
    return v_existing.response;
  end if;
  select * into v_poll from public.community_polls where public_id = p_poll_public_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_poll.row_version <> p_expected_poll_version then return jsonb_build_object('outcome', 'stale'); end if;
  if v_poll.status not in ('draft', 'active') then return jsonb_build_object('outcome', 'invalid_state'); end if;
  update public.community_polls set status = 'aborted', row_version = row_version + 1,
    closed_at = transaction_timestamp(), outcome = 'aborted'
  where id = v_poll.id returning * into v_poll;
  insert into public.community_poll_admin_events (
    poll_id, event_type, actor_discord_user_id, actor_role, request_id, poll_version, details
  ) values (v_poll.id, 'aborted', btrim(p_actor_discord_user_id), v_role, p_request_id,
    v_poll.row_version, jsonb_build_object('reason', v_reason));
  v_response := jsonb_build_object('outcome', 'aborted', 'pollPublicId', v_poll.public_id, 'rowVersion', v_poll.row_version);
  insert into public.community_poll_mutation_requests values (
    btrim(p_actor_discord_user_id), p_request_id, 'abort', p_poll_public_id, v_hash, v_response, transaction_timestamp()
  );
  return v_response;
end;
$function$;

create function public.replace_community_poll(
  p_actor_discord_user_id text,
  p_poll_public_id uuid,
  p_request_id uuid,
  p_expected_poll_version bigint,
  p_question text,
  p_context text,
  p_duration_hours integer,
  p_options jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_role text := public.assert_community_poll_capability(p_actor_discord_user_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_hash text;
  v_existing public.community_poll_mutation_requests%rowtype;
  v_poll public.community_polls%rowtype;
  v_new_id uuid;
  v_new public.community_polls%rowtype;
  v_response jsonb;
begin
  if p_request_id is null or p_poll_public_id is null or p_expected_poll_version is null
    or char_length(v_reason) not between 10 and 500 then raise exception using errcode = '22023', message = 'COMMUNITY_POLL_REQUEST_INVALID'; end if;
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'pollPublicId', p_poll_public_id, 'expectedVersion', p_expected_poll_version,
    'question', p_question, 'context', p_context, 'durationHours', p_duration_hours,
    'options', p_options, 'reason', v_reason
  )::text, 'UTF8'), 'sha256'), 'hex');
  select * into v_existing from public.community_poll_mutation_requests
  where actor_discord_user_id = btrim(p_actor_discord_user_id) and request_id = p_request_id and action = 'replace';
  if found then
    if v_existing.request_hash <> v_hash then raise exception using errcode = '22023', message = 'COMMUNITY_POLL_REQUEST_CONFLICT'; end if;
    return v_existing.response;
  end if;
  select * into v_poll from public.community_polls where public_id = p_poll_public_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_poll.row_version <> p_expected_poll_version then return jsonb_build_object('outcome', 'stale'); end if;
  if v_poll.status not in ('draft', 'active') then return jsonb_build_object('outcome', 'invalid_state'); end if;

  update public.community_polls set status = 'replaced', row_version = row_version + 1,
    closed_at = transaction_timestamp(), outcome = 'replaced'
  where id = v_poll.id returning * into v_poll;
  v_new_id := public.insert_community_poll_draft(
    p_actor_discord_user_id, p_question, p_context, p_duration_hours, p_options,
    v_poll.root_poll_id, null, v_poll.id
  );
  select * into v_new from public.community_polls where id = v_new_id;
  insert into public.community_poll_admin_events (
    poll_id, event_type, actor_discord_user_id, actor_role, request_id, poll_version, details
  ) values (v_poll.id, 'replaced', btrim(p_actor_discord_user_id), v_role, p_request_id,
    v_poll.row_version, jsonb_build_object('reason', v_reason, 'replacementPollPublicId', v_new.public_id));
  insert into public.community_poll_admin_events (
    poll_id, event_type, actor_discord_user_id, actor_role, request_id, poll_version, details
  ) values (v_new.id, 'replacement_created', btrim(p_actor_discord_user_id), v_role, p_request_id,
    v_new.row_version, jsonb_build_object('replacedPollPublicId', v_poll.public_id));
  v_response := jsonb_build_object('outcome', 'replaced', 'pollPublicId', v_poll.public_id,
    'rowVersion', v_poll.row_version, 'replacementPollPublicId', v_new.public_id,
    'replacementRowVersion', v_new.row_version);
  insert into public.community_poll_mutation_requests values (
    btrim(p_actor_discord_user_id), p_request_id, 'replace', p_poll_public_id, v_hash, v_response, transaction_timestamp()
  );
  return v_response;
end;
$function$;

create function public.get_community_poll_management(
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
begin
  select coalesce(jsonb_agg(public.build_community_poll_json(id, p_actor_discord_user_id)
    order by created_at desc, public_id), '[]'::jsonb)
  into v_polls from public.community_polls;
  select coalesce(jsonb_agg(jsonb_build_object(
    'eventId', event.id,
    'pollPublicId', poll.public_id,
    'eventType', event.event_type,
    'actorDiscordUserId', event.actor_discord_user_id,
    'actorRole', event.actor_role,
    'pollVersion', event.poll_version,
    'details', event.details,
    'occurredAt', event.occurred_at
  ) order by event.occurred_at desc, event.id desc), '[]'::jsonb)
  into v_events
  from public.community_poll_admin_events event
  join public.community_polls poll on poll.id = event.poll_id;
  return jsonb_build_object('serverNow', transaction_timestamp(), 'actorRole', v_role,
    'polls', v_polls, 'events', v_events);
end;
$function$;

alter function public.protect_community_poll_append_only() owner to postgres;
alter function public.protect_community_poll_row() owner to postgres;
alter function public.protect_community_poll_option() owner to postgres;
alter function public.assert_community_poll_capability(text) owner to postgres;
alter function public.validate_community_poll_options(jsonb) owner to postgres;
alter function public.insert_community_poll_draft(text,text,text,integer,jsonb,uuid,uuid,uuid) owner to postgres;
alter function public.build_community_poll_json(uuid,text) owner to postgres;
alter function public.get_community_poll_index(text) owner to postgres;
alter function public.get_community_poll(uuid,text) owner to postgres;
alter function public.cast_community_poll_vote(uuid,uuid,uuid,uuid,bigint) owner to postgres;
alter function public.create_community_poll(text,uuid,text,text,integer,jsonb) owner to postgres;
alter function public.activate_community_poll(text,uuid,uuid,bigint) owner to postgres;
alter function public.close_community_poll(text,uuid,uuid,bigint) owner to postgres;
alter function public.abort_community_poll(text,uuid,uuid,bigint,text) owner to postgres;
alter function public.replace_community_poll(text,uuid,uuid,bigint,text,text,integer,jsonb,text) owner to postgres;
alter function public.get_community_poll_management(text) owner to postgres;

revoke all on function public.protect_community_poll_append_only() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.protect_community_poll_row() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.protect_community_poll_option() from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.assert_community_poll_capability(text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.validate_community_poll_options(jsonb) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.insert_community_poll_draft(text,text,text,integer,jsonb,uuid,uuid,uuid) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.build_community_poll_json(uuid,text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_poll_index(text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_poll(uuid,text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.cast_community_poll_vote(uuid,uuid,uuid,uuid,bigint) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.create_community_poll(text,uuid,text,text,integer,jsonb) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.activate_community_poll(text,uuid,uuid,bigint) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.close_community_poll(text,uuid,uuid,bigint) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.abort_community_poll(text,uuid,uuid,bigint,text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.replace_community_poll(text,uuid,uuid,bigint,text,text,integer,jsonb,text) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.get_community_poll_management(text) from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_community_poll_index(text) to service_role;
grant execute on function public.get_community_poll(uuid,text) to service_role;
grant execute on function public.cast_community_poll_vote(uuid,uuid,uuid,uuid,bigint) to service_role;
grant execute on function public.create_community_poll(text,uuid,text,text,integer,jsonb) to service_role;
grant execute on function public.activate_community_poll(text,uuid,uuid,bigint) to service_role;
grant execute on function public.close_community_poll(text,uuid,uuid,bigint) to service_role;
grant execute on function public.abort_community_poll(text,uuid,uuid,bigint,text) to service_role;
grant execute on function public.replace_community_poll(text,uuid,uuid,bigint,text,text,integer,jsonb,text) to service_role;
grant execute on function public.get_community_poll_management(text) to service_role;

comment on table public.community_poll_participants is
  'Poll-scoped pseudonymous participation facts only. This table never stores an option identity or raw account identity.';
comment on table public.community_poll_options is
  'Ordered poll options with aggregate counters only. This table never stores a participant identity or digest.';
comment on function public.cast_community_poll_vote(uuid,uuid,uuid,uuid,bigint) is
  'Atomically validates one current Website session without Discord-membership or Participation-Hold requirements, records one poll-scoped HMAC participation fact, and increments only the selected aggregate option counter.';

do $postflight$
declare
  v_name text;
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
      select 1 from public.team_role_capabilities
      where capability_key = 'community.polls.manage'
    )
    or (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in (
        'community_polls', 'community_poll_options', 'community_poll_participation_keys',
        'community_poll_participants', 'community_poll_admin_events', 'community_poll_mutation_requests'
      ) and c.relrowsecurity) <> 6
  then
    raise exception using errcode = '55000', message = 'COMMUNITY_POLLS_POSTFLIGHT_MISMATCH';
  end if;

  foreach v_name in array array[
    'get_community_poll_index', 'get_community_poll', 'cast_community_poll_vote',
    'create_community_poll', 'activate_community_poll', 'close_community_poll',
    'abort_community_poll', 'replace_community_poll', 'get_community_poll_management'
  ] loop
    if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_name) <> 1 then
      raise exception using errcode = '55000', message = 'COMMUNITY_POLL_FUNCTION_OVERLOAD_MISMATCH';
    end if;
  end loop;
end;
$postflight$;

commit;

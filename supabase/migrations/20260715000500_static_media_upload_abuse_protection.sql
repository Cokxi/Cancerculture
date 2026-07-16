begin;

create table public.submission_upload_abuse_states (
  discord_user_id text not null
    references public.user_logs(discord_user_id) on delete restrict,
  cycle_id bigint not null
    references public.voting_cycles(id) on delete restrict,
  invalid_attempt_count integer not null default 0,
  total_invalid_attempt_count integer not null default 0,
  last_error_code text,
  last_invalid_attempt_at timestamptz,
  blocked_at timestamptz,
  blocked_reason text,
  block_count integer not null default 0,
  last_blocked_at timestamptz,
  unblocked_at timestamptz,
  unblocked_by_discord_user_id text,
  unblock_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (discord_user_id, cycle_id),
  constraint submission_upload_abuse_attempt_count_check
    check (invalid_attempt_count between 0 and 5),
  constraint submission_upload_abuse_total_count_check
    check (total_invalid_attempt_count >= invalid_attempt_count),
  constraint submission_upload_abuse_block_count_check
    check (block_count >= 0),
  constraint submission_upload_abuse_error_code_check
    check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,80}$'),
  constraint submission_upload_abuse_state_check
    check (
      (blocked_at is null and invalid_attempt_count < 5 and blocked_reason is null)
      or
      (blocked_at is not null and invalid_attempt_count = 5 and blocked_reason is not null)
    ),
  constraint submission_upload_abuse_unblock_audit_check
    check (
      (unblocked_at is null and unblocked_by_discord_user_id is null and unblock_reason is null)
      or
      (unblocked_at is not null and unblocked_by_discord_user_id is not null and unblock_reason is not null)
    )
);

comment on table public.submission_upload_abuse_states is
  'Authoritative server-only per-user/per-cycle invalid submission-media counter and upload block state. Historical totals and block count survive an Admin unblock.';

create index submission_upload_abuse_blocked_idx
  on public.submission_upload_abuse_states (blocked_at desc, cycle_id)
  where blocked_at is not null;

create index submission_upload_abuse_cycle_updated_idx
  on public.submission_upload_abuse_states (cycle_id, updated_at desc);

alter table public.submission_upload_abuse_states enable row level security;

revoke all on table public.submission_upload_abuse_states
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.submission_upload_abuse_states to service_role;

create or replace function public.get_submission_upload_abuse_status(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_discord_user_id text;
  v_cycle_id bigint;
  v_state public.submission_upload_abuse_states%rowtype;
begin
  if p_session_id is null then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select session.discord_user_id
  into v_discord_user_id
  from public.sessions session
  where session.id = p_session_id
    and session.revoked_at is null;

  if not found then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select cycle.id
  into v_cycle_id
  from public.voting_cycles cycle
  where cycle.status::text in ('submission_open', 'active')
  order by cycle.id desc
  limit 1;

  if not found then
    return jsonb_build_object('outcome', 'cycle_not_open');
  end if;

  select state.*
  into v_state
  from public.submission_upload_abuse_states state
  where state.discord_user_id = v_discord_user_id
    and state.cycle_id = v_cycle_id;

  return jsonb_build_object(
    'outcome', 'status',
    'cycleId', v_cycle_id,
    'blocked', coalesce(v_state.blocked_at is not null, false),
    'invalidAttemptCount', coalesce(v_state.invalid_attempt_count, 0)
  );
end;
$$;

create or replace function public.register_invalid_submission_upload(
  p_session_id uuid,
  p_cycle_id bigint,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := transaction_timestamp();
  v_discord_user_id text;
  v_cycle public.voting_cycles%rowtype;
  v_state public.submission_upload_abuse_states%rowtype;
  v_allowed_codes constant text[] := array[
    'MEDIA_FILE_TOO_LARGE',
    'MEDIA_FORMAT_UNSUPPORTED',
    'MEDIA_MIME_MISMATCH',
    'MEDIA_CORRUPT',
    'MEDIA_ANIMATION_UNSUPPORTED',
    'MEDIA_WIDTH_EXCEEDED',
    'MEDIA_HEIGHT_EXCEEDED',
    'MEDIA_PIXEL_LIMIT_EXCEEDED',
    'MEDIA_DECOMPRESSION_LIMIT',
    'MEDIA_OUTPUT_TOO_LARGE'
  ];
begin
  if p_session_id is null or p_cycle_id is null then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  if p_error_code is null or not (p_error_code = any(v_allowed_codes)) then
    return jsonb_build_object('outcome', 'not_countable');
  end if;

  select session.discord_user_id
  into v_discord_user_id
  from public.sessions session
  where session.id = p_session_id
    and session.revoked_at is null;

  if not found then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  select cycle.*
  into v_cycle
  from public.voting_cycles cycle
  where cycle.id = p_cycle_id
  for update;

  if not found or v_cycle.status::text not in ('submission_open', 'active') then
    return jsonb_build_object('outcome', 'cycle_not_open');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'submission-upload-abuse:' || v_discord_user_id || ':' || p_cycle_id::text,
      0
    )
  );

  select state.*
  into v_state
  from public.submission_upload_abuse_states state
  where state.discord_user_id = v_discord_user_id
    and state.cycle_id = p_cycle_id
  for update;

  if found and v_state.blocked_at is not null then
    return jsonb_build_object(
      'outcome', 'already_blocked',
      'cycleId', p_cycle_id,
      'blocked', true,
      'invalidAttemptCount', 5
    );
  end if;

  insert into public.submission_upload_abuse_states (
    discord_user_id,
    cycle_id,
    invalid_attempt_count,
    total_invalid_attempt_count,
    last_error_code,
    last_invalid_attempt_at,
    blocked_at,
    blocked_reason,
    block_count,
    last_blocked_at,
    created_at,
    updated_at
  ) values (
    v_discord_user_id,
    p_cycle_id,
    1,
    1,
    p_error_code,
    v_now,
    null,
    null,
    0,
    null,
    v_now,
    v_now
  )
  on conflict (discord_user_id, cycle_id) do update
  set
    invalid_attempt_count = least(
      5,
      public.submission_upload_abuse_states.invalid_attempt_count + 1
    ),
    total_invalid_attempt_count =
      public.submission_upload_abuse_states.total_invalid_attempt_count + 1,
    last_error_code = excluded.last_error_code,
    last_invalid_attempt_at = v_now,
    blocked_at = case
      when public.submission_upload_abuse_states.invalid_attempt_count >= 4
        then v_now
      else null
    end,
    blocked_reason = case
      when public.submission_upload_abuse_states.invalid_attempt_count >= 4
        then 'five_invalid_media_attempts'
      else null
    end,
    block_count = public.submission_upload_abuse_states.block_count + case
      when public.submission_upload_abuse_states.invalid_attempt_count = 4
        then 1
      else 0
    end,
    last_blocked_at = case
      when public.submission_upload_abuse_states.invalid_attempt_count >= 4
        then v_now
      else public.submission_upload_abuse_states.last_blocked_at
    end,
    updated_at = v_now
  returning * into v_state;

  return jsonb_build_object(
    'outcome', case when v_state.blocked_at is null then 'counted' else 'blocked' end,
    'cycleId', v_state.cycle_id,
    'blocked', v_state.blocked_at is not null,
    'invalidAttemptCount', v_state.invalid_attempt_count
  );
end;
$$;

create or replace function public.unblock_submission_upload(
  p_discord_user_id text,
  p_cycle_id bigint,
  p_actor_discord_user_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := transaction_timestamp();
  v_reason text := nullif(btrim(p_reason), '');
  v_state public.submission_upload_abuse_states%rowtype;
begin
  if nullif(btrim(p_discord_user_id), '') is null
    or p_cycle_id is null
    or nullif(btrim(p_actor_discord_user_id), '') is null
    or v_reason is null
    or length(v_reason) > 500
  then
    return jsonb_build_object('outcome', 'invalid_request');
  end if;

  if not exists (
    select 1
    from public.team_members member
    where member.discord_user_id = p_actor_discord_user_id
      and member.role = 'admin'
  ) then
    return jsonb_build_object('outcome', 'forbidden');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'submission-upload-abuse:' || p_discord_user_id || ':' || p_cycle_id::text,
      0
    )
  );

  select state.*
  into v_state
  from public.submission_upload_abuse_states state
  where state.discord_user_id = p_discord_user_id
    and state.cycle_id = p_cycle_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_state.blocked_at is null then
    return jsonb_build_object(
      'outcome', 'already_unblocked',
      'cycleId', p_cycle_id
    );
  end if;

  update public.submission_upload_abuse_states state
  set
    invalid_attempt_count = 0,
    blocked_at = null,
    blocked_reason = null,
    unblocked_at = v_now,
    unblocked_by_discord_user_id = p_actor_discord_user_id,
    unblock_reason = v_reason,
    updated_at = v_now
  where state.discord_user_id = p_discord_user_id
    and state.cycle_id = p_cycle_id;

  update public.user_logs users
  set upload_fail_count = 0
  where users.discord_user_id = p_discord_user_id
    and coalesce(users.upload_fail_count, 0) <> 0;

  insert into public.admin_action_logs (
    actor_type,
    actor_id,
    action,
    target_type,
    target_id,
    meta
  ) values (
    'admin',
    p_actor_discord_user_id,
    'submission_upload_cycle_unblocked',
    'discord_user',
    p_discord_user_id,
    jsonb_build_object(
      'cycleId', p_cycle_id,
      'reason', v_reason,
      'invalidAttemptCountBeforeUnblock', v_state.invalid_attempt_count,
      'totalInvalidAttemptCount', v_state.total_invalid_attempt_count,
      'blockCount', v_state.block_count
    )
  );

  return jsonb_build_object(
    'outcome', 'unblocked',
    'cycleId', p_cycle_id
  );
end;
$$;

create or replace function public.enforce_submission_upload_abuse_block()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('reserved', 'completed') and exists (
    select 1
    from public.submission_upload_abuse_states state
    where state.discord_user_id = new.discord_user_id
      and state.cycle_id = new.cycle_id
      and state.blocked_at is not null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'UPLOAD_BLOCKED_FOR_CYCLE';
  end if;

  return new;
end;
$$;

create trigger submission_upload_operations_abuse_block_trigger
before insert or update of status
on public.submission_upload_operations
for each row
execute function public.enforce_submission_upload_abuse_block();

revoke all on function public.get_submission_upload_abuse_status(uuid)
  from public, anon, authenticated;
revoke all on function public.register_invalid_submission_upload(uuid, bigint, text)
  from public, anon, authenticated;
revoke all on function public.unblock_submission_upload(text, bigint, text, text)
  from public, anon, authenticated;
revoke all on function public.enforce_submission_upload_abuse_block()
  from public, anon, authenticated;

grant execute on function public.get_submission_upload_abuse_status(uuid)
  to service_role;
grant execute on function public.register_invalid_submission_upload(uuid, bigint, text)
  to service_role;
grant execute on function public.unblock_submission_upload(text, bigint, text, text)
  to service_role;

commit;

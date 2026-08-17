begin;

do $baseline$
begin
  if to_regclass('public.submission_upload_operations') is null
    or to_regclass('public.submission_private_data') is null
    or to_regclass('public.account_sol_profile_wallets') is null
    or to_regclass('public.account_totp_factors') is null
    or to_regprocedure(
      'public.reserve_submission_upload(uuid,uuid,text,text,text,integer)'
    ) is null
    or to_regprocedure(
      'public.commit_submission_upload(uuid,uuid,text,text,integer,text,integer,integer)'
    ) is null
    or to_regprocedure('public.is_valid_sol_recipient_address(text)') is null
    or exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'submission_upload_operations'
        and column_name in (
          'wallet_source',
          'wallet_address',
          'profile_wallet_version',
          'payout_choice',
          'split_percent',
          'charity'
        )
    )
    or exists (
      select 1
      from public.submission_upload_operations operation
      where operation.status in ('reserved', 'r2_uploaded')
    )
    or exists (
      select 1
      from public.submission_upload_operations operation
      where operation.status = 'completed'
        and not exists (
          select 1
          from public.submission_private_data private_data
          where private_data.submission_id = operation.submission_id
        )
    )
  then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_PROFILE_WALLET_BINDING_BASELINE_MISMATCH';
  end if;
end;
$baseline$;

alter table public.submission_upload_operations
  add column wallet_source text,
  add column wallet_address text,
  add column profile_wallet_version bigint,
  add column payout_choice text,
  add column split_percent integer,
  add column charity text;

update public.submission_upload_operations operation
set
  wallet_source = case
    when private_data.payout_choice = 'donate' then 'none'
    else 'manual'
  end,
  wallet_address = private_data.wallet_address,
  profile_wallet_version = null,
  payout_choice = private_data.payout_choice,
  split_percent = private_data.split_percent,
  charity = private_data.charity
from public.submission_private_data private_data
where operation.status = 'completed'
  and private_data.submission_id = operation.submission_id;

alter table public.submission_upload_operations
  add constraint submission_upload_operations_private_binding_check check (
    status in ('cleanup_pending', 'failed')
    or (
      payout_choice = 'keep'
      and wallet_source in ('manual', 'profile')
      and public.is_valid_sol_recipient_address(wallet_address)
      and split_percent is null
      and charity is null
      and (
        (wallet_source = 'manual' and profile_wallet_version is null)
        or
        (wallet_source = 'profile' and profile_wallet_version > 0)
      )
    )
    or (
      payout_choice = 'donate'
      and wallet_source = 'none'
      and wallet_address = ''
      and profile_wallet_version is null
      and split_percent is null
      and nullif(btrim(charity), '') is not null
      and length(charity) <= 256
    )
    or (
      payout_choice = 'split'
      and wallet_source in ('manual', 'profile')
      and public.is_valid_sol_recipient_address(wallet_address)
      and split_percent between 1 and 99
      and nullif(btrim(charity), '') is not null
      and length(charity) <= 256
      and (
        (wallet_source = 'manual' and profile_wallet_version is null)
        or
        (wallet_source = 'profile' and profile_wallet_version > 0)
      )
    )
  );

alter table public.submission_private_data
  add constraint submission_private_data_sol_recipient_contract_check check (
    (
      payout_choice = 'keep'
      and public.is_valid_sol_recipient_address(wallet_address)
      and split_percent is null
      and charity is null
    )
    or (
      payout_choice = 'donate'
      and wallet_address = ''
      and split_percent is null
      and nullif(btrim(charity), '') is not null
      and length(charity) <= 256
    )
    or (
      payout_choice = 'split'
      and public.is_valid_sol_recipient_address(wallet_address)
      and split_percent between 1 and 99
      and nullif(btrim(charity), '') is not null
      and length(charity) <= 256
    )
  );

revoke all on table public.submission_upload_operations
  from public, anon, authenticated, discord_bot, service_role;
revoke insert, update, delete on table public.submission_private_data
  from public, anon, authenticated, discord_bot, service_role;

create function public.get_completed_submission_upload_operation(
  p_session_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_discord_user_id text;
  v_operation public.submission_upload_operations%rowtype;
begin
  if p_session_id is null or p_idempotency_key is null then
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

  select operation.*
  into v_operation
  from public.submission_upload_operations operation
  where operation.discord_user_id = v_discord_user_id
    and operation.idempotency_key = p_idempotency_key
    and operation.status = 'completed';

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  return jsonb_build_object(
    'outcome', 'completed',
    'operationId', v_operation.id,
    'cycleId', v_operation.cycle_id,
    'submissionId', v_operation.submission_id
  );
end;
$function$;

drop function public.reserve_submission_upload(
  uuid, uuid, text, text, text, integer
);

create function public.reserve_submission_upload(
  p_session_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_content_sha256 text,
  p_media_type text,
  p_media_bytes integer,
  p_wallet_source text,
  p_profile_wallet_version bigint,
  p_manual_wallet_address text,
  p_payout_choice text,
  p_split_percent integer,
  p_charity text
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
  v_profile_wallet public.account_sol_profile_wallets%rowtype;
  v_factor_active boolean := false;
  v_rules_version integer;
  v_cleanup_status text;
  v_storage_key text;
  v_used integer;
  v_last_completed_at timestamptz;
  v_next_allowed_at timestamptz;
  v_cooldown_remaining integer := 0;
  v_manual_wallet_address text := coalesce(btrim(p_manual_wallet_address), '');
  v_charity text := nullif(btrim(p_charity), '');
  v_bound_wallet_address text := '';
  v_bound_profile_wallet_version bigint;
begin
  if p_session_id is null then
    return jsonb_build_object('outcome', 'not_authenticated');
  end if;

  if p_idempotency_key is null
    or p_request_fingerprint is null
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_content_sha256 is null
    or p_content_sha256 !~ '^[0-9a-f]{64}$'
    or p_media_type is distinct from 'image/webp'
    or p_media_bytes is null
    or p_media_bytes <= 0
    or p_media_bytes > 16777216
    or p_payout_choice is null
    or p_payout_choice not in ('keep', 'donate', 'split')
    or p_wallet_source is null
    or p_wallet_source not in ('manual', 'profile', 'none')
    or length(v_manual_wallet_address) > 512
    or length(coalesce(v_charity, '')) > 256
    or (
      p_payout_choice = 'keep'
      and (
        p_wallet_source not in ('manual', 'profile')
        or p_split_percent is not null
        or v_charity is not null
      )
    )
    or (
      p_payout_choice = 'donate'
      and (
        p_wallet_source <> 'none'
        or v_manual_wallet_address <> ''
        or p_profile_wallet_version is not null
        or p_split_percent is not null
        or v_charity is null
      )
    )
    or (
      p_payout_choice = 'split'
      and (
        p_wallet_source not in ('manual', 'profile')
        or p_split_percent is null
        or p_split_percent not between 1 and 99
        or v_charity is null
      )
    )
    or (
      p_wallet_source = 'manual'
      and (
        p_profile_wallet_version is not null
        or not public.is_valid_sol_recipient_address(v_manual_wallet_address)
      )
    )
    or (
      p_wallet_source = 'profile'
      and (
        v_manual_wallet_address <> ''
        or p_profile_wallet_version is null
        or p_profile_wallet_version <= 0
      )
    )
  then
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

  perform pg_advisory_xact_lock(
    hashtextextended(
      'submission-upload-idempotency:' ||
      v_discord_user_id || ':' || p_idempotency_key::text,
      0
    )
  );

  select operation.*
  into v_operation
  from public.submission_upload_operations operation
  where operation.discord_user_id = v_discord_user_id
    and operation.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_operation.request_fingerprint <> p_request_fingerprint
      or v_operation.content_sha256 <> p_content_sha256
      or v_operation.media_type <> p_media_type
      or v_operation.media_bytes <> p_media_bytes
    then
      return jsonb_build_object(
        'outcome', 'idempotency_conflict',
        'cycleId', v_operation.cycle_id
      );
    end if;

    if v_operation.status = 'completed' then
      return jsonb_build_object(
        'outcome', 'already_completed',
        'operationId', v_operation.id,
        'cycleId', v_operation.cycle_id,
        'submissionId', v_operation.submission_id
      );
    end if;

    if v_operation.status in ('reserved', 'r2_uploaded') then
      return jsonb_build_object(
        'outcome', 'reserved',
        'operationId', v_operation.id,
        'cycleId', v_operation.cycle_id,
        'storageKey', v_operation.storage_key,
        'r2Uploaded', v_operation.status = 'r2_uploaded'
      );
    end if;

    if v_operation.status = 'cleanup_pending' then
      select queue.status
      into v_cleanup_status
      from public.media_cleanup_queue queue
      where queue.storage_provider = v_operation.storage_provider
        and queue.storage_key = v_operation.storage_key;

      if v_cleanup_status is distinct from 'completed' then
        return jsonb_build_object(
          'outcome', case
            when v_cleanup_status = 'dead' then 'cleanup_blocked'
            else 'cleanup_pending'
          end,
          'operationId', v_operation.id,
          'cycleId', v_operation.cycle_id
        );
      end if;
    end if;
  end if;

  select cycle.*
  into v_cycle
  from public.voting_cycles cycle
  where cycle.status in ('submission_open', 'active')
  order by cycle.id desc
  limit 1;

  if not found then
    return jsonb_build_object('outcome', 'cycle_not_open');
  end if;

  if v_operation.id is not null
    and v_operation.cycle_id <> v_cycle.id
  then
    return jsonb_build_object(
      'outcome', 'idempotency_cycle_conflict',
      'cycleId', v_operation.cycle_id
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'submission-upload-user-cycle:' ||
      v_discord_user_id || ':' || v_cycle.id::text,
      0
    )
  );

  select cycle.*
  into v_cycle
  from public.voting_cycles cycle
  where cycle.id = v_cycle.id
    and cycle.status in ('submission_open', 'active')
  for update;

  if not found then
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
    or v_membership.discord_joined_at > v_now - interval '10 minutes'
  then
    return jsonb_build_object('outcome', 'joined_too_recently');
  end if;

  select count(*)::integer
  into v_used
  from public.submissions submission
  where submission.cycle_id = v_cycle.id
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
    and operation.cycle_id = v_cycle.id
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

  if exists (
    select 1
    from public.submission_upload_operations other_operation
    where other_operation.discord_user_id = v_discord_user_id
      and other_operation.cycle_id = v_cycle.id
      and other_operation.status in ('reserved', 'r2_uploaded')
      and (
        v_operation.id is null
        or other_operation.id <> v_operation.id
      )
  ) then
    return jsonb_build_object('outcome', 'upload_in_progress');
  end if;

  if p_payout_choice in ('keep', 'split') then
    perform pg_advisory_xact_lock(
      hashtextextended('account-2fa:' || v_discord_user_id, 0)
    );
    perform pg_advisory_xact_lock(
      hashtextextended('sol-profile-wallet:' || v_discord_user_id, 0)
    );

    select exists (
      select 1
      from public.account_totp_factors factor
      where factor.discord_user_id = v_discord_user_id
    ) into v_factor_active;

    select wallet.*
    into v_profile_wallet
    from public.account_sol_profile_wallets wallet
    where wallet.discord_user_id = v_discord_user_id
    for update;

    if p_wallet_source = 'profile' then
      if not v_factor_active
        or not found
        or v_profile_wallet.wallet_address is null
        or v_profile_wallet.version <> p_profile_wallet_version
        or not public.is_valid_sol_recipient_address(
          v_profile_wallet.wallet_address
        )
      then
        return jsonb_build_object('outcome', 'profile_wallet_stale');
      end if;

      v_bound_wallet_address := v_profile_wallet.wallet_address;
      v_bound_profile_wallet_version := v_profile_wallet.version;
    elsif v_factor_active
      and found
      and v_profile_wallet.wallet_address is not null
    then
      return jsonb_build_object('outcome', 'profile_wallet_stale');
    else
      v_bound_wallet_address := v_manual_wallet_address;
      v_bound_profile_wallet_version := null;
    end if;
  end if;

  v_storage_key :=
    v_cycle.id::text || '/' || gen_random_uuid()::text || '.webp';

  if v_operation.id is null then
    insert into public.submission_upload_operations (
      discord_user_id,
      cycle_id,
      idempotency_key,
      request_fingerprint,
      content_sha256,
      storage_key,
      media_type,
      media_bytes,
      status,
      wallet_source,
      wallet_address,
      profile_wallet_version,
      payout_choice,
      split_percent,
      charity,
      created_at,
      updated_at,
      last_attempt_at
    ) values (
      v_discord_user_id,
      v_cycle.id,
      p_idempotency_key,
      p_request_fingerprint,
      p_content_sha256,
      v_storage_key,
      p_media_type,
      p_media_bytes,
      'reserved',
      p_wallet_source,
      v_bound_wallet_address,
      v_bound_profile_wallet_version,
      p_payout_choice,
      case when p_payout_choice = 'split' then p_split_percent else null end,
      case when p_payout_choice in ('donate', 'split') then v_charity else null end,
      v_now,
      v_now,
      v_now
    )
    returning * into v_operation;
  else
    update public.submission_upload_operations operation
    set
      storage_key = v_storage_key,
      status = 'reserved',
      r2_etag = null,
      cleanup_required = false,
      last_error_code = null,
      wallet_source = p_wallet_source,
      wallet_address = v_bound_wallet_address,
      profile_wallet_version = v_bound_profile_wallet_version,
      payout_choice = p_payout_choice,
      split_percent = case
        when p_payout_choice = 'split' then p_split_percent
        else null
      end,
      charity = case
        when p_payout_choice in ('donate', 'split') then v_charity
        else null
      end,
      updated_at = v_now,
      last_attempt_at = v_now,
      completed_at = null,
      submission_id = null
    where operation.id = v_operation.id
    returning * into v_operation;
  end if;

  return jsonb_build_object(
    'outcome', 'reserved',
    'operationId', v_operation.id,
    'cycleId', v_operation.cycle_id,
    'storageKey', v_operation.storage_key,
    'r2Uploaded', false,
    'used', v_used,
    'limit', v_cycle.submissions_per_user,
    'remaining', v_cycle.submissions_per_user - v_used
  );
end;
$function$;

drop function public.commit_submission_upload(
  uuid, uuid, text, text, integer, text, integer, integer
);

create function public.commit_submission_upload(
  p_operation_id uuid,
  p_session_id uuid,
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
    or p_media_width::bigint * p_media_height::bigint > 24000000
  then
    return jsonb_build_object('outcome', 'invalid_media_metadata');
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

  if v_operation.payout_choice is null or (
    v_operation.payout_choice = 'keep'
    and (
      v_operation.wallet_source not in ('manual', 'profile')
      or not public.is_valid_sol_recipient_address(
        v_operation.wallet_address
      )
      or v_operation.split_percent is not null
      or v_operation.charity is not null
    )
  ) or (
    v_operation.payout_choice = 'donate'
    and (
      v_operation.wallet_source <> 'none'
      or v_operation.wallet_address <> ''
      or v_operation.profile_wallet_version is not null
      or v_operation.split_percent is not null
      or nullif(btrim(v_operation.charity), '') is null
    )
  ) or (
    v_operation.payout_choice = 'split'
    and (
      v_operation.wallet_source not in ('manual', 'profile')
      or not public.is_valid_sol_recipient_address(
        v_operation.wallet_address
      )
      or v_operation.split_percent not between 1 and 99
      or nullif(btrim(v_operation.charity), '') is null
    )
  ) or (
    v_operation.wallet_source = 'manual'
    and v_operation.profile_wallet_version is not null
  ) or (
    v_operation.wallet_source = 'profile'
    and (
      v_operation.profile_wallet_version is null
      or v_operation.profile_wallet_version <= 0
    )
  ) then
    return jsonb_build_object('outcome', 'invalid_private_data');
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
    or v_membership.discord_joined_at > v_now - interval '10 minutes'
  then
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
    or v_operation.content_sha256 !~ '^[0-9a-f]{64}$'
  then
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
    v_operation.wallet_address,
    v_operation.payout_choice,
    v_operation.split_percent,
    v_operation.charity
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

alter function public.get_completed_submission_upload_operation(uuid,uuid)
  owner to postgres;
alter function public.reserve_submission_upload(
  uuid, uuid, text, text, text, integer,
  text, bigint, text, text, integer, text
) owner to postgres;
alter function public.commit_submission_upload(uuid,uuid,integer,integer)
  owner to postgres;

revoke all on function public.get_completed_submission_upload_operation(uuid,uuid)
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.reserve_submission_upload(
  uuid, uuid, text, text, text, integer,
  text, bigint, text, text, integer, text
) from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.commit_submission_upload(uuid,uuid,integer,integer)
  from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.get_completed_submission_upload_operation(uuid,uuid)
  to service_role;
grant execute on function public.reserve_submission_upload(
  uuid, uuid, text, text, text, integer,
  text, bigint, text, text, integer, text
) to service_role;
grant execute on function public.commit_submission_upload(uuid,uuid,integer,integer)
  to service_role;

do $security_postflight$
declare
  v_signature text;
  v_service_signatures text[] := array[
    'public.get_completed_submission_upload_operation(uuid,uuid)',
    'public.reserve_submission_upload(uuid,uuid,text,text,text,integer,text,bigint,text,text,integer,text)',
    'public.commit_submission_upload(uuid,uuid,integer,integer)'
  ];
begin
  foreach v_signature in array v_service_signatures loop
    if to_regprocedure(v_signature) is null
      or not exists (
        select 1
        from pg_proc function_row
        where function_row.oid = to_regprocedure(v_signature)
          and pg_get_userbyid(function_row.proowner) = 'postgres'
          and function_row.prosecdef
          and function_row.proconfig is not distinct from
            array['search_path=public, pg_temp']::text[]
      )
      or exists (
        select 1
        from pg_proc function_row
        cross join lateral aclexplode(
          coalesce(
            function_row.proacl,
            acldefault('f', function_row.proowner)
          )
        ) acl
        where function_row.oid = to_regprocedure(v_signature)
          and acl.grantee = 0
          and acl.privilege_type = 'EXECUTE'
      )
      or has_function_privilege('anon', v_signature, 'EXECUTE')
      or has_function_privilege('authenticated', v_signature, 'EXECUTE')
      or has_function_privilege('discord_bot', v_signature, 'EXECUTE')
      or not has_function_privilege('service_role', v_signature, 'EXECUTE')
    then
      raise exception using
        errcode = '55000',
        message = 'SUBMISSION_PROFILE_WALLET_BINDING_FUNCTION_SECURITY_MISMATCH',
        detail = v_signature;
    end if;
  end loop;

  if exists (
    select 1
    from pg_proc function_row
    join pg_namespace namespace_row
      on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname in (
        'get_completed_submission_upload_operation',
        'reserve_submission_upload',
        'commit_submission_upload'
      )
      and function_row.oid <> all(v_service_signatures::regprocedure[])
  ) then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_PROFILE_WALLET_BINDING_FUNCTION_OVERLOAD_MISMATCH';
  end if;

  if not exists (
      select 1
      from pg_class relation
      where relation.oid = 'public.submission_upload_operations'::regclass
        and relation.relrowsecurity
    )
    or has_table_privilege(
      'anon', 'public.submission_upload_operations', 'SELECT'
    )
    or has_table_privilege(
      'authenticated', 'public.submission_upload_operations', 'SELECT'
    )
    or has_table_privilege(
      'discord_bot', 'public.submission_upload_operations', 'SELECT'
    )
    or has_table_privilege(
      'service_role', 'public.submission_upload_operations', 'SELECT'
    )
    or has_table_privilege(
      'service_role', 'public.submission_upload_operations', 'INSERT'
    )
    or has_table_privilege(
      'service_role', 'public.submission_upload_operations', 'UPDATE'
    )
    or has_table_privilege(
      'service_role', 'public.submission_upload_operations', 'DELETE'
    )
    or has_table_privilege(
      'service_role', 'public.submission_private_data', 'INSERT'
    )
    or has_table_privilege(
      'service_role', 'public.submission_private_data', 'UPDATE'
    )
    or has_table_privilege(
      'service_role', 'public.submission_private_data', 'DELETE'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_PROFILE_WALLET_BINDING_TABLE_ACL_MISMATCH';
  end if;

  if not exists (
      select 1
      from pg_constraint constraint_row
      where constraint_row.conrelid =
        'public.submission_upload_operations'::regclass
        and constraint_row.conname =
          'submission_upload_operations_private_binding_check'
        and constraint_row.convalidated
    )
    or not exists (
      select 1
      from pg_constraint constraint_row
      where constraint_row.conrelid =
        'public.submission_private_data'::regclass
        and constraint_row.conname =
          'submission_private_data_sol_recipient_contract_check'
        and constraint_row.convalidated
    )
  then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_PROFILE_WALLET_BINDING_CONSTRAINT_MISMATCH';
  end if;
end;
$security_postflight$;

comment on column public.submission_upload_operations.wallet_source is
  'Private recipient source bound atomically at reservation: manual, profile, or none for donate.';
comment on column public.submission_upload_operations.wallet_address is
  'Private per-Submission recipient snapshot. It never follows later Profile Wallet changes.';
comment on column public.submission_upload_operations.profile_wallet_version is
  'Displayed Profile Wallet version that was verified and bound server-side; null for manual and donate.';
comment on function public.reserve_submission_upload(
  uuid, uuid, text, text, text, integer,
  text, bigint, text, text, integer, text
) is
  'Atomically validates Upload eligibility and binds one private manual or server-resolved Profile Wallet recipient before R2. Same-key retry reuses the bound snapshot.';
comment on function public.commit_submission_upload(uuid,uuid,integer,integer) is
  'Atomically commits one processed Submission using only the private payout metadata frozen in its Upload reservation.';
comment on function public.get_completed_submission_upload_operation(uuid,uuid) is
  'Returns only the owning current session completed-operation identifiers needed for safe Upload replay; it never returns private payout metadata.';

commit;

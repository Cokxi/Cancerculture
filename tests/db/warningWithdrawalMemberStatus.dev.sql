\set ON_ERROR_STOP on

begin;

set local lock_timeout = '10s';
set local statement_timeout = '60s';

do $contract$
declare
  v_withdrawn_session uuid;
  v_withdrawn_public_id uuid;
  v_withdrawn_detail jsonb;
  v_withdrawn_notifications jsonb;
  v_active_session uuid;
  v_active_public_id uuid;
  v_active_detail jsonb;
begin
  if position(
    'Account Warning withdrawn' in pg_get_functiondef(
      'public.get_own_notifications(uuid,timestamp with time zone,uuid,integer)'::regprocedure
    )
  ) = 0
    or position(
      'accountActiveWarningCount' in pg_get_functiondef(
        'public.get_own_user_warning_detail(uuid,uuid)'::regprocedure
      )
    ) = 0
  then
    raise exception 'DEV_WARNING_WITHDRAWAL_MEMBER_STATUS_NOT_INSTALLED';
  end if;

  select session_row.id, warning_row.public_warning_id
  into v_withdrawn_session, v_withdrawn_public_id
  from public.user_warnings warning_row
  join public.user_warning_current current_row
    on current_row.warning_id = warning_row.warning_id
  join lateral (
    select candidate.id
    from public.sessions candidate
    where candidate.discord_user_id = warning_row.target_discord_user_id
      and candidate.revoked_at is null
    order by candidate.created_at desc, candidate.id
    limit 1
  ) session_row on true
  where current_row.state = 'overruled'
  order by warning_row.issued_at desc
  limit 1;

  if v_withdrawn_session is null or v_withdrawn_public_id is null then
    raise exception 'DEV_WARNING_WITHDRAWAL_FIXTURE_UNAVAILABLE';
  end if;

  v_withdrawn_detail := public.get_own_user_warning_detail(
    v_withdrawn_session,
    v_withdrawn_public_id
  );
  if v_withdrawn_detail ->> 'outcome' <> 'found'
    or v_withdrawn_detail ->> 'effectiveStatus' <> 'withdrawn'
    or (v_withdrawn_detail -> 'expiresAt') <> 'null'::jsonb
    or v_withdrawn_detail ->> 'accountActiveWarningCount' <> '0'
    or (v_withdrawn_detail -> 'accountLatestActiveExpiresAt') <> 'null'::jsonb
    or (select count(*) from jsonb_object_keys(v_withdrawn_detail)) <> 9
    or v_withdrawn_detail ?| array[
      'actorDisplayName', 'actorDiscordUserId', 'actorRoleKey',
      'correctionReason', 'sourceCommentBody', 'autoFlag'
    ]
  then
    raise exception 'DEV_WARNING_WITHDRAWAL_DETAIL_PROJECTION_FAILED';
  end if;

  v_withdrawn_notifications := public.get_own_notifications(
    v_withdrawn_session,
    null,
    null,
    50
  );
  if not exists (
    select 1
    from jsonb_array_elements(v_withdrawn_notifications -> 'items') item
    where item ->> 'eventType' = 'user_warning_overruled'
      and item ->> 'title' = 'Account Warning withdrawn'
      and item ->> 'body' =
        'A Warning for your account was withdrawn. Review your updated account Warning status.'
      and item ->> 'actionLabel' = 'View updated status'
  )
  then
    raise exception 'DEV_WARNING_WITHDRAWAL_NOTIFICATION_COPY_FAILED';
  end if;

  select session_row.id, warning_row.public_warning_id
  into v_active_session, v_active_public_id
  from public.user_warnings warning_row
  join public.user_warning_current current_row
    on current_row.warning_id = warning_row.warning_id
  join lateral (
    select candidate.id
    from public.sessions candidate
    where candidate.discord_user_id = warning_row.target_discord_user_id
      and candidate.revoked_at is null
    order by candidate.created_at desc, candidate.id
    limit 1
  ) session_row on true
  where current_row.state = 'active'
    and current_row.expires_at > clock_timestamp()
  order by warning_row.issued_at desc
  limit 1;

  if v_active_session is null or v_active_public_id is null then
    raise exception 'DEV_ACTIVE_WARNING_FIXTURE_UNAVAILABLE';
  end if;

  v_active_detail := public.get_own_user_warning_detail(
    v_active_session,
    v_active_public_id
  );
  if v_active_detail ->> 'effectiveStatus' <> 'active'
    or (v_active_detail -> 'expiresAt') = 'null'::jsonb
    or (v_active_detail ->> 'accountActiveWarningCount')::integer < 1
    or (v_active_detail -> 'accountLatestActiveExpiresAt') = 'null'::jsonb
  then
    raise exception 'DEV_ACTIVE_WARNING_ACCOUNT_STATUS_FAILED';
  end if;
end;
$contract$;

rollback;

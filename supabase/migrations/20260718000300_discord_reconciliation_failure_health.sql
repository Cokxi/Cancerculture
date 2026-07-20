begin;

create or replace function public.record_discord_reconciliation_failure(
  p_event_id text,
  p_observed_at timestamptz,
  p_payload_sha256 text,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_claim text;
  v_error_code text;
  v_health_error_code text;
  v_failure_at timestamptz;
  v_health_rows integer;
begin
  v_error_code := upper(
    regexp_replace(coalesce(p_error_code, ''), '[^A-Z0-9_]', '_', 'g')
  );
  v_error_code := left(v_error_code, 80);

  if v_error_code = '' then
    v_error_code := 'RECONCILIATION_FAILED';
  end if;

  if coalesce(p_error_code, '') ~ '^[A-Z0-9_]{1,80}$' then
    v_health_error_code := left(p_error_code, 64);
  else
    v_health_error_code := 'RECONCILIATION_FAILED';
  end if;

  v_claim := public.claim_discord_membership_sync_event(
    p_event_id,
    'reconciliation_failed',
    p_observed_at,
    p_payload_sha256
  );

  if v_claim = 'replay' then
    return jsonb_build_object('outcome', 'replay');
  elsif v_claim <> 'claimed' then
    return jsonb_build_object('outcome', 'invalid_event');
  end if;

  select greatest(
    clock_timestamp(),
    coalesce(last_failure_at, '-infinity'::timestamptz)
  )
  into v_failure_at
  from public.discord_sync_health
  where id = 1
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'DISCORD_SYNC_HEALTH_SINGLETON_MISSING';
  end if;

  update public.discord_sync_health
  set
    last_error_at = now(),
    last_error_code = v_error_code,
    last_failure_at = v_failure_at,
    last_failure_component = 'full_reconciliation',
    last_failure_code = v_health_error_code,
    updated_at = v_failure_at
  where id = 1;
  get diagnostics v_health_rows = row_count;

  if v_health_rows <> 1 then
    raise exception using
      errcode = 'P0001',
      message = 'DISCORD_SYNC_HEALTH_SINGLETON_UPDATE_FAILED';
  end if;

  perform public.audit_discord_sync_action(
    'discord_reconciliation_failed',
    null,
    jsonb_build_object('errorCode', v_error_code)
  );
  perform public.finish_discord_membership_sync_event(
    p_event_id,
    'failed'
  );

  return jsonb_build_object('outcome', 'applied');
end;
$function$;

alter function public.record_discord_reconciliation_failure(
  text,
  timestamptz,
  text,
  text
) owner to postgres;

revoke all on function public.record_discord_reconciliation_failure(
  text,
  timestamptz,
  text,
  text
) from public, anon, authenticated, discord_bot, service_role;

grant execute on function public.record_discord_reconciliation_failure(
  text,
  timestamptz,
  text,
  text
) to service_role;

comment on function public.record_discord_reconciliation_failure(
  text,
  timestamptz,
  text,
  text
) is
  'Records an accepted reconciliation failure and atomically updates global failure health without clearing historical success or heartbeat timestamps.';

commit;

begin;

do $proof$
declare
  v_actor_discord_user_id text;
  v_payload jsonb;
begin
  select member.discord_user_id
  into v_actor_discord_user_id
  from public.team_members member
  where member.role = 'admin'
  limit 1;

  if v_actor_discord_user_id is null then
    raise exception using message = 'PAYOUT_V2_DEV_ADMIN_MISSING';
  end if;

  v_payload := public.get_simple_team_payouts_v2(
    v_actor_discord_user_id,
    true
  );

  if v_payload ->> 'outcome' <> 'ok'
    or jsonb_typeof(v_payload -> 'items') <> 'array'
  then
    raise exception using message = 'PAYOUT_V2_DEV_PROJECTION_INVALID';
  end if;
end;
$proof$;

rollback;

\set ON_ERROR_STOP on
begin;

do $$
declare
  v_base bigint := 980000000000000000 + floor(random() * 1000000000000000)::bigint;
  v_unknown text := v_base::text;
  v_nonmember text := (v_base + 1)::text;
  v_waiting text := (v_base + 2)::text;
  v_eligible text := (v_base + 3)::text;
  v_discord_banned text := (v_base + 4)::text;
  v_website_banned text := (v_base + 5)::text;
  v_unknown_session uuid := gen_random_uuid();
  v_nonmember_session uuid := gen_random_uuid();
  v_waiting_session uuid := gen_random_uuid();
  v_eligible_session uuid := gen_random_uuid();
  v_website_banned_session uuid := gen_random_uuid();
  v_result jsonb;
  v_now timestamptz := transaction_timestamp();
begin
  insert into public.user_logs (
    discord_user_id,
    current_discord_username,
    is_banned
  ) values
    (v_unknown, 'auth-separation-unknown', false),
    (v_nonmember, 'auth-separation-nonmember', false),
    (v_waiting, 'auth-separation-waiting', false),
    (v_eligible, 'auth-separation-eligible', false),
    (v_discord_banned, 'auth-separation-discord-ban', false),
    (v_website_banned, 'auth-separation-website-ban', false);

  insert into public.discord_member_state (
    discord_user_id,
    current_discord_username,
    discord_joined_at,
    is_in_discord,
    discord_ban_active,
    discord_membership_observed_at,
    discord_ban_observed_at
  ) values
    (v_nonmember, 'auth-separation-nonmember', null, false, false, v_now, v_now),
    (v_waiting, 'auth-separation-waiting', v_now - interval '2 minutes', true, false, v_now, v_now),
    (v_eligible, 'auth-separation-eligible', v_now - interval '1 day', true, false, v_now, v_now),
    (v_discord_banned, 'auth-separation-discord-ban', null, false, true, v_now, v_now),
    (v_website_banned, 'auth-separation-website-ban', null, false, false, v_now, v_now);

  v_result := public.create_cancerculture_session(v_unknown_session, v_unknown);
  if v_result ->> 'outcome' <> 'created'
    or coalesce((v_result ->> 'membershipKnown')::boolean, true)
  then
    raise exception 'unknown membership did not receive a restricted session: %', v_result;
  end if;

  v_result := public.create_cancerculture_session(v_nonmember_session, v_nonmember);
  if v_result ->> 'outcome' <> 'created' then
    raise exception 'nonmember did not receive a restricted session: %', v_result;
  end if;

  v_result := public.create_cancerculture_session(v_waiting_session, v_waiting);
  if v_result ->> 'outcome' <> 'created' then
    raise exception 'join-wait user did not receive a restricted session: %', v_result;
  end if;

  v_result := public.create_cancerculture_session(v_eligible_session, v_eligible);
  if v_result ->> 'outcome' <> 'created' then
    raise exception 'eligible member could not create a session: %', v_result;
  end if;

  if (public.get_cancerculture_session_access(v_unknown_session) ->> 'outcome') <> 'allowed'
    or (public.get_cancerculture_session_access(v_nonmember_session) ->> 'outcome') <> 'allowed'
    or (public.get_cancerculture_session_access(v_waiting_session) ->> 'outcome') <> 'allowed'
  then
    raise exception 'membership leaked back into session validation';
  end if;

  v_result := public.create_cancerculture_session(gen_random_uuid(), v_discord_banned);
  if v_result ->> 'outcome' <> 'discord_banned' then
    raise exception 'known Discord ban did not block session creation: %', v_result;
  end if;

  v_result := public.create_cancerculture_session(
    v_website_banned_session,
    v_website_banned
  );
  if v_result ->> 'outcome' <> 'created' then
    raise exception 'pre-ban website session was not created: %', v_result;
  end if;

  update public.user_logs
  set is_banned = true
  where discord_user_id = v_website_banned;

  if not exists (
    select 1 from public.sessions
    where id = v_website_banned_session and revoked_at is not null
  ) then
    raise exception 'website ban trigger did not revoke the active session';
  end if;

  v_result := public.create_cancerculture_session(
    gen_random_uuid(),
    v_website_banned
  );
  if v_result ->> 'outcome' <> 'website_banned' then
    raise exception 'website ban did not block later session creation: %', v_result;
  end if;

  v_result := public.apply_discord_ban(
    'auth-separation-ban-' || gen_random_uuid()::text,
    v_now + interval '1 second',
    repeat('a', 64),
    v_unknown,
    'auth-separation-unknown'
  );
  if v_result ->> 'outcome' <> 'applied'
    or not exists (
      select 1 from public.sessions
      where id = v_unknown_session and revoked_at is not null
    )
  then
    raise exception 'later Discord ban did not revoke the restricted session: %', v_result;
  end if;
end;
$$;

select 'auth_participation_separation_ok' as result;
rollback;

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 23
    or (select count(*) from public.capability_catalog where is_active) <> 21
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 21
    or exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'DELEGABLE_PAYOUT_SPONSOR_REPORT_BASELINE_MISMATCH';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = 'cycles.manage'
      and implementation_version = 1
      and definition_hash =
        '4f3e07f01bc453f594994689c3049e698ca2bd1d1c99e75927d161056033f710'
      and is_active
      and assignable_to_non_admin
  ) then
    raise exception using
      errcode = '55000',
      message = 'DELEGABLE_PAYOUT_SPONSOR_REPORT_PREVIOUS_CUTOVER_MISMATCH';
  end if;

  if exists (
    select 1
    from public.capability_catalog
    where key in (
      'sponsorships.reports.view',
      'winners.payouts.view'
    )
  )
    or to_regclass('public.winner_public_profiles') is null
    or to_regclass('public.cycle_sponsorships') is null
    or to_regclass('public.sponsor_tracking_events') is null then
    raise exception using
      errcode = '55000',
      message = 'DELEGABLE_PAYOUT_SPONSOR_REPORT_TARGET_MISMATCH';
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
values
  (
    'sponsorships.reports.view',
    'View Sponsor Reports',
    'Review cycle sponsorship details and aggregate engagement reports, including a redacted JSON export.',
    'Sponsoring',
    array[
      'View sponsor name, linked website, cycle, active state, and sponsorship timing.',
      'View aggregate impressions, clicks, unique counts, click-through rate, and per-surface totals.',
      'Download the same report as a redacted JSON export.'
    ]::text[],
    array[
      'Viewing raw viewer hashes, cookies, pseudonymous identifiers, or individual tracking events.',
      'Viewing banner storage keys, credentials, secrets, or infrastructure details.',
      'Creating or changing sponsor drafts, planned sponsorships, contacts, commercial terms, banners, links, or cycles.',
      'Viewing unrelated logs, winner payouts, or private user data.'
    ]::text[],
    'high',
    true,
    true,
    1,
    '421c31be87cac7864a7fb6fad229e614befed4d38374f0fc05e285ffaa24d655'
  ),
  (
    'winners.payouts.view',
    'View Winner Payouts',
    'Review finalized winner identities, prize shares, payout choices, charities, and required payout wallet addresses without changing payouts.',
    'Winner & Payouts',
    array[
      'View finalized winners grouped by cycle with theme, submission, identity, votes, and prize share.',
      'View payout choice, charity or split details, and wallet addresses only where a winner keeps part of the prize.',
      'Copy an existing payout wallet address exactly through the protected view.'
    ]::text[],
    array[
      'Initiating, confirming, marking, changing, retrying, or otherwise managing payouts.',
      'Editing winners, rankings, votes, refunds, disqualifications, or finalized cycle history.',
      'Viewing non-winner private submission data, unrelated wallets, secrets, or infrastructure details.',
      'Viewing sponsor reports, unrelated logs, or managing team roles and permissions.'
    ]::text[],
    'high',
    true,
    true,
    1,
    'd482f10a0e15ea2f166f633e7cf8a27760987ea748fddc4b5c34aa6abde978e9'
  );

do $postflight$
begin
  if (select count(*) from public.capability_catalog) <> 25
    or (select count(*) from public.capability_catalog where is_active) <> 23
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 23
    or (
      select count(*)
      from public.capability_catalog
      where (
        (
          key = 'sponsorships.reports.view'
          and definition_hash =
            '421c31be87cac7864a7fb6fad229e614befed4d38374f0fc05e285ffaa24d655'
        )
        or (
          key = 'winners.payouts.view'
          and definition_hash =
            'd482f10a0e15ea2f166f633e7cf8a27760987ea748fddc4b5c34aa6abde978e9'
        )
      )
        and risk_level = 'high'
        and assignable_to_non_admin
        and is_active
        and implementation_version = 1
    ) <> 2
    or exists (
      select 1
      from public.team_role_capabilities
      where capability_key in (
        'sponsorships.reports.view',
        'winners.payouts.view'
      )
    ) then
    raise exception using
      errcode = '55000',
      message = 'DELEGABLE_PAYOUT_SPONSOR_REPORT_CATALOG_POSTFLIGHT_MISMATCH';
  end if;

  if not coalesce((
      select relrowsecurity
      from pg_class
      where oid = 'public.winner_public_profiles'::regclass
    ), false)
    or not coalesce((
      select relrowsecurity
      from pg_class
      where oid = 'public.cycle_sponsorships'::regclass
    ), false)
    or not coalesce((
      select relrowsecurity
      from pg_class
      where oid = 'public.sponsor_tracking_events'::regclass
    ), false)
    or has_table_privilege(
      'anon', 'public.winner_public_profiles', 'select'
    )
    or has_table_privilege(
      'authenticated', 'public.winner_public_profiles', 'select'
    )
    or has_table_privilege(
      'anon', 'public.cycle_sponsorships', 'select'
    )
    or has_table_privilege(
      'authenticated', 'public.cycle_sponsorships', 'select'
    )
    or has_table_privilege(
      'anon', 'public.sponsor_tracking_events', 'select'
    )
    or has_table_privilege(
      'authenticated', 'public.sponsor_tracking_events', 'select'
    ) then
    raise exception using
      errcode = '55000',
      message = 'DELEGABLE_PAYOUT_SPONSOR_REPORT_SECURITY_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

commit;

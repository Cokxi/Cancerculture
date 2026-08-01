begin;

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 18
    or (select count(*) from public.capability_catalog where is_active) <> 16
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 16
    or exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'VOTE_LOG_CAPABILITY_BASELINE_MISMATCH';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = 'logs.avatar_uploads.view'
      and implementation_version = 1
      and definition_hash = 'd9b917101f9051d91eef9f2f20cbfa738fcd8787abe8283b0862d007416d5813'
      and is_active
      and assignable_to_non_admin
  ) then
    raise exception using
      errcode = '55000',
      message = 'VOTE_LOG_CAPABILITY_PREVIOUS_CUTOVER_MISMATCH';
  end if;

  if exists (
    select 1
    from public.capability_catalog
    where key = 'logs.votes.view'
  ) then
    raise exception using
      errcode = '55000',
      message = 'VOTE_LOG_CAPABILITY_ALREADY_PRESENT';
  end if;

  if to_regclass('public.vote_logs') is null
    or (
      select count(*)
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'vote_logs'
        and column_name = any (array[
          'id',
          'created_at',
          'cycle_id',
          'submission_id',
          'status',
          'reason',
          'discord_user_id'
        ]::text[])
    ) <> 7
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'vote_logs'
        and column_name = 'cycle_id'
        and is_nullable = 'NO'
    ) then
    raise exception using
      errcode = '55000',
      message = 'VOTE_LOG_TABLE_CONTRACT_MISMATCH';
  end if;
end;
$preflight$;

alter table public.vote_logs
  alter column cycle_id drop not null;

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
  'logs.votes.view',
  'View Vote Logs',
  'View redacted individual vote outcomes and their user, cycle, submission, and timestamp context.',
  'Logs',
  array[
    'View recent accepted and rejected individual vote outcomes.',
    'View the associated user, cycle, submission reference, timestamp, and redacted outcome category.'
  ]::text[],
  array[
    'Viewing raw internal policy, database, provider, or infrastructure error details.',
    'Viewing vote-cluster, network, device, abuse-detection, or hidden aggregate signals.',
    'Casting, changing, refunding, or moderating votes and viewing unrelated logs.'
  ]::text[],
  'high',
  true,
  true,
  1,
  '991f2ef3ae5b454d3b1fec1c8fbc15ed64f845049553c6ba1cd07fe3bc0c09da'
);

do $postflight$
begin
  if (select count(*) from public.capability_catalog) <> 19
    or (select count(*) from public.capability_catalog where is_active) <> 17
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 17
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'logs.votes.view'
        and implementation_version = 1
        and definition_hash = '991f2ef3ae5b454d3b1fec1c8fbc15ed64f845049553c6ba1cd07fe3bc0c09da'
        and is_active
        and assignable_to_non_admin
    )
    or not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'vote_logs'
        and column_name = 'cycle_id'
        and is_nullable = 'YES'
    ) then
    raise exception using
      errcode = '55000',
      message = 'VOTE_LOG_CAPABILITY_FINAL_STATE_MISMATCH';
  end if;

  if exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'VOTE_LOG_CAPABILITY_MUST_START_UNGRANTED';
  end if;
end;
$postflight$;

commit;

begin;

set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $preflight$
begin
  if to_regclass('public.team_members') is null then
    raise exception using
      errcode = '42P01',
      message = 'TEAM_MEMBERS_TABLE_MISSING';
  end if;

  if to_regclass('public.social_verification_logs') is null then
    raise exception using
      errcode = '42P01',
      message = 'SOCIAL_VERIFICATION_LOGS_TABLE_MISSING';
  end if;

  if to_regprocedure(
    'public.set_team_member_role(text,text,text,text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = 'TEAM_MEMBER_ROLE_RPC_MISSING';
  end if;

  if to_regprocedure('gen_random_uuid()') is null then
    raise exception using
      errcode = '42883',
      message = 'UUID_GENERATOR_MISSING';
  end if;

  if exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.team_members'::regclass
      and constraint_row.conname = 'team_members_role_fkey'
  ) then
    raise exception using
      errcode = '42710',
      message = 'TEAM_MEMBER_ROLE_FOREIGN_KEY_ALREADY_EXISTS';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.team_members'::regclass
      and constraint_row.conname = 'team_members_role_check'
      and constraint_row.contype = 'c'
  ) then
    raise exception using
      errcode = '42704',
      message = 'TEAM_MEMBER_ROLE_CHECK_MISSING';
  end if;

  if not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.social_verification_logs'::regclass
      and constraint_row.conname =
        'social_verification_logs_actor_role_check'
      and constraint_row.contype = 'c'
  ) then
    raise exception using
      errcode = '42704',
      message = 'SOCIAL_ACTOR_ROLE_CHECK_MISSING';
  end if;

  if to_regclass('public.team_roles') is not null
    or to_regclass('public.capability_catalog') is not null
    or to_regclass('public.team_role_capabilities') is not null
    or to_regclass('public.team_authorization_audit') is not null
  then
    raise exception using
      errcode = '42P07',
      message = 'TEAM_AUTHORIZATION_FOUNDATION_ALREADY_EXISTS';
  end if;
end;
$preflight$;

lock table public.team_members in share row exclusive mode;
lock table public.social_verification_logs in share row exclusive mode;

do $data_preflight$
begin
  if exists (
    select 1
    from public.team_members
    where role not in (
      'admin',
      'trial_moderator',
      'moderator',
      'super_moderator',
      'mod'
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'UNKNOWN_TEAM_MEMBER_ROLE';
  end if;

  if exists (
    select 1
    from public.social_verification_logs
    where actor_role not in (
      'admin',
      'trial_moderator',
      'moderator',
      'super_moderator',
      'mod'
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'UNKNOWN_SOCIAL_VERIFICATION_ACTOR_ROLE';
  end if;
end;
$data_preflight$;

create table public.team_roles (
  key text primary key,
  display_name text not null,
  description text not null default '',
  is_system boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  created_by_discord_user_id text,
  updated_at timestamptz not null default now(),
  updated_by_discord_user_id text,
  constraint team_roles_key_format_check
    check (key ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint team_roles_display_name_check
    check (
      char_length(btrim(display_name)) between 1 and 100
    ),
  constraint team_roles_description_check
    check (char_length(description) <= 1000),
  constraint team_roles_row_version_check
    check (row_version >= 1),
  constraint team_roles_admin_invariant_check
    check (
      key <> 'admin'
      or (is_system = true and is_active = true)
    )
);

alter table public.team_roles owner to postgres;

insert into public.team_roles (
  key,
  display_name,
  description,
  is_system,
  is_active,
  sort_order
)
values
  (
    'admin',
    'Admin',
    'Fixed owner role for administrative, security, legal, infrastructure, and role-management access.',
    true,
    true,
    0
  ),
  (
    'trial_moderator',
    'Trial Moderator',
    'Current non-admin role with submission-phase moderation, user flagging, and basic user-directory access.',
    true,
    true,
    10
  ),
  (
    'moderator',
    'Moderator',
    'Current non-admin role with submission-phase moderation, user flagging, and basic user-directory access.',
    true,
    true,
    20
  ),
  (
    'super_moderator',
    'Super Moderator',
    'Current non-admin role with submission-phase moderation, user flagging, and basic user-directory access.',
    true,
    true,
    30
  );

alter table public.team_members
  drop constraint team_members_role_check;

update public.team_members
set role = 'trial_moderator'
where role = 'mod';

alter table public.team_members
  add constraint team_members_role_fkey
  foreign key (role)
  references public.team_roles(key)
  on update restrict
  on delete restrict;

create index if not exists team_members_role_idx
  on public.team_members (role);

create table public.capability_catalog (
  key text primary key,
  display_name text not null,
  description text not null,
  category text not null,
  included_actions text[] not null default '{}',
  excluded_actions text[] not null default '{}',
  risk_level text not null,
  assignable_to_non_admin boolean not null,
  is_active boolean not null default true,
  implementation_version integer not null,
  definition_hash text not null,
  introduced_at timestamptz not null default now(),
  deprecated_at timestamptz,
  constraint capability_catalog_key_format_check
    check (
      char_length(key) <= 128
      and key ~
        '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
    ),
  constraint capability_catalog_display_name_check
    check (
      char_length(btrim(display_name)) between 1 and 120
    ),
  constraint capability_catalog_description_check
    check (
      char_length(btrim(description)) between 1 and 2000
    ),
  constraint capability_catalog_category_check
    check (
      char_length(btrim(category)) between 1 and 100
    ),
  constraint capability_catalog_included_actions_check
    check (cardinality(included_actions) >= 1),
  constraint capability_catalog_excluded_actions_check
    check (cardinality(excluded_actions) >= 1),
  constraint capability_catalog_risk_level_check
    check (
      risk_level in ('low', 'moderate', 'high', 'critical')
    ),
  constraint capability_catalog_implementation_version_check
    check (implementation_version >= 1),
  constraint capability_catalog_definition_hash_check
    check (definition_hash ~ '^[0-9a-f]{64}$'),
  constraint capability_catalog_deprecation_check
    check (deprecated_at is null or is_active = false)
);

alter table public.capability_catalog owner to postgres;

insert into public.capability_catalog (
  key,
  display_name,
  description,
  category,
  included_actions,
  excluded_actions,
  risk_level,
  assignable_to_non_admin,
  implementation_version,
  definition_hash
)
values
  (
    'submissions.submission_phase.moderate',
    'Submission Phase Moderation',
    'Moderate submissions only during the currently permitted submission phase.',
    'Submission Moderation',
    array[
      'Disqualify submissions during the currently allowed submission phase.',
      'Reinstate submissions during the currently allowed submission phase.'
    ],
    array[
      'Voting-phase moderation.',
      'Vote refunds.',
      'Public visibility changes.',
      'Legal review.',
      'Finalized or archived cycles.'
    ],
    'high',
    true,
    1,
    '89d9d8794cc2a15772f869cf6670802b89afd00b8adafbbd1229db1d6d29f116'
  ),
  (
    'users.flag',
    'Flag Users',
    'Internally flag a user for later review.',
    'User Moderation',
    array[
      'Internally mark a user for later review.'
    ],
    array[
      'Read flag details for other users.',
      'Review or resolve flags.',
      'Manage website bans.',
      'Apply any other sanction.'
    ],
    'moderate',
    true,
    1,
    '802eb6c05cdeb7721a068262675b740f3208609eb0355632da09f607f5ec676b'
  ),
  (
    'users.directory.basic.view',
    'View Basic User Directory',
    'View the minimal redacted user directory used for selection and flagging.',
    'User Moderation',
    array[
      'View the minimal redacted user list used for selection and flagging.'
    ],
    array[
      'Full user histories.',
      'Flag reasons.',
      'Ban or unban reasons.',
      'Social, session, vote, wallet, or sync data.'
    ],
    'low',
    true,
    1,
    '5d0d0ab97601631a43f7ba87ba04d0007bf6534449774ac859f838e370cede48'
  );

create table public.team_role_capabilities (
  role_key text not null,
  capability_key text not null,
  granted_at timestamptz not null default now(),
  granted_by_discord_user_id text,
  grant_reason text not null,
  constraint team_role_capabilities_pkey
    primary key (role_key, capability_key),
  constraint team_role_capabilities_role_fkey
    foreign key (role_key)
    references public.team_roles(key)
    on update restrict
    on delete restrict,
  constraint team_role_capabilities_capability_fkey
    foreign key (capability_key)
    references public.capability_catalog(key)
    on update restrict
    on delete restrict,
  constraint team_role_capabilities_non_admin_check
    check (role_key <> 'admin'),
  constraint team_role_capabilities_grant_reason_check
    check (
      char_length(btrim(grant_reason)) between 3 and 1000
    )
);

alter table public.team_role_capabilities owner to postgres;

insert into public.team_role_capabilities (
  role_key,
  capability_key,
  grant_reason
)
select
  role_key,
  capability_key,
  'Initial migration seed preserving the current production authorization contract.'
from unnest(
  array[
    'trial_moderator',
    'moderator',
    'super_moderator'
  ]::text[]
) as seeded_roles(role_key)
cross join unnest(
  array[
    'submissions.submission_phase.moderate',
    'users.flag',
    'users.directory.basic.view'
  ]::text[]
) as seeded_capabilities(capability_key);

create table public.team_authorization_audit (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  idempotency_key uuid not null unique,
  actor_discord_user_id text not null,
  actor_role_key text not null,
  event_type text not null,
  target_role_key text,
  target_discord_user_id text,
  capability_key text,
  before_state jsonb not null,
  after_state jsonb not null,
  reason text not null,
  request_id text,
  constraint team_authorization_audit_actor_check
    check (
      char_length(btrim(actor_discord_user_id)) between 1 and 100
      and actor_role_key = 'admin'
    ),
  constraint team_authorization_audit_event_type_check
    check (
      event_type in (
        'role_created',
        'role_updated',
        'role_activated',
        'role_deactivated',
        'capability_granted',
        'capability_revoked',
        'member_role_changed',
        'admin_role_changed'
      )
    ),
  constraint team_authorization_audit_target_role_check
    check (
      target_role_key is null
      or target_role_key ~ '^[a-z][a-z0-9_]{2,63}$'
    ),
  constraint team_authorization_audit_capability_check
    check (
      capability_key is null
      or (
        char_length(capability_key) <= 128
        and capability_key ~
          '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
      )
    ),
  constraint team_authorization_audit_state_check
    check (
      jsonb_typeof(before_state) = 'object'
      and jsonb_typeof(after_state) = 'object'
    ),
  constraint team_authorization_audit_reason_check
    check (
      char_length(btrim(reason)) between 3 and 1000
    ),
  constraint team_authorization_audit_request_id_check
    check (
      request_id is null
      or char_length(btrim(request_id)) between 1 and 200
    ),
  constraint team_authorization_audit_target_check
    check (
      (
        event_type in (
          'role_created',
          'role_updated',
          'role_activated',
          'role_deactivated'
        )
        and target_role_key is not null
      )
      or (
        event_type in (
          'capability_granted',
          'capability_revoked'
        )
        and target_role_key is not null
        and capability_key is not null
      )
      or (
        event_type in (
          'member_role_changed',
          'admin_role_changed'
        )
        and nullif(btrim(target_discord_user_id), '') is not null
      )
    )
);

alter table public.team_authorization_audit owner to postgres;

alter table public.social_verification_logs
  drop constraint social_verification_logs_actor_role_check;

alter table public.social_verification_logs
  add constraint social_verification_logs_actor_role_check
  check (
    actor_role ~ '^[a-z][a-z0-9_]{2,63}$'
  );

create function public.protect_team_roles_foundation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'TEAM_ROLE_DELETE_FORBIDDEN';
  end if;

  if old.key = 'admin' and new is distinct from old then
    raise exception using
      errcode = '55000',
      message = 'ADMIN_ROLE_IMMUTABLE';
  end if;

  if new.key is distinct from old.key then
    raise exception using
      errcode = '55000',
      message = 'TEAM_ROLE_KEY_IMMUTABLE';
  end if;

  return new;
end;
$function$;

alter function public.protect_team_roles_foundation()
  owner to postgres;

create trigger protect_team_roles_foundation
before update or delete on public.team_roles
for each row
execute function public.protect_team_roles_foundation();

create function public.protect_capability_catalog_foundation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'CAPABILITY_DELETE_FORBIDDEN';
  end if;

  if new.key is distinct from old.key then
    raise exception using
      errcode = '55000',
      message = 'CAPABILITY_KEY_IMMUTABLE';
  end if;

  return new;
end;
$function$;

alter function public.protect_capability_catalog_foundation()
  owner to postgres;

create trigger protect_capability_catalog_foundation
before update or delete on public.capability_catalog
for each row
execute function public.protect_capability_catalog_foundation();

create function public.protect_team_authorization_audit()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
begin
  raise exception using
    errcode = '55000',
    message = 'TEAM_AUTHORIZATION_AUDIT_IMMUTABLE';
end;
$function$;

alter function public.protect_team_authorization_audit()
  owner to postgres;

create trigger protect_team_authorization_audit
before update or delete on public.team_authorization_audit
for each row
execute function public.protect_team_authorization_audit();

alter table public.team_roles enable row level security;
alter table public.capability_catalog enable row level security;
alter table public.team_role_capabilities enable row level security;
alter table public.team_authorization_audit enable row level security;

revoke all on table public.team_roles
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.capability_catalog
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.team_role_capabilities
  from public, anon, authenticated, discord_bot, service_role;
revoke all on table public.team_authorization_audit
  from public, anon, authenticated, discord_bot, service_role;

grant select on table public.team_roles to service_role;
grant select on table public.capability_catalog to service_role;
grant select on table public.team_role_capabilities to service_role;
grant select on table public.team_authorization_audit to service_role;

revoke all on function public.protect_team_roles_foundation()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.protect_capability_catalog_foundation()
  from public, anon, authenticated, discord_bot, service_role;
revoke all on function public.protect_team_authorization_audit()
  from public, anon, authenticated, discord_bot, service_role;

comment on table public.team_roles is
  'Registered team roles. Admin is the fixed owner role; non-admin roles become data-driven only after a later application cutover.';

comment on table public.capability_catalog is
  'Migration-managed catalog of system-defined capability definitions.';

comment on table public.team_role_capabilities is
  'Current positive non-admin role grants. Absence of a row means denied.';

comment on table public.team_authorization_audit is
  'Append-only audit foundation for future role and capability mutations.';

commit;

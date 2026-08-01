begin;

do $preflight$
begin
  if (select count(*) from public.capability_catalog) <> 19
    or (select count(*) from public.capability_catalog where is_active) <> 17
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 17
    or exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_MODERATION_LOG_CAPABILITY_BASELINE_MISMATCH';
  end if;

  if not exists (
    select 1
    from public.capability_catalog
    where key = 'logs.votes.view'
      and implementation_version = 1
      and definition_hash = '991f2ef3ae5b454d3b1fec1c8fbc15ed64f845049553c6ba1cd07fe3bc0c09da'
      and is_active
      and assignable_to_non_admin
  ) then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_MODERATION_LOG_CAPABILITY_PREVIOUS_CUTOVER_MISMATCH';
  end if;

  if exists (
    select 1
    from public.capability_catalog
    where key = 'logs.submission_moderation.view'
  ) then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_MODERATION_LOG_CAPABILITY_ALREADY_PRESENT';
  end if;

  if to_regclass('public.moderation_action_logs') is null
    or (
      select count(*)
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'moderation_action_logs'
        and column_name = any (array[
          'id',
          'created_at',
          'actor_role',
          'actor_id',
          'action',
          'target_type',
          'target_id',
          'target_discord_user_id',
          'reason_code',
          'reason_text',
          'evidence',
          'cycle_id',
          'moderation_request_id',
          'moderation_phase',
          'moderation_operation',
          'before_state',
          'after_state'
        ]::text[])
    ) <> 17 then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_MODERATION_LOG_TABLE_CONTRACT_MISMATCH';
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
  'logs.submission_moderation.view',
  'View Submission Moderation Logs',
  'View redacted submission-moderation actions and their actor, affected user, cycle, submission, and timestamp context.',
  'Logs',
  array[
    'View recent submission disqualification, reinstatement, legal-review, removal, and visibility-restoration actions.',
    'View the associated actor and affected user identities, cycle, submission reference, timestamp, and broad redacted reason category.'
  ]::text[],
  array[
    'Viewing free-text moderation notes, exact reason codes, evidence, object keys, idempotency details, internal capability names, or before/after state snapshots.',
    'Disqualifying, reinstating, hiding, restoring, exporting, or otherwise changing submissions.',
    'Viewing flag, user, upload, vote, social-verification, website-ban, or other unrelated logs.'
  ]::text[],
  'high',
  true,
  true,
  1,
  'fc820ff4bea36171834588856c8f1ca09f0b0391d0b04ff6c0521fffa85d88e7'
);

do $postflight$
begin
  if (select count(*) from public.capability_catalog) <> 20
    or (select count(*) from public.capability_catalog where is_active) <> 18
    or (
      select count(*)
      from public.capability_catalog
      where is_active and assignable_to_non_admin
    ) <> 18
    or not exists (
      select 1
      from public.capability_catalog
      where key = 'logs.submission_moderation.view'
        and implementation_version = 1
        and definition_hash = 'fc820ff4bea36171834588856c8f1ca09f0b0391d0b04ff6c0521fffa85d88e7'
        and is_active
        and assignable_to_non_admin
    ) then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_MODERATION_LOG_CAPABILITY_FINAL_STATE_MISMATCH';
  end if;

  if exists (select 1 from public.team_role_capabilities) then
    raise exception using
      errcode = '55000',
      message = 'SUBMISSION_MODERATION_LOG_CAPABILITY_MUST_START_UNGRANTED';
  end if;
end;
$postflight$;

commit;

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
declare
  v_recovery_sequence regclass :=
    to_regclass('public.account_totp_recovery_codes_id_seq');
  v_audit_sequence regclass :=
    to_regclass('public.account_two_factor_audit_id_seq');
begin
  if to_regclass('public.account_totp_recovery_codes') is null
    or to_regclass('public.account_two_factor_audit') is null
    or v_recovery_sequence is null
    or v_audit_sequence is null
    or pg_get_serial_sequence(
      'public.account_totp_recovery_codes', 'id'
    ) is distinct from 'public.account_totp_recovery_codes_id_seq'
    or pg_get_serial_sequence(
      'public.account_two_factor_audit', 'id'
    ) is distinct from 'public.account_two_factor_audit_id_seq'
    or exists (
      select 1
      from pg_class relation
      where relation.oid in (
        'public.account_totp_recovery_codes'::regclass,
        'public.account_two_factor_audit'::regclass,
        v_recovery_sequence,
        v_audit_sequence
      )
        and pg_get_userbyid(relation.relowner) <> 'postgres'
    )
    or exists (
      select 1
      from pg_class sequence_relation
      cross join lateral aclexplode(coalesce(
        sequence_relation.relacl,
        acldefault('S', sequence_relation.relowner)
      )) acl
      where sequence_relation.oid in (v_recovery_sequence, v_audit_sequence)
        and acl.grantee not in (
          'postgres'::regrole,
          'service_role'::regrole
        )
    )
    or not has_sequence_privilege(
      'service_role', v_recovery_sequence, 'SELECT'
    )
    or not has_sequence_privilege(
      'service_role', v_recovery_sequence, 'UPDATE'
    )
    or not has_sequence_privilege(
      'service_role', v_recovery_sequence, 'USAGE'
    )
    or not has_sequence_privilege(
      'service_role', v_audit_sequence, 'SELECT'
    )
    or not has_sequence_privilege(
      'service_role', v_audit_sequence, 'UPDATE'
    )
    or not has_sequence_privilege(
      'service_role', v_audit_sequence, 'USAGE'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'ACCOUNT_TWO_FACTOR_SEQUENCE_ACL_BASELINE_MISMATCH';
  end if;
end;
$preflight$;

revoke all on sequence public.account_totp_recovery_codes_id_seq
  from public, anon, authenticated, discord_bot, service_role;
revoke all on sequence public.account_two_factor_audit_id_seq
  from public, anon, authenticated, discord_bot, service_role;

do $postflight$
declare
  v_recovery_sequence regclass :=
    'public.account_totp_recovery_codes_id_seq'::regclass;
  v_audit_sequence regclass :=
    'public.account_two_factor_audit_id_seq'::regclass;
begin
  if pg_get_serial_sequence(
      'public.account_totp_recovery_codes', 'id'
    ) is distinct from 'public.account_totp_recovery_codes_id_seq'
    or pg_get_serial_sequence(
      'public.account_two_factor_audit', 'id'
    ) is distinct from 'public.account_two_factor_audit_id_seq'
    or exists (
      select 1
      from pg_class sequence_relation
      where sequence_relation.oid in (v_recovery_sequence, v_audit_sequence)
        and (
          sequence_relation.relkind <> 'S'
          or pg_get_userbyid(sequence_relation.relowner) <> 'postgres'
        )
    )
    or exists (
      select 1
      from pg_class sequence_relation
      cross join lateral aclexplode(coalesce(
        sequence_relation.relacl,
        acldefault('S', sequence_relation.relowner)
      )) acl
      where sequence_relation.oid in (v_recovery_sequence, v_audit_sequence)
        and (
          acl.grantee <> 'postgres'::regrole
          or acl.privilege_type not in ('SELECT', 'UPDATE', 'USAGE')
        )
    )
    or not has_sequence_privilege(
      'postgres', v_recovery_sequence, 'SELECT, UPDATE, USAGE'
    )
    or not has_sequence_privilege(
      'postgres', v_audit_sequence, 'SELECT, UPDATE, USAGE'
    )
    or has_sequence_privilege(
      'service_role', v_recovery_sequence, 'SELECT, UPDATE, USAGE'
    )
    or has_sequence_privilege(
      'service_role', v_audit_sequence, 'SELECT, UPDATE, USAGE'
    )
  then
    raise exception using
      errcode = '55000',
      message = 'ACCOUNT_TWO_FACTOR_SEQUENCE_ACL_POSTFLIGHT_MISMATCH';
  end if;
end;
$postflight$;

comment on sequence public.account_totp_recovery_codes_id_seq is
  'Owner-only identity sequence for hashed one-time recovery codes.';
comment on sequence public.account_two_factor_audit_id_seq is
  'Owner-only identity sequence for append-only redacted two-factor audit events.';

commit;

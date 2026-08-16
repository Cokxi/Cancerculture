import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL(
    "../../supabase/migrations/20260816000100_account_totp_two_factor_foundation.sql",
    import.meta.url
  ),
  "utf8"
);

const sequenceAclMigration = await readFile(
  new URL(
    "../../supabase/migrations/20260816000200_harden_account_two_factor_sequence_acls.sql",
    import.meta.url
  ),
  "utf8"
);

test("TOTP migration is additive and keeps secret, code, contact, grant, and audit state separate", () => {
  for (const table of [
    "account_totp_factors",
    "account_totp_enrollments",
    "account_totp_recovery_codes",
    "account_step_up_grants",
    "account_recovery_contacts",
    "account_email_challenges",
    "account_totp_attempt_limits",
    "account_two_factor_audit",
  ]) {
    assert.match(migration, new RegExp(`create table public\\.${table} \\(`, "u"));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "u"));
  }
  assert.doesNotMatch(migration, /drop table|truncate table/iu);
  assert.doesNotMatch(migration, /wallet_address|payout|winners\.manage_payouts/iu);
  assert.match(migration, /code_digest text not null check \(code_digest ~ '\^\[0-9a-f\]\{64\}\$'\)/u);
  assert.doesNotMatch(migration, /recovery_code\s+text|totp_secret\s+text|email_address\s+text/iu);
});

test("factor activation is atomic and erases pending ciphertext", () => {
  const activation = migration.slice(
    migration.indexOf("create function public.activate_account_totp_enrollment"),
    migration.indexOf("create function public.record_account_totp_failure")
  );
  assert.match(activation, /for update/u);
  assert.match(activation, /delete from public\.account_totp_factors/u);
  assert.match(activation, /insert into public\.account_totp_factors/u);
  assert.match(activation, /insert into public\.account_totp_recovery_codes/u);
  assert.match(activation, /secret_ciphertext = null/u);
  assert.match(activation, /status = 'activated'/u);
  assert.match(activation, /id <> p_session_id/u);
});

test("TOTP time-window replay and brute-force resistance are server-authoritative", () => {
  const accept = migration.slice(
    migration.indexOf("create function public.accept_account_totp_step_up"),
    migration.indexOf("create function public.accept_account_recovery_code_step_up")
  );
  assert.match(accept, /p_accepted_step <= v_factor\.last_accepted_step/u);
  assert.match(accept, /for update/u);
  assert.match(accept, /last_accepted_step = p_accepted_step/u);
  assert.match(accept, /'step_up_replayed'/u);
  assert.match(migration, /v_count >= 5 then p_now \+ interval '15 minutes'/u);
  assert.match(migration, /window_started_at <= p_now - interval '10 minutes'/u);
  assert.match(migration, /expires_at.*interval '5 minutes'/su);
});

test("backup email verification is TOTP-only, session-bound, delivered, expiring, and one-time", () => {
  const request = migration.slice(
    migration.indexOf("create function public.begin_account_recovery_email_change"),
    migration.indexOf("create function public.reserve_account_factor_recovery_email")
  );
  const confirmation = migration.slice(
    migration.indexOf("create function public.confirm_account_recovery_email"),
    migration.indexOf("create function public.remove_account_recovery_email")
  );

  assert.match(
    request,
    /account_consume_step_up\([\s\S]*'backup_email_change'[\s\S]*true/u
  );
  assert.match(request, /requested_at > v_now - interval '1 minute'/u);
  assert.match(request, /v_now \+ interval '15 minutes'/u);
  assert.match(confirmation, /session_id = p_session_id/u);
  assert.match(confirmation, /delivery_status = 'sent'/u);
  assert.match(confirmation, /consumed_at is null/u);
  assert.match(confirmation, /expires_at > v_now/u);
  assert.match(confirmation, /account_totp_register_failure\(v_user_id, 'email_token'/u);
  assert.match(confirmation, /set consumed_at = v_now/u);
  assert.match(confirmation, /account_totp_reset_failures\(v_user_id, 'email_token'/u);
});

test("automated factor recovery is verified-contact-only, rate-limited, and fail-closed", () => {
  const reservation = migration.slice(
    migration.indexOf("create function public.reserve_account_factor_recovery_email"),
    migration.indexOf("create function public.mark_account_email_challenge_delivery")
  );
  const delivery = migration.slice(
    migration.indexOf("create function public.mark_account_email_challenge_delivery"),
    migration.indexOf("create function public.confirm_account_recovery_email")
  );
  const recoveryEnrollment = migration.slice(
    migration.indexOf("create function public.begin_account_totp_enrollment"),
    migration.indexOf("create function public.activate_account_totp_enrollment")
  );

  assert.match(reservation, /from public\.account_totp_factors[\s\S]*for update/u);
  assert.match(reservation, /from public\.account_recovery_contacts/u);
  assert.match(reservation, /pg_advisory_xact_lock/u);
  assert.match(reservation, /v_daily_count >= 3/u);
  assert.match(reservation, /v_now - interval '24 hours'/u);
  assert.match(reservation, /v_now - interval '15 minutes'/u);
  assert.match(delivery, /delivery_status = 'pending'/u);
  assert.match(delivery, /p_delivery_status not in \('sent', 'failed'\)/u);
  assert.match(delivery, /'email_delivery_failed'/u);
  assert.match(recoveryEnrollment, /challenge_type = 'factor_recovery'/u);
  assert.match(recoveryEnrollment, /session_id = p_session_id/u);
  assert.match(recoveryEnrollment, /delivery_status = 'sent'/u);
  assert.match(recoveryEnrollment, /consumed_at is null/u);
  assert.match(recoveryEnrollment, /expires_at > v_now/u);
  assert.match(recoveryEnrollment, /set consumed_at = v_now/u);
});

test("factor recovery atomically invalidates old grants, challenges, and other sessions", () => {
  const activation = migration.slice(
    migration.indexOf("create function public.activate_account_totp_enrollment"),
    migration.indexOf("create function public.record_account_totp_failure")
  );
  assert.match(activation, /delete from public\.account_step_up_grants/u);
  assert.match(
    activation,
    /update public\.account_email_challenges[\s\S]*set consumed_at = coalesce\(consumed_at, v_now\)/u
  );
  assert.match(
    activation,
    /intent = 'email_recovery'[\s\S]*update public\.sessions[\s\S]*id <> p_session_id[\s\S]*revoked_at is null/u
  );
});

test("all public TOTP RPCs have fixed search path, checked owner, exact signatures, and service-only execute", () => {
  const signatures = [
    "get_account_two_factor_status(uuid)",
    "get_account_totp_factor_material(uuid)",
    "begin_account_totp_enrollment(uuid,uuid,text,text,text,text,integer,boolean,text)",
    "activate_account_totp_enrollment(uuid,uuid,bigint,text[])",
    "accept_account_totp_step_up(uuid,uuid,bigint,text)",
    "accept_account_recovery_code_step_up(uuid,text,text)",
    "consume_account_step_up_grant(uuid,text,uuid)",
  ];
  for (const signature of signatures) {
    assert.ok(migration.includes(`alter function public.${signature} owner to postgres`));
    assert.ok(migration.includes(`revoke all on function public.${signature}`));
    assert.ok(migration.includes(`grant execute on function public.${signature} to service_role`));
  }
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/u);
  assert.match(migration, /ACCOUNT_TOTP_FUNCTION_OVERLOAD_MISMATCH/u);
  assert.match(migration, /acl\.grantee = 0/u);
  assert.match(migration, /ACCOUNT_TOTP_INTERNAL_FUNCTION_SECURITY_MISMATCH/u);
  assert.match(migration, /'sol_wallet_change'/u);
  assert.match(migration, /future SOL Profile Wallet mutation must call this/u);
});

test("audit is append-only and structurally excludes secret-bearing metadata", () => {
  assert.match(migration, /ACCOUNT_TWO_FACTOR_AUDIT_IS_APPEND_ONLY/u);
  assert.match(migration, /before update on public\.account_two_factor_audit/u);
  assert.match(migration, /before delete on public\.account_two_factor_audit/u);
  const auditTable = migration.slice(
    migration.indexOf("create table public.account_two_factor_audit"),
    migration.indexOf("create index account_two_factor_audit_user_idx")
  );
  assert.doesNotMatch(
    auditTable,
    /\n\s+(?:metadata|secret|email_address|token|code_digest|request_body)\s/iu
  );
});

test("follow-up migration removes inherited service-role sequence privileges fail closed", () => {
  for (const sequence of [
    "account_totp_recovery_codes_id_seq",
    "account_two_factor_audit_id_seq",
  ]) {
    assert.match(
      sequenceAclMigration,
      new RegExp(
        `revoke all on sequence public\\.${sequence}[\\s\\S]*?service_role`,
        "u"
      )
    );
    assert.match(
      sequenceAclMigration,
      new RegExp(`comment on sequence public\\.${sequence}`, "u")
    );
  }
  assert.match(
    sequenceAclMigration,
    /ACCOUNT_TWO_FACTOR_SEQUENCE_ACL_BASELINE_MISMATCH/u
  );
  assert.match(
    sequenceAclMigration,
    /ACCOUNT_TWO_FACTOR_SEQUENCE_ACL_POSTFLIGHT_MISMATCH/u
  );
  assert.match(sequenceAclMigration, /acldefault\('S'/u);
  assert.match(sequenceAclMigration, /pg_get_serial_sequence/u);
  assert.doesNotMatch(sequenceAclMigration, /alter default privileges/iu);
  assert.doesNotMatch(sequenceAclMigration, /drop|truncate/iu);
});

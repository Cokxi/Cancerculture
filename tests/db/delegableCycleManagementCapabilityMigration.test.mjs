import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TEAM_CAPABILITY_REGISTRY } from "../../lib/auth/teamCapabilityRegistry.ts";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
const migration = await source(
  "supabase/migrations/20260802000200_delegable_cycle_management_capability.sql"
);
const definition = TEAM_CAPABILITY_REGISTRY["cycles.manage"];

function canonicalDefinition(entry) {
  return {
    key: entry.key,
    display_name: entry.displayName,
    description: entry.description,
    category: entry.category,
    included_actions: entry.includedActions,
    excluded_actions: entry.excludedActions,
    risk_level: entry.riskLevel,
    assignable_to_non_admin: entry.assignableToNonAdmin,
    implementation_version: entry.implementationVersion,
  };
}

test("cycles.manage is an exact critical capability and starts with zero grants", () => {
  const hash = createHash("sha256")
    .update(JSON.stringify(canonicalDefinition(definition)), "utf8")
    .digest("hex");
  const historicalHash =
    "4f3e07f01bc453f594994689c3049e698ca2bd1d1c99e75927d161056033f710";

  assert.equal(
    hash,
    "c0ba905e5e737ca1d09afa197f1bcb9adaf8919e7fb6fb37d33b53cfb54fb38a"
  );
  assert.equal(definition.definitionHash, hash);
  assert.equal(definition.riskLevel, "critical");
  assert.equal(definition.assignableToNonAdmin, true);
  assert.match(migration, new RegExp(historicalHash, "u"));
  assert.match(migration, /insert into public\.capability_catalog/u);
  assert.match(migration, /'cycles\.manage'[\s\S]*'critical'[\s\S]*true,[\s\S]*true,[\s\S]*1,/u);
  assert.doesNotMatch(
    migration,
    /insert\s+into\s+public\.team_role_capabilities/iu
  );
  assert.match(
    migration,
    /where capability_key = 'cycles\.manage'[\s\S]*CYCLE_MANAGEMENT_CAPABILITY_POSTFLIGHT_MISMATCH/u
  );
});

test("database authorization validates the real actor and exact grant", () => {
  assert.match(
    migration,
    /create or replace function public\.assert_cycle_manager\([\s\S]*from public\.team_members[\s\S]*join public\.team_roles[\s\S]*role_row\.is_active/u
  );
  assert.match(
    migration,
    /v_actor_role <> 'admin'[\s\S]*grant_row\.capability_key = 'cycles\.manage'/u
  );
  assert.match(migration, /security definer/iu);
  assert.match(migration, /set search_path = public, pg_temp/iu);
  assert.match(
    migration,
    /alter function public\.assert_cycle_manager\(text\) owner to postgres/u
  );
  assert.match(
    migration,
    /revoke all on function public\.assert_cycle_manager\(text\)[\s\S]*from public, anon, authenticated, service_role/u
  );
});

test("manual phase operations are idempotent and share the automatic transition lock", () => {
  assert.match(
    migration,
    /create table public\.cycle_management_requests[\s\S]*idempotency_key uuid primary key/u
  );
  assert.match(
    migration,
    /create or replace function public\.manage_cycle_phase\([\s\S]*assert_cycle_manager\(v_actor_id\)[\s\S]*cycle-phase-automation-global[\s\S]*from public\.voting_cycles[\s\S]*for update/u
  );
  assert.match(
    migration,
    /end_submission_start_voting[\s\S]*set status = 'voting_open'[\s\S]*submission_phase_closed[\s\S]*voting_phase_opened/u
  );
  assert.match(
    migration,
    /grant execute on function public\.manage_cycle_phase\([\s\S]*to service_role/u
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.manage_cycle_phase\([\s\S]*to (?:anon|authenticated)/u
  );
});

test("start, finalization and reset can no longer bypass the managed wrappers", () => {
  for (const operation of ["start", "finalize", "reset"]) {
    assert.match(
      migration,
      new RegExp(
        `create or replace function public\\.${operation}_cycle_managed\\([\\s\\S]*?assert_cycle_manager\\(v_actor_id\\)`,
        "u"
      )
    );
    assert.match(
      migration,
      new RegExp(
        `revoke execute on function public\\.${operation}_cycle\\([\\s\\S]*?from service_role`,
        "u"
      )
    );
  }
  assert.match(migration, /INVALID_SPONSOR_SETTINGS/u);
  assert.match(migration, /\^https:\/\//u);
  assert.match(migration, /sponsored-cycles\/drafts/u);
});

test("Cycle End Moderation is locked to voting_closed and cycles.manage", () => {
  const cycleEndFunction = migration.slice(
    migration.indexOf(
      "create or replace function public.moderate_cycle_end_submission"
    ),
    migration.indexOf(
      "alter function public.moderate_cycle_end_submission"
    )
  );

  assert.match(
    migration,
    /create or replace function public\.moderate_cycle_end_submission\([\s\S]*v_expected_phase <> 'voting_closed'[\s\S]*assert_cycle_manager\(v_actor_id\)/u
  );
  assert.match(
    migration,
    /from public\.voting_cycles[\s\S]*for update[\s\S]*v_cycle\.status::text <> 'voting_closed'[\s\S]*from public\.submissions[\s\S]*for update/u
  );
  assert.match(migration, /'requiredCapability', 'cycles\.manage'/u);
  assert.doesNotMatch(
    cycleEndFunction,
    /refund|winner_payout|update\s+public\.votes/iu
  );
});

test("reset cleanup and sponsored draft inputs stay narrowly server-controlled", async () => {
  const [resetRoute, cleanupWorker, sponsorRoute] = await Promise.all([
    source("app/api/admin/cycles/reset/route.ts"),
    source("lib/r2/processMediaCleanupQueue.ts"),
    source("app/api/admin/cycles/sponsored-draft/route.ts"),
  ]);

  assert.match(
    migration,
    /create or replace function public\.claim_media_cleanup_jobs_by_ids/u
  );
  assert.match(migration, /where queue\.id = any\(p_job_ids\)/u);
  assert.match(
    resetRoute,
    /processTargetedR2CleanupQueue\([\s\S]*reset\.r2CleanupQueueIds/u
  );
  assert.match(resetRoute, /verifyR2CleanupQueuePostflight/u);
  assert.doesNotMatch(resetRoute, /r2CleanupQueueIds\.slice/u);
  assert.match(cleanupWorker, /claim_media_cleanup_jobs_by_ids/u);
  assert.match(cleanupWorker, /if \(queueIds\)[\s\S]*claimDueJobsByIds/u);
  assert.match(
    cleanupWorker,
    /else \{[\s\S]*recoverStaleSubmissionUploads\(\)[\s\S]*claimDueJobs\(\)/u
  );
  assert.doesNotMatch(sponsorRoute, /body\?\.currentBannerR2Key/u);
  assert.match(
    sponsorRoute,
    /url\.protocol === "https:" && !url\.username && !url\.password/u
  );
  assert.match(sponsorRoute, /validIdempotencyKey\(idempotencyKey\)/u);
  assert.match(sponsorRoute, /reserve_sponsor_media_upload/u);
  assert.match(sponsorRoute, /commit_sponsor_media_upload/u);
});

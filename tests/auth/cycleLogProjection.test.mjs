import assert from "node:assert/strict";
import test from "node:test";
import { buildCycleLogEntry } from "../../lib/admin/cycleLogProjection.ts";

function row(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    created_at: "2026-08-02T00:00:00.000Z",
    actor_type: "admin",
    actor_id: "123456789012345678",
    action: "cycle_reset",
    target_type: "cycle",
    target_id: "42",
    meta: {
      reason: "internal free-text reset reason",
      sponsor_link: "https://internal.invalid",
      r2_keys_pending_cleanup: 3,
      removed_votes: 12,
    },
    ...overrides,
  };
}

test("delegated Cycle Log entries expose only the explicit read-only projection", () => {
  const entry = buildCycleLogEntry(row(), false, {
    actorLabel: "Known Discord Name",
    actorPublicProfileId: "private-admin-profile-reference",
    cycleTheme: "Community theme",
  });

  assert.equal(entry.eventType, "cycle_reset");
  assert.equal(entry.eventLabel, "Cycle reset");
  assert.equal(entry.cycleId, 42);
  assert.equal(entry.cycleTheme, "Community theme");
  assert.equal(entry.actorLabel, "Known Discord Name");
  assert.equal(entry.actorPublicProfileId, null);
  assert.equal(entry.adminAudit, null);
  const serialized = JSON.stringify(entry);
  for (const secret of [
    "internal free-text reset reason",
    "sponsor_link",
    "r2_keys_pending_cleanup",
    "removed_votes",
    "private-admin-profile-reference",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("Admin retains the existing raw audit context", () => {
  const entry = buildCycleLogEntry(row(), true, {
    actorLabel: "Owner • ID: 123456789012345678",
    actorPublicProfileId: "owner-profile",
    cycleTheme: "Community theme",
  });

  assert.equal(entry.actorPublicProfileId, "owner-profile");
  assert.equal(entry.adminAudit?.actorType, "admin");
  assert.equal(entry.adminAudit?.targetType, "cycle");
  assert.equal(entry.adminAudit?.rawAction, "cycle_reset");
  assert.equal(
    entry.adminAudit?.metadata.reason,
    "internal free-text reset reason"
  );
});

test("unexpected actions and invalid cycle IDs fail into bounded display values", () => {
  const entry = buildCycleLogEntry(
    row({ action: "internal_future_cycle_job", target_id: "not-a-cycle" }),
    false
  );

  assert.equal(entry.eventType, "cycle_event");
  assert.equal(entry.eventLabel, "Cycle event");
  assert.equal(entry.cycleId, null);
  assert.equal(JSON.stringify(entry).includes("internal_future_cycle_job"), false);
});

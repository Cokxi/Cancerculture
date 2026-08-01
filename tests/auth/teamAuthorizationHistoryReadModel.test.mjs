import assert from "node:assert/strict";
import test from "node:test";
import { buildTeamAuthorizationHistoryEntry } from "../../lib/auth/teamAuthorizationHistoryProjection.ts";

function row(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    occurred_at: "2026-08-01T12:00:00.000Z",
    actor_discord_user_id: "actor-1",
    actor_role_key: "admin",
    event_type: "member_role_changed",
    target_role_key: "moderator",
    target_discord_user_id: "member-1",
    capability_key: null,
    before_state: {
      previousRole: "trial_moderator",
      rowVersion: 7,
      batchId: "internal-batch",
    },
    after_state: {
      changed: true,
      previousRole: "trial_moderator",
      newRole: "moderator",
      rowVersion: 8,
      batchId: "internal-batch",
    },
    reason: "Approved team-role transition",
    request_id: "internal-request",
    ...overrides,
  };
}

test("delegated team-change projection exposes the role transition without raw enforcement state", () => {
  const entry = buildTeamAuthorizationHistoryEntry(
    row(),
    false,
    "  Known Discord Name  "
  );

  assert.equal(entry.previousRoleKey, "trial_moderator");
  assert.equal(entry.newRoleKey, "moderator");
  assert.equal(entry.targetDiscordUsername, "Known Discord Name");
  assert.equal(entry.adminAudit, null);
  assert.equal(JSON.stringify(entry).includes("rowVersion"), false);
  assert.equal(JSON.stringify(entry).includes("batchId"), false);
  assert.equal(JSON.stringify(entry).includes("internal-request"), false);
});

test("missing or invalid known names fall back to the unchanged Discord ID", () => {
  assert.equal(
    buildTeamAuthorizationHistoryEntry(row(), false, "   ")
      .targetDiscordUsername,
    null
  );
  assert.equal(
    buildTeamAuthorizationHistoryEntry(row(), false, "x".repeat(101))
      .targetDiscordUsername,
    null
  );
});

test("delegated role projection allowlists descriptive role fields", () => {
  const entry = buildTeamAuthorizationHistoryEntry(
    row({
      event_type: "role_updated",
      target_role_key: "community_reviewer",
      target_discord_user_id: null,
      before_state: {
        displayName: "Reviewer",
        description: "Reviews community items.",
        isActive: true,
        isSystem: false,
        rowVersion: 2,
        sortOrder: 40,
      },
      after_state: {
        changed: true,
        role: {
          displayName: "Community reviewer",
          description: "Reviews community submissions.",
          isActive: true,
          isSystem: false,
          rowVersion: 3,
          sortOrder: 30,
        },
      },
    }),
    false
  );

  assert.deepEqual(entry.roleBefore, {
    displayName: "Reviewer",
    description: "Reviews community items.",
    isActive: true,
  });
  assert.deepEqual(entry.roleAfter, {
    displayName: "Community reviewer",
    description: "Reviews community submissions.",
    isActive: true,
  });
  assert.equal(JSON.stringify(entry).includes("isSystem"), false);
  assert.equal(JSON.stringify(entry).includes("sortOrder"), false);
});

test("Admin projection retains the complete existing raw audit context", () => {
  const entry = buildTeamAuthorizationHistoryEntry(row(), true);

  assert.equal(entry.adminAudit?.requestId, "internal-request");
  assert.equal(entry.adminAudit?.beforeState.rowVersion, 7);
  assert.equal(entry.adminAudit?.afterState.batchId, "internal-batch");
});

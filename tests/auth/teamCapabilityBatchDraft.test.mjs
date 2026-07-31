import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCapabilityBatchReview,
  rebaseCapabilityDraft,
  resolveCapabilityBatchRequestIdentity,
  summarizeCapabilityDraft,
  toggleCapabilityDraft,
} from "../../lib/auth/teamCapabilityBatchDraft.ts";

const role = (key, overrides = {}) => ({
  key,
  displayName: key === "moderator" ? "Moderator" : "Custom Reviewers",
  isSystem: key === "moderator",
  isActive: true,
  rowVersion: key === "moderator" ? 4 : 7,
  grantedCapabilityKeys:
    key === "moderator" ? ["users.flag"] : [],
  ...overrides,
});

const capability = (key, overrides = {}) => ({
  key,
  displayName:
    key === "users.flag" ? "Flag users" : "View user directory",
  isActive: true,
  assignableToNonAdmin: true,
  implementationVersion: key === "users.flag" ? 2 : 3,
  definitionHash:
    key === "users.flag" ? "a".repeat(64) : "b".repeat(64),
  mutable: true,
  ...overrides,
});

test("the draft stores only deviations and toggling back removes the pair", () => {
  let draft = [];
  draft = toggleCapabilityDraft(draft, {
    roleKey: "moderator",
    capabilityKey: "users.flag",
    originalGranted: true,
  });
  assert.deepEqual(draft, [
    {
      roleKey: "moderator",
      capabilityKey: "users.flag",
      originalGranted: true,
      desiredGranted: false,
    },
  ]);

  draft = toggleCapabilityDraft(draft, {
    roleKey: "moderator",
    capabilityKey: "users.flag",
    originalGranted: true,
  });
  assert.deepEqual(draft, []);

  draft = toggleCapabilityDraft(draft, {
    roleKey: "custom_reviewers",
    capabilityKey: "users.directory.basic.view",
    originalGranted: false,
  });
  assert.equal(draft[0].desiredGranted, true);
});

test("the draft summary counts grants, revocations, roles, and capabilities", () => {
  assert.deepEqual(
    summarizeCapabilityDraft([
      {
        roleKey: "moderator",
        capabilityKey: "users.flag",
        originalGranted: true,
        desiredGranted: false,
      },
      {
        roleKey: "custom_reviewers",
        capabilityKey: "users.flag",
        originalGranted: false,
        desiredGranted: true,
      },
      {
        roleKey: "custom_reviewers",
        capabilityKey: "users.directory.basic.view",
        originalGranted: false,
        desiredGranted: true,
      },
    ]),
    {
      total: 3,
      grants: 2,
      revocations: 1,
      roles: 2,
      capabilities: 2,
    },
  );
});

test("review freezes a complete deterministic minimal batch payload", () => {
  const roles = [role("moderator"), role("custom_reviewers")];
  const capabilities = [
    capability("users.flag"),
    capability("users.directory.basic.view"),
  ];
  const review = buildCapabilityBatchReview(
    [
      {
        roleKey: "custom_reviewers",
        capabilityKey: "users.directory.basic.view",
        originalGranted: false,
        desiredGranted: true,
      },
      {
        roleKey: "moderator",
        capabilityKey: "users.flag",
        originalGranted: true,
        desiredGranted: false,
      },
      {
        roleKey: "custom_reviewers",
        capabilityKey: "users.flag",
        originalGranted: false,
        desiredGranted: true,
      },
    ],
    roles,
    capabilities,
  );

  assert.deepEqual(review.changes, [
    {
      role_key: "custom_reviewers",
      capability_key: "users.directory.basic.view",
      desired_granted: true,
    },
    {
      role_key: "custom_reviewers",
      capability_key: "users.flag",
      desired_granted: true,
    },
    {
      role_key: "moderator",
      capability_key: "users.flag",
      desired_granted: false,
    },
  ]);
  assert.deepEqual(review.roleSnapshots, [
    { role_key: "custom_reviewers", expected_row_version: 7 },
    { role_key: "moderator", expected_row_version: 4 },
  ]);
  assert.deepEqual(review.capabilitySnapshots, [
    {
      capability_key: "users.directory.basic.view",
      expected_implementation_version: 3,
      expected_definition_hash: "b".repeat(64),
    },
    {
      capability_key: "users.flag",
      expected_implementation_version: 2,
      expected_definition_hash: "a".repeat(64),
    },
  ]);
  assert.deepEqual(
    review.entries.map((entry) => [
      entry.capabilityKey,
      entry.roleKey,
      entry.originalGranted,
      entry.desiredGranted,
    ]),
    [
      ["users.flag", "moderator", true, false],
      ["users.flag", "custom_reviewers", false, true],
      [
        "users.directory.basic.view",
        "custom_reviewers",
        false,
        true,
      ],
    ],
  );
  assert.equal(Object.hasOwn(review, "actorDiscordUserId"), false);
  assert.equal(Object.isFrozen(review), true);
});

test("Admin, inactive roles, unavailable capabilities, duplicates, and no-ops cannot be reviewed", () => {
  const validCapability = capability("users.flag");
  const change = {
    roleKey: "moderator",
    capabilityKey: "users.flag",
    originalGranted: true,
    desiredGranted: false,
  };

  for (const [draft, roles, capabilities] of [
    [[], [role("moderator")], [validCapability]],
    [[change, change], [role("moderator")], [validCapability]],
    [
      [{ ...change, roleKey: "admin" }],
      [role("admin", { isSystem: true })],
      [validCapability],
    ],
    [[change], [role("moderator", { isActive: false })], [validCapability]],
    [[change], [role("moderator")], [capability("users.flag", { mutable: false })]],
    [
      [{ ...change, desiredGranted: true }],
      [role("moderator")],
      [validCapability],
    ],
  ]) {
    assert.throws(() =>
      buildCapabilityBatchReview(draft, roles, capabilities),
    );
  }
});

test("rebase removes achieved states, preserves remaining intent, and reports unavailable pairs", () => {
  const draft = [
    {
      roleKey: "moderator",
      capabilityKey: "users.flag",
      originalGranted: true,
      desiredGranted: false,
    },
    {
      roleKey: "custom_reviewers",
      capabilityKey: "users.flag",
      originalGranted: false,
      desiredGranted: true,
    },
    {
      roleKey: "removed_role",
      capabilityKey: "users.flag",
      originalGranted: false,
      desiredGranted: true,
    },
  ];
  const result = rebaseCapabilityDraft(
    draft,
    [
      role("moderator", { grantedCapabilityKeys: [] }),
      role("custom_reviewers", { rowVersion: 8 }),
    ],
    [capability("users.flag")],
  );

  assert.deepEqual(result.draft, [
    {
      roleKey: "custom_reviewers",
      capabilityKey: "users.flag",
      originalGranted: false,
      desiredGranted: true,
    },
  ]);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].reason, "role_unavailable");
});

test("one unchanged review and normalized reason retain one idempotency key", () => {
  let created = 0;
  const createKey = () => `key-${++created}`;
  const first = resolveCapabilityBatchRequestIdentity(
    null,
    "review-a",
    "  approved access  ",
    createKey,
  );
  const retry = resolveCapabilityBatchRequestIdentity(
    first,
    "review-a",
    "approved access",
    createKey,
  );
  const changedReason = resolveCapabilityBatchRequestIdentity(
    retry,
    "review-a",
    "different reason",
    createKey,
  );
  const changedDraft = resolveCapabilityBatchRequestIdentity(
    changedReason,
    "review-b",
    "different reason",
    createKey,
  );

  assert.strictEqual(retry, first);
  assert.equal(retry.idempotencyKey, "key-1");
  assert.equal(changedReason.idempotencyKey, "key-2");
  assert.equal(changedDraft.idempotencyKey, "key-3");
  assert.equal(created, 3);
});

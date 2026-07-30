import assert from "node:assert/strict";
import test from "node:test";
import {
  TeamRoleMutationPayloadError,
  parseTeamRoleMutationPayload,
} from "../../lib/auth/teamRoleMutationPayload.ts";

const idempotencyKey = "123e4567-e89b-42d3-a456-426614174000";
const definitionHash = "a".repeat(64);

test("role creation has no technical key or implicit grants", () => {
  assert.deepEqual(
    parseTeamRoleMutationPayload({
      operation: "create_role",
      displayName: " Review Team ",
      description: " Reviews submissions ",
      sortOrder: 40,
      reason: " Needed for review ",
      idempotencyKey,
    }),
    {
      operation: "create_role",
      displayName: "Review Team",
      description: "Reviews submissions",
      sortOrder: 40,
      reason: "Needed for review",
      idempotencyKey,
    }
  );

  for (const forbidden of [
    { roleKey: "review_team" },
    { capabilities: ["users.flag"] },
    { isAdmin: true },
  ]) {
    assert.throws(
      () =>
        parseTeamRoleMutationPayload({
          operation: "create_role",
          displayName: "Review Team",
          description: "",
          sortOrder: 40,
          reason: "Needed for review",
          idempotencyKey,
          ...forbidden,
        }),
      TeamRoleMutationPayloadError
    );
  }
});

test("role and capability mutations require concurrency metadata", () => {
  assert.deepEqual(
    parseTeamRoleMutationPayload({
      operation: "set_role_capability",
      roleKey: "custom_reviewers",
      capabilityKey: "users.flag",
      granted: true,
      expectedRoleRowVersion: 4,
      expectedCapabilityImplementationVersion: 2,
      expectedCapabilityDefinitionHash: definitionHash,
      reason: "Approved access",
      idempotencyKey,
    }),
    {
      operation: "set_role_capability",
      roleKey: "custom_reviewers",
      capabilityKey: "users.flag",
      granted: true,
      expectedRoleRowVersion: 4,
      expectedCapabilityImplementationVersion: 2,
      expectedCapabilityDefinitionHash: definitionHash,
      reason: "Approved access",
      idempotencyKey,
    }
  );

  for (const missing of [
    "expectedRoleRowVersion",
    "expectedCapabilityImplementationVersion",
    "expectedCapabilityDefinitionHash",
  ]) {
    const payload = {
      operation: "set_role_capability",
      roleKey: "custom_reviewers",
      capabilityKey: "users.flag",
      granted: true,
      expectedRoleRowVersion: 4,
      expectedCapabilityImplementationVersion: 2,
      expectedCapabilityDefinitionHash: definitionHash,
      reason: "Approved access",
      idempotencyKey,
    };
    delete payload[missing];
    assert.throws(
      () => parseTeamRoleMutationPayload(payload),
      TeamRoleMutationPayloadError
    );
  }
});

test("normal member changes cannot grant admin and carry the expected role", () => {
  const parsed = parseTeamRoleMutationPayload({
    operation: "set_member_non_admin_role",
    targetDiscordUserId: "target-user",
    newRoleKey: "custom_reviewers",
    expectedPreviousRoleKey: "moderator",
    reason: "Move to review team",
    idempotencyKey,
  });
  assert.equal(parsed.expectedPreviousRoleKey, "moderator");
  assert.equal(parsed.newRoleKey, "custom_reviewers");

  assert.throws(
    () =>
      parseTeamRoleMutationPayload({
        ...parsed,
        newRoleKey: "admin",
      }),
    TeamRoleMutationPayloadError
  );
});

test("owner changes require ADMIN and demotion requires a fallback", () => {
  assert.deepEqual(
    parseTeamRoleMutationPayload({
      operation: "set_member_admin_role",
      targetDiscordUserId: "target-user",
      isAdmin: false,
      expectedPreviousRoleKey: "admin",
      fallbackRoleKey: "moderator",
      confirmationWord: "ADMIN",
      reason: "Owner transition",
      idempotencyKey,
    }).fallbackRoleKey,
    "moderator"
  );

  for (const invalid of [
    { confirmationWord: "admin", fallbackRoleKey: "moderator" },
    { confirmationWord: "ADMIN", fallbackRoleKey: null },
  ]) {
    assert.throws(
      () =>
        parseTeamRoleMutationPayload({
          operation: "set_member_admin_role",
          targetDiscordUserId: "target-user",
          isAdmin: false,
          expectedPreviousRoleKey: "admin",
          reason: "Owner transition",
          idempotencyKey,
          ...invalid,
        }),
      TeamRoleMutationPayloadError
    );
  }
});

test("member enrollment and removal accept only the reviewed non-Admin payload", () => {
  const targetDiscordUserId = "123456789012345678";

  assert.deepEqual(
    parseTeamRoleMutationPayload({
      operation: "add_team_member",
      targetDiscordUserId,
      initialRoleKey: "custom_reviewers",
      confirmationWord: "ADD",
      reason: "Approved team enrollment",
      idempotencyKey,
    }),
    {
      operation: "add_team_member",
      targetDiscordUserId,
      initialRoleKey: "custom_reviewers",
      confirmationWord: "ADD",
      reason: "Approved team enrollment",
      idempotencyKey,
    }
  );

  assert.deepEqual(
    parseTeamRoleMutationPayload({
      operation: "remove_team_member",
      targetDiscordUserId,
      expectedPreviousRoleKey: "moderator",
      confirmationWord: "REMOVE",
      reason: "Authorization no longer required",
      idempotencyKey,
    }).expectedPreviousRoleKey,
    "moderator"
  );

  for (const invalid of [
    {
      operation: "add_team_member",
      targetDiscordUserId: "not-a-discord-id",
      initialRoleKey: "moderator",
      confirmationWord: "ADD",
    },
    {
      operation: "add_team_member",
      targetDiscordUserId,
      initialRoleKey: "admin",
      confirmationWord: "ADD",
    },
    {
      operation: "add_team_member",
      targetDiscordUserId,
      initialRoleKey: "moderator",
      confirmationWord: "add",
    },
    {
      operation: "add_team_member",
      targetDiscordUserId,
      initialRoleKey: "moderator",
      confirmationWord: "ADD",
      expectedAbsent: true,
    },
    {
      operation: "remove_team_member",
      targetDiscordUserId,
      expectedPreviousRoleKey: "admin",
      confirmationWord: "REMOVE",
    },
    {
      operation: "remove_team_member",
      targetDiscordUserId,
      expectedPreviousRoleKey: "moderator",
      confirmationWord: "remove",
    },
  ]) {
    assert.throws(
      () =>
        parseTeamRoleMutationPayload({
          ...invalid,
          reason: "Reviewed request",
          idempotencyKey,
        }),
      TeamRoleMutationPayloadError
    );
  }
});

test("wildcards, malformed idempotency keys, and actor input are rejected", () => {
  for (const payload of [
    {
      operation: "set_role_capability",
      roleKey: "moderator",
      capabilityKey: "users.*",
      granted: true,
      expectedRoleRowVersion: 1,
      expectedCapabilityImplementationVersion: 1,
      expectedCapabilityDefinitionHash: definitionHash,
      reason: "Approved access",
      idempotencyKey,
    },
    {
      operation: "set_role_active",
      roleKey: "moderator",
      isActive: false,
      expectedRowVersion: 1,
      reason: "Deactivate role",
      idempotencyKey: "retry-me",
    },
    {
      operation: "set_role_active",
      roleKey: "moderator",
      isActive: false,
      expectedRowVersion: 1,
      reason: "Deactivate role",
      idempotencyKey,
      actorDiscordUserId: "attacker",
    },
  ]) {
    assert.throws(
      () => parseTeamRoleMutationPayload(payload),
      TeamRoleMutationPayloadError
    );
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  TeamRoleCompatibilityPayloadError,
  parseTeamRoleCompatibilityPayload,
} from "../../lib/auth/teamRoleCompatibilityPayload.ts";

test("the compatibility payload accepts a data-driven non-admin role", () => {
  assert.deepEqual(
    parseTeamRoleCompatibilityPayload({
      targetDiscordId: " target-user ",
      targetRole: " custom_reviewers ",
      reason: " approved reason ",
    }),
    {
      targetDiscordId: "target-user",
      targetRole: "custom_reviewers",
      reason: "approved reason",
    }
  );
});

test("the compatibility payload rejects owner changes, removal, and extra input", () => {
  for (const payload of [
    {
      targetDiscordId: "target-user",
      targetRole: "admin",
      reason: "reason",
    },
    {
      targetDiscordId: "target-user",
      targetRole: null,
      reason: "reason",
    },
    {
      targetDiscordId: "target-user",
      targetRole: "moderator",
      reason: "reason",
      actorDiscordUserId: "attacker",
    },
  ]) {
    assert.throws(
      () => parseTeamRoleCompatibilityPayload(payload),
      TeamRoleCompatibilityPayloadError
    );
  }
});

test("the compatibility payload requires a target and meaningful reason", () => {
  for (const payload of [
    null,
    {},
    {
      targetDiscordId: "",
      targetRole: "moderator",
      reason: "reason",
    },
    {
      targetDiscordId: "target-user",
      targetRole: "moderator",
      reason: "x",
    },
  ]) {
    assert.throws(
      () => parseTeamRoleCompatibilityPayload(payload),
      TeamRoleCompatibilityPayloadError
    );
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  TeamRolePayloadError,
  parseTeamRoleChangePayload,
} from "../../lib/auth/teamRoleChangePayload.ts";

test("all canonical roles and removal parse with a required reason", () => {
  for (const targetRole of [
    "trial_moderator",
    "moderator",
    "super_moderator",
    "admin",
    null,
  ]) {
    assert.deepEqual(
      parseTeamRoleChangePayload({
        targetDiscordId: " target-user ",
        targetRole,
        reason: " approved reason ",
      }),
      {
        targetDiscordId: "target-user",
        targetRole,
        reason: "approved reason",
      }
    );
  }
});

test("legacy mod and unknown roles are rejected as write values", () => {
  for (const targetRole of ["mod", "owner", "", undefined]) {
    assert.throws(
      () =>
        parseTeamRoleChangePayload({
          targetDiscordId: "target-user",
          targetRole,
          reason: "reason",
        }),
      TeamRolePayloadError
    );
  }
});

test("missing targets and reasons are rejected server-side", () => {
  for (const payload of [
    null,
    {},
    { targetDiscordId: "", targetRole: null, reason: "x" },
    {
      targetDiscordId: "target-user",
      targetRole: null,
      reason: " ",
    },
  ]) {
    assert.throws(
      () => parseTeamRoleChangePayload(payload),
      TeamRolePayloadError
    );
  }
});

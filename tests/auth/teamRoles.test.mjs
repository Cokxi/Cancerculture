import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_TEAM_ROLES,
  TEAM_CAPABILITIES,
  getTeamRoleCapabilities,
  hasTeamCapability,
  normalizeTeamRole,
} from "../../lib/auth/teamRoles.ts";

test("canonical roles normalize and legacy mod is read-only Trial compatibility", () => {
  for (const role of CANONICAL_TEAM_ROLES) {
    assert.equal(normalizeTeamRole(role), role);
  }

  assert.equal(normalizeTeamRole("mod"), "trial_moderator");
});

test("unknown and empty role values fail closed", () => {
  for (const value of [
    "unknown",
    "",
    "ADMIN",
    true,
    1,
    null,
    undefined,
  ]) {
    assert.equal(normalizeTeamRole(value), null);

    for (const capability of TEAM_CAPABILITIES) {
      assert.equal(
        hasTeamCapability(value, capability),
        false
      );
    }
  }
});

test("the complete capability matrix matches the role contract", () => {
  const expected = {
    trial_moderator: [
      true,
      false,
      false,
      true,
      true,
      false,
    ],
    moderator: [
      true,
      true,
      false,
      true,
      true,
      false,
    ],
    super_moderator: [
      true,
      true,
      true,
      true,
      true,
      false,
    ],
    admin: [true, true, true, true, true, true],
  };

  for (const [role, values] of Object.entries(expected)) {
    const capabilities = getTeamRoleCapabilities(role);

    assert.deepEqual(
      TEAM_CAPABILITIES.map(
        (capability) => capabilities[capability]
      ),
      values
    );
  }

  assert.deepEqual(
    getTeamRoleCapabilities("mod"),
    getTeamRoleCapabilities("trial_moderator")
  );
});

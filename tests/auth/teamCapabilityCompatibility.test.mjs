import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTeamCapabilityCompatibility } from "../../lib/auth/teamCapabilityCompatibility.ts";

const active = Object.freeze({
  key: "test.compatibility.active",
  lifecycle: "active",
  implementationVersion: 1,
  definitionHash: "a".repeat(64),
});
const staged = Object.freeze({
  key: "test.compatibility.staged",
  lifecycle: "staged",
  implementationVersion: 1,
  definitionHash: "b".repeat(64),
});
const deprecated = Object.freeze({
  key: "test.compatibility.deprecated",
  lifecycle: "deprecated",
  implementationVersion: 1,
  definitionHash: "c".repeat(64),
});
const registry = Object.freeze({
  [active.key]: active,
  [staged.key]: staged,
  [deprecated.key]: deprecated,
});

const catalogEntry = (definition, overrides = {}) => ({
  key: definition.key,
  isActive: definition.lifecycle === "active",
  assignableToNonAdmin: definition.lifecycle === "active",
  implementationVersion: definition.implementationVersion,
  definitionHash: definition.definitionHash,
  ...overrides,
});

function evaluate({ catalog = [], grants = [] } = {}) {
  return evaluateTeamCapabilityCompatibility({
    registry,
    catalog,
    grantedCapabilityKeys: grants,
  });
}

test("active registry entries stay strict while absent non-active entries are safe", () => {
  const result = evaluate({ catalog: [catalogEntry(active)] });

  assert.deepEqual(result.activeCapabilityKeys, [active.key]);
  assert.deepEqual(result.safeTombstoneKeys, [
    deprecated.key,
    staged.key,
  ]);
  assert.deepEqual(result.issues, []);
});

test("an unknown inactive, non-assignable and ungranted catalog key is a safe tombstone", () => {
  const key = "test.compatibility.tombstone";
  const result = evaluate({
    catalog: [
      catalogEntry(active),
      {
        key,
        isActive: false,
        assignableToNonAdmin: false,
        implementationVersion: 1,
        definitionHash: "d".repeat(64),
      },
    ],
  });

  assert.deepEqual(result.activeCapabilityKeys, [active.key]);
  assert.equal(result.safeTombstoneKeys.includes(key), true);
  assert.deepEqual(result.issues, []);
});

for (const [name, overrides, grants, expectedCode] of [
  ["active", { isActive: true }, [], "unknown_catalog_key_active"],
  [
    "assignable",
    { assignableToNonAdmin: true },
    [],
    "unknown_catalog_key_assignable",
  ],
  ["granted", {}, ["test.compatibility.tombstone"], "unknown_catalog_key_granted"],
]) {
  test(`an unknown ${name} catalog key is drift`, () => {
    const key = "test.compatibility.tombstone";
    const result = evaluate({
      catalog: [
        catalogEntry(active),
        {
          key,
          isActive: false,
          assignableToNonAdmin: false,
          implementationVersion: 1,
          definitionHash: "d".repeat(64),
          ...overrides,
        },
      ],
      grants,
    });

    assert.equal(
      result.issues.some((entry) => entry.code === expectedCode),
      true
    );
    assert.equal(result.safeTombstoneKeys.includes(key), false);
  });
}

test("staged and deprecated registry entries tolerate only safe database tombstones", () => {
  const result = evaluate({
    catalog: [
      catalogEntry(active),
      catalogEntry(staged),
      catalogEntry(deprecated),
    ],
  });

  assert.deepEqual(result.activeCapabilityKeys, [active.key]);
  assert.deepEqual(result.safeTombstoneKeys, [
    deprecated.key,
    staged.key,
  ]);
  assert.deepEqual(result.issues, []);
});

for (const [name, overrides, grants, expectedCode] of [
  [
    "active in catalog",
    { isActive: true },
    [],
    "inactive_registry_key_active_in_catalog",
  ],
  [
    "assignable in catalog",
    { assignableToNonAdmin: true },
    [],
    "inactive_registry_key_assignable_in_catalog",
  ],
  [
    "granted",
    {},
    [staged.key],
    "inactive_registry_key_granted",
  ],
]) {
  test(`a staged registry entry that is ${name} is drift and never active`, () => {
    const result = evaluate({
      catalog: [catalogEntry(active), catalogEntry(staged, overrides)],
      grants,
    });

    assert.equal(
      result.issues.some((entry) => entry.code === expectedCode),
      true
    );
    assert.equal(result.activeCapabilityKeys.includes(staged.key), false);
  });
}

test("active entries fail on missing catalog, inactive state, assignability, version and hash", () => {
  const variants = [
    [[], "active_registry_key_missing_catalog"],
    [[catalogEntry(active, { isActive: false })], "catalog_entry_inactive"],
    [
      [catalogEntry(active, { assignableToNonAdmin: false })],
      "capability_not_assignable",
    ],
    [
      [catalogEntry(active, { implementationVersion: 2 })],
      "implementation_version_mismatch",
    ],
    [
      [catalogEntry(active, { definitionHash: "f".repeat(64) })],
      "definition_hash_mismatch",
    ],
  ];

  for (const [catalog, expectedCode] of variants) {
    const result = evaluate({ catalog });
    assert.equal(
      result.issues.some((entry) => entry.code === expectedCode),
      true
    );
    assert.deepEqual(result.activeCapabilityKeys, []);
  }
});

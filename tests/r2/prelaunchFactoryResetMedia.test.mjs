import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifyStorageKey,
  collectStorageKeys,
  parseArguments,
  sameR2Timestamp,
  sha256,
  stableJson,
  validateBackup,
  validateDatabasePostflightEvidence,
  validateManifest,
} from "../../scripts/prelaunchFactoryResetMedia.mjs";

test("R2 list and object timestamps compare at their shared precision", () => {
  assert.equal(
    sameR2Timestamp(
      "2026-08-08T18:38:21.346Z",
      "2026-08-08T18:38:21.000Z"
    ),
    true
  );
  assert.equal(
    sameR2Timestamp(
      "2026-08-08T18:38:21.346Z",
      "2026-08-08T18:38:22.000Z"
    ),
    false
  );
});

test("factory reset media inventory recognizes every owned prefix and blocks unknown keys", () => {
  assert.equal(
    classifyStorageKey("18/00000000-0000-4000-8000-000000000018.webp"),
    "cycle_media"
  );
  assert.equal(classifyStorageKey("avatars/123456789.webp"), "avatar");
  assert.equal(classifyStorageKey("avatars/123456789.png"), "avatar");
  assert.equal(
    classifyStorageKey(
      "sponsored-cycles/drafts/00000000-0000-4000-8000-000000000018.webp"
    ),
    "sponsor_draft"
  );
  assert.equal(
    classifyStorageKey(
      "sponsored-cycles/drafts/detail/00000000-0000-4000-8000-000000000018.webp"
    ),
    "sponsor_draft"
  );
  assert.equal(
    classifyStorageKey(
      "sponsored-cycles/drafts/feed/00000000-0000-4000-8000-000000000018.webp"
    ),
    "sponsor_draft"
  );
  assert.equal(
    classifyStorageKey("tests/media-cleanup-smoke/run/object.webp"),
    "media_cleanup_test"
  );
  assert.equal(classifyStorageKey("unowned/object.webp"), "unknown");
});

test("future factory reset contract includes Sponsor upload and measurement state", async () => {
  const script = await readFile(
    new URL("../../scripts/prelaunchFactoryResetMedia.mjs", import.meta.url),
    "utf8"
  );
  assert.match(script, /sponsor_media_upload_operations/u);
  assert.match(script, /sponsor_tracking_aggregates/u);
  assert.match(script, /next_cycle_sponsor_feed_banner_r2_key/u);
  assert.match(script, /next_cycle_sponsor_draft_revision/u);
});

test("factory reset media references are found recursively in rows, JSON and URLs", () => {
  const keys = new Set();
  collectStorageKeys(
    {
      direct: "18/00000000-0000-4000-8000-000000000018.webp",
      nested: [
        { avatar: "https://media.example/avatars/123456789.png" },
        {
          sponsor:
            "sponsored-cycles/drafts/00000000-0000-4000-8000-000000000019.webp",
        },
        {
          feedSponsor:
            "https://media.example/sponsored-cycles/drafts/feed/00000000-0000-4000-8000-000000000020.webp",
        },
      ],
    },
    keys
  );
  assert.deepEqual([...keys].sort(), [
    "18/00000000-0000-4000-8000-000000000018.webp",
    "avatars/123456789.png",
    "sponsored-cycles/drafts/00000000-0000-4000-8000-000000000019.webp",
    "sponsored-cycles/drafts/feed/00000000-0000-4000-8000-000000000020.webp",
  ]);
});

test("manifest hashes cover the complete inventory and reject unknown objects", () => {
  const inventory = {
    createdAt: "2026-08-12T00:00:00.000Z",
    migration: "20260812000400_prelaunch_application_data_factory_reset.sql",
    projectRef: "dev-ref",
    bucket: "dev-bucket",
    objects: [],
    referencedMissingObjects: [],
    preservedObjectKeys: [],
    unknownObjectKeys: [],
  };
  const manifest = {
    schemaVersion: 2,
    inventory,
    inventorySha256: sha256(stableJson(inventory)),
    backup: null,
  };
  assert.doesNotThrow(() => validateManifest(manifest));
  assert.throws(
    () => validateManifest({ ...manifest, inventorySha256: "0".repeat(64) }),
    /FACTORY_RESET_MANIFEST_INTEGRITY_FAILED/u
  );

  const unknownInventory = {
    ...inventory,
    unknownObjectKeys: ["unowned/object.webp"],
  };
  assert.throws(
    () =>
      validateManifest({
        ...manifest,
        inventory: unknownInventory,
        inventorySha256: sha256(stableJson(unknownInventory)),
      }),
    /FACTORY_RESET_UNKNOWN_OBJECTS_REQUIRE_REVIEW/u
  );
});

test("destructive media work requires a complete verified backup", () => {
  const inventory = {
    objects: [{ key: "avatars/123.png" }],
  };
  const records = [
    {
      sourceKey: "avatars/123.png",
      backupKey: "factory-reset/hash/avatars/123.png",
      size: 12,
      sha256: "a".repeat(64),
      contentType: "image/png",
      cacheControl: null,
    },
  ];
  const manifest = {
    inventory,
    inventorySha256: "b".repeat(64),
    backup: {
      inventorySha256: "b".repeat(64),
      records,
      recordsSha256: sha256(stableJson(records)),
    },
  };
  assert.doesNotThrow(() => validateBackup(manifest));
  assert.throws(
    () =>
      validateBackup({
        ...manifest,
        backup: { ...manifest.backup, records: [] },
      }),
    /FACTORY_RESET_VERIFIED_BACKUP_REQUIRED/u
  );
});

test("media deletion remains guarded against post-backup source drift", async () => {
  const source = await readFile(
    new URL("../../scripts/prelaunchFactoryResetMedia.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /assertCurrentSourceMatchesManifest/u);
  assert.match(source, /FACTORY_RESET_SOURCE_CHANGED_AFTER_BACKUP/u);
  const deleteFunction = source.slice(
    source.indexOf("async function deleteSourceObjects"),
    source.indexOf("async function assertSourceObjectsDeleted")
  );
  assert.ok(
    deleteFunction.indexOf("validateBackup(manifest)") <
      deleteFunction.indexOf("validateDatabasePostflightEvidence")
  );
  assert.ok(
    deleteFunction.indexOf("validateDatabasePostflightEvidence") <
      deleteFunction.indexOf("assertCurrentSourceMatchesManifest")
  );
});

test("database postflight evidence binds every reset table to the media manifest", () => {
  const scriptSource = readFile(
    new URL("../../scripts/prelaunchFactoryResetMedia.mjs", import.meta.url),
    "utf8"
  );
  return scriptSource.then((source) => {
    const block = source.match(/const RESET_ZERO_TABLES = \[([\s\S]*?)\];/u)?.[1];
    const tables = [...block.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
    const payload = {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      projectRef: "dev-ref",
      migrationSha256: "a".repeat(64),
      mediaManifestSha256: "b".repeat(64),
      resetTableCounts: Object.fromEntries(tables.map((table) => [table, 0])),
      adminCounts: { user_logs: 1, team_members: 1 },
    };
    const evidence = {
      payload,
      evidenceSha256: sha256(stableJson(payload)),
    };
    assert.doesNotThrow(() =>
      validateDatabasePostflightEvidence(
        evidence,
        { inventorySha256: "b".repeat(64) },
        "dev-ref"
      )
    );
    assert.throws(
      () =>
        validateDatabasePostflightEvidence(
          {
            ...evidence,
            payload: {
              ...payload,
              resetTableCounts: { ...payload.resetTableCounts, votes: 1 },
            },
          },
          { inventorySha256: "b".repeat(64) },
          "dev-ref"
        ),
      /FACTORY_RESET_DATABASE_POSTFLIGHT_EVIDENCE_INVALID/u
    );
  });
});

test("command parsing never infers a target or confirmation", () => {
  assert.deepEqual(parseArguments(["inventory", "--manifest", "C:/safe.json"]), {
    command: "inventory",
    options: new Map([["manifest", "C:/safe.json"]]),
  });
  assert.throws(
    () => parseArguments(["delete", "--confirm"]),
    /FACTORY_RESET_INVALID_ARGUMENTS/u
  );
});

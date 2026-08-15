import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXPECTED_MIGRATIONS,
  LIVE_BUCKET,
  LIVE_ORIGIN,
  LIVE_PROJECT_REF,
  MANIFEST_SCHEMA_VERSION,
  assertExactTarget,
  assertInventoryUnchanged,
  backupCandidates,
  createInventoryManifest,
  deleteCandidates,
  exceptionFingerprint,
  purgeDeletedUrls,
  restoreCandidates,
  sealManifest,
  sha256,
  stableJson,
  validateManifest,
  verifyDeletionPostflight,
} from "../../scripts/finalPrelaunchFactoryResetMedia.mjs";

const bytes = (value) => Buffer.from(value, "utf8");
const object = (key, value, overrides = {}) => ({
  key,
  size: bytes(value).length,
  etag: `"${sha256(value).slice(0, 16)}"`,
  lastModified: "2026-08-15T00:00:00.000Z",
  contentType: "image/webp",
  cacheControl: "public, max-age=31536000",
  sha256: sha256(bytes(value)),
  ...overrides,
});

const target = (overrides = {}) => ({
  projectRef: LIVE_PROJECT_REF,
  bucket: LIVE_BUCKET,
  origin: LIVE_ORIGIN,
  gitHead: "b".repeat(40),
  migrations: EXPECTED_MIGRATIONS,
  catalogSha256: "1".repeat(64),
  dataSha256: "2".repeat(64),
  referenceSha256: "3".repeat(64),
  backupRecordSha256: "4".repeat(64),
  ...overrides,
});

function referenceMap(entries = []) {
  return new Map(entries.map(([key, ...sources]) => [key, new Set(sources)]));
}

async function manifestFixture({ preserve = false } = {}) {
  const key = "4/00000000-0000-4000-8000-000000000004.webp";
  const sourceObject = object(key, "source-media");
  return createInventoryManifest({
    target: target(),
    objects: [sourceObject],
    resetReferences: preserve ? new Map() : referenceMap([[key, "submissions"]]),
    preserveReferences: preserve
      ? referenceMap([[key, "content_documents"]])
      : new Map(),
    expectedMissingReferenceSha256: exceptionFingerprint([]),
    expectedOrphanSha256: exceptionFingerprint([]),
  });
}

function createMemoryAdapter(manifest) {
  const source = new Map();
  const backup = new Map();
  const purges = [];
  for (const item of manifest.inventory.objects) {
    source.set(item.key, {
      bytes: bytes("source-media"),
      contentType: item.contentType,
      cacheControl: item.cacheControl,
    });
  }
  const adapter = {
    source,
    backup,
    purges,
    backupTarget: "private-final-reset-backup",
    inventorySource: async () =>
      manifest.inventory.objects
        .filter((item) => source.has(item.key))
        .map((item) => ({
          key: item.key,
          size: source.get(item.key).bytes.length,
          etag: item.etag,
          lastModified: item.lastModified,
          contentType: source.get(item.key).contentType,
          cacheControl: source.get(item.key).cacheControl,
          sha256: sha256(source.get(item.key).bytes),
        })),
    listSourceKeys: async () => [...source.keys()],
    getSource: async (key) => {
      if (!source.has(key)) throw new Error("missing source");
      return source.get(key);
    },
    getBackup: async (key) => {
      if (!backup.has(key)) throw new Error("missing backup");
      return backup.get(key);
    },
    headSource: async (key) => source.has(key),
    putBackup: async (key, value) => backup.set(key, { ...value, bytes: Buffer.from(value.bytes) }),
    putSource: async (key, value) => source.set(key, { ...value, bytes: Buffer.from(value.bytes) }),
    deleteSource: async (keys) => keys.forEach((key) => source.delete(key)),
    purgeExactUrls: async (urls) => purges.push(...urls),
  };
  return adapter;
}

function databaseEvidence(manifest) {
  const payload = {
    projectRef: LIVE_PROJECT_REF,
    migrationSha256: EXPECTED_MIGRATIONS.at(-1).sha256,
    mediaManifestSha256: manifest.manifestSha256,
    catalogSha256: manifest.target.catalogSha256,
    dataSha256: manifest.target.dataSha256,
    referenceSha256: manifest.target.referenceSha256,
    backupRecordSha256: manifest.target.backupRecordSha256,
    adminCounts: { user_logs: 1, team_members: 1 },
    resetTableCounts: { submissions: 0, votes: 0, sponsor_media_upload_operations: 0 },
  };
  return { payload, evidenceSha256: sha256(stableJson(payload)) };
}

test("manifest v3 is hard-bound to LIVE and never accepts cancerculture-assets", () => {
  assert.equal(MANIFEST_SCHEMA_VERSION, 3);
  assert.doesNotThrow(() => assertExactTarget(target()));
  for (const mismatch of [
    { projectRef: "gceljiuydyiwkomymuqh" },
    { bucket: "cancerculture-assets" },
    { bucket: "cancerculture-local" },
    { origin: "https://dev-uploads.example" },
    { migrations: EXPECTED_MIGRATIONS.slice(1) },
  ]) {
    assert.throws(() => assertExactTarget(target(mismatch)), /FINAL_RESET_MEDIA_/u);
  }
});

test("unknown keys, unclassified missing references, orphans and preserve conflicts fail closed", async () => {
  const known = object("4/00000000-0000-4000-8000-000000000004.webp", "source-media");
  const base = {
    target: target(),
    objects: [known],
    resetReferences: new Map(),
    preserveReferences: new Map(),
    expectedMissingReferenceSha256: undefined,
    expectedOrphanSha256: undefined,
  };
  await assert.rejects(
    createInventoryManifest({ ...base, objects: [object("unknown/key.bin", "x")] }),
    /FINAL_RESET_MEDIA_UNKNOWN_KEY/u
  );
  await assert.rejects(
    createInventoryManifest({
      ...base,
      resetReferences: referenceMap([["avatars/missing.webp", "user_logs"]]),
    }),
    /FINAL_RESET_MEDIA_MISSING_REFERENCE_MISMATCH/u
  );
  await assert.rejects(createInventoryManifest(base), /FINAL_RESET_MEDIA_ORPHAN_MISMATCH/u);
  await assert.rejects(
    createInventoryManifest({
      ...base,
      resetReferences: referenceMap([[known.key, "submissions"]]),
      preserveReferences: referenceMap([[known.key, "content_documents"]]),
    }),
    /FINAL_RESET_MEDIA_PRESERVE_CONFLICT/u
  );
});

test("explicit missing-reference and orphan fingerprints are bound into the manifest", async () => {
  const source = object("4/00000000-0000-4000-8000-000000000004.webp", "source-media");
  const missing = ["avatars/missing.webp"];
  const manifest = await createInventoryManifest({
    target: target(),
    objects: [source],
    resetReferences: referenceMap([[missing[0], "avatar_upload_logs"]]),
    preserveReferences: new Map(),
    expectedMissingReferenceSha256: exceptionFingerprint(missing),
    expectedOrphanSha256: exceptionFingerprint([source.key]),
  });
  assert.equal(manifest.inventory.missingReferenceSha256, exceptionFingerprint(missing));
  assert.equal(manifest.inventory.orphanSha256, exceptionFingerprint([source.key]));
  assert.doesNotThrow(() => validateManifest(manifest));
});

test("backup verifies source and copied bytes by GET/SHA-256 and rejects partial/hash failures", async () => {
  const manifest = await manifestFixture();
  const adapter = createMemoryAdapter(manifest);
  const backedUp = await backupCandidates(manifest, adapter);
  assert.equal(backedUp.backup.records.length, 1);
  assert.equal(adapter.backup.size, 1);

  const broken = createMemoryAdapter(manifest);
  broken.getBackup = async () => ({ bytes: bytes("wrong") });
  await assert.rejects(backupCandidates(manifest, broken), /FINAL_RESET_MEDIA_BACKUP_HASH_MISMATCH/u);

  const tampered = sealManifest({
    ...backedUp,
    backup: { ...backedUp.backup, records: [] },
  });
  assert.throws(() => validateManifest(tampered), /FINAL_RESET_MEDIA_BACKUP_RECORD_INVALID/u);
});

test("a partial multi-object copy never produces a verified backup manifest", async () => {
  const keys = [
    "4/00000000-0000-4000-8000-000000000004.webp",
    "4/00000000-0000-4000-8000-000000000005.webp",
  ];
  const manifest = await createInventoryManifest({
    target: target(),
    objects: keys.map((key) => object(key, "source-media")),
    resetReferences: referenceMap(keys.map((key) => [key, "submissions"])),
    preserveReferences: new Map(),
    expectedMissingReferenceSha256: exceptionFingerprint([]),
    expectedOrphanSha256: exceptionFingerprint([]),
  });
  const adapter = createMemoryAdapter(manifest);
  const realPut = adapter.putBackup;
  let copyCount = 0;
  adapter.putBackup = async (...args) => {
    copyCount += 1;
    if (copyCount === 2) throw new Error("simulated partial copy");
    return realPut(...args);
  };
  await assert.rejects(backupCandidates(manifest, adapter), /simulated partial copy/u);
  assert.equal(adapter.backup.size, 1);
  assert.equal(manifest.backup, null);
});

test("inventory drift blocks manifest-bound delete before the first deletion", async () => {
  const manifest = await manifestFixture();
  const adapter = createMemoryAdapter(manifest);
  const backedUp = await backupCandidates(manifest, adapter);
  adapter.inventorySource = async () => [];
  await assert.rejects(
    deleteCandidates(backedUp, adapter, databaseEvidence(backedUp)),
    /FINAL_RESET_MEDIA_INVENTORY_DRIFT/u
  );
  assert.equal(adapter.source.size, 1);
});

test("partial delete and independent HEAD/list failures are detected", async () => {
  const manifest = await manifestFixture();
  const adapter = createMemoryAdapter(manifest);
  const backedUp = await backupCandidates(manifest, adapter);
  adapter.deleteSource = async () => {};
  await assert.rejects(
    deleteCandidates(backedUp, adapter, databaseEvidence(backedUp)),
    /FINAL_RESET_MEDIA_DELETE_HEAD_FAILED/u
  );

  const preservedManifest = await manifestFixture({ preserve: true });
  const preserveAdapter = createMemoryAdapter(preservedManifest);
  preserveAdapter.listSourceKeys = async () => [];
  await assert.rejects(
    verifyDeletionPostflight(preservedManifest, preserveAdapter),
    /FINAL_RESET_MEDIA_POSTFLIGHT_LIST_MISMATCH/u
  );
});

test("delete requires hash-bound DB postflight and then records independent absence", async () => {
  const manifest = await manifestFixture();
  const adapter = createMemoryAdapter(manifest);
  const backedUp = await backupCandidates(manifest, adapter);
  const invalid = databaseEvidence(backedUp);
  invalid.payload.referenceSha256 = "0".repeat(64);
  await assert.rejects(
    deleteCandidates(backedUp, adapter, invalid),
    /FINAL_RESET_MEDIA_DATABASE_POSTFLIGHT_INVALID/u
  );

  const deleted = await deleteCandidates(
    backedUp,
    adapter,
    databaseEvidence(backedUp)
  );
  assert.equal(deleted.deletion.deletedCount, 1);
  assert.equal(adapter.source.size, 0);
});

test("CDN purge uses only the exact manifest URLs and never broad purge", async () => {
  const manifest = await manifestFixture();
  const adapter = createMemoryAdapter(manifest);
  const backedUp = await backupCandidates(manifest, adapter);
  const deleted = await deleteCandidates(backedUp, adapter, databaseEvidence(backedUp));
  const purged = await purgeDeletedUrls(deleted, adapter);
  assert.deepEqual(adapter.purges, deleted.inventory.objects[0].purgeUrls);
  assert.equal(adapter.purges.length, 2);
  assert.ok(adapter.purges.every((url) => url.startsWith(`${LIVE_ORIGIN}/`)));
  assert.ok(!stableJson(purged).includes("purge_everything"));
});

test("restore replays metadata and verifies GET hash plus full source inventory", async () => {
  const manifest = await manifestFixture();
  const adapter = createMemoryAdapter(manifest);
  const backedUp = await backupCandidates(manifest, adapter);
  const deleted = await deleteCandidates(backedUp, adapter, databaseEvidence(backedUp));
  const result = await restoreCandidates(deleted, adapter);
  assert.deepEqual(result, { restoredCount: 1 });
  assert.equal(adapter.source.size, 1);
  const restored = adapter.source.values().next().value;
  assert.equal(restored.contentType, "image/webp");
  assert.equal(restored.cacheControl, "public, max-age=31536000");
  const adapterInventory = await adapter.inventorySource();
  assert.doesNotThrow(() =>
    assertInventoryUnchanged(deleted, adapterInventory)
  );
});

test("operational tool has no prefix delete and purges an exact files array", async () => {
  const source = await readFile(
    new URL("../../scripts/finalPrelaunchFactoryResetMedia.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /purge_everything/u);
  assert.doesNotMatch(source, /DeleteBucket|Prefix:\s*[^}]/u);
  assert.match(source, /JSON[.]stringify\(\{ files:/u);
  assert.match(source, /HeadObjectCommand/u);
  assert.match(source, /GetObjectCommand/u);
  assert.match(source, /FINAL_RESET_MEDIA_GIT_HEAD_MISMATCH/u);
  assert.match(source, /FINAL_RESET_MEDIA_MIGRATION_HASH_MISMATCH/u);
});

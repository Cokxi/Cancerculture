import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const MANIFEST_SCHEMA_VERSION = 3;
const LIVE_PROJECT_REF = "nrxfuvsfezfqcwfmpxxl";
const LIVE_BUCKET = "cancerculture-uploads";
const LIVE_ORIGIN = "https://uploads.cancerculture.fun";
const FORBIDDEN_WEBSITE_ASSET_BUCKET = "cancerculture-assets";
const DELETE_BATCH_SIZE = 10;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

const EXPECTED_MIGRATIONS = Object.freeze([
  {
    file: "20260812000500_community_feed_classification_foundation.sql",
    sha256: "d33fce7cbba80380bff0d11b982e8e796be702e4130c2127e76d6d82132591fd",
  },
  {
    file: "20260813000100_community_feed_sponsor_measurement.sql",
    sha256: "868f030d7ac5142cf4b4859f2579f3e10813b717b5cb666bf8d95929d8b51998",
  },
  {
    file: "20260815000100_dual_sponsor_banner_formats_and_upload_operations.sql",
    sha256: "3ccb1174582b93eb03c85f088a099f9f875124f8869809b77de3758e2bd8c2aa",
  },
  {
    file: "20260815000200_final_prelaunch_application_data_factory_reset.sql",
    sha256: "a2e8b01ed0960ddb4e4cee590b3f8360f5821e5d2091b3e2e45ff9aa3a4b6db7",
  },
]);

const MEDIA_SOURCES = Object.freeze([
  ["submissions", "r2_key"],
  ["submission_upload_operations", "storage_key"],
  ["media_cleanup_queue", "storage_key"],
  ["cycle_sponsorships", "banner_r2_key,feed_banner_r2_key"],
  ["sponsor_media_upload_operations", "detail_candidate_r2_key,feed_candidate_r2_key"],
  ["voting_cycles", "sponsor_banner_key,sponsor_banner_url_snapshot"],
  ["winner_public_profiles", "r2_key,image_url"],
  ["user_logs", "avatar_key"],
  ["avatar_upload_logs", "avatar_key"],
  ["next_cycle_config", "sponsor_banner_key"],
  ["app_config", "key,value"],
  ["moderation_action_logs", "evidence"],
  ["cycle_events", "payload"],
  ["admin_action_logs", "meta"],
]);

const FULLY_PRESERVED_TABLES = Object.freeze([
  "capability_catalog",
  "coin_launches",
  "content_documents",
  "content_publications",
  "content_revisions",
  "cycle_rule_templates",
  "cycle_scheduler_health",
  "cycle_vote_signal_policies",
  "cycle_vote_signal_policy_state",
  "discord_sync_health",
  "homepage_info_blocks",
  "rules_meta",
  "team_roles",
]);

const SPONSOR_CONFIG_KEYS = new Set([
  "next_cycle_is_sponsored",
  "next_cycle_sponsored_enabled",
  "next_cycle_reward_description",
  "next_cycle_sponsor_name",
  "next_cycle_sponsor_link",
  "next_cycle_sponsor_banner_key",
  "next_cycle_sponsor_banner_r2_key",
  "next_cycle_sponsor_feed_banner_r2_key",
  "next_cycle_sponsor_draft_revision",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || rest[index + 1] === undefined) {
      throw new Error("FINAL_RESET_MEDIA_INVALID_ARGUMENTS");
    }
    options.set(rest[index].slice(2), rest[index + 1]);
  }
  return { command, options };
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`FINAL_RESET_MEDIA_OPTION_REQUIRED_${name}`);
  return value;
}

function requiredSha(options, name) {
  const value = requiredOption(options, name).toLowerCase();
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`FINAL_RESET_MEDIA_INVALID_SHA256_${name}`);
  }
  return value;
}

function assertPrivatePath(filePath) {
  if (!path.isAbsolute(filePath)) {
    throw new Error("FINAL_RESET_MEDIA_PRIVATE_PATH_MUST_BE_ABSOLUTE");
  }
  const relative = path.relative(REPOSITORY_ROOT, filePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    throw new Error("FINAL_RESET_MEDIA_PRIVATE_PATH_INSIDE_REPOSITORY");
  }
}

function classifyStorageKey(key) {
  if (/^\d+\/[0-9a-f-]{36}[.]webp$/iu.test(key)) return "cycle_media";
  if (/^avatars\/[^/]+[.](?:webp|png|jpe?g)$/iu.test(key)) return "avatar";
  if (/^sponsored-cycles\/drafts\/(?:detail\/|feed\/)?[0-9a-f-]{36}[.]webp$/iu.test(key)) {
    return "sponsor_draft";
  }
  return "unknown";
}

function collectStorageKeys(value, target) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectStorageKeys(item, target);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) collectStorageKeys(item, target);
    return;
  }
  if (typeof value !== "string") return;
  for (const match of value.matchAll(
    /(?:^|\/)(?:\d+\/[0-9a-f-]{36}[.]webp|avatars\/[^/?#\s]+[.](?:webp|png|jpe?g)|sponsored-cycles\/drafts\/(?:detail\/|feed\/)?[0-9a-f-]{36}[.]webp)/giu
  )) {
    target.add(match[0].replace(/^\//u, ""));
  }
}

function exceptionFingerprint(values) {
  return sha256([...values].sort().join("\n"));
}

function purgeUrlsForObject(origin, object) {
  const encodedKey = object.key.split("/").map(encodeURIComponent).join("/");
  const canonical = `${origin}/${encodedKey}`;
  return object.classification === "cycle_media"
    ? [canonical, `${origin}/cdn-cgi/image/w=400,q=75/${encodedKey}`]
    : [canonical];
}

function assertExactTarget(target) {
  if (
    target.projectRef !== LIVE_PROJECT_REF ||
    target.bucket !== LIVE_BUCKET ||
    target.origin !== LIVE_ORIGIN ||
    target.bucket === FORBIDDEN_WEBSITE_ASSET_BUCKET
  ) {
    throw new Error("FINAL_RESET_MEDIA_LIVE_TARGET_MISMATCH");
  }
  if (!GIT_SHA_PATTERN.test(target.gitHead)) {
    throw new Error("FINAL_RESET_MEDIA_GIT_HEAD_INVALID");
  }
  for (const name of [
    "catalogSha256",
    "dataSha256",
    "referenceSha256",
    "backupRecordSha256",
  ]) {
    if (!SHA256_PATTERN.test(target[name])) {
      throw new Error("FINAL_RESET_MEDIA_TARGET_FINGERPRINT_INVALID");
    }
  }
  if (stableJson(target.migrations) !== stableJson(EXPECTED_MIGRATIONS)) {
    throw new Error("FINAL_RESET_MEDIA_MIGRATION_SET_MISMATCH");
  }
}

function sealManifest(payload) {
  const manifest = { ...payload };
  delete manifest.manifestSha256;
  return { ...manifest, manifestSha256: sha256(stableJson(manifest)) };
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error("FINAL_RESET_MEDIA_MANIFEST_VERSION_MISMATCH");
  }
  assertExactTarget(manifest.target);
  const expected = sealManifest(manifest).manifestSha256;
  if (manifest.manifestSha256 !== expected) {
    throw new Error("FINAL_RESET_MEDIA_MANIFEST_HASH_MISMATCH");
  }
  const keys = manifest.inventory.objects.map((object) => object.key);
  if (keys.length !== new Set(keys).size) {
    throw new Error("FINAL_RESET_MEDIA_DUPLICATE_OBJECT_KEY");
  }
  if (manifest.inventory.objects.some((object) => object.classification === "unknown")) {
    throw new Error("FINAL_RESET_MEDIA_UNKNOWN_KEY");
  }
  if (manifest.backup) {
    const candidates = manifest.inventory.objects.filter(
      (object) => object.disposition === "delete"
    );
    const records = manifest.backup.records;
    if (
      !Array.isArray(records) ||
      records.length !== candidates.length ||
      manifest.backup.target === LIVE_BUCKET ||
      manifest.backup.target === FORBIDDEN_WEBSITE_ASSET_BUCKET ||
      !manifest.backup.target ||
      manifest.backup.recordsSha256 !== sha256(stableJson(records))
    ) {
      throw new Error("FINAL_RESET_MEDIA_BACKUP_RECORD_INVALID");
    }
    const recordBySource = new Map(records.map((record) => [record.sourceKey, record]));
    for (const object of candidates) {
      const record = recordBySource.get(object.key);
      if (
        record?.backupKey !== object.backupKey ||
        record?.size !== object.size ||
        record?.sha256 !== object.sha256 ||
        record?.contentType !== object.contentType ||
        record?.cacheControl !== object.cacheControl
      ) {
        throw new Error("FINAL_RESET_MEDIA_BACKUP_RECORD_INVALID");
      }
    }
  }
  return manifest;
}

async function createInventoryManifest({
  target,
  objects,
  resetReferences,
  preserveReferences,
  expectedMissingReferenceSha256,
  expectedOrphanSha256,
}) {
  assertExactTarget(target);
  const objectByKey = new Map(objects.map((object) => [object.key, object]));
  const unknownKeys = objects
    .filter((object) => classifyStorageKey(object.key) === "unknown")
    .map((object) => object.key);
  if (unknownKeys.length > 0) throw new Error("FINAL_RESET_MEDIA_UNKNOWN_KEY");

  const conflicts = [...preserveReferences.keys()].filter((key) => resetReferences.has(key));
  if (conflicts.length > 0) throw new Error("FINAL_RESET_MEDIA_PRESERVE_CONFLICT");

  const allReferences = new Set([...resetReferences.keys(), ...preserveReferences.keys()]);
  const missingReferences = [...allReferences].filter((key) => !objectByKey.has(key)).sort();
  if (
    missingReferences.length > 0 &&
    exceptionFingerprint(missingReferences) !== expectedMissingReferenceSha256
  ) {
    throw new Error("FINAL_RESET_MEDIA_MISSING_REFERENCE_MISMATCH");
  }
  const orphanKeys = objects
    .map((object) => object.key)
    .filter((key) => !allReferences.has(key))
    .sort();
  if (orphanKeys.length > 0 && exceptionFingerprint(orphanKeys) !== expectedOrphanSha256) {
    throw new Error("FINAL_RESET_MEDIA_ORPHAN_MISMATCH");
  }

  const inventoryObjects = objects
    .map((object) => {
      if (!SHA256_PATTERN.test(object.sha256) || !Number.isSafeInteger(object.size)) {
        throw new Error("FINAL_RESET_MEDIA_OBJECT_EVIDENCE_INVALID");
      }
      const preserved = preserveReferences.has(object.key);
      return {
        ...object,
        classification: classifyStorageKey(object.key),
        resetReferenceSources: [...(resetReferences.get(object.key) ?? [])].sort(),
        preserveReferenceSources: [...(preserveReferences.get(object.key) ?? [])].sort(),
        disposition: preserved ? "preserve" : "delete",
        backupKey: preserved
          ? null
          : `final-prelaunch-reset/${target.gitHead}/${object.key}`,
        purgeUrls: preserved ? [] : purgeUrlsForObject(target.origin, {
          key: object.key,
          classification: classifyStorageKey(object.key),
        }),
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key, "en"));

  return sealManifest({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    target,
    inventory: {
      createdAt: new Date().toISOString(),
      objects: inventoryObjects,
      missingReferences,
      missingReferenceSha256: exceptionFingerprint(missingReferences),
      orphanKeys,
      orphanSha256: exceptionFingerprint(orphanKeys),
    },
    backup: null,
    deletion: null,
    purge: null,
  });
}

function assertInventoryUnchanged(manifest, currentObjects) {
  const expected = manifest.inventory.objects.map((object) => ({
    key: object.key,
    size: object.size,
    etag: object.etag,
    lastModified: object.lastModified,
    sha256: object.sha256,
  }));
  const current = [...currentObjects]
    .map((object) => ({
      key: object.key,
      size: object.size,
      etag: object.etag,
      lastModified: object.lastModified,
      sha256: object.sha256,
    }))
    .sort((left, right) => left.key.localeCompare(right.key, "en"));
  if (stableJson(expected) !== stableJson(current)) {
    throw new Error("FINAL_RESET_MEDIA_INVENTORY_DRIFT");
  }
}

async function backupCandidates(manifest, adapter) {
  validateManifest(manifest);
  if (manifest.backup) throw new Error("FINAL_RESET_MEDIA_BACKUP_ALREADY_RECORDED");
  const candidates = manifest.inventory.objects.filter((object) => object.disposition === "delete");
  const records = [];
  for (const object of candidates) {
    const source = await adapter.getSource(object.key);
    if (sha256(source.bytes) !== object.sha256) {
      throw new Error("FINAL_RESET_MEDIA_SOURCE_HASH_MISMATCH");
    }
    await adapter.putBackup(object.backupKey, source);
    const backup = await adapter.getBackup(object.backupKey);
    if (sha256(backup.bytes) !== object.sha256) {
      throw new Error("FINAL_RESET_MEDIA_BACKUP_HASH_MISMATCH");
    }
    records.push({
      sourceKey: object.key,
      backupKey: object.backupKey,
      size: object.size,
      sha256: object.sha256,
      contentType: object.contentType,
      cacheControl: object.cacheControl,
    });
  }
  if (records.length !== candidates.length) {
    throw new Error("FINAL_RESET_MEDIA_PARTIAL_BACKUP");
  }
  return sealManifest({
    ...manifest,
    backup: {
      verifiedAt: new Date().toISOString(),
      target: adapter.backupTarget,
      records,
      recordsSha256: sha256(stableJson(records)),
    },
  });
}

function validateDatabasePostflightEvidence(evidence, manifest) {
  const payload = evidence?.payload;
  if (
    evidence?.evidenceSha256 !== sha256(stableJson(payload)) ||
    payload?.projectRef !== LIVE_PROJECT_REF ||
    payload?.migrationSha256 !== EXPECTED_MIGRATIONS.at(-1).sha256 ||
    payload?.mediaManifestSha256 !== manifest.manifestSha256 ||
    payload?.catalogSha256 !== manifest.target.catalogSha256 ||
    payload?.dataSha256 !== manifest.target.dataSha256 ||
    payload?.referenceSha256 !== manifest.target.referenceSha256 ||
    payload?.backupRecordSha256 !== manifest.target.backupRecordSha256 ||
    payload?.adminCounts?.user_logs !== 1 ||
    payload?.adminCounts?.team_members !== 1 ||
    Object.values(payload?.resetTableCounts ?? {}).some((count) => count !== 0)
  ) {
    throw new Error("FINAL_RESET_MEDIA_DATABASE_POSTFLIGHT_INVALID");
  }
}

async function deleteCandidates(manifest, adapter, databaseEvidence) {
  validateManifest(manifest);
  if (!manifest.backup) throw new Error("FINAL_RESET_MEDIA_VERIFIED_BACKUP_REQUIRED");
  validateDatabasePostflightEvidence(databaseEvidence, manifest);
  assertInventoryUnchanged(manifest, await adapter.inventorySource());
  const candidates = manifest.inventory.objects.filter((object) => object.disposition === "delete");
  for (let index = 0; index < candidates.length; index += DELETE_BATCH_SIZE) {
    await adapter.deleteSource(candidates.slice(index, index + DELETE_BATCH_SIZE).map((object) => object.key));
  }
  const result = await verifyDeletionPostflight(manifest, adapter);
  if (result.deletedCount !== candidates.length) {
    throw new Error("FINAL_RESET_MEDIA_PARTIAL_DELETE");
  }
  return sealManifest({
    ...manifest,
    deletion: { verifiedAt: new Date().toISOString(), ...result },
  });
}

async function verifyDeletionPostflight(manifest, adapter) {
  validateManifest(manifest);
  const candidates = manifest.inventory.objects.filter((object) => object.disposition === "delete");
  const preserved = manifest.inventory.objects.filter((object) => object.disposition === "preserve");
  for (const object of candidates) {
    if (await adapter.headSource(object.key)) {
      throw new Error("FINAL_RESET_MEDIA_DELETE_HEAD_FAILED");
    }
  }
  for (const object of preserved) {
    const current = await adapter.getSource(object.key);
    if (sha256(current.bytes) !== object.sha256) {
      throw new Error("FINAL_RESET_MEDIA_PRESERVE_HASH_FAILED");
    }
  }
  const remaining = (await adapter.listSourceKeys()).sort();
  const expectedRemaining = preserved.map((object) => object.key).sort();
  if (stableJson(remaining) !== stableJson(expectedRemaining)) {
    throw new Error("FINAL_RESET_MEDIA_POSTFLIGHT_LIST_MISMATCH");
  }
  return { deletedCount: candidates.length, preservedCount: preserved.length };
}

async function purgeDeletedUrls(manifest, adapter) {
  validateManifest(manifest);
  if (!manifest.deletion) throw new Error("FINAL_RESET_MEDIA_DELETE_POSTFLIGHT_REQUIRED");
  const urls = manifest.inventory.objects
    .filter((object) => object.disposition === "delete")
    .flatMap((object) => object.purgeUrls);
  if (urls.length !== new Set(urls).size) throw new Error("FINAL_RESET_MEDIA_PURGE_URL_DUPLICATE");
  await adapter.purgeExactUrls(urls);
  return sealManifest({
    ...manifest,
    purge: { completedAt: new Date().toISOString(), urls, urlsSha256: sha256(stableJson(urls)) },
  });
}

async function restoreCandidates(manifest, adapter) {
  validateManifest(manifest);
  if (!manifest.backup) throw new Error("FINAL_RESET_MEDIA_VERIFIED_BACKUP_REQUIRED");
  const candidates = manifest.inventory.objects.filter((object) => object.disposition === "delete");
  for (const object of candidates) {
    const backup = await adapter.getBackup(object.backupKey);
    if (sha256(backup.bytes) !== object.sha256) throw new Error("FINAL_RESET_MEDIA_RESTORE_BACKUP_HASH_FAILED");
    await adapter.putSource(object.key, backup);
    const restored = await adapter.getSource(object.key);
    if (sha256(restored.bytes) !== object.sha256) throw new Error("FINAL_RESET_MEDIA_RESTORE_HASH_FAILED");
  }
  assertInventoryUnchanged(manifest, await adapter.inventorySource());
  return { restoredCount: candidates.length };
}

async function bodyBytes(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function listR2Objects(client, bucket) {
  const objects = [];
  let ContinuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken }));
    objects.push(...(page.Contents ?? []));
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return objects;
}

function r2Client(prefix = "R2") {
  const endpoint = process.env[`${prefix}_ENDPOINT`];
  const accessKeyId = process.env[`${prefix}_ACCESS_KEY_ID`];
  const secretAccessKey = process.env[`${prefix}_SECRET_ACCESS_KEY`];
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error("FINAL_RESET_MEDIA_R2_CONFIGURATION_MISSING");
  return new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
}

function createAwsAdapter() {
  const source = r2Client("R2");
  const backup = r2Client("FINAL_RESET_BACKUP_R2");
  const backupBucket = process.env.FINAL_RESET_BACKUP_BUCKET;
  if (!backupBucket || backupBucket === LIVE_BUCKET || backupBucket === FORBIDDEN_WEBSITE_ASSET_BUCKET) {
    throw new Error("FINAL_RESET_MEDIA_BACKUP_TARGET_INVALID");
  }
  const get = async (client, bucket, key) => {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return {
      bytes: await bodyBytes(result.Body),
      contentType: result.ContentType ?? null,
      cacheControl: result.CacheControl ?? null,
      etag: result.ETag ?? null,
      lastModified: result.LastModified?.toISOString() ?? null,
    };
  };
  const inventorySource = async () => Promise.all((await listR2Objects(source, LIVE_BUCKET)).map(async (listed) => {
    const object = await get(source, LIVE_BUCKET, listed.Key);
    return {
      key: listed.Key,
      size: object.bytes.length,
      etag: listed.ETag ?? object.etag,
      lastModified: listed.LastModified?.toISOString() ?? object.lastModified,
      contentType: object.contentType,
      cacheControl: object.cacheControl,
      sha256: sha256(object.bytes),
    };
  }));
  return {
    backupTarget: backupBucket,
    inventorySource,
    listSourceKeys: async () => (await listR2Objects(source, LIVE_BUCKET)).map((object) => object.Key),
    getSource: (key) => get(source, LIVE_BUCKET, key),
    getBackup: (key) => get(backup, backupBucket, key),
    headSource: async (key) => {
      try { await source.send(new HeadObjectCommand({ Bucket: LIVE_BUCKET, Key: key })); return true; }
      catch (error) { if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") return false; throw error; }
    },
    putBackup: (key, object) => backup.send(new PutObjectCommand({ Bucket: backupBucket, Key: key, Body: object.bytes, ContentType: object.contentType ?? undefined, CacheControl: object.cacheControl ?? undefined })),
    putSource: (key, object) => source.send(new PutObjectCommand({ Bucket: LIVE_BUCKET, Key: key, Body: object.bytes, ContentType: object.contentType ?? undefined, CacheControl: object.cacheControl ?? undefined })),
    deleteSource: (keys) => source.send(new DeleteObjectsCommand({ Bucket: LIVE_BUCKET, Delete: { Quiet: false, Objects: keys.map((Key) => ({ Key })) } })),
    purgeExactUrls: async (urls) => {
      const zoneId = process.env.CLOUDFLARE_ZONE_ID;
      const token = process.env.CLOUDFLARE_API_TOKEN;
      if (!zoneId || !token) throw new Error("FINAL_RESET_MEDIA_PURGE_CONFIGURATION_MISSING");
      for (let index = 0; index < urls.length; index += 30) {
        const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ files: urls.slice(index, index + 30) }),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || body?.success !== true) throw new Error("FINAL_RESET_MEDIA_EXACT_PURGE_FAILED");
      }
    },
  };
}

async function readAllRows(database, table, columns) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await database.from(table).select(columns).range(offset, offset + 499);
    if (error) throw new Error(`FINAL_RESET_MEDIA_DATABASE_READ_FAILED_${table}`);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 500) return rows;
  }
}

function addReferenceRows(map, source, rows) {
  const keys = new Set();
  collectStorageKeys(rows, keys);
  for (const key of keys) map.set(key, new Set([...(map.get(key) ?? []), source]));
}

async function readReferenceMaps(database) {
  const reset = new Map();
  for (const [table, columns] of MEDIA_SOURCES) addReferenceRows(reset, table, await readAllRows(database, table, columns));
  const preserve = new Map();
  for (const table of FULLY_PRESERVED_TABLES) addReferenceRows(preserve, table, await readAllRows(database, table, "*"));
  addReferenceRows(preserve, "app_config_non_sponsor", (await readAllRows(database, "app_config", "key,value")).filter((row) => !SPONSOR_CONFIG_KEYS.has(row.key)));
  const nextRows = (await readAllRows(database, "next_cycle_config", "*")).map((row) => {
    const preserved = { ...row };
    for (const key of [
      "is_sponsored",
      "sponsor_name",
      "sponsor_link",
      "reward_description",
      "sponsor_banner_key",
      "updated_by_discord_user_id",
      "updated_by_discord_username",
    ]) {
      delete preserved[key];
    }
    return preserved;
  });
  addReferenceRows(preserve, "next_cycle_config_non_sponsor", nextRows);
  const subsetSourceNames = new Set(["app_config", "next_cycle_config", "user_logs"]);
  for (const key of preserve.keys()) {
    const resetSources = reset.get(key);
    if (!resetSources) continue;
    const remainingResetSources = new Set(
      [...resetSources].filter((source) => !subsetSourceNames.has(source))
    );
    if (remainingResetSources.size === 0) reset.delete(key);
    else reset.set(key, remainingResetSources);
  }
  return { reset, preserve };
}

async function verifyRepositoryBinding(expectedGitHead) {
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  if (git.status !== 0 || git.stdout.trim().toLowerCase() !== expectedGitHead) throw new Error("FINAL_RESET_MEDIA_GIT_HEAD_MISMATCH");
  for (const migration of EXPECTED_MIGRATIONS) {
    const bytes = await readFile(path.join(REPOSITORY_ROOT, "supabase", "migrations", migration.file));
    if (sha256(bytes) !== migration.sha256) throw new Error("FINAL_RESET_MEDIA_MIGRATION_HASH_MISMATCH");
  }
}

async function readManifest(filePath) {
  assertPrivatePath(filePath);
  return validateManifest(JSON.parse(await readFile(filePath, "utf8")));
}

async function writeManifest(filePath, manifest, exclusive = false) {
  assertPrivatePath(filePath);
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, ...(exclusive ? { flag: "wx" } : {}) });
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (!command || !["inventory", "backup", "delete", "postflight", "purge", "restore"].includes(command)) {
    throw new Error("FINAL_RESET_MEDIA_COMMAND_REQUIRED");
  }
  const manifestPath = requiredOption(options, "manifest");
  assertPrivatePath(manifestPath);
  const adapter = createAwsAdapter();

  if (command === "inventory") {
    const gitHead = requiredOption(options, "git-head").toLowerCase();
    await verifyRepositoryBinding(gitHead);
    const supabaseUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    const projectRef = supabaseUrl.hostname.split(".")[0];
    const database = createClient(supabaseUrl.href, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false, autoRefreshToken: false } });
    const references = await readReferenceMaps(database);
    const target = {
      projectRef,
      bucket: process.env.R2_BUCKET_NAME,
      origin: process.env.R2_PUBLIC_BASE_URL,
      gitHead,
      migrations: EXPECTED_MIGRATIONS,
      catalogSha256: requiredSha(options, "catalog-sha256"),
      dataSha256: requiredSha(options, "data-sha256"),
      referenceSha256: requiredSha(options, "reference-sha256"),
      backupRecordSha256: requiredSha(options, "backup-record-sha256"),
    };
    const manifest = await createInventoryManifest({
      target,
      objects: await adapter.inventorySource(),
      resetReferences: references.reset,
      preserveReferences: references.preserve,
      expectedMissingReferenceSha256: options.get("expected-missing-reference-sha256")?.toLowerCase(),
      expectedOrphanSha256: options.get("expected-orphan-sha256")?.toLowerCase(),
    });
    await writeManifest(manifestPath, manifest, true);
    console.log(JSON.stringify({ outcome: "inventory_created", manifestSha256: manifest.manifestSha256 }));
    return;
  }

  let manifest = await readManifest(manifestPath);
  await verifyRepositoryBinding(manifest.target.gitHead);
  if (command === "backup") {
    manifest = await backupCandidates(manifest, adapter);
    await writeManifest(manifestPath, manifest);
  } else if (command === "delete") {
    if (requiredOption(options, "confirm") !== `DELETE-${manifest.manifestSha256}`) throw new Error("FINAL_RESET_MEDIA_DELETE_CONFIRMATION_MISMATCH");
    const evidencePath = requiredOption(options, "database-postflight");
    assertPrivatePath(evidencePath);
    manifest = await deleteCandidates(manifest, adapter, JSON.parse(await readFile(evidencePath, "utf8")));
    await writeManifest(manifestPath, manifest);
  } else if (command === "postflight") {
    await verifyDeletionPostflight(manifest, adapter);
  } else if (command === "purge") {
    manifest = await purgeDeletedUrls(manifest, adapter);
    await writeManifest(manifestPath, manifest);
  } else if (command === "restore") {
    if (requiredOption(options, "confirm") !== `RESTORE-${manifest.manifestSha256}`) throw new Error("FINAL_RESET_MEDIA_RESTORE_CONFIRMATION_MISMATCH");
    await restoreCandidates(manifest, adapter);
  }
  console.log(JSON.stringify({ outcome: `${command}_complete`, manifestSha256: manifest.manifestSha256 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "FINAL_RESET_MEDIA_UNEXPECTED_ERROR");
    process.exitCode = 1;
  });
}

export {
  EXPECTED_MIGRATIONS,
  LIVE_BUCKET,
  LIVE_ORIGIN,
  LIVE_PROJECT_REF,
  MANIFEST_SCHEMA_VERSION,
  assertExactTarget,
  assertInventoryUnchanged,
  backupCandidates,
  classifyStorageKey,
  collectStorageKeys,
  createInventoryManifest,
  deleteCandidates,
  exceptionFingerprint,
  parseArguments,
  purgeDeletedUrls,
  restoreCandidates,
  sealManifest,
  sha256,
  stableJson,
  validateDatabasePostflightEvidence,
  validateManifest,
  verifyDeletionPostflight,
};

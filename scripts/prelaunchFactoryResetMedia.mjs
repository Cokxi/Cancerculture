import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const MANIFEST_SCHEMA_VERSION = 2;
const DELETE_BATCH_SIZE = 10;
const RESET_MIGRATION =
  "20260812000400_prelaunch_application_data_factory_reset.sql";

const MEDIA_SOURCES = [
  ["submissions", "r2_key"],
  ["submission_upload_operations", "storage_key"],
  ["media_cleanup_queue", "storage_key"],
  ["cycle_sponsorships", "banner_r2_key"],
  ["voting_cycles", "sponsor_banner_key,sponsor_banner_url_snapshot"],
  ["winner_public_profiles", "r2_key,image_url"],
  ["user_logs", "avatar_key"],
  ["avatar_upload_logs", "avatar_key"],
  ["next_cycle_config", "sponsor_banner_key"],
  ["app_config", "key,value"],
  ["moderation_action_logs", "evidence"],
  ["cycle_events", "payload"],
  ["admin_action_logs", "meta"],
];

const FULLY_PRESERVED_MEDIA_TABLES = [
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
];

const SPONSOR_APP_CONFIG_KEYS = new Set([
  "next_cycle_is_sponsored",
  "next_cycle_reward_description",
  "next_cycle_sponsor_banner_r2_key",
  "next_cycle_sponsor_banner_key",
  "next_cycle_sponsor_link",
  "next_cycle_sponsor_name",
  "next_cycle_sponsored_enabled",
]);

const RESET_ZERO_TABLES = [
  "admin_action_logs",
  "admin_invites",
  "avatar_upload_logs",
  "blocked_cycle_events",
  "blocked_user_meta",
  "content_management_requests",
  "cycle_events",
  "cycle_management_requests",
  "cycle_reminders",
  "cycle_results",
  "cycle_sponsorships",
  "cycle_vote_observation_events",
  "cycle_vote_observation_snapshots",
  "cycle_vote_signal_bindings",
  "cycle_vote_submission_observations",
  "discord_guard_logs",
  "discord_member_state",
  "discord_membership_sync_events",
  "discord_reconciliation_bans",
  "discord_reconciliation_members",
  "discord_reconciliation_snapshots",
  "invite_auth_logs",
  "media_cleanup_queue",
  "moderation_action_logs",
  "sessions",
  "social_verification_logs",
  "sponsor_tracking_events",
  "submission_disqualification_events",
  "submission_moderation_requests",
  "submission_private_data",
  "submission_report_case_events",
  "submission_report_cases",
  "submission_report_payloads",
  "submission_report_reads",
  "submission_report_requests",
  "submission_reporter_identities",
  "submission_reports",
  "submission_social_links",
  "submission_upload_abuse_states",
  "submission_upload_operations",
  "submissions",
  "team_authorization_audit",
  "team_authorization_batches",
  "team_role_capabilities",
  "upload_logs",
  "user_cycle_acceptance",
  "user_flag_actor_snapshots",
  "user_flag_cases",
  "user_flag_events",
  "user_flag_requests",
  "user_social_links",
  "vote_logs",
  "vote_refund_events",
  "vote_refund_items",
  "votes",
  "voting_cycles",
  "website_ban_events",
  "website_ban_requests",
  "winner_public_profiles",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameR2Timestamp(left, right) {
  if (left === null || right === null) return left === right;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return (
    Number.isFinite(leftTime) &&
    Number.isFinite(rightTime) &&
    Math.trunc(leftTime / 1000) === Math.trunc(rightTime / 1000)
  );
}

function parseDotenv(contents) {
  const values = new Map();
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("FACTORY_RESET_INVALID_ARGUMENTS");
    }
    options.set(name.slice(2), value);
  }
  return { command, options };
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`FACTORY_RESET_OPTION_REQUIRED_${name}`);
  return value;
}

function assertPrivateManifestPath(manifestPath) {
  if (!path.isAbsolute(manifestPath)) {
    throw new Error("FACTORY_RESET_MANIFEST_PATH_MUST_BE_ABSOLUTE");
  }
  const relative = path.relative(repoRoot, manifestPath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    throw new Error("FACTORY_RESET_MANIFEST_MUST_STAY_OUTSIDE_REPOSITORY");
  }
}

function classifyStorageKey(storageKey) {
  if (/^\d+\/[0-9A-Fa-f-]{36}\.webp$/u.test(storageKey)) {
    return "cycle_media";
  }
  if (/^avatars\/[^/]+\.(?:webp|png|jpe?g)$/iu.test(storageKey)) {
    return "avatar";
  }
  if (
    /^sponsored-cycles\/drafts\/[0-9A-Fa-f-]{36}\.webp$/u.test(
      storageKey
    )
  ) {
    return "sponsor_draft";
  }
  if (/^tests\/media-cleanup-smoke\//u.test(storageKey)) {
    return "media_cleanup_test";
  }
  if (/^codex-tests\/media-cleanup\//u.test(storageKey)) {
    return "codex_media_test";
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
    /(?:^|\/)(?:\d+\/[0-9A-Fa-f-]{36}\.webp|avatars\/[^/?#\s]+\.(?:webp|png|jpe?g)|sponsored-cycles\/drafts\/[0-9A-Fa-f-]{36}\.webp|tests\/media-cleanup-smoke\/[^?#\s]+|codex-tests\/media-cleanup\/[^?#\s]+)/giu
  )) {
    target.add(match[0].replace(/^\//u, ""));
  }
}

async function readAllRows(database, table, columns) {
  const rows = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await database
      .from(table)
      .select(columns)
      .range(offset, offset + pageSize - 1);
    if (error) {
      throw new Error(`FACTORY_RESET_DATABASE_READ_FAILED_${table}`);
    }
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < pageSize) return rows;
  }
}

function addReferenceRows(referenceSourcesByKey, sourceName, rows) {
  const keys = new Set();
  collectStorageKeys(rows, keys);
  for (const key of keys) {
    const sources = referenceSourcesByKey.get(key) ?? new Set();
    sources.add(sourceName);
    referenceSourcesByKey.set(key, sources);
  }
}

async function readPreservedReferenceSources(database) {
  const references = new Map();
  for (const table of FULLY_PRESERVED_MEDIA_TABLES) {
    addReferenceRows(references, table, await readAllRows(database, table, "*"));
  }

  const preservedAppConfig = (
    await readAllRows(database, "app_config", "key,value")
  ).filter((row) => !SPONSOR_APP_CONFIG_KEYS.has(row.key));
  addReferenceRows(references, "app_config_non_sponsor", preservedAppConfig);

  const preservedNextCycleConfig = (
    await readAllRows(database, "next_cycle_config", "*")
  ).map((row) => {
    const {
      is_sponsored: ignoredSponsored,
      sponsor_name: ignoredSponsorName,
      sponsor_link: ignoredSponsorLink,
      reward_description: ignoredReward,
      sponsor_banner_key: ignoredBanner,
      updated_by_discord_user_id: ignoredUpdaterId,
      updated_by_discord_username: ignoredUpdaterName,
      ...preserved
    } = row;
    void ignoredSponsored;
    void ignoredSponsorName;
    void ignoredSponsorLink;
    void ignoredReward;
    void ignoredBanner;
    void ignoredUpdaterId;
    void ignoredUpdaterName;
    return preserved;
  });
  addReferenceRows(
    references,
    "next_cycle_config_non_sponsor",
    preservedNextCycleConfig
  );

  const adminIds = new Set(
    (await readAllRows(database, "team_members", "discord_user_id,role"))
      .filter((row) => row.role === "admin")
      .map((row) => row.discord_user_id)
  );
  const preservedAdminRows = (await readAllRows(database, "user_logs", "*"))
    .filter((row) => adminIds.has(row.discord_user_id))
    .map((row) => ({ ...row, avatar_key: null, avatar_updated_at: null }));
  addReferenceRows(references, "canonical_admin_non_avatar", preservedAdminRows);

  return references;
}

async function listObjects(client, bucket) {
  const objects = [];
  let continuationToken;
  do {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      })
    );
    objects.push(...(result.Contents ?? []));
    continuationToken = result.IsTruncated
      ? result.NextContinuationToken
      : undefined;
  } while (continuationToken);
  return objects;
}

function createR2Client({ endpoint, accessKeyId, secretAccessKey }) {
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("FACTORY_RESET_R2_CONFIGURATION_MISSING");
  }
  return new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function loadSourceContext() {
  const values = parseDotenv(
    await readFile(path.join(repoRoot, ".env.local"), "utf8")
  );
  const requiredKeys = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "R2_ENDPOINT",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
  ];
  for (const key of requiredKeys) {
    if (!values.get(key)) {
      throw new Error(`FACTORY_RESET_SOURCE_CONFIGURATION_MISSING_${key}`);
    }
  }
  const supabaseUrl = new URL(values.get("NEXT_PUBLIC_SUPABASE_URL"));
  const projectRef = supabaseUrl.hostname.split(".")[0];
  if (!projectRef || !supabaseUrl.hostname.endsWith(".supabase.co")) {
    throw new Error("FACTORY_RESET_INVALID_SUPABASE_TARGET");
  }
  return {
    projectRef,
    bucket: values.get("R2_BUCKET_NAME"),
    database: createClient(
      values.get("NEXT_PUBLIC_SUPABASE_URL"),
      values.get("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } }
    ),
    r2: createR2Client({
      endpoint: values.get("R2_ENDPOINT"),
      accessKeyId: values.get("R2_ACCESS_KEY_ID"),
      secretAccessKey: values.get("R2_SECRET_ACCESS_KEY"),
    }),
  };
}

async function createInventory(source) {
  const referenceSourcesByKey = new Map();
  for (const [table, columns] of MEDIA_SOURCES) {
    addReferenceRows(
      referenceSourcesByKey,
      table,
      await readAllRows(source.database, table, columns)
    );
  }

  const preservedReferenceSourcesByKey =
    await readPreservedReferenceSources(source.database);
  for (const [key, preservedSources] of preservedReferenceSourcesByKey) {
    const sources = referenceSourcesByKey.get(key) ?? new Set();
    for (const sourceName of preservedSources) {
      sources.add(sourceName);
    }
    referenceSourcesByKey.set(key, sources);
  }

  const bucketObjects = await listObjects(source.r2, source.bucket);
  const bucketKeySet = new Set(bucketObjects.map((object) => object.Key));
  const objects = bucketObjects
    .map((object) => ({
      key: object.Key,
      classification: classifyStorageKey(object.Key),
      size: object.Size ?? null,
      etag: object.ETag ?? null,
      lastModified: object.LastModified?.toISOString() ?? null,
      referenceSources: [
        ...(referenceSourcesByKey.get(object.Key) ?? new Set()),
      ].sort(),
      preservedReferenceSources: [
        ...(preservedReferenceSourcesByKey.get(object.Key) ?? new Set()),
      ].sort(),
      disposition: preservedReferenceSourcesByKey.has(object.Key)
        ? "preserve"
        : "delete",
    }))
    .sort((left, right) => left.key.localeCompare(right.key, "en"));

  const unknownObjects = objects.filter(
    (object) => object.classification === "unknown"
  );
  const referencedMissingObjects = [...referenceSourcesByKey]
    .filter(([key]) => !bucketKeySet.has(key))
    .map(([key, sourceTables]) => ({
      key,
      sourceTables: [...sourceTables].sort(),
    }))
    .sort((left, right) => left.key.localeCompare(right.key, "en"));

  const inventory = {
    createdAt: new Date().toISOString(),
    migration: RESET_MIGRATION,
    projectRef: source.projectRef,
    bucket: source.bucket,
    objects,
    referencedMissingObjects,
    preservedObjectKeys: objects
      .filter((object) => object.disposition === "preserve")
      .map((object) => object.key),
    unknownObjectKeys: unknownObjects.map((object) => object.key),
  };
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    inventory,
    inventorySha256: sha256(stableJson(inventory)),
    backup: null,
  };
}

function validateManifest(manifest) {
  if (
    manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    !manifest.inventory ||
    manifest.inventorySha256 !== sha256(stableJson(manifest.inventory))
  ) {
    throw new Error("FACTORY_RESET_MANIFEST_INTEGRITY_FAILED");
  }
  if (manifest.inventory.unknownObjectKeys.length > 0) {
    throw new Error("FACTORY_RESET_UNKNOWN_OBJECTS_REQUIRE_REVIEW");
  }
  const preservedKeys = new Set(manifest.inventory.preservedObjectKeys ?? []);
  if (
    manifest.inventory.objects.some(
      (object) =>
        !["delete", "preserve"].includes(object.disposition) ||
        (object.disposition === "delete" &&
          (preservedKeys.has(object.key) ||
            object.preservedReferenceSources?.length > 0)) ||
        (object.disposition === "preserve" && !preservedKeys.has(object.key))
    )
  ) {
    throw new Error("FACTORY_RESET_PRESERVED_MEDIA_CONTRACT_INVALID");
  }
}

async function readManifest(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest);
  return manifest;
}

function loadBackupContext(sourceBucket) {
  const localDirectory =
    process.env.FACTORY_RESET_BACKUP_LOCAL_DIRECTORY?.trim();
  if (localDirectory) {
    if (
      process.env.FACTORY_RESET_BACKUP_CONFIRMED_PRIVATE !== "true" ||
      !path.isAbsolute(localDirectory)
    ) {
      throw new Error("FACTORY_RESET_PRIVATE_LOCAL_BACKUP_REQUIRED");
    }
    const relative = path.relative(repoRoot, localDirectory);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      throw new Error("FACTORY_RESET_BACKUP_MUST_STAY_OUTSIDE_REPOSITORY");
    }
    return {
      kind: "local_directory",
      target: path.resolve(localDirectory),
    };
  }

  const bucket = process.env.FACTORY_RESET_BACKUP_R2_BUCKET?.trim();
  if (
    process.env.FACTORY_RESET_BACKUP_CONFIRMED_PRIVATE !== "true" ||
    !bucket ||
    bucket === sourceBucket
  ) {
    throw new Error("FACTORY_RESET_PRIVATE_BACKUP_BUCKET_REQUIRED");
  }
  return {
    kind: "r2",
    target: bucket,
    bucket,
    r2: createR2Client({
      endpoint: process.env.FACTORY_RESET_BACKUP_R2_ENDPOINT?.trim(),
      accessKeyId: process.env.FACTORY_RESET_BACKUP_R2_ACCESS_KEY_ID?.trim(),
      secretAccessKey:
        process.env.FACTORY_RESET_BACKUP_R2_SECRET_ACCESS_KEY?.trim(),
    }),
  };
}

function localBackupPath(backup, backupKey) {
  const resolved = path.resolve(backup.target, ...backupKey.split("/"));
  const relative = path.relative(backup.target, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("FACTORY_RESET_INVALID_LOCAL_BACKUP_KEY");
  }
  return resolved;
}

async function getObjectBytes(client, bucket, key) {
  const result = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  if (!result.Body) throw new Error("FACTORY_RESET_OBJECT_BODY_MISSING");
  return {
    bytes: Buffer.from(await result.Body.transformToByteArray()),
    contentType: result.ContentType ?? null,
    cacheControl: result.CacheControl ?? null,
    contentDisposition: result.ContentDisposition ?? null,
    contentEncoding: result.ContentEncoding ?? null,
    contentLanguage: result.ContentLanguage ?? null,
    metadata: result.Metadata ?? {},
    etag: result.ETag ?? null,
    lastModified: result.LastModified?.toISOString() ?? null,
  };
}

async function backupObjects(manifest, source, backup) {
  const records = [];
  for (const object of manifest.inventory.objects) {
    const sourceObject = await getObjectBytes(source.r2, source.bucket, object.key);
    if (
      sourceObject.bytes.length !== object.size ||
      sourceObject.etag !== object.etag ||
      !sameR2Timestamp(sourceObject.lastModified, object.lastModified)
    ) {
      throw new Error("FACTORY_RESET_SOURCE_CHANGED_AFTER_INVENTORY");
    }
    const contentSha256 = sha256(sourceObject.bytes);
    const backupKey = `factory-reset/${manifest.inventorySha256}/${object.key}`;
    if (backup.kind === "local_directory") {
      const destination = localBackupPath(backup, backupKey);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, sourceObject.bytes, {
        flag: "wx",
        mode: 0o600,
      });
      const verification = await readFile(destination);
      if (
        verification.length !== sourceObject.bytes.length ||
        sha256(verification) !== contentSha256
      ) {
        throw new Error("FACTORY_RESET_BACKUP_VERIFICATION_FAILED");
      }
    } else {
      await backup.r2.send(
        new PutObjectCommand({
          Bucket: backup.bucket,
          Key: backupKey,
          Body: sourceObject.bytes,
          ContentType: sourceObject.contentType ?? undefined,
          CacheControl: sourceObject.cacheControl ?? undefined,
          Metadata: {
            "source-sha256": contentSha256,
            "source-inventory": manifest.inventorySha256,
          },
        })
      );
      const verification = await backup.r2.send(
        new HeadObjectCommand({ Bucket: backup.bucket, Key: backupKey })
      );
      if (
        verification.ContentLength !== sourceObject.bytes.length ||
        verification.Metadata?.["source-sha256"] !== contentSha256
      ) {
        throw new Error("FACTORY_RESET_BACKUP_VERIFICATION_FAILED");
      }
    }
    records.push({
      sourceKey: object.key,
      backupKey,
      size: sourceObject.bytes.length,
      sha256: contentSha256,
      contentType: sourceObject.contentType,
      cacheControl: sourceObject.cacheControl,
      contentDisposition: sourceObject.contentDisposition,
      contentEncoding: sourceObject.contentEncoding,
      contentLanguage: sourceObject.contentLanguage,
      metadata: sourceObject.metadata,
    });
  }
  const orderedRecords = records.sort((left, right) =>
    left.sourceKey.localeCompare(right.sourceKey, "en")
  );
  manifest.backup = {
    kind: backup.kind,
    target: backup.target,
    inventorySha256: manifest.inventorySha256,
    verifiedAt: new Date().toISOString(),
    records: orderedRecords,
    recordsSha256: sha256(stableJson(orderedRecords)),
  };
  return manifest;
}

function validateBackup(manifest) {
  if (
    !manifest.backup ||
    manifest.backup.inventorySha256 !== manifest.inventorySha256 ||
    manifest.backup.recordsSha256 !== sha256(stableJson(manifest.backup.records)) ||
    manifest.backup.records.length !== manifest.inventory.objects.length
  ) {
    throw new Error("FACTORY_RESET_VERIFIED_BACKUP_REQUIRED");
  }
}

function validateDatabasePostflightEvidence(evidence, manifest, projectRef) {
  const payload = evidence?.payload;
  const expectedTables = [...RESET_ZERO_TABLES].sort();
  const actualTables = Object.keys(payload?.resetTableCounts ?? {}).sort();
  const checkedAt = Date.parse(payload?.checkedAt ?? "");
  if (
    evidence?.evidenceSha256 !== sha256(stableJson(payload)) ||
    payload?.schemaVersion !== 1 ||
    payload?.projectRef !== projectRef ||
    payload?.mediaManifestSha256 !== manifest.inventorySha256 ||
    !/^[0-9a-f]{64}$/u.test(payload?.migrationSha256 ?? "") ||
    !Number.isFinite(checkedAt) ||
    Math.abs(Date.now() - checkedAt) > 10 * 60 * 1000 ||
    stableJson(actualTables) !== stableJson(expectedTables) ||
    expectedTables.some((table) => payload.resetTableCounts[table] !== 0) ||
    payload?.adminCounts?.user_logs !== 1 ||
    payload?.adminCounts?.team_members !== 1
  ) {
    throw new Error("FACTORY_RESET_DATABASE_POSTFLIGHT_EVIDENCE_INVALID");
  }
}

async function assertDatabaseResetComplete(database) {
  for (const table of RESET_ZERO_TABLES) {
    const { count, error } = await database
      .from(table)
      .select("*", { count: "exact", head: true });
    if (!error && count !== 0) {
      throw new Error(`FACTORY_RESET_DATABASE_NOT_EMPTY_${table}`);
    }
  }
  for (const table of ["user_logs", "team_members"]) {
    const { count, error } = await database
      .from(table)
      .select("*", { count: "exact", head: true });
    if (error || count !== 1) {
      throw new Error(`FACTORY_RESET_ADMIN_BASELINE_INVALID_${table}`);
    }
  }
}

async function assertNoCurrentPreservedDeleteReferences(manifest, database) {
  const currentPreservedReferences = await readPreservedReferenceSources(database);
  const deleteKeys = new Set(
    manifest.inventory.objects
      .filter((object) => object.disposition === "delete")
      .map((object) => object.key)
  );
  const conflict = [...currentPreservedReferences.keys()].find((key) =>
    deleteKeys.has(key)
  );
  if (conflict) {
    throw new Error("FACTORY_RESET_CURRENT_PRESERVED_MEDIA_CONFLICT");
  }
}

async function assertCurrentSourceMatchesManifest(manifest, source) {
  const currentObjects = await listObjects(source.r2, source.bucket);
  const currentByKey = new Map(
    currentObjects.map((object) => [object.Key, object])
  );
  if (currentByKey.size !== manifest.inventory.objects.length) {
    throw new Error("FACTORY_RESET_SOURCE_CHANGED_AFTER_BACKUP");
  }
  for (const expected of manifest.inventory.objects) {
    const current = currentByKey.get(expected.key);
    if (
      !current ||
      (current.Size ?? null) !== expected.size ||
      (current.ETag ?? null) !== expected.etag ||
      !sameR2Timestamp(
        current.LastModified?.toISOString() ?? null,
        expected.lastModified
      )
    ) {
      throw new Error("FACTORY_RESET_SOURCE_CHANGED_AFTER_BACKUP");
    }
  }
}

async function deleteSourceObjects(manifest, source, databasePostflightEvidence) {
  validateBackup(manifest);
  validateDatabasePostflightEvidence(
    databasePostflightEvidence,
    manifest,
    source.projectRef
  );
  await assertCurrentSourceMatchesManifest(manifest, source);
  await assertDatabaseResetComplete(source.database);
  await assertNoCurrentPreservedDeleteReferences(manifest, source.database);
  const keys = manifest.inventory.objects
    .filter((object) => object.disposition === "delete")
    .map((object) => object.key);
  for (let index = 0; index < keys.length; index += DELETE_BATCH_SIZE) {
    const batch = keys.slice(index, index + DELETE_BATCH_SIZE);
    const result = await source.r2.send(
      new DeleteObjectsCommand({
        Bucket: source.bucket,
        Delete: { Quiet: false, Objects: batch.map((Key) => ({ Key })) },
      })
    );
    if ((result.Errors?.length ?? 0) > 0) {
      throw new Error("FACTORY_RESET_R2_DELETE_BATCH_FAILED");
    }
  }
  await assertSourceObjectsDeleted(manifest, source);
}

async function assertSourceObjectsDeleted(manifest, source) {
  const remainingObjects = await listObjects(source.r2, source.bucket);
  const remaining = new Map(
    remainingObjects.map((object) => [object.Key, object])
  );
  const expectedDeleted = manifest.inventory.objects
    .filter((object) => object.disposition === "delete")
    .map((object) => object.key);
  if (expectedDeleted.some((key) => remaining.has(key))) {
    throw new Error("FACTORY_RESET_R2_DELETE_POSTFLIGHT_FAILED");
  }
  const expectedPreserved = manifest.inventory.objects.filter(
    (object) => object.disposition === "preserve"
  );
  if (
    expectedPreserved.some((expected) => {
      const current = remaining.get(expected.key);
      return (
        !current ||
        (current.Size ?? null) !== expected.size ||
        (current.ETag ?? null) !== expected.etag ||
        !sameR2Timestamp(
          current.LastModified?.toISOString() ?? null,
          expected.lastModified
        )
      );
    })
  ) {
    throw new Error("FACTORY_RESET_PRESERVED_MEDIA_POSTFLIGHT_FAILED");
  }
  const preservedKeys = new Set(expectedPreserved.map((object) => object.key));
  const unexpected = [...remaining.keys()].filter(
    (key) => classifyStorageKey(key) !== "unknown" && !preservedKeys.has(key)
  );
  if (unexpected.length > 0) {
    throw new Error("FACTORY_RESET_NEW_APPLICATION_MEDIA_DETECTED");
  }
}

async function restoreObjects(manifest, source, backup) {
  validateBackup(manifest);
  if (
    backup.kind !== manifest.backup.kind ||
    backup.target !== manifest.backup.target
  ) {
    throw new Error("FACTORY_RESET_BACKUP_TARGET_MISMATCH");
  }
  for (const record of manifest.backup.records) {
    const backupObject = backup.kind === "local_directory"
      ? { bytes: await readFile(localBackupPath(backup, record.backupKey)) }
      : await getObjectBytes(backup.r2, backup.bucket, record.backupKey);
    if (
      backupObject.bytes.length !== record.size ||
      sha256(backupObject.bytes) !== record.sha256
    ) {
      throw new Error("FACTORY_RESET_BACKUP_RESTORE_SOURCE_INVALID");
    }
    await source.r2.send(
      new PutObjectCommand({
        Bucket: source.bucket,
        Key: record.sourceKey,
        Body: backupObject.bytes,
        ContentType: record.contentType ?? undefined,
        CacheControl: record.cacheControl ?? undefined,
        ContentDisposition: record.contentDisposition ?? undefined,
        ContentEncoding: record.contentEncoding ?? undefined,
        ContentLanguage: record.contentLanguage ?? undefined,
        Metadata: record.metadata,
      })
    );
    const restored = await getObjectBytes(
      source.r2,
      source.bucket,
      record.sourceKey
    );
    if (sha256(restored.bytes) !== record.sha256) {
      throw new Error("FACTORY_RESET_RESTORE_VERIFICATION_FAILED");
    }
  }
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (!command || !["inventory", "backup", "delete", "verify", "restore"].includes(command)) {
    throw new Error("FACTORY_RESET_COMMAND_REQUIRED");
  }
  const manifestPath = requiredOption(options, "manifest");
  const expectedProjectRef = requiredOption(options, "project-ref");
  const expectedBucket = requiredOption(options, "source-bucket");
  assertPrivateManifestPath(manifestPath);

  const source = await loadSourceContext();
  if (
    source.projectRef !== expectedProjectRef ||
    source.bucket !== expectedBucket
  ) {
    throw new Error("FACTORY_RESET_EXPLICIT_SOURCE_TARGET_MISMATCH");
  }

  if (command === "inventory") {
    const manifest = await createInventory(source);
    if (manifest.inventory.unknownObjectKeys.length > 0) {
      throw new Error("FACTORY_RESET_UNKNOWN_OBJECTS_REQUIRE_REVIEW");
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    console.log(JSON.stringify({
      outcome: "inventory_created",
      inventorySha256: manifest.inventorySha256,
      objectCount: manifest.inventory.objects.length,
      missingReferencedObjectCount:
        manifest.inventory.referencedMissingObjects.length,
    }));
    return;
  }

  const manifest = await readManifest(manifestPath);
  if (
    manifest.inventory.projectRef !== source.projectRef ||
    manifest.inventory.bucket !== source.bucket
  ) {
    throw new Error("FACTORY_RESET_MANIFEST_SOURCE_TARGET_MISMATCH");
  }

  if (command === "verify") {
    await assertSourceObjectsDeleted(manifest, source);
    console.log(JSON.stringify({ outcome: "source_media_absent" }));
    return;
  }

  const backup = loadBackupContext(source.bucket);
  if (
    manifest.backup &&
    (backup.kind !== manifest.backup.kind ||
      backup.target !== manifest.backup.target)
  ) {
    throw new Error("FACTORY_RESET_BACKUP_TARGET_MISMATCH");
  }
  if (command === "backup") {
    if (manifest.backup) throw new Error("FACTORY_RESET_BACKUP_ALREADY_RECORDED");
    await backupObjects(manifest, source, backup);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(JSON.stringify({
      outcome: "backup_verified",
      inventorySha256: manifest.inventorySha256,
      backupRecordsSha256: manifest.backup.recordsSha256,
      objectCount: manifest.backup.records.length,
    }));
    return;
  }

  if (command === "delete") {
    const confirmation = requiredOption(options, "confirm");
    const databasePostflightPath = requiredOption(
      options,
      "database-postflight"
    );
    assertPrivateManifestPath(databasePostflightPath);
    const databasePostflightEvidence = JSON.parse(
      await readFile(databasePostflightPath, "utf8")
    );
    if (confirmation !== `DELETE-${manifest.inventorySha256.slice(0, 16)}`) {
      throw new Error("FACTORY_RESET_DELETE_CONFIRMATION_MISMATCH");
    }
    await deleteSourceObjects(manifest, source, databasePostflightEvidence);
    console.log(JSON.stringify({ outcome: "source_media_deleted" }));
    return;
  }

  const confirmation = requiredOption(options, "confirm");
  if (confirmation !== `RESTORE-${manifest.inventorySha256.slice(0, 16)}`) {
    throw new Error("FACTORY_RESET_RESTORE_CONFIRMATION_MISMATCH");
  }
  await restoreObjects(manifest, source, backup);
  console.log(JSON.stringify({ outcome: "source_media_restored" }));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "FACTORY_RESET_UNEXPECTED_ERROR"
    );
    process.exitCode = 1;
  });
}

export {
  classifyStorageKey,
  collectStorageKeys,
  parseArguments,
  sameR2Timestamp,
  sha256,
  stableJson,
  validateBackup,
  validateDatabasePostflightEvidence,
  validateManifest,
};

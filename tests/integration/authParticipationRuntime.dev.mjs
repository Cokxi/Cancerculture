import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const psql =
  process.env.PSQL_BIN ??
  "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
const baseUrl = process.env.LOCAL_WEBSITE_URL ?? "http://localhost:3000";
const runId = randomUUID();
const seed = BigInt(`0x${runId.replaceAll("-", "").slice(0, 14)}`);
const discordUserId = String(
  970_000_000_000_000_000n + (seed % 20_000_000_000_000_000n)
);
const sessionId = randomUUID();
const secondSessionId = randomUUID();
const eventPrefix = `auth-runtime-${runId}-`;
let databaseUrl;

async function readEnvFile(name) {
  const values = new Map();
  const source = await readFile(path.join(repoRoot, name), "utf8");
  for (const line of source.split(/\r?\n/u)) {
    if (!line || /^\s*#/u.test(line) || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    values.set(
      line.slice(0, separator).trim(),
      line
        .slice(separator + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/u, "$2")
    );
  }
  return values;
}

function projectRef(databaseUrlValue) {
  const parsed = new URL(databaseUrlValue);
  return (
    parsed.hostname.match(/^db\.([^.]+)\./u)?.[1] ??
    decodeURIComponent(parsed.username).match(/^postgres\.([^:]+)$/u)?.[1] ??
    null
  );
}

async function loadDevDatabaseUrl() {
  const [local, codex] = await Promise.all([
    readEnvFile(".env.local"),
    readEnvFile(".env.codex.local"),
  ]);
  const value =
    process.env.SUPABASE_DEV_DATABASE_URL ??
    codex.get("SUPABASE_DEV_DATABASE_URL");
  const websiteUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    local.get("NEXT_PUBLIC_SUPABASE_URL");

  if (!value || !websiteUrl) {
    throw new Error("Required DEV configuration is missing");
  }
  if (
    projectRef(value) !== new URL(websiteUrl).hostname.split(".")[0]
  ) {
    throw new Error("Refusing to run against a non-matching database project");
  }
  return value;
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSql(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      psql,
      [databaseUrl, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", source],
      { windowsHide: true }
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", () => {});
    child.on("error", () => reject(new Error("DEV database command could not start")));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error("Sanitized DEV database command failed"));
    });
  });
}

async function request(pathname, currentSessionId = sessionId) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { cookie: `session_id=${currentSessionId}` },
    redirect: "manual",
  });
  const contentType = response.headers.get("content-type") ?? "";
  return {
    body: contentType.includes("application/json")
      ? await response.json()
      : await response.text(),
    location: response.headers.get("location"),
    status: response.status,
  };
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function timestampAtOffset(nowMs, offsetMs) {
  return new Date(nowMs + offsetMs).toISOString();
}

async function setTimes(joinedAgeMs, observedAgeMs) {
  const nowMs = Date.now();
  const joinedAt = timestampAtOffset(nowMs, -joinedAgeMs);
  const observedAt =
    observedAgeMs === null
      ? "null"
      : `${literal(timestampAtOffset(nowMs, -observedAgeMs))}::timestamptz`;

  await runSql(`
    update public.discord_member_state
    set
      is_in_discord = true,
      discord_ban_active = false,
      discord_joined_at = ${literal(joinedAt)}::timestamptz,
      discord_membership_observed_at = ${observedAt},
      updated_at = clock_timestamp()
    where discord_user_id = ${literal(discordUserId)};
  `);
}

async function cleanup() {
  await runSql(`
    delete from public.discord_membership_sync_events
    where event_id like ${literal(`${eventPrefix}%`)};
    delete from public.admin_action_logs
    where target_id in (${literal(discordUserId)}, ${literal(sessionId)}, ${literal(secondSessionId)});
    delete from public.sessions
    where id in (${literal(sessionId)}::uuid, ${literal(secondSessionId)}::uuid)
       or discord_user_id = ${literal(discordUserId)};
    delete from public.team_members
    where discord_user_id = ${literal(discordUserId)};
    delete from public.discord_member_state
    where discord_user_id = ${literal(discordUserId)};
    delete from public.user_logs
    where discord_user_id = ${literal(discordUserId)};
  `);
}

async function fixtureResidualCount() {
  return runSql(`
    select (
      (select count(*) from public.user_logs where discord_user_id = ${literal(discordUserId)}) +
      (select count(*) from public.discord_member_state where discord_user_id = ${literal(discordUserId)}) +
      (select count(*) from public.sessions where discord_user_id = ${literal(discordUserId)}) +
      (select count(*) from public.team_members where discord_user_id = ${literal(discordUserId)}) +
      (select count(*) from public.discord_membership_sync_events where event_id like ${literal(`${eventPrefix}%`)}) +
      (select count(*) from public.admin_action_logs where target_id in (${literal(discordUserId)}, ${literal(sessionId)}, ${literal(secondSessionId)}))
    )::text;
  `);
}

databaseUrl = await loadDevDatabaseUrl();
expect(
  (await fixtureResidualCount()) === "0",
  "random DEV fixture identity was not isolated"
);

let testError = null;
let cleanupError = null;

try {
  const fixtureNowMs = Date.now();
  const initialJoinedAt = timestampAtOffset(
    fixtureNowMs,
    -5 * 60 * 1000
  );
  const initialObservedAt = timestampAtOffset(fixtureNowMs, 0);

  await runSql(`
    insert into public.user_logs (
      discord_user_id,
      current_discord_username,
      is_banned
    ) values (${literal(discordUserId)}, 'auth-runtime-admin', false);

    insert into public.discord_member_state (
      discord_user_id,
      current_discord_username,
      discord_joined_at,
      is_in_discord,
      discord_ban_active,
      discord_membership_observed_at,
      discord_ban_observed_at
    ) values (
      ${literal(discordUserId)},
      'auth-runtime-admin',
      ${literal(initialJoinedAt)}::timestamptz,
      true,
      false,
      ${literal(initialObservedAt)}::timestamptz,
      null
    );

    insert into public.team_members (
      discord_user_id,
      role,
      discord_username
    ) values (${literal(discordUserId)}, 'admin', 'auth-runtime-admin');

    select public.create_cancerculture_session(
      ${literal(sessionId)}::uuid,
      ${literal(discordUserId)}
    );
  `);

  const initialFixture = await runSql(`
    select jsonb_build_object(
      'sessionCount', (
        select count(*) from public.sessions
        where id = ${literal(sessionId)}::uuid
          and discord_user_id = ${literal(discordUserId)}
          and revoked_at is null
      ),
      'membershipObservationPresent', discord_membership_observed_at is not null,
      'isInDiscord', is_in_discord,
      'joinedAgeSecondsByDatabase', floor(
        extract(epoch from (clock_timestamp() - discord_joined_at))
      ),
      'discordBanned', discord_ban_active,
      'websiteBanned', (
        select is_banned from public.user_logs
        where discord_user_id = ${literal(discordUserId)}
      )
    )
    from public.discord_member_state
    where discord_user_id = ${literal(discordUserId)};
  `);

  const beforeCooldown = await request("/api/vote/eligibility");
  console.log(
    "DEV auth/participation pre-cooldown diagnostic:",
    JSON.stringify({
      actualStatus: beforeCooldown.body?.participation?.status ?? null,
      expectedStatus: "join_wait",
      fixture: JSON.parse(initialFixture),
    })
  );
  expect(beforeCooldown.status === 200, "pre-cooldown eligibility request failed");
  expect(
    beforeCooldown.body?.participation?.status === "join_wait",
    "pre-cooldown membership did not retain the join cooldown"
  );

  await setTimes(10 * 60 * 1000 + 1000, 0);
  const afterCooldown = await request("/api/vote/eligibility");
  expect(afterCooldown.status === 200, "post-cooldown eligibility request failed");
  expect(
    afterCooldown.body?.participation?.status === "eligible",
    "fresh membership after the cooldown was not eligible"
  );

  const adminIndex = await request("/admin");
  expect(
    adminIndex.status === 307 && adminIndex.location === "/admin/logs",
    "eligible Admin did not reach the Admin index redirect"
  );
  const adminChild = await request("/admin/logs");
  expect(adminChild.status === 200, "eligible Admin could not reach an Admin child page");

  await setTimes(11 * 60 * 1000, 89 * 60 * 1000);
  const freshBoundary = await request("/api/vote/eligibility");
  expect(
    freshBoundary.body?.participation?.status === "eligible",
    "89-minute observation was not accepted"
  );

  // Keep this stale-observation case inside the join wait so degraded
  // Health cannot intentionally grant established-member Grace.
  await setTimes(5 * 60 * 1000, 91 * 60 * 1000);
  const stale = await request("/api/vote/eligibility");
  expect(
    stale.body?.participation?.status === "membership_pending",
    "stale observation did not fail closed"
  );
  const staleAdmin = await request("/admin");
  expect(
    staleAdmin.status === 307 && staleAdmin.location === "/admin/logs",
    "pending membership incorrectly blocked authenticated Admin access"
  );
  const forbidden = await request("/403");
  expect(forbidden.status === 200, "Forbidden route is missing");

  await setTimes(11 * 60 * 1000, null);
  const missing = await request("/api/vote/eligibility");
  expect(
    missing.body?.participation?.status === "membership_pending",
    "NULL observation did not fail closed"
  );

  await setTimes(11 * 60 * 1000, -4 * 60 * 1000);
  const allowedSkew = await request("/api/vote/eligibility");
  expect(
    allowedSkew.body?.participation?.status === "eligible",
    "accepted clock skew was rejected"
  );

  await setTimes(11 * 60 * 1000, -6 * 60 * 1000);
  const excessiveSkew = await request("/api/vote/eligibility");
  expect(
    excessiveSkew.body?.participation?.status === "membership_pending",
    "excessive clock skew did not fail closed"
  );

  await setTimes(11 * 60 * 1000, 0);
  await runSql(`delete from public.team_members where discord_user_id = ${literal(discordUserId)};`);
  const regularUser = await request("/admin");
  expect(
    regularUser.status === 307 && regularUser.location === "/403",
    "regular user unexpectedly reached Admin"
  );

  await runSql(`
    insert into public.team_members (discord_user_id, role, discord_username)
    values (${literal(discordUserId)}, 'admin', 'auth-runtime-admin');
    select public.apply_discord_ban(
      ${literal(`${eventPrefix}ban`)},
      clock_timestamp(),
      repeat('a', 64),
      ${literal(discordUserId)},
      'auth-runtime-admin'
    );
  `);
  const discordBanFixture = await runSql(`
    select jsonb_build_object(
      'discordBanned', (
        select discord_ban_active from public.discord_member_state
        where discord_user_id = ${literal(discordUserId)}
      ),
      'activeSessionCount', (
        select count(*) from public.sessions
        where discord_user_id = ${literal(discordUserId)}
          and revoked_at is null
      )
    );
  `);
  const discordBanned = await request("/admin");
  console.log(
    "DEV auth/participation Discord-ban diagnostic:",
    JSON.stringify({
      status: discordBanned.status,
      location: discordBanned.location,
      fixture: JSON.parse(discordBanFixture),
    })
  );
  expect(
    discordBanned.status === 307 && discordBanned.location === "/403",
    "Discord-banned Admin unexpectedly retained access"
  );

  await runSql(`
    select public.apply_discord_unban(
      ${literal(`${eventPrefix}unban`)},
      clock_timestamp(),
      repeat('b', 64),
      ${literal(discordUserId)},
      'auth-runtime-admin'
    );
    update public.discord_member_state
    set
      is_in_discord = true,
      discord_joined_at = clock_timestamp() - interval '11 minutes',
      discord_membership_observed_at = clock_timestamp()
    where discord_user_id = ${literal(discordUserId)};
    select public.create_cancerculture_session(
      ${literal(secondSessionId)}::uuid,
      ${literal(discordUserId)}
    );
    update public.user_logs
    set is_banned = true
    where discord_user_id = ${literal(discordUserId)};
  `);
  const websiteBanned = await request("/admin", secondSessionId);
  expect(
    websiteBanned.status === 307 && websiteBanned.location === "/403",
    "website-banned Admin unexpectedly retained access"
  );

  console.log("DEV auth/participation runtime integration passed.");
} catch (error) {
  testError = error;
} finally {
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }
}

const residualCount = await fixtureResidualCount();

if (residualCount !== "0") {
  throw new Error("DEV auth/participation runtime fixtures remain after cleanup");
}

console.log("DEV auth/participation runtime cleanup passed.");

if (cleanupError) throw cleanupError;
if (testError) throw testError;

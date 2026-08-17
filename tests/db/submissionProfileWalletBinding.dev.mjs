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
const runId = randomUUID();
const userPrefix = `codex-profile-binding-${runId}`;
const walletA = "So11111111111111111111111111111111111111112";
const walletB = "Vote111111111111111111111111111111111111111";
const users = {
  frozen: `${userPrefix}-frozen`,
  stale: `${userPrefix}-stale`,
  downgrade: `${userPrefix}-downgrade`,
  donate: `${userPrefix}-donate`,
  race: `${userPrefix}-race`,
};
const sessions = Object.fromEntries(
  Object.keys(users).map((name) => [name, randomUUID()])
);
const keys = Object.fromEntries(
  Object.keys(users).map((name) => [name, randomUUID()])
);

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function readEnv(name) {
  const source = await readFile(path.join(repoRoot, name), "utf8");
  const values = new Map();
  for (const line of source.split(/\r?\n/u)) {
    if (!line || /^\s*#/u.test(line) || !line.includes("=")) continue;
    const index = line.indexOf("=");
    values.set(
      line.slice(0, index).trim(),
      line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/u, "$2")
    );
  }
  return values;
}

function projectRef(databaseUrl) {
  const parsed = new URL(databaseUrl);
  return (
    parsed.hostname.match(/^db\.([^.]+)\./u)?.[1] ??
    decodeURIComponent(parsed.username).match(/^postgres\.([^:]+)$/u)?.[1] ??
    null
  );
}

async function loadDevDatabaseUrl() {
  const [local, codex] = await Promise.all([
    readEnv(".env.local"),
    readEnv(".env.codex.local"),
  ]);
  const databaseUrl =
    process.env.SUPABASE_DEV_DATABASE_URL ??
    codex.get("SUPABASE_DEV_DATABASE_URL");
  const websiteUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    local.get("NEXT_PUBLIC_SUPABASE_URL");
  if (!databaseUrl || !websiteUrl) {
    throw new Error("Required DEV configuration is missing.");
  }
  if (
    projectRef(databaseUrl) !== "gceljiuydyiwkomymuqh" ||
    new URL(websiteUrl).hostname.split(".")[0] !== "gceljiuydyiwkomymuqh"
  ) {
    throw new Error("Refusing to run against a non-DEV project.");
  }
  return databaseUrl;
}

function runSql(databaseUrl, source) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      psql,
      [databaseUrl, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", source],
      { cwd: repoRoot, windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", () => {
      reject(new Error("The DEV database command could not start."));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const detail = stderr
        .replaceAll(databaseUrl, "[DEV_DATABASE_URL]")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 500);
      reject(new Error(`Sanitized DEV SQL failed${detail ? `: ${detail}` : "."}`));
    });
  });
}

async function rpc(databaseUrl, source) {
  return JSON.parse(await runSql(databaseUrl, `select ${source}::text;`));
}

function reserveCall({ session, key, fingerprint, source, version, wallet, payout, charity }) {
  return `public.reserve_submission_upload(
    ${quote(session)}::uuid,
    ${quote(key)}::uuid,
    ${quote(fingerprint.repeat(64))},
    ${quote(fingerprint.toUpperCase().repeat(64).toLowerCase())},
    'image/webp',
    100,
    ${quote(source)},
    ${version ?? "null"},
    ${wallet ? quote(wallet) : "null"},
    ${quote(payout)},
    null,
    ${charity ? quote(charity) : "null"}
  )`;
}

async function cleanup(databaseUrl) {
  await runSql(
    databaseUrl,
    `
      create temporary table codex_recipient_fixture_keys as
      select storage_key
      from public.submission_upload_operations
      where discord_user_id like ${quote(`${userPrefix}%`)}
      union
      select r2_key
      from public.submissions
      where discord_user_id like ${quote(`${userPrefix}%`)}
        and r2_key is not null;

      delete from public.upload_logs
      where discord_user_id like ${quote(`${userPrefix}%`)};
      delete from public.submission_upload_operations
      where discord_user_id like ${quote(`${userPrefix}%`)};
      delete from public.submissions
      where discord_user_id like ${quote(`${userPrefix}%`)};
      delete from public.media_cleanup_queue
      where storage_key in (
        select storage_key from codex_recipient_fixture_keys
      );
      delete from public.account_sol_profile_wallets
      where discord_user_id like ${quote(`${userPrefix}%`)};
      delete from public.account_totp_factors
      where discord_user_id like ${quote(`${userPrefix}%`)};
      delete from public.sessions
      where discord_user_id like ${quote(`${userPrefix}%`)};
      delete from public.discord_member_state
      where discord_user_id like ${quote(`${userPrefix}%`)};
      delete from public.user_logs
      where discord_user_id like ${quote(`${userPrefix}%`)};
    `
  );
}

async function setup(databaseUrl) {
  const currentCycle = await runSql(
    databaseUrl,
    `select id from public.voting_cycles where status = 'submission_open' order by id desc limit 2;`
  );
  const cycleIds = currentCycle.split(/\r?\n/u).filter(Boolean);
  if (cycleIds.length !== 1) {
    throw new Error("DEV test requires exactly one submission-open Cycle.");
  }

  const userValues = Object.entries(users)
    .map(([name, user]) => `(${quote(user)}, ${quote(`codex-${name}`)})`)
    .join(",");
  const membershipValues = Object.entries(users)
    .map(
      ([name, user]) =>
        `(${quote(user)}, ${quote(`codex-${name}`)}, transaction_timestamp() - interval '1 day', true)`
    )
    .join(",");
  const sessionValues = Object.entries(users)
    .map(([name, user]) => `(${quote(sessions[name])}::uuid, ${quote(user)})`)
    .join(",");
  const securedUsers = [users.frozen, users.stale, users.downgrade, users.race];

  await runSql(
    databaseUrl,
    `
      with rules as (select current_version from public.rules_meta where id = 1)
      insert into public.user_logs (
        discord_user_id, current_discord_username, accepted_rules_version
      )
      select fixture.discord_user_id, fixture.username, rules.current_version
      from rules
      cross join (values ${userValues}) fixture(discord_user_id, username);

      insert into public.discord_member_state (
        discord_user_id, current_discord_username, discord_joined_at, is_in_discord
      ) values ${membershipValues};

      insert into public.sessions (id, discord_user_id) values ${sessionValues};

      insert into public.account_totp_factors (
        discord_user_id, secret_ciphertext, secret_nonce, secret_tag, key_version
      )
      select secured.discord_user_id, repeat('a', 32), repeat('b', 24), repeat('c', 24), 1
      from unnest(array[${securedUsers.map(quote).join(",")}]) secured(discord_user_id);

      insert into public.account_sol_profile_wallets (
        discord_user_id, wallet_address, version
      )
      select secured.discord_user_id, ${quote(walletA)}, 1
      from unnest(array[${securedUsers.map(quote).join(",")}]) secured(discord_user_id);
    `
  );
  return Number(cycleIds[0]);
}

async function waitForWalletLock(databaseUrl, user) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await runSql(
      databaseUrl,
      `select case when pg_try_advisory_lock(hashtextextended(${quote(`sol-profile-wallet:${user}`)}, 0)) then pg_advisory_unlock(hashtextextended(${quote(`sol-profile-wallet:${user}`)}, 0))::text else 'busy' end;`
    );
    if (result === "busy") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the Profile Wallet transaction lock.");
}

const databaseUrl = await loadDevDatabaseUrl();
await cleanup(databaseUrl);

try {
  const cycleId = await setup(databaseUrl);

  const frozenReservation = await rpc(
    databaseUrl,
    reserveCall({
      session: sessions.frozen,
      key: keys.frozen,
      fingerprint: "a",
      source: "profile",
      version: 1,
      wallet: null,
      payout: "keep",
      charity: null,
    })
  );
  if (frozenReservation.outcome !== "reserved") {
    throw new Error("Profile Wallet reservation did not succeed.");
  }

  await runSql(
    databaseUrl,
    `update public.account_sol_profile_wallets set wallet_address=${quote(walletB)}, version=2 where discord_user_id=${quote(users.frozen)};`
  );
  const frozenReplay = await rpc(
    databaseUrl,
    reserveCall({
      session: sessions.frozen,
      key: keys.frozen,
      fingerprint: "a",
      source: "profile",
      version: 1,
      wallet: null,
      payout: "keep",
      charity: null,
    })
  );
  if (
    frozenReplay.outcome !== "reserved" ||
    frozenReplay.operationId !== frozenReservation.operationId
  ) {
    throw new Error("Same-key replay did not preserve the frozen reservation.");
  }

  const frozenSnapshot = await runSql(
    databaseUrl,
    `select wallet_address || ':' || profile_wallet_version from public.submission_upload_operations where id=${quote(frozenReservation.operationId)}::uuid;`
  );
  if (frozenSnapshot !== `${walletA}:1`) {
    throw new Error("Reserved Profile Wallet snapshot changed after reservation.");
  }

  const marked = await rpc(
    databaseUrl,
    `public.mark_submission_upload_r2_uploaded(${quote(frozenReservation.operationId)}::uuid, ${quote(sessions.frozen)}::uuid, null)`
  );
  if (marked.outcome !== "r2_uploaded") {
    throw new Error("Synthetic R2 acknowledgement failed.");
  }
  const committed = await rpc(
    databaseUrl,
    `public.commit_submission_upload(${quote(frozenReservation.operationId)}::uuid, ${quote(sessions.frozen)}::uuid, 1200, 800)`
  );
  if (committed.outcome !== "completed") {
    throw new Error("Frozen Profile Wallet commit failed.");
  }
  const privateSnapshot = await runSql(
    databaseUrl,
    `select wallet_address from public.submission_private_data where submission_id=${committed.submissionId};`
  );
  if (privateSnapshot !== walletA) {
    throw new Error("Commit did not copy the frozen Profile Wallet snapshot.");
  }

  await runSql(
    databaseUrl,
    `update public.account_sol_profile_wallets set wallet_address=${quote(walletB)}, version=2 where discord_user_id=${quote(users.stale)};`
  );
  const stale = await rpc(
    databaseUrl,
    reserveCall({
      session: sessions.stale,
      key: keys.stale,
      fingerprint: "b",
      source: "profile",
      version: 1,
      wallet: null,
      payout: "keep",
      charity: null,
    })
  );
  if (stale.outcome !== "profile_wallet_stale") {
    throw new Error("Changed pre-reservation Profile Wallet was not rejected as stale.");
  }

  const downgrade = await rpc(
    databaseUrl,
    reserveCall({
      session: sessions.downgrade,
      key: keys.downgrade,
      fingerprint: "c",
      source: "manual",
      version: null,
      wallet: walletB,
      payout: "keep",
      charity: null,
    })
  );
  if (downgrade.outcome !== "profile_wallet_stale") {
    throw new Error("Manual downgrade bypassed the active Profile Wallet.");
  }

  const donate = await rpc(
    databaseUrl,
    reserveCall({
      session: sessions.donate,
      key: keys.donate,
      fingerprint: "d",
      source: "none",
      version: null,
      wallet: null,
      payout: "donate",
      charity: "Synthetic Charity",
    })
  );
  if (donate.outcome !== "reserved") {
    throw new Error("Donate reservation incorrectly required a wallet.");
  }

  const raceChange = runSql(
    databaseUrl,
    `begin;
     select pg_advisory_xact_lock(hashtextextended(${quote(`account-2fa:${users.race}`)}, 0));
     select pg_advisory_xact_lock(hashtextextended(${quote(`sol-profile-wallet:${users.race}`)}, 0));
     update public.account_sol_profile_wallets set wallet_address=${quote(walletB)}, version=2 where discord_user_id=${quote(users.race)};
     select pg_sleep(2);
     commit;`
  );
  await waitForWalletLock(databaseUrl, users.race);
  const racedReservation = await rpc(
    databaseUrl,
    reserveCall({
      session: sessions.race,
      key: keys.race,
      fingerprint: "e",
      source: "profile",
      version: 1,
      wallet: null,
      payout: "keep",
      charity: null,
    })
  );
  await raceChange;
  if (racedReservation.outcome !== "profile_wallet_stale") {
    throw new Error("Concurrent Profile Wallet change did not serialize before reservation.");
  }

  const fixtureOperationCount = await runSql(
    databaseUrl,
    `select count(*) from public.submission_upload_operations where discord_user_id like ${quote(`${userPrefix}%`)};`
  );
  if (fixtureOperationCount !== "2") {
    throw new Error("Stale reservations created unexpected upload operations.");
  }
  console.log(`DEV submission recipient binding tests passed on Cycle ${cycleId}.`);
} finally {
  await cleanup(databaseUrl);
}

const remaining = await runSql(
  databaseUrl,
  `select count(*) from public.user_logs where discord_user_id like ${quote(`${userPrefix}%`)};`
);
if (remaining !== "0") {
  throw new Error("Synthetic DEV recipient fixtures were not fully removed.");
}
console.log("DEV submission recipient binding cleanup passed.");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createDiscordMembershipSyncSignature,
  DISCORD_MEMBERSHIP_SYNC_PATH,
  DiscordMembershipSyncAuthError,
  verifyDiscordMembershipSyncRequest,
} from "../../lib/auth/discordMembershipSyncAuth.ts";

const originalEnvironment = { ...process.env };
const secret = "d".repeat(48);
const guildId = "123456789012345678";
const body =
  '{"eventType":"member_removed","eventId":"event-123456","guildId":"123456789012345678","observedAt":"2026-07-16T00:00:00.000Z","discordUserId":"223456789012345678","discordUsername":"tester"}';
const nowMs = Date.parse("2026-07-16T00:00:01.000Z");
const timestamp = String(Math.floor(nowMs / 1000));

test.beforeEach(() => {
  process.env.DISCORD_MEMBERSHIP_SYNC_SECRET = secret;
  process.env.DISCORD_GUILD_ID = guildId;
});

test.after(() => {
  process.env = originalEnvironment;
});

function signature(overrides = {}) {
  return createDiscordMembershipSyncSignature({
    secret,
    method: "POST",
    path: DISCORD_MEMBERSHIP_SYNC_PATH,
    timestamp,
    eventId: "event-123456",
    body,
    ...overrides,
  });
}

test("missing or weak sync configuration fails closed with 503", () => {
  process.env.DISCORD_MEMBERSHIP_SYNC_SECRET = "short";

  assert.throws(
    () =>
      verifyDiscordMembershipSyncRequest({
        method: "POST",
        path: DISCORD_MEMBERSHIP_SYNC_PATH,
        timestamp,
        eventId: "event-123456",
        signature: signature(),
        body,
        nowMs,
      }),
    (error) =>
      error instanceof DiscordMembershipSyncAuthError &&
      error.status === 503 &&
      error.code === "SYNC_NOT_CONFIGURED"
  );
});

test("valid signature is accepted and body changes invalidate it", () => {
  const verified = verifyDiscordMembershipSyncRequest({
    method: "POST",
    path: DISCORD_MEMBERSHIP_SYNC_PATH,
    timestamp,
    eventId: "event-123456",
    signature: `sha256=${signature()}`,
    body,
    nowMs,
  });

  assert.equal(verified.eventId, "event-123456");
  assert.equal(verified.guildId, guildId);
  assert.match(verified.payloadSha256, /^[0-9a-f]{64}$/);

  assert.throws(
    () =>
      verifyDiscordMembershipSyncRequest({
        method: "POST",
        path: DISCORD_MEMBERSHIP_SYNC_PATH,
        timestamp,
        eventId: "event-123456",
        signature: signature(),
        body: `${body} `,
        nowMs,
      }),
    (error) =>
      error instanceof DiscordMembershipSyncAuthError &&
      error.status === 401 &&
      error.code === "INVALID_SYNC_SIGNATURE"
  );
});

test("expired timestamp, wrong path, and malformed event ID are rejected", () => {
  for (const request of [
    {
      path: DISCORD_MEMBERSHIP_SYNC_PATH,
      timestamp: String(Number(timestamp) - 301),
      eventId: "event-123456",
      expectedCode: "EXPIRED_SYNC_REQUEST",
    },
    {
      path: "/api/internal/other",
      timestamp,
      eventId: "event-123456",
      expectedCode: "INVALID_SYNC_REQUEST",
    },
    {
      path: DISCORD_MEMBERSHIP_SYNC_PATH,
      timestamp,
      eventId: "bad id",
      expectedCode: "INVALID_SYNC_REQUEST",
    },
  ]) {
    assert.throws(
      () =>
        verifyDiscordMembershipSyncRequest({
          method: "POST",
          path: request.path,
          timestamp: request.timestamp,
          eventId: request.eventId,
          signature: signature(),
          body,
          nowMs,
        }),
      (error) =>
        error instanceof DiscordMembershipSyncAuthError &&
        error.status === 401 &&
        error.code === request.expectedCode
    );
  }
});

test("internal route is narrow, bounded, no-store, and uses only fixed RPCs", async () => {
  const source = await readFile(
    new URL(
      "../../app/api/internal/discord/membership-sync/route.ts",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(source, /export async function POST/);
  assert.doesNotMatch(source, /export async function (GET|PUT|PATCH|DELETE)/);
  assert.match(source, /DISCORD_MEMBERSHIP_SYNC_MAX_BODY_BYTES/);
  assert.match(source, /Cache-Control/);
  assert.match(source, /verifyDiscordMembershipSyncRequest/);
  assert.doesNotMatch(
    source,
    /SUPABASE_SERVICE_ROLE_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY/
  );
  assert.doesNotMatch(source, /console\.(log|error)\([^)]*payload/i);
});

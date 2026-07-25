import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  createDiscordMembershipSyncSignature,
  DISCORD_MEMBERSHIP_SYNC_PATH,
} from "../../lib/auth/discordMembershipSyncAuth.ts";

const originalEnvironment = { ...process.env };
const secret = "r".repeat(48);
const guildId = "123456789012345678";

const database = {
  calls: [],
};

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      rpc(name, parameters) {
        database.calls.push({ name, parameters });
        return Promise.resolve({
          data: { outcome: "applied" },
          error: null,
        });
      },
    },
  },
});

const route = await import(
  "../../app/api/internal/discord/membership-sync/route.ts"
);

test.beforeEach(() => {
  process.env.DISCORD_MEMBERSHIP_SYNC_SECRET = secret;
  process.env.DISCORD_GUILD_ID = guildId;
  database.calls = [];
});

test.after(() => {
  process.env = originalEnvironment;
});

function timestampBefore(isoTimestamp, milliseconds) {
  return new Date(Date.parse(isoTimestamp) - milliseconds).toISOString();
}

function signedRequest(payload, eventId = "route-test-event") {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));

  return new Request(
    `https://example.test${DISCORD_MEMBERSHIP_SYNC_PATH}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cc-timestamp": timestamp,
        "x-cc-event-id": eventId,
        "x-cc-signature": createDiscordMembershipSyncSignature({
          secret,
          method: "POST",
          path: DISCORD_MEMBERSHIP_SYNC_PATH,
          timestamp,
          eventId,
          body,
        }),
      },
      body,
    }
  );
}

function liveJoinPayload(overrides = {}) {
  const observedAt = new Date(Date.now() - 1_000).toISOString();

  return {
    eventType: "member_joined",
    eventId: "route-test-event",
    guildId,
    observedAt,
    discordUserId: "223456789012345678",
    discordUsername: "route-tester",
    ...overrides,
  };
}

function memberChunkPayload(recordOverrides = {}) {
  const observedAt = new Date(Date.now() - 1_000).toISOString();

  return {
    eventType: "snapshot_members_chunk",
    eventId: "route-test-event",
    guildId,
    observedAt,
    snapshotId: "12345678-1234-4234-8234-123456789012",
    records: [
      {
        discordUserId: "223456789012345678",
        discordUsername: "snapshot-tester",
        ...recordOverrides,
      },
    ],
  };
}

test("member_joined forwards a normalized optional joinedAt", async () => {
  const payload = liveJoinPayload();
  payload.joinedAt = timestampBefore(payload.observedAt, 14 * 60 * 1_000);

  const response = await route.POST(signedRequest(payload));

  assert.equal(response.status, 200);
  assert.equal(database.calls.length, 1);
  assert.equal(database.calls[0].name, "apply_discord_member_join_v2");
  assert.equal(
    database.calls[0].parameters.p_joined_at,
    new Date(payload.joinedAt).toISOString()
  );
});

test("member_joined without joinedAt remains backward compatible", async () => {
  const response = await route.POST(signedRequest(liveJoinPayload()));

  assert.equal(response.status, 200);
  assert.equal(database.calls.length, 1);
  assert.equal(database.calls[0].name, "apply_discord_member_join_v2");
  assert.equal(database.calls[0].parameters.p_joined_at, null);
});

test("member_joined accepts PostgreSQL year one", async () => {
  const payload = liveJoinPayload({
    joinedAt: "0001-01-01T00:00:00.000Z",
  });
  const response = await route.POST(signedRequest(payload));

  assert.equal(response.status, 200);
  assert.equal(database.calls.length, 1);
  assert.equal(
    database.calls[0].parameters.p_joined_at,
    "0001-01-01T00:00:00.000Z"
  );
});

test("member_joined rejects PostgreSQL year zero before RPC", async () => {
  const payload = liveJoinPayload({
    joinedAt: "0000-01-01T00:00:00.000Z",
  });
  const response = await route.POST(signedRequest(payload));

  assert.equal(response.status, 400);
  assert.equal(database.calls.length, 0);
});

test("member_joined rejects a non-string joinedAt before RPC", async () => {
  const payload = liveJoinPayload({ joinedAt: { seconds: 0 } });
  const response = await route.POST(signedRequest(payload));

  assert.equal(response.status, 400);
  assert.equal(database.calls.length, 0);
});

test("invalid or future member_joined joinedAt is rejected before RPC", async () => {
  for (const joinedAt of [
    "not-a-timestamp",
    "July 20, 2026 12:00 UTC",
    "2026-02-30T12:00:00.000Z",
    new Date(Date.now() + 60_000).toISOString(),
  ]) {
    const payload = liveJoinPayload({ joinedAt });
    const response = await route.POST(signedRequest(payload));

    assert.equal(response.status, 400);
    assert.equal(database.calls.length, 0);
  }
});

test("snapshot member timestamps survive validation and reach the RPC", async () => {
  const payload = memberChunkPayload();
  const membershipObservedAt = timestampBefore(payload.observedAt, 1_000);
  const joinedAt = timestampBefore(membershipObservedAt, 20 * 60 * 1_000);
  payload.records[0].membershipObservedAt = membershipObservedAt;
  payload.records[0].joinedAt = joinedAt;

  const response = await route.POST(signedRequest(payload));

  assert.equal(response.status, 200);
  assert.deepEqual(database.calls[0].parameters.p_records, [
    {
      discordUserId: payload.records[0].discordUserId,
      discordUsername: payload.records[0].discordUsername,
      joinedAt: new Date(joinedAt).toISOString(),
      membershipObservedAt: new Date(membershipObservedAt).toISOString(),
    },
  ]);
});

test("snapshot joinedAt requires membershipObservedAt", async () => {
  const payload = memberChunkPayload({
    joinedAt: new Date(Date.now() - 60_000).toISOString(),
  });

  const response = await route.POST(signedRequest(payload));

  assert.equal(response.status, 400);
  assert.equal(database.calls.length, 0);
});

test("snapshot joinedAt cannot exceed membershipObservedAt", async () => {
  const payload = memberChunkPayload();
  payload.records[0].membershipObservedAt = timestampBefore(
    payload.observedAt,
    2_000
  );
  payload.records[0].joinedAt = timestampBefore(payload.observedAt, 1_000);

  const response = await route.POST(signedRequest(payload));

  assert.equal(response.status, 400);
  assert.equal(database.calls.length, 0);
});

test("snapshot member rejects PostgreSQL year zero before RPC", async () => {
  const payload = memberChunkPayload({
    membershipObservedAt: new Date(Date.now() - 2_000).toISOString(),
    joinedAt: "0000-01-01T00:00:00.000Z",
  });
  const response = await route.POST(signedRequest(payload));

  assert.equal(response.status, 400);
  assert.equal(database.calls.length, 0);
});

test("snapshot membershipObservedAt cannot exceed event observedAt", async () => {
  const payload = memberChunkPayload();
  payload.records[0].membershipObservedAt = new Date(
    Date.parse(payload.observedAt) + 1_000
  ).toISOString();

  const response = await route.POST(signedRequest(payload));

  assert.equal(response.status, 400);
  assert.equal(database.calls.length, 0);
});

test("legacy snapshot records remain accepted unchanged", async () => {
  const payload = memberChunkPayload();
  const response = await route.POST(signedRequest(payload));

  assert.equal(response.status, 200);
  assert.deepEqual(database.calls[0].parameters.p_records, payload.records);
});

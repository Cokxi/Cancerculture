import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  createDiscordMembershipSyncSignature,
  DISCORD_HEARTBEAT_PATH,
} from "../../lib/auth/discordMembershipSyncAuth.ts";

const originalEnvironment = { ...process.env };
const secret = "h".repeat(48);
const guildId = "123456789012345678";

const database = {
  data: { id: 1 },
  error: null,
  throwError: null,
  fromTable: null,
  updatePayload: null,
  filter: null,
  selectedColumns: null,
};

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      from(table) {
        database.fromTable = table;
        return {
          update(payload) {
            database.updatePayload = payload;
            return this;
          },
          eq(column, value) {
            database.filter = { column, value };
            return this;
          },
          select(columns) {
            database.selectedColumns = columns;
            return this;
          },
          maybeSingle() {
            if (database.throwError) {
              return Promise.reject(database.throwError);
            }
            return Promise.resolve({
              data: database.data,
              error: database.error,
            });
          },
        };
      },
    },
  },
});

const route = await import(
  "../../app/api/internal/discord/heartbeat/route.ts"
);

function resetDatabase() {
  database.data = { id: 1 };
  database.error = null;
  database.throwError = null;
  database.fromTable = null;
  database.updatePayload = null;
  database.filter = null;
  database.selectedColumns = null;
}

test.beforeEach(() => {
  process.env.DISCORD_MEMBERSHIP_SYNC_SECRET = secret;
  process.env.DISCORD_GUILD_ID = guildId;
  resetDatabase();
});

test.after(() => {
  process.env = originalEnvironment;
});

function signedHeaders({
  providedSecret = secret,
  signature = null,
} = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const eventId = "heartbeat-test-event";
  return {
    "x-cc-timestamp": timestamp,
    "x-cc-event-id": eventId,
    "x-cc-signature":
      signature ??
      createDiscordMembershipSyncSignature({
        secret: providedSecret,
        method: "POST",
        path: DISCORD_HEARTBEAT_PATH,
        timestamp,
        eventId,
        body: "",
      }),
  };
}

function heartbeatRequest({ headers = signedHeaders(), body } = {}) {
  return new Request(`https://example.test${DISCORD_HEARTBEAT_PATH}`, {
    method: "POST",
    headers,
    body,
  });
}

test("missing request signature is rejected without database access", async () => {
  const headers = signedHeaders();
  delete headers["x-cc-signature"];

  const response = await route.POST(heartbeatRequest({ headers }));

  assert.equal(response.status, 401);
  assert.equal(database.fromTable, null);
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("wrong secret signature is rejected", async () => {
  const response = await route.POST(
    heartbeatRequest({
      headers: signedHeaders({ providedSecret: "w".repeat(48) }),
    })
  );

  assert.equal(response.status, 401);
  assert.equal(database.fromTable, null);
});

test("missing server secret fails closed", async () => {
  delete process.env.DISCORD_MEMBERSHIP_SYNC_SECRET;

  const response = await route.POST(heartbeatRequest());

  assert.equal(response.status, 503);
  assert.equal(database.fromTable, null);
});

test("valid HMAC updates the singleton without a Website session", async () => {
  const response = await route.POST(heartbeatRequest());

  assert.equal(response.status, 204);
  assert.equal(database.fromTable, "discord_sync_health");
  assert.deepEqual(database.filter, { column: "id", value: 1 });
  assert.equal(database.selectedColumns, "id");
});

test("only server heartbeat and updated_at timestamps are written", async () => {
  const suppliedTimestamp = "2000-01-01T00:00:00.000Z";

  await route.POST(
    heartbeatRequest({
      body: JSON.stringify({
        lastHeartbeatAt: suppliedTimestamp,
        membershipStatus: "membership_pending",
      }),
    })
  );

  assert.deepEqual(Object.keys(database.updatePayload).sort(), [
    "last_heartbeat_at",
    "updated_at",
  ]);
  assert.equal(
    database.updatePayload.last_heartbeat_at,
    database.updatePayload.updated_at
  );
  assert.notEqual(database.updatePayload.last_heartbeat_at, suppliedTimestamp);
  assert.ok(Number.isFinite(Date.parse(database.updatePayload.last_heartbeat_at)));
});

test("missing singleton fails closed without insert or upsert", async () => {
  database.data = null;

  const response = await route.POST(heartbeatRequest());

  assert.equal(response.status, 503);
  assert.equal(database.fromTable, "discord_sync_health");
  assert.deepEqual(Object.keys(database.updatePayload).sort(), [
    "last_heartbeat_at",
    "updated_at",
  ]);
});

test("database error returns a sanitized 503", async () => {
  database.error = { code: "DB_UNAVAILABLE", details: "private details" };

  const response = await route.POST(heartbeatRequest());
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.deepEqual(body, { error: "HEARTBEAT_DEPENDENCY_UNAVAILABLE" });
  assert.doesNotMatch(JSON.stringify(body), /DB_UNAVAILABLE|private details/);
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("unexpected database failure returns a sanitized 503", async () => {
  database.throwError = new Error("private connection URL");

  const response = await route.POST(heartbeatRequest());

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "HEARTBEAT_DEPENDENCY_UNAVAILABLE",
  });
});

test("successful response is empty, private, and non-cacheable", async () => {
  const response = await route.POST(heartbeatRequest());

  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
});

test("route exposes no GET health response", () => {
  assert.equal(route.GET, undefined);
});

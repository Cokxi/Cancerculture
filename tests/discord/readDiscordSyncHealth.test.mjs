import assert from "node:assert/strict";
import { mock, test } from "node:test";

const database = {
  data: null,
  error: null,
  throwError: null,
  fromCalls: [],
  selectedColumns: null,
  filter: null,
  singleCalls: 0,
};

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      from(table) {
        database.fromCalls.push(table);
        return {
          select(columns) {
            database.selectedColumns = columns;
            return this;
          },
          eq(column, value) {
            database.filter = { column, value };
            return this;
          },
          single() {
            database.singleCalls += 1;
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

const { readDiscordSyncHealth } = await import(
  "../../lib/discord/readDiscordSyncHealth.ts"
);

const validRow = () => ({
  last_heartbeat_at: "2026-07-18T12:00:00.000Z",
  last_full_reconciliation_succeeded_at:
    "2026-07-18T11:55:00.000Z",
  last_failure_at: null,
});

test.beforeEach(() => {
  database.data = validRow();
  database.error = null;
  database.throwError = null;
  database.fromCalls = [];
  database.selectedColumns = null;
  database.filter = null;
  database.singleCalls = 0;
});

test("the helper reads only the private health singleton id 1", async () => {
  const result = await readDiscordSyncHealth();

  assert.deepEqual(result, validRow());
  assert.deepEqual(database.fromCalls, ["discord_sync_health"]);
  assert.equal(
    database.selectedColumns,
    "last_heartbeat_at, last_full_reconciliation_succeeded_at, last_failure_at"
  );
  assert.deepEqual(database.filter, { column: "id", value: 1 });
  assert.equal(database.singleCalls, 1);
});

test("a missing singleton returns null", async () => {
  database.data = null;

  assert.equal(await readDiscordSyncHealth(), null);
});

test("a database error returns null without exposing details", async () => {
  database.error = {
    code: "PRIVATE_CODE",
    details: "private database details",
  };

  assert.equal(await readDiscordSyncHealth(), null);
});

test("an unexpected database exception returns null", async () => {
  database.throwError = new Error("private connection details");

  assert.equal(await readDiscordSyncHealth(), null);
});

test("unexpected row value types return null", async () => {
  database.data = {
    ...validRow(),
    last_heartbeat_at: 123,
  };

  assert.equal(await readDiscordSyncHealth(), null);
});

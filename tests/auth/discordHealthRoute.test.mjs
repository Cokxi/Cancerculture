import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";

const originalEnvironment = { ...process.env };
const secret = "q".repeat(48);
const routePath = "/api/internal/discord/health";

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

const route = await import(
  "../../app/api/internal/discord/health/route.ts"
);

const timestampAgo = (ageMs) =>
  new Date(Date.now() - ageMs).toISOString();

function freshRow() {
  return {
    last_heartbeat_at: timestampAgo(2 * 60 * 1000),
    last_full_reconciliation_succeeded_at:
      timestampAgo(15 * 60 * 1000),
    last_failure_at: timestampAgo(20 * 60 * 1000),
  };
}

function resetDatabase() {
  database.data = freshRow();
  database.error = null;
  database.throwError = null;
  database.fromCalls = [];
  database.selectedColumns = null;
  database.filter = null;
  database.singleCalls = 0;
}

function healthRequest({
  providedSecret = secret,
  includeAuthorization = true,
  search = "",
} = {}) {
  const headers = new Headers();
  if (includeAuthorization) {
    headers.set("authorization", "Bearer " + providedSecret);
  }

  return new Request("https://example.test" + routePath + search, {
    method: "GET",
    headers,
  });
}

function assertNoStore(response) {
  assert.equal(
    response.headers.get("cache-control"),
    "no-store, max-age=0"
  );
}

test.beforeEach(() => {
  process.env.DISCORD_SYNC_HEALTH_SECRET = secret;
  resetDatabase();
});

test.after(() => {
  process.env = originalEnvironment;
});

test("missing Authorization returns 401 without database access", async () => {
  const response = await route.GET(
    healthRequest({ includeAuthorization: false })
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "UNAUTHORIZED" });
  assert.deepEqual(database.fromCalls, []);
});

test("a wrong health secret returns 401", async () => {
  const response = await route.GET(
    healthRequest({ providedSecret: "w".repeat(48) })
  );

  assert.equal(response.status, 401);
  assert.deepEqual(database.fromCalls, []);
});

test("missing server health configuration returns 503", async () => {
  delete process.env.DISCORD_SYNC_HEALTH_SECRET;

  const response = await route.GET(healthRequest());

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "HEALTH_NOT_CONFIGURED",
  });
  assert.deepEqual(database.fromCalls, []);
});

test("valid auth reads only the health singleton id 1", async () => {
  const response = await route.GET(healthRequest());

  assert.equal(response.status, 200);
  assert.deepEqual(database.fromCalls, ["discord_sync_health"]);
  assert.deepEqual(database.filter, { column: "id", value: 1 });
  assert.equal(database.singleCalls, 1);
  assert.equal(
    database.selectedColumns,
    "last_heartbeat_at, last_full_reconciliation_succeeded_at, last_failure_at"
  );
});

test("no Website session or Participation state is required", async () => {
  const response = await route.GET(healthRequest());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("fresh health returns healthy", async () => {
  const response = await route.GET(healthRequest());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "healthy");
  assert.deepEqual(body.reasons, []);
});

test("a stale heartbeat returns degraded with HTTP 200", async () => {
  database.data = {
    ...freshRow(),
    last_heartbeat_at: timestampAgo(13 * 60 * 1000),
  };

  const response = await route.GET(healthRequest());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "degraded");
  assert.deepEqual(body.reasons, ["heartbeat_stale"]);
});

test("a missing heartbeat returns offline with HTTP 200", async () => {
  database.data = {
    ...freshRow(),
    last_heartbeat_at: null,
  };

  const response = await route.GET(healthRequest());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "offline");
  assert.deepEqual(body.reasons, ["heartbeat_missing"]);
});

test("a heartbeat older than 30 minutes returns offline", async () => {
  database.data = {
    ...freshRow(),
    last_heartbeat_at: timestampAgo(31 * 60 * 1000),
  };

  const response = await route.GET(healthRequest());

  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "offline");
});

test("a newer failure remains degraded despite a fresh heartbeat", async () => {
  database.data = {
    last_heartbeat_at: timestampAgo(60 * 1000),
    last_full_reconciliation_succeeded_at:
      timestampAgo(10 * 60 * 1000),
    last_failure_at: timestampAgo(5 * 60 * 1000),
  };

  const response = await route.GET(healthRequest());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "degraded");
  assert.deepEqual(body.reasons, [
    "reconciliation_failed_after_success",
  ]);
});

test("the route uses the central evaluator", async () => {
  const source = await readFile(
    new URL(
      "../../app/api/internal/discord/health/route.ts",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(source, /evaluateDiscordSyncHealth\(\{/);
});

test("the route does not duplicate evaluator thresholds", async () => {
  const source = await readFile(
    new URL(
      "../../app/api/internal/discord/health/route.ts",
      import.meta.url
    ),
    "utf8"
  );

  assert.doesNotMatch(
    source,
    /HEARTBEAT_DEGRADED|HEARTBEAT_OFFLINE|RECONCILIATION_STALE/
  );
  assert.doesNotMatch(source, /\b(?:720000|1800000|4500000)\b/);
});

test("ages are converted to completed seconds", async () => {
  database.data = {
    last_heartbeat_at: timestampAgo(120 * 1000),
    last_full_reconciliation_succeeded_at:
      timestampAgo(900 * 1000),
    last_failure_at: null,
  };

  const response = await route.GET(healthRequest());
  const body = await response.json();

  assert.equal(body.heartbeatAgeSeconds, 120);
  assert.equal(body.reconciliationAgeSeconds, 900);
});

test("missing timestamps preserve null ages", async () => {
  database.data = {
    last_heartbeat_at: null,
    last_full_reconciliation_succeeded_at: null,
    last_failure_at: null,
  };

  const response = await route.GET(healthRequest());
  const body = await response.json();

  assert.equal(body.heartbeatAgeSeconds, null);
  assert.equal(body.reconciliationAgeSeconds, null);
});

test("healthy, degraded, and offline states all use HTTP 200", async () => {
  const rows = [
    freshRow(),
    {
      ...freshRow(),
      last_heartbeat_at: timestampAgo(13 * 60 * 1000),
    },
    {
      ...freshRow(),
      last_heartbeat_at: null,
    },
  ];

  for (const row of rows) {
    database.data = row;
    const response = await route.GET(healthRequest());
    assert.equal(response.status, 200);
  }
});

test("a missing singleton returns a sanitized 503", async () => {
  database.data = null;

  const response = await route.GET(healthRequest());

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "HEALTH_DEPENDENCY_UNAVAILABLE",
  });
});

test("database errors return a sanitized 503", async () => {
  database.error = {
    code: "PRIVATE_DB_CODE",
    details: "private database details",
  };

  const response = await route.GET(healthRequest());
  const serialized = JSON.stringify(await response.json());

  assert.equal(response.status, 503);
  assert.doesNotMatch(
    serialized,
    /PRIVATE_DB_CODE|private database details|discord_sync_health/
  );
});

test("unexpected database failures return a sanitized 503", async () => {
  database.throwError = new Error("private connection details");

  const response = await route.GET(healthRequest());

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "HEALTH_DEPENDENCY_UNAVAILABLE",
  });
});

test("responses expose only minimized health fields", async () => {
  database.data = {
    ...freshRow(),
    last_failure_code: "PRIVATE_FAILURE",
    last_failure_component: "full_reconciliation",
    id: 1,
  };

  const response = await route.GET(healthRequest());
  const body = await response.json();

  assert.deepEqual(Object.keys(body).sort(), [
    "heartbeatAgeSeconds",
    "reasons",
    "reconciliationAgeSeconds",
    "recoveredFromLatestFailure",
    "status",
  ]);
  assert.doesNotMatch(
    JSON.stringify(body),
    /PRIVATE_FAILURE|full_reconciliation|last_|2026-|discord/
  );
});

test("all success and error responses are non-cacheable", async () => {
  const success = await route.GET(healthRequest());
  assertNoStore(success);

  const unauthorized = await route.GET(
    healthRequest({ includeAuthorization: false })
  );
  assertNoStore(unauthorized);

  database.error = { code: "DB_ERROR" };
  const dependencyError = await route.GET(healthRequest());
  assertNoStore(dependencyError);
});

test("GET is the only implemented method", () => {
  assert.equal(route.POST, undefined);
  assert.equal(route.PUT, undefined);
  assert.equal(route.PATCH, undefined);
  assert.equal(route.DELETE, undefined);
});

test("query values cannot control now or database timestamps", async () => {
  const response = await route.GET(
    healthRequest({
      search:
        "?now=2000-01-01T00:00:00.000Z&lastHeartbeatAt=2099-01-01T00:00:00.000Z",
    })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "healthy");
  assert.ok(body.heartbeatAgeSeconds >= 120);
  assert.ok(body.reconciliationAgeSeconds >= 900);
});

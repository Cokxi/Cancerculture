import assert from "node:assert/strict";
import test from "node:test";
import {
  ALREADY_CURRENT_MODERATION_MESSAGE,
  NETWORK_MODERATION_MESSAGE,
  STALE_MODERATION_MESSAGE,
  createModerationIdempotencyKey,
  finishModerationRequest,
  performModerationClientRequest,
  tryBeginModerationRequest,
} from "../../lib/moderation/moderationClientRequest.ts";

function response(status, payload = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function successfulResult({ changed, replayed }) {
  return response(200, {
    success: true,
    result: { changed, replayed },
  });
}

function harness(fetcher) {
  const events = [];
  let requests = 0;
  return {
    events,
    get requests() {
      return requests;
    },
    run(endpoint = "/api/admin/disqualify") {
      return performModerationClientRequest({
        endpoint,
        body: { submissionId: 125 },
        fetcher: async (...args) => {
          requests += 1;
          return fetcher(...args);
        },
        finishPending: () => events.push("pending-finished"),
        showMessage: (message) => events.push(`alert:${message}`),
        refresh: () => events.push("reload"),
      });
    },
  };
}

test("stale Disqualify and Reinstate finish pending, alert, then refresh without retry", async () => {
  for (const endpoint of [
    "/api/admin/disqualify",
    "/api/admin/reinstate",
  ]) {
    const client = harness(async () => response(409));

    assert.equal(await client.run(endpoint), "stale");
    assert.deepEqual(client.events, [
      "pending-finished",
      `alert:${STALE_MODERATION_MESSAGE}`,
      "reload",
    ]);
    assert.equal(client.requests, 1);
  }
});

test("a changed result finishes pending and fully refreshes", async () => {
  const client = harness(async () =>
    successfulResult({ changed: true, replayed: false })
  );

  assert.equal(await client.run(), "changed");
  assert.deepEqual(client.events, ["pending-finished", "reload"]);
  assert.equal(client.requests, 1);
});

test("an identical replay refreshes without claiming a new mutation", async () => {
  const client = harness(async () =>
    successfulResult({ changed: true, replayed: true })
  );

  assert.equal(await client.run(), "replayed");
  assert.deepEqual(client.events, ["pending-finished", "reload"]);
  assert.equal(client.requests, 1);
});

test("a consistent no-op finishes pending, explains the state, then refreshes", async () => {
  const client = harness(async () =>
    successfulResult({ changed: false, replayed: false })
  );

  assert.equal(await client.run(), "already-current");
  assert.deepEqual(client.events, [
    "pending-finished",
    `alert:${ALREADY_CURRENT_MODERATION_MESSAGE}`,
    "reload",
  ]);
  assert.equal(client.requests, 1);
});

test("403 and 503 finish pending and show their safe error without refresh", async () => {
  for (const [status, outcome, message] of [
    [403, "forbidden", "Forbidden"],
    [503, "unavailable", "Moderation is temporarily unavailable."],
  ]) {
    const client = harness(async () => response(status, { error: message }));

    assert.equal(await client.run(), outcome);
    assert.deepEqual(client.events, [
      "pending-finished",
      `alert:${message}`,
    ]);
    assert.equal(client.requests, 1);
  }
});

test("a network failure finishes pending without refresh or retry", async () => {
  const client = harness(async () => {
    throw new TypeError("socket and internal stack detail");
  });

  assert.equal(await client.run(), "network-error");
  assert.deepEqual(client.events, [
    "pending-finished",
    `alert:${NETWORK_MODERATION_MESSAGE}`,
  ]);
  assert.equal(client.requests, 1);
  assert.doesNotMatch(client.events[1], /socket|stack/u);
});

test("the synchronous guard blocks a double click and permits a later attempt", () => {
  const pending = { current: false };

  assert.equal(tryBeginModerationRequest(pending), true);
  assert.equal(tryBeginModerationRequest(pending), false);
  finishModerationRequest(pending);
  assert.equal(tryBeginModerationRequest(pending), true);
});

test("each later semantic attempt receives a fresh, non-persisted idempotency key", () => {
  let sequence = 0;
  const randomUUID = () => `request-${++sequence}`;

  const disqualifyKey = createModerationIdempotencyKey(randomUUID);
  const laterDisqualifyKey = createModerationIdempotencyKey(randomUUID);
  const reinstateKey = createModerationIdempotencyKey(randomUUID);

  assert.notEqual(disqualifyKey, laterDisqualifyKey);
  assert.notEqual(disqualifyKey, reinstateKey);
  assert.notEqual(laterDisqualifyKey, reinstateKey);
});

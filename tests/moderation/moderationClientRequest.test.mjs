import assert from "node:assert/strict";
import test from "node:test";
import {
  NETWORK_MODERATION_MESSAGE,
  STALE_MODERATION_MESSAGE,
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

function harness(fetcher) {
  const messages = [];
  let refreshes = 0;
  let requests = 0;
  return {
    messages,
    get refreshes() {
      return refreshes;
    },
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
        showMessage: (message) => messages.push(message),
        refresh: () => {
          refreshes += 1;
        },
      });
    },
  };
}

test("stale Disqualify and Reinstate show feedback, refresh, and never retry", async () => {
  for (const endpoint of [
    "/api/admin/disqualify",
    "/api/admin/reinstate",
  ]) {
    const client = harness(async () => response(409));

    assert.equal(await client.run(endpoint), "stale");
    assert.deepEqual(client.messages, [STALE_MODERATION_MESSAGE]);
    assert.equal(client.refreshes, 1);
    assert.equal(client.requests, 1);
  }
});

test("a successful mutation retains the full refresh convention", async () => {
  const client = harness(async () => response(200, { success: true }));

  assert.equal(await client.run(), "success");
  assert.deepEqual(client.messages, []);
  assert.equal(client.refreshes, 1);
  assert.equal(client.requests, 1);
});

test("403 and 503 remain visibly distinct from stale without refresh", async () => {
  for (const [status, outcome, message] of [
    [403, "forbidden", "Forbidden"],
    [503, "unavailable", "INTERNAL_ERROR"],
  ]) {
    const client = harness(async () => response(status, { error: message }));

    assert.equal(await client.run(), outcome);
    assert.deepEqual(client.messages, [message]);
    assert.equal(client.refreshes, 0);
    assert.equal(client.requests, 1);
  }
});

test("a network failure is controlled, does not refresh, and does not retry", async () => {
  const client = harness(async () => {
    throw new TypeError("socket and internal stack detail");
  });

  assert.equal(await client.run(), "network-error");
  assert.deepEqual(client.messages, [NETWORK_MODERATION_MESSAGE]);
  assert.equal(client.refreshes, 0);
  assert.equal(client.requests, 1);
  assert.doesNotMatch(client.messages[0], /socket|stack/u);
});

test("the synchronous pending guard prevents repeated submission", () => {
  const pending = { current: false };

  assert.equal(tryBeginModerationRequest(pending), true);
  assert.equal(tryBeginModerationRequest(pending), false);
  finishModerationRequest(pending);
  assert.equal(tryBeginModerationRequest(pending), true);
});

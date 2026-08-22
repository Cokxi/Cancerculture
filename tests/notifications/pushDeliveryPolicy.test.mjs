import assert from "node:assert/strict";
import test from "node:test";
import { classifyPushDeliveryError } from "../../lib/notifications/pushDeliveryPolicy.ts";

test("permanent provider expiry deactivates subscriptions", () => {
  for (const statusCode of [404, 410]) {
    assert.deepEqual(classifyPushDeliveryError({ statusCode }), {
      code: `provider_${statusCode}`,
      retryable: false,
      subscriptionInvalid: true,
    });
  }
});

test("transient provider failures retry while other failures terminate safely", () => {
  for (const statusCode of [408, 429, 500, 503]) {
    assert.deepEqual(classifyPushDeliveryError({ statusCode }), {
      code: `provider_${statusCode}`,
      retryable: true,
      subscriptionInvalid: false,
    });
  }
  assert.deepEqual(classifyPushDeliveryError({ statusCode: 400 }), {
    code: "provider_400",
    retryable: false,
    subscriptionInvalid: false,
  });
  assert.deepEqual(classifyPushDeliveryError(new Error("private provider detail")), {
    code: "delivery_failed",
    retryable: false,
    subscriptionInvalid: false,
  });
});

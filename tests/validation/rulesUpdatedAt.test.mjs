import assert from "node:assert/strict";
import test from "node:test";
import { formatRulesUpdatedAt } from "../../lib/content/rules/format.ts";

test("material Rules timestamps render deterministically in UTC", () => {
  assert.equal(
    formatRulesUpdatedAt("2026-08-04T19:42:00.000Z"),
    "04 Aug 2026, 19:42 UTC"
  );
});

test("invalid Rules timestamps fail closed", () => {
  assert.throws(
    () => formatRulesUpdatedAt("not-a-timestamp"),
    /Invalid Rules update timestamp/u
  );
});

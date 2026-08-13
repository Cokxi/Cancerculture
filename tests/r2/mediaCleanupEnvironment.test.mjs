import assert from "node:assert/strict";
import test from "node:test";
import {
  isMatchingMediaCleanupEnvironment,
  resolveWebsiteMediaCleanupEnvironment,
} from "../../lib/r2/mediaCleanupEnvironment.ts";

test("website cleanup environment derives only from the two canonical project refs", () => {
  assert.equal(
    resolveWebsiteMediaCleanupEnvironment(
      "https://gceljiuydyiwkomymuqh.supabase.co",
    ),
    "dev",
  );
  assert.equal(
    resolveWebsiteMediaCleanupEnvironment(
      "https://nrxfuvsfezfqcwfmpxxl.supabase.co",
    ),
    "live",
  );
  assert.equal(resolveWebsiteMediaCleanupEnvironment("http://127.0.0.1"), null);
  assert.equal(resolveWebsiteMediaCleanupEnvironment("not a url"), null);
});

test("DEV and LIVE trigger expectations fail closed on every mix-up", () => {
  assert.equal(
    isMatchingMediaCleanupEnvironment({ requested: "dev", website: "dev" }),
    true,
  );
  assert.equal(
    isMatchingMediaCleanupEnvironment({ requested: "live", website: "live" }),
    true,
  );
  for (const [requested, website] of [
    ["live", "dev"],
    ["dev", "live"],
    [null, "dev"],
    ["dev", null],
  ]) {
    assert.equal(isMatchingMediaCleanupEnvironment({ requested, website }), false);
  }
});

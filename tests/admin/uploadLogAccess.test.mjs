import assert from "node:assert/strict";
import test from "node:test";
import { getDelegatedUploadLogReason } from "../../lib/admin/uploadLogAccess.ts";

test("successful uploads expose no failure reason", () => {
  assert.equal(getDelegatedUploadLogReason("r2_provider_error", "success"), null);
});

test("delegated upload reasons preserve only bounded product categories", () => {
  const cases = new Map([
    ["banned", "access_denied"],
    ["rules_not_accepted", "access_denied"],
    ["upload_blocked_for_cycle", "upload_blocked"],
    ["cycle_not_open", "cycle_unavailable"],
    ["duplicate_submission", "submission_limit"],
    ["media_file_too_large", "validation_failed"],
    ["validation_failed", "validation_failed"],
    ["dependency_unavailable", "service_unavailable"],
    ["r2_provider_error", "service_unavailable"],
    ["upload_cleanup_pending", "service_unavailable"],
    ["internal_error", "upload_failed"],
    ["unexpected_database_detail", "upload_failed"],
  ]);

  for (const [reason, expected] of cases) {
    assert.equal(getDelegatedUploadLogReason(reason, "failed"), expected);
  }
});

test("missing and mixed-case raw reasons fail closed", () => {
  assert.equal(getDelegatedUploadLogReason(null, "failed"), "upload_failed");
  assert.equal(
    getDelegatedUploadLogReason(" R2_PROVIDER_ERROR ", "FAILED"),
    "service_unavailable"
  );
});

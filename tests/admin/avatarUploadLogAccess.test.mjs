import assert from "node:assert/strict";
import test from "node:test";
import { getDelegatedAvatarUploadLogReason } from "../../lib/admin/avatarUploadLogAccess.ts";

test("successful avatar uploads expose no failure reason", () => {
  assert.equal(
    getDelegatedAvatarUploadLogReason("r2_provider_error", "success"),
    null
  );
});

test("delegated avatar reasons preserve only bounded product categories", () => {
  const cases = new Map([
    ["cooldown", "cooldown_active"],
    ["missing_file", "invalid_request"],
    ["media_file_too_large", "validation_failed"],
    ["validation_failed", "validation_failed"],
    ["avatar_upload_dependency_unavailable", "service_unavailable"],
    ["r2_provider_error", "service_unavailable"],
    ["storage_write_failed", "service_unavailable"],
    ["database_update_failed", "service_unavailable"],
    ["internal_error", "upload_failed"],
  ]);

  for (const [reason, expected] of cases) {
    assert.equal(
      getDelegatedAvatarUploadLogReason(reason, "failed"),
      expected
    );
  }
});

test("missing and mixed-case avatar reasons fail closed", () => {
  assert.equal(
    getDelegatedAvatarUploadLogReason(null, "failed"),
    "upload_failed"
  );
  assert.equal(
    getDelegatedAvatarUploadLogReason(" R2_PROVIDER_ERROR ", "FAILED"),
    "service_unavailable"
  );
});

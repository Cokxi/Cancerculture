import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  routeSource,
  clientSource,
  sagaSource,
  adminSource,
  avatarSource,
  uploadLogSource,
  eligibilitySource,
] = await Promise.all([
  readFile(new URL("../../app/api/upload/route.ts", import.meta.url), "utf8"),
  readFile(
    new URL(
      "../../app/components/upload/DesktopUpload.tsx",
      import.meta.url
    ),
    "utf8"
  ),
  readFile(
    new URL("../../lib/upload/submissionUploadSaga.ts", import.meta.url),
    "utf8"
  ),
  readFile(
    new URL("../../app/api/admin/upload-blocks/route.ts", import.meta.url),
    "utf8"
  ),
  readFile(
    new URL("../../app/api/upload-avatar/route.ts", import.meta.url),
    "utf8"
  ),
  readFile(new URL("../../lib/logging/logUpload.ts", import.meta.url), "utf8"),
  readFile(
    new URL("../../lib/upload/getUploadEligibility.ts", import.meta.url),
    "utf8"
  ),
]);

test("upload route uses the durable saga and never performs direct cleanup deletes", () => {
  assert.match(routeSource, /reserveSubmissionUpload/);
  assert.match(routeSource, /markSubmissionUploadR2Uploaded/);
  assert.match(routeSource, /commitSubmissionUpload/);
  assert.match(routeSource, /compensateSubmissionUpload/);
  assert.doesNotMatch(routeSource, /DeleteObjectCommand/);
  assert.doesNotMatch(
    routeSource,
    /\.from\(["'](?:submissions|submission_private_data|submission_social_links)["']\)/
  );
});

test("client creates and retains a cryptographically random request key", () => {
  assert.match(clientSource, /crypto\.randomUUID\(\)/);
  assert.match(clientSource, /Idempotency-Key/);
  assert.match(clientSource, /uploadAttemptKeyRef/);
});

test("upload UI renders quota, cooldown and resets only the completed Submission form", () => {
  assert.match(clientSource, /quota\.used[\s\S]*quota\.limit/);
  assert.match(clientSource, /quota\.remaining/);
  assert.match(clientSource, /submissionCooldownRemaining/);
  assert.match(clientSource, /refreshedAfterCooldown/);
  assert.match(clientSource, /uploadAttemptKeyRef\.current = null/);
  assert.match(clientSource, /setFile\(null\)/);
  assert.doesNotMatch(clientSource, /forceSuccessState/);
});

test("authoritative upload responses drive cooldown and the existing exhausted-limit view without a browser reload", () => {
  const successBranch = clientSource.slice(
    clientSource.indexOf("const nextQuota ="),
    clientSource.indexOf("} catch {")
  );
  const limitBranch = clientSource.slice(
    clientSource.indexOf('data.error === "UPLOAD_LIMIT_REACHED"'),
    clientSource.indexOf(
      "\n  setTurnstileToken(null);",
      clientSource.indexOf('data.error === "UPLOAD_LIMIT_REACHED"')
    )
  );

  assert.ok(
    successBranch.indexOf("setSubmissionCooldownRemaining(") <
      successBranch.indexOf("router.refresh()")
  );
  assert.match(successBranch, /nextQuota\?\.remaining === 0[\s\S]*?"already"/);
  assert.match(limitBranch, /setSuccessMode\("already"\)/);
  assert.match(limitBranch, /router\.refresh\(\)/);
  assert.doesNotMatch(clientSource, /window\.location\.reload|location\.reload/);
});

test("completed replay bypasses early quota and cooldown while retaining the same fingerprint path", () => {
  assert.match(routeSource, /getCompletedSubmissionUploadOperation/);
  assert.match(routeSource, /!isCompletedReplay && uploadEligibility\.quota\?\.remaining === 0/);
  assert.match(routeSource, /!isCompletedReplay &&[\s\S]*?cooldownRemainingSeconds/);
  assert.match(sagaSource, /get_completed_submission_upload_operation/);
  assert.match(sagaSource, /p_session_id: sessionId/);
  assert.match(sagaSource, /p_idempotency_key: idempotencyKey/);
  assert.doesNotMatch(sagaSource, /\.from\("submission_upload_operations"\)/);
  assert.ok(routeSource.indexOf("req.formData()") < routeSource.indexOf("reserveSubmissionUpload({"));
});

test("compensation delegates only to the shared cleanup queue orchestrator", () => {
  assert.match(sagaSource, /enqueue_submission_upload_cleanup/);
  assert.match(sagaSource, /processR2CleanupQueue/);
  assert.doesNotMatch(sagaSource, /DeleteObjectCommand/);
});

test("blocked users are rejected before body parsing, decoding, intent and R2", () => {
  const blockCheck = routeSource.indexOf("abuseStatus.blocked");
  const formData = routeSource.indexOf("req.formData()");
  const decoder = routeSource.indexOf("processStaticImage(");
  const reserve = routeSource.indexOf("reserveSubmissionUpload(");
  const r2Put = routeSource.indexOf("new PutObjectCommand");
  assert.ok(blockCheck > -1);
  assert.ok(blockCheck < formData);
  assert.ok(formData < decoder);
  assert.ok(decoder < reserve);
  assert.ok(reserve < r2Put);
});

test("Turnstile is verified before upload body parsing and expensive work", () => {
  const turnstile = routeSource.indexOf("verifyTurnstileRequest(");
  const formData = routeSource.indexOf("req.formData()");
  const decoder = routeSource.indexOf("processStaticImage(");
  const reserve = routeSource.indexOf("reserveSubmissionUpload(");

  assert.ok(turnstile > -1);
  assert.ok(turnstile < formData);
  assert.ok(formData < decoder);
  assert.ok(decoder < reserve);
  const replayBranch = routeSource.slice(
    routeSource.indexOf("const isCompletedReplay"),
    routeSource.indexOf("const turnstileResult")
  );
  assert.doesNotMatch(replayBranch, /return[\s\S]*verifyTurnstileRequest/);
  assert.doesNotMatch(routeSource, /if \(!isCompletedReplay\) \{[\s\S]*verifyTurnstileRequest/);
});

test("quota and cooldown return before Turnstile, body decoding, image work and R2", () => {
  const quota = routeSource.indexOf("uploadEligibility.quota?.remaining === 0");
  const cooldown = routeSource.indexOf("cooldownRemainingSeconds ?? 0");
  const turnstile = routeSource.indexOf("verifyTurnstileRequest(");
  const formData = routeSource.indexOf("req.formData()");
  const decoder = routeSource.indexOf("processStaticImage(");
  const r2Put = routeSource.indexOf("new PutObjectCommand");

  assert.ok(quota > -1 && quota < turnstile);
  assert.ok(cooldown > quota && cooldown < turnstile);
  assert.ok(turnstile < formData);
  assert.ok(formData < decoder);
  assert.ok(decoder < r2Put);
  assert.match(routeSource, /status: 429/);
  assert.match(routeSource, /"Retry-After": String\(retryAfterSeconds\)/);
  assert.match(routeSource, /error: "UPLOAD_COOLDOWN_ACTIVE"/);
});

test("quota and upload-log dependency failures remain safely observable", () => {
  assert.match(eligibilitySource, /\[upload eligibility\]\[quota response\]/);
  assert.match(uploadLogSource, /const \{ error \} = await/);
  assert.match(uploadLogSource, /\[upload log\]\[insert\]/);
  assert.match(uploadLogSource, /error\.code/);
  assert.doesNotMatch(uploadLogSource, /console\.error\("\[UPLOAD LOG\]", error\)/);
});

test("route hashes and stores only canonical server-processed bytes", () => {
  assert.match(routeSource, /const webpBuffer = processedImage\.buffer/);
  assert.match(routeSource, /createSubmissionContentHash\(webpBuffer\)/);
  assert.match(routeSource, /Body: webpBuffer/);
});

test("Admin-only unblock requires a reason and delegates to the audited RPC", () => {
  assert.match(adminSource, /requireAdmin\(\)/);
  assert.match(adminSource, /if \(!discordUserId \|\| !Number\.isSafeInteger\(cycleId\) \|\| !reason\)/);
  assert.match(adminSource, /unblock_submission_upload/);
  assert.doesNotMatch(
    adminSource,
    /\.from\(["']submission_upload_abuse_states["']\)\s*\.update/
  );
});

test("local avatar uploads use the same server-only canonical media pipeline", () => {
  assert.match(avatarSource, /processStaticImage/);
  assert.match(avatarSource, /AVATAR_MEDIA_PROFILE/);
  assert.match(avatarSource, /ContentType: "image\/webp"/);
  assert.match(avatarSource, /\.webp`/);
});

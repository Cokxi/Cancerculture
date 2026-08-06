import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [routeSource, clientSource, sagaSource, adminSource, avatarSource] = await Promise.all([
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

test("only a completed operation with the same user request key passes the early duplicate check", () => {
  assert.match(routeSource, /hasCompletedSubmissionUploadOperation/);
  assert.match(routeSource, /alreadyUploaded && !isCompletedReplay/);
  assert.match(sagaSource, /\.eq\("discord_user_id", discordUserId\)/);
  assert.match(sagaSource, /\.eq\("idempotency_key", idempotencyKey\)/);
  assert.match(sagaSource, /\.eq\("status", "completed"\)/);
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

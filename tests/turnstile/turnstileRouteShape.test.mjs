import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [voteRoute, uploadRoute, verifier] = await Promise.all([
  readFile(new URL("../../app/api/vote/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../../app/api/upload/route.ts", import.meta.url), "utf8"),
  readFile(
    new URL("../../lib/turnstile/verify.server.ts", import.meta.url),
    "utf8"
  ),
]);

test("vote verifies after participation auth and before eligibility or vote writes", () => {
  const participation = voteRoute.indexOf("requireParticipation()");
  const verification = voteRoute.indexOf("verifyTurnstileRequest(");
  const eligibility = voteRoute.indexOf("getVoteEligibility(");
  const voteWrite = voteRoute.indexOf('rpc("cast_cycle_vote"');

  assert.ok(participation > -1);
  assert.ok(participation < verification);
  assert.ok(verification < eligibility);
  assert.ok(eligibility < voteWrite);
});

test("upload verifies after cheap access checks and before body or image work", () => {
  const accessCheck = uploadRoute.indexOf("uploadEligibility.isUploadBlocked");
  const verification = uploadRoute.indexOf("verifyTurnstileRequest(");
  const formData = uploadRoute.indexOf("req.formData()");
  const imageWork = uploadRoute.indexOf("processStaticImage(");

  assert.ok(accessCheck > -1);
  assert.ok(accessCheck < verification);
  assert.ok(verification < formData);
  assert.ok(formData < imageWork);
});

test("Turnstile rejection bypasses persistent vote and upload abuse logs", () => {
  const voteVerification = voteRoute.indexOf("verifyTurnstileRequest(");
  const firstVoteLog = voteRoute.indexOf("logVote({", voteVerification);
  const uploadVerification = uploadRoute.indexOf("verifyTurnstileRequest(");
  const nextUploadLog = uploadRoute.indexOf("failUpload({", uploadVerification);

  assert.ok(firstVoteLog > voteVerification);
  assert.ok(nextUploadLog === -1 || nextUploadLog > uploadVerification);
  assert.match(voteRoute, /turnstileResult\.status === "rejected"[\s\S]*?NextResponse\.json/);
  assert.match(uploadRoute, /turnstileResult\.status === "rejected"[\s\S]*?uploadJson/);
  assert.match(uploadRoute, /PRIVATE_UPLOAD_CACHE_CONTROL = "no-store, max-age=0"/);
});

test("Siteverify payload deliberately omits remote IP", () => {
  assert.doesNotMatch(verifier, /remoteip/);
});

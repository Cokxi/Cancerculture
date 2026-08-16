import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [service, statusRoute, http, mail, ui, securityPage, recoveryRoute] = await Promise.all([
  readFile(new URL("../../lib/twoFactor/service.server.ts", import.meta.url), "utf8"),
  readFile(new URL("../../app/api/account/two-factor/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../../lib/twoFactor/http.server.ts", import.meta.url), "utf8"),
  readFile(new URL("../../lib/twoFactor/mail.server.ts", import.meta.url), "utf8"),
  readFile(new URL("../../app/components/auth/TwoFactorSettings.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../app/settings/security/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../app/api/account/two-factor/email-recovery/route.ts", import.meta.url), "utf8"),
]);

test("browser status DTO is an explicit redacted projection", () => {
  const statusFunction = service.slice(
    service.indexOf("export async function getTwoFactorStatus"),
    service.indexOf("export async function beginTotpEnrollment")
  );
  assert.match(statusFunction, /maskRecoveryEmail/u);
  assert.match(statusFunction, /recoveryCodesRemaining/u);
  assert.doesNotMatch(statusFunction.slice(statusFunction.indexOf("return {")), /ciphertext|nonce|tag|manualKey|otpAuthUri/u);
  assert.doesNotMatch(statusRoute, /ciphertext|nonce|tag|secret|recoveryCodes/u);
});

test("one-time material only appears in controlled enrollment and activation responses", () => {
  assert.match(service, /qrCodeDataUrl: await createAuthenticatorQrCode\(otpAuthUri\)/u);
  assert.match(service, /manualKey: secret/u);
  assert.match(service, /recoveryCodes,/u);
  assert.match(ui, /This is the only time these codes are shown/u);
  assert.match(ui, /Hide codes permanently/u);
  assert.match(ui, /shown only for this pending enrollment/u);
  assert.doesNotMatch(mail, /otpauth:|qrCode|manualKey|TOTP secret:/u);
});

test("sensitive mutations require same-origin JSON and never log request bodies", () => {
  assert.match(http, /origin !== requestOrigin/u);
  assert.match(http, /contentType !== "application\/json"/u);
  assert.match(http, /contentLength > 16_384/u);
  assert.match(http, /"Cache-Control": "no-store, max-age=0"/u);
  assert.match(http, /"Referrer-Policy": "no-referrer"/u);
  assert.match(http, /console\.error\("\[2FA\] request failed", \{ code: "UNEXPECTED_ERROR" \}\)/u);
  assert.doesNotMatch(http, /console\.(?:log|error)\([^;]*(?:JSON\.stringify|request\.json|error\.message|error\.stack)/iu);
  assert.doesNotMatch(service, /console\./u);
});

test("Settings Hub exposes an extensible own-account two-factor category with explicit warnings", () => {
  assert.match(securityPage, /Security &amp; two-factor authentication/u);
  assert.match(securityPage, /<TwoFactorSettings/u);
  assert.match(ui, /support and administrators cannot restore or bypass this factor/u);
  assert.match(ui, /invalidates every older code immediately/u);
  assert.match(ui, /Recovery codes are entered directly on this CancerCulture page/u);
  assert.match(ui, /not accepted in the Team Area verification field/u);
  assert.match(ui, /recovery codes are not accepted/u);
});

test("email recovery is Turnstile-gated and never emails a QR code", () => {
  const turnstile = recoveryRoute.indexOf("verifyTurnstileRequest(");
  const session = recoveryRoute.indexOf("requireSession()", turnstile);
  const request = recoveryRoute.indexOf("await requestFactorRecoveryEmail", turnstile);
  assert.ok(turnstile > -1);
  assert.ok(request > turnstile);
  assert.ok(session > request);
  assert.match(recoveryRoute, /requestFactorRecoveryEmail\(await requireSession\(\)\)/u);
  assert.match(recoveryRoute, /TURNSTILE_ACTIONS\.twoFactorRecovery/u);
  assert.match(mail, /It does not contain a TOTP secret or QR code/u);
});

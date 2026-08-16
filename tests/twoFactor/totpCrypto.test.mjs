import assert from "node:assert/strict";
import test from "node:test";

process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
process.env.TOTP_HMAC_PEPPER = Buffer.alloc(32, 29).toString("base64");
process.env.TOTP_ENCRYPTION_KEY_VERSION = "7";

const {
  buildOtpAuthUri,
  decryptTwoFactorValue,
  digestEmailToken,
  digestEmailVerificationCode,
  digestRecoveryCode,
  encryptTwoFactorValue,
  findMatchingTotpStep,
  generateEmailToken,
  generateEmailVerificationCode,
  generateRecoveryCodes,
  maskRecoveryEmail,
  normalizeEmailVerificationCode,
} = await import("../../lib/twoFactor/crypto.server.ts");

test("standard SHA-1 TOTP matches RFC 6238-derived six-digit vectors", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(findMatchingTotpStep({ secret, code: "287082", nowMs: 59_000 }), 1);
  assert.equal(
    findMatchingTotpStep({ secret, code: "081804", nowMs: 1_111_111_109_000 }),
    37_037_036
  );
  assert.equal(findMatchingTotpStep({ secret, code: "000000", nowMs: 59_000 }), null);
});

test("TOTP secrets and recovery email values are authenticated-encrypted with purpose binding", () => {
  const encrypted = encryptTwoFactorValue(
    "JBSWY3DPEHPK3PXP",
    "totp-secret",
    "1234567890"
  );
  assert.equal(encrypted.keyVersion, 7);
  assert.doesNotMatch(JSON.stringify(encrypted), /JBSWY3DPEHPK3PXP/u);
  assert.equal(
    decryptTwoFactorValue(encrypted, "totp-secret", "1234567890"),
    "JBSWY3DPEHPK3PXP"
  );
  assert.throws(
    () => decryptTwoFactorValue(encrypted, "recovery-email", "1234567890"),
    /TWO_FACTOR_DECRYPTION_FAILED/u
  );
  assert.throws(
    () => decryptTwoFactorValue(encrypted, "totp-secret", "9999999999"),
    /TWO_FACTOR_DECRYPTION_FAILED/u
  );
});

test("recovery material is high-entropy, one-time shaped, and only keyed digests are stable", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^CC-(?:[A-Z2-7]{4}-){3}[A-Z2-7]{4}$/u);
  assert.equal(digestRecoveryCode(codes[0]), digestRecoveryCode(codes[0].toLowerCase()));
  assert.notEqual(digestRecoveryCode(codes[0]), digestRecoveryCode(codes[1]));

  const token = generateEmailToken();
  assert.ok(token.length >= 40);
  assert.match(digestEmailToken(token), /^[0-9a-f]{64}$/u);
  assert.equal(
    digestEmailToken(`${token.slice(0, 8)} \n${token.slice(8)}`),
    digestEmailToken(token)
  );
  assert.doesNotMatch(digestEmailToken(token), new RegExp(token, "u"));
});

test("backup email verification uses a copy-safe eight-digit code with normalized hashing", () => {
  const code = generateEmailVerificationCode();
  assert.match(code, /^\d{8}$/u);
  const formatted = `${code.slice(0, 4)} ${code.slice(4)}`;
  assert.equal(normalizeEmailVerificationCode(formatted), code);
  assert.equal(normalizeEmailVerificationCode(`${code.slice(0, 4)}-${code.slice(4)}`), code);
  assert.equal(digestEmailVerificationCode(formatted), digestEmailVerificationCode(code));
  assert.match(digestEmailVerificationCode(code), /^[0-9a-f]{64}$/u);
  assert.throws(
    () => digestEmailVerificationCode("1234567"),
    /EMAIL_VERIFICATION_CODE_INVALID/u
  );
});

test("Authenticator URI uses the interoperable Google Authenticator contract", () => {
  const uri = buildOtpAuthUri({
    secret: "JBSWY3DPEHPK3PXP",
    accountLabel: "Cancer member",
  });
  assert.match(uri, /^otpauth:\/\/totp\//u);
  assert.match(uri, /secret=JBSWY3DPEHPK3PXP/u);
  assert.match(uri, /issuer=CancerCulture/u);
  assert.match(uri, /algorithm=SHA1/u);
  assert.match(uri, /digits=6/u);
  assert.match(uri, /period=30/u);
  assert.equal(maskRecoveryEmail("Example.User@Mail.example"), "ex**********@m***.example");
});

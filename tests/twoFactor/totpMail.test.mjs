import assert from "node:assert/strict";
import test from "node:test";

process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
process.env.CLOUDFLARE_EMAIL_API_TOKEN = "test-api-token";
process.env.TWO_FACTOR_SECURITY_FROM_EMAIL = "security@cancerculture.fun";
process.env.TWO_FACTOR_SECURITY_REPLY_TO_EMAIL = "support@cancerculture.fun";

const { sendTwoFactorSecurityMail } = await import(
  "../../lib/twoFactor/mail.server.ts"
);

test("Cloudflare adapter keeps credentials in headers and sends only a one-time recovery token", async () => {
  let captured;
  const result = await sendTwoFactorSecurityMail(
    {
      kind: "factor_recovery",
      recipient: "owner@example.test",
      token: "opaque-one-time-token",
    },
    {
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return Response.json({
          success: true,
          result: {
            delivered: [],
            queued: ["owner@example.test"],
            permanent_bounces: [],
          },
        });
      },
    }
  );
  assert.equal(result.status, "sent");
  assert.equal(
    captured.url,
    "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/email/sending/send"
  );
  assert.equal(captured.init.headers.authorization, "Bearer test-api-token");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.from.address, "security@cancerculture.fun");
  assert.equal(body.reply_to.address, "support@cancerculture.fun");
  assert.equal(body.to[0], "owner@example.test");
  assert.match(body.text.replace(/\s/gu, ""), /opaque-one-time-token/u);
  assert.doesNotMatch(body.text, /otpauth:|QR code data|secret=/u);
  assert.doesNotMatch(captured.init.body, /test-api-token/u);
});

test("Cloudflare message id confirms provider acceptance without recipient arrays", async () => {
  const result = await sendTwoFactorSecurityMail(
    {
      kind: "verify_backup_email",
      recipient: "owner@example.test",
      token: "12345678",
    },
    {
      fetchImpl: async () => Response.json({
        success: true,
        result: {
          message_id: "accepted-message-id",
          delivered: [],
          queued: [],
          permanent_bounces: [],
        },
      }),
    }
  );
  assert.equal(result.status, "sent");
});

test("backup email code is rendered as one selectable eight-digit group", async () => {
  let body;
  await sendTwoFactorSecurityMail(
    {
      kind: "verify_backup_email",
      recipient: "owner@example.test",
      token: "12345678",
    },
    {
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body);
        return Response.json({
          success: true,
          result: {
            message_id: "accepted-message-id",
            permanent_bounces: [],
          },
        });
      },
    }
  );
  assert.match(body.text, /1234 5678/u);
  assert.match(body.text, /CancerCulture 2FA settings/u);
  assert.doesNotMatch(body.text, /CancerCulture profile/u);
  assert.match(body.html, /user-select: all/u);
  assert.doesNotMatch(body.subject, /1234|5678/u);
});

test("factor recovery token is grouped and selectable without reducing entropy", async () => {
  let body;
  await sendTwoFactorSecurityMail(
    {
      kind: "factor_recovery",
      recipient: "owner@example.test",
      token: "abcdefghijklmnopqrstuvwx",
    },
    {
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body);
        return Response.json({
          success: true,
          result: {
            message_id: "accepted-message-id",
            permanent_bounces: [],
          },
        });
      },
    }
  );
  assert.match(body.text, /abcdef ghijkl mnopqr stuvwx/u);
  assert.match(body.text, /CancerCulture 2FA settings/u);
  assert.doesNotMatch(body.text, /CancerCulture profile/u);
  assert.match(body.html, /user-select: all/u);
});

test("mail delivery fails closed when server configuration is missing", async () => {
  const apiToken = process.env.CLOUDFLARE_EMAIL_API_TOKEN;
  delete process.env.CLOUDFLARE_EMAIL_API_TOKEN;
  let contacted = false;
  const result = await sendTwoFactorSecurityMail(
    { kind: "factor_changed", recipient: "owner@example.test" },
    { fetchImpl: async () => { contacted = true; return new Response(null, { status: 200 }); } }
  );
  process.env.CLOUDFLARE_EMAIL_API_TOKEN = apiToken;
  assert.equal(result.status, "configuration_unavailable");
  assert.equal(contacted, false);
});

test("mail delivery fails closed for invalid sender configuration", async () => {
  const fromEmail = process.env.TWO_FACTOR_SECURITY_FROM_EMAIL;
  process.env.TWO_FACTOR_SECURITY_FROM_EMAIL = "other@cancerculture.fun";
  let contacted = false;
  const result = await sendTwoFactorSecurityMail(
    { kind: "factor_changed", recipient: "owner@example.test" },
    { fetchImpl: async () => { contacted = true; return new Response(null, { status: 200 }); } }
  );
  process.env.TWO_FACTOR_SECURITY_FROM_EMAIL = fromEmail;
  assert.equal(result.status, "configuration_unavailable");
  assert.equal(contacted, false);
});

test("mail delivery fails closed unless Cloudflare accepts the recipient", async () => {
  const result = await sendTwoFactorSecurityMail(
    { kind: "factor_changed", recipient: "owner@example.test" },
    {
      fetchImpl: async () => Response.json({
        success: true,
        result: {
          delivered: [],
          queued: [],
          permanent_bounces: ["owner@example.test"],
        },
      }),
    }
  );
  assert.equal(result.status, "provider_unavailable");
});

test("mail delivery fails closed for an invalid Cloudflare response", async () => {
  const result = await sendTwoFactorSecurityMail(
    { kind: "factor_changed", recipient: "owner@example.test" },
    { fetchImpl: async () => new Response("not-json", { status: 200 }) }
  );
  assert.equal(result.status, "provider_unavailable");
});

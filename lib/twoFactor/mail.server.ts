import "server-only";

const CLOUDFLARE_SEND_URL = "https://api.cloudflare.com/client/v4/accounts";
const SEND_TIMEOUT_MS = 5_000;
const SECURITY_FROM_EMAIL = "security@cancerculture.fun";
const SECURITY_REPLY_TO_EMAIL = "support@cancerculture.fun";
const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;

type SecurityMailKind =
  | "verify_backup_email"
  | "factor_recovery"
  | "factor_changed";

type SecurityMail = {
  kind: SecurityMailKind;
  recipient: string;
  token?: string;
};

type MailConfig = {
  accountId: string;
  apiToken: string;
};

function readMailConfig(): MailConfig | null {
  const accountId = process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_EMAIL_API_TOKEN?.trim();
  const fromEmail = process.env.TWO_FACTOR_SECURITY_FROM_EMAIL?.trim();
  const replyToEmail = process.env.TWO_FACTOR_SECURITY_REPLY_TO_EMAIL?.trim();
  if (
    !accountId ||
    !CLOUDFLARE_ACCOUNT_ID_PATTERN.test(accountId) ||
    !apiToken ||
    fromEmail !== SECURITY_FROM_EMAIL ||
    replyToEmail !== SECURITY_REPLY_TO_EMAIL
  ) {
    return null;
  }
  return { accountId, apiToken };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function deliveryWasAccepted(payload: unknown, recipient: string) {
  if (!payload || typeof payload !== "object") return false;
  const envelope = payload as Record<string, unknown>;
  if (
    envelope.success !== true ||
    !envelope.result ||
    typeof envelope.result !== "object"
  ) {
    return false;
  }
  const result = envelope.result as Record<string, unknown>;
  const messageId =
    typeof result.message_id === "string" ? result.message_id.trim() : "";
  const accepted = [
    ...stringArray(result.delivered),
    ...stringArray(result.queued),
  ];
  const permanentBounces = stringArray(result.permanent_bounces);
  const normalizedRecipient = recipient.toLowerCase();
  const recipientBounced = permanentBounces.some(
    (address) => address.toLowerCase() === normalizedRecipient
  );
  const recipientListed = accepted.some(
    (address) => address.toLowerCase() === normalizedRecipient
  );
  return !recipientBounced && (recipientListed || messageId.length > 0);
}

function formatVerificationCode(token: string) {
  return /^\d{8}$/u.test(token)
    ? `${token.slice(0, 4)} ${token.slice(4)}`
    : token;
}

function formatRecoveryToken(token: string) {
  return token.match(/.{1,6}/gu)?.join(" ") ?? token;
}

function contentFor(mail: SecurityMail) {
  if (mail.kind === "verify_backup_email") {
    if (!mail.token) throw new Error("SECURITY_MAIL_TOKEN_REQUIRED");
    const verificationCode = formatVerificationCode(mail.token);
    return {
      subject: "Verify your CancerCulture backup email",
      text: `Enter this one-time code in your CancerCulture 2FA settings to verify this backup email:\n\n${verificationCode}\n\nThe code expires in 15 minutes. CancerCulture support and administrators cannot use it for you. If you did not request this, do not share the code.`,
      html: `<p>Enter this one-time code in your CancerCulture 2FA settings to verify this backup email:</p><p style="font-size: 28px; font-weight: 700; letter-spacing: 0.12em; user-select: all; -webkit-user-select: all;"><code>${verificationCode}</code></p><p>The code expires in 15 minutes. CancerCulture support and administrators cannot use it for you. If you did not request this, do not share the code.</p>`,
    };
  }
  if (mail.kind === "factor_recovery") {
    if (!mail.token) throw new Error("SECURITY_MAIL_TOKEN_REQUIRED");
    const recoveryToken = formatRecoveryToken(mail.token);
    return {
      subject: "CancerCulture two-factor recovery",
      text: `Enter this one-time recovery code in your CancerCulture 2FA settings:\n\n${recoveryToken}\n\nThe code expires in 15 minutes and works only with your signed-in CancerCulture account. It does not contain a TOTP secret or QR code. If you did not request this, do not share the code.`,
      html: `<p>Enter this one-time recovery code in your CancerCulture 2FA settings:</p><p style="font-family: monospace; line-height: 1.7; overflow-wrap: anywhere; user-select: all; -webkit-user-select: all;"><code>${recoveryToken}</code></p><p>The code expires in 15 minutes and works only with your signed-in CancerCulture account. It does not contain a TOTP secret or QR code. If you did not request this, do not share the code.</p>`,
    };
  }
  return {
    subject: "Your CancerCulture two-factor factor changed",
    text: "Your CancerCulture two-factor authenticator was changed through the account recovery flow. Other website sessions were revoked. If this was not you, contact support immediately.",
    html: "<p>Your CancerCulture two-factor authenticator was changed through the account recovery flow. Other website sessions were revoked.</p><p>If this was not you, contact support immediately.</p>",
  };
}

export async function sendTwoFactorSecurityMail(
  mail: SecurityMail,
  options: { fetchImpl?: typeof fetch } = {}
) {
  const config = readMailConfig();
  if (!config) return { status: "configuration_unavailable" as const };
  const content = contentFor(mail);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${CLOUDFLARE_SEND_URL}/${config.accountId}/email/sending/send`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: {
            name: "CancerCulture Security",
            address: SECURITY_FROM_EMAIL,
          },
          reply_to: {
            name: "CancerCulture Support",
            address: SECURITY_REPLY_TO_EMAIL,
          },
          to: [mail.recipient],
          subject: content.subject,
          text: content.text,
          html: content.html,
        }),
        signal: controller.signal,
        cache: "no-store",
      }
    );
    if (!response.ok) {
      return {
        status: "provider_unavailable" as const,
        providerStatus: response.status,
      };
    }
    const payload = await response.json().catch(() => null);
    if (!deliveryWasAccepted(payload, mail.recipient)) {
      return {
        status: "provider_unavailable" as const,
        providerStatus: response.status,
      };
    }
    return { status: "sent" as const };
  } catch {
    return { status: "provider_unavailable" as const };
  } finally {
    clearTimeout(timeout);
  }
}

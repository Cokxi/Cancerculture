import "server-only";

import { randomUUID } from "node:crypto";
import { getTurnstileConfig } from "@/lib/turnstile/config.server";
import {
  TURNSTILE_TOKEN_HEADER,
  type TurnstileAction,
} from "@/lib/turnstile/shared";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2_048;
const VERIFY_TIMEOUT_MS = 4_000;
const MAX_ATTEMPTS = 2;

type SiteverifyPayload = {
  success?: unknown;
  action?: unknown;
  hostname?: unknown;
  challenge_ts?: unknown;
  "error-codes"?: unknown;
};

export type TurnstileVerificationResult =
  | { status: "verified" }
  | {
      status: "rejected";
      code: "TURNSTILE_REQUIRED" | "TURNSTILE_INVALID";
    }
  | {
      status: "configuration_error";
      code: "TURNSTILE_CONFIGURATION_ERROR";
    }
  | { status: "provider_unavailable" };

function getErrorCodes(payload: SiteverifyPayload) {
  return Array.isArray(payload["error-codes"])
    ? payload["error-codes"].filter(
        (value): value is string => typeof value === "string"
      )
    : [];
}

function isRetryablePayload(payload: SiteverifyPayload) {
  return getErrorCodes(payload).includes("internal-error");
}

function hasSecretConfigurationError(payload: SiteverifyPayload) {
  const errorCodes = getErrorCodes(payload);
  return (
    errorCodes.includes("missing-input-secret") ||
    errorCodes.includes("invalid-input-secret")
  );
}

export async function verifyTurnstileRequest(
  request: Request,
  expectedAction: TurnstileAction,
  options: {
    fetchImpl?: typeof fetch;
    maxTokenAgeMs?: number;
    now?: () => number;
  } = {}
): Promise<TurnstileVerificationResult> {
  const token = request.headers.get(TURNSTILE_TOKEN_HEADER)?.trim();

  if (!token) {
    return { status: "rejected", code: "TURNSTILE_REQUIRED" };
  }

  if (token.length > MAX_TOKEN_LENGTH) {
    return { status: "rejected", code: "TURNSTILE_INVALID" };
  }

  const config = getTurnstileConfig();
  if (!config.available) {
    return {
      status: "configuration_error",
      code: "TURNSTILE_CONFIGURATION_ERROR",
    };
  }

  // The public test widget proves the browser rendered the explicit
  // non-Production challenge. Production cannot resolve this mode, so local
  // tests stay deterministic without treating Cloudflare's test response as a
  // managed, action-bound attestation.
  if (
    config.mode === "test" &&
    process.env.TURNSTILE_MODE?.trim().toLowerCase() === "test"
  ) {
    return { status: "verified" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const idempotencyKey = randomUUID();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

    try {
      const response = await fetchImpl(SITEVERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: config.secretKey,
          response: token,
          idempotency_key: idempotencyKey,
        }),
        signal: controller.signal,
        cache: "no-store",
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return {
            status: "configuration_error",
            code: "TURNSTILE_CONFIGURATION_ERROR",
          };
        }

        if (response.status === 400) {
          return { status: "rejected", code: "TURNSTILE_INVALID" };
        }

        if (attempt + 1 < MAX_ATTEMPTS) continue;
        return { status: "provider_unavailable" };
      }

      let payload: SiteverifyPayload;
      try {
        payload = (await response.json()) as SiteverifyPayload;
      } catch {
        if (attempt + 1 < MAX_ATTEMPTS) continue;
        return { status: "provider_unavailable" };
      }

      if (payload.success !== true) {
        if (hasSecretConfigurationError(payload)) {
          return {
            status: "configuration_error",
            code: "TURNSTILE_CONFIGURATION_ERROR",
          };
        }

        if (isRetryablePayload(payload)) {
          if (attempt + 1 < MAX_ATTEMPTS) continue;
          return { status: "provider_unavailable" };
        }

        return { status: "rejected", code: "TURNSTILE_INVALID" };
      }

      if (payload.action !== expectedAction) {
        return { status: "rejected", code: "TURNSTILE_INVALID" };
      }

      if (
        config.mode === "managed" &&
        (typeof payload.hostname !== "string" ||
          !config.allowedHostnames.has(payload.hostname.toLowerCase()))
      ) {
        return { status: "rejected", code: "TURNSTILE_INVALID" };
      }

      if (options.maxTokenAgeMs !== undefined) {
        const challengeAt =
          typeof payload.challenge_ts === "string"
            ? Date.parse(payload.challenge_ts)
            : Number.NaN;
        const age = (options.now ?? Date.now)() - challengeAt;
        if (
          !Number.isFinite(options.maxTokenAgeMs) ||
          options.maxTokenAgeMs <= 0 ||
          !Number.isFinite(challengeAt) ||
          age < -30_000 ||
          age > options.maxTokenAgeMs
        ) {
          return { status: "rejected", code: "TURNSTILE_INVALID" };
        }
      }

      return { status: "verified" };
    } catch {
      if (attempt + 1 >= MAX_ATTEMPTS) {
        return { status: "provider_unavailable" };
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return { status: "provider_unavailable" };
}

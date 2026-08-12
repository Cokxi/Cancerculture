import type { SubmissionReportCreateInput } from "@/lib/reports/submissionReportContract";
import { TURNSTILE_TOKEN_HEADER } from "@/lib/turnstile/shared";

export const SUBMISSION_REPORT_CREATE_ENDPOINT = "/api/safety-feedback";

type CryptoProvider = Partial<
  Pick<Crypto, "getRandomValues" | "randomUUID">
>;

export class SubmissionReportClientError extends Error {
  constructor(code: "REPORT_CLIENT_UNAVAILABLE" | "REPORT_NETWORK_ERROR") {
    super(code);
    this.name = "SubmissionReportClientError";
  }
}

function formatUuidV4(bytes: Uint8Array) {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0")
  ).join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function createSubmissionReportIdempotencyKey(
  cryptoProvider: CryptoProvider | undefined = globalThis.crypto
) {
  if (!cryptoProvider) {
    throw new SubmissionReportClientError("REPORT_CLIENT_UNAVAILABLE");
  }

  if (typeof cryptoProvider.randomUUID === "function") {
    return cryptoProvider.randomUUID();
  }

  if (typeof cryptoProvider.getRandomValues !== "function") {
    throw new SubmissionReportClientError("REPORT_CLIENT_UNAVAILABLE");
  }

  return formatUuidV4(cryptoProvider.getRandomValues(new Uint8Array(16)));
}

export async function submitSubmissionReportFromClient(
  input: SubmissionReportCreateInput,
  turnstileToken: string,
  fetchImpl: typeof fetch = globalThis.fetch
) {
  let response: Response;

  try {
    response = await fetchImpl(SUBMISSION_REPORT_CREATE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TURNSTILE_TOKEN_HEADER]: turnstileToken,
      },
      body: JSON.stringify(input),
    });
  } catch {
    throw new SubmissionReportClientError("REPORT_NETWORK_ERROR");
  }

  const data = await response.json().catch(() => null);
  return { data, response };
}

import { createHash } from "node:crypto";
import { SUBMISSION_MEDIA_PROFILE } from "@/lib/media/profiles";

export const SUBMISSION_UPLOAD_IDEMPOTENCY_HEADER = "idempotency-key";
export const MAX_SUBMISSION_UPLOAD_SIZE =
  SUBMISSION_MEDIA_PROFILE.maxInputBytes;
export const ALLOWED_SUBMISSION_UPLOAD_TYPES =
  SUBMISSION_MEDIA_PROFILE.allowedBrowserMimeTypes;

export type SubmissionPayoutChoice = "keep" | "donate" | "split";

export type NormalizedSubmissionPrivateData = {
  walletAddress: string;
  payoutChoice: SubmissionPayoutChoice;
  splitPercent: number | null;
  charity: string | null;
};

export class SubmissionUploadRequestError extends Error {
  code: string;
  status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.name = "SubmissionUploadRequestError";
    this.code = code;
    this.status = status;
  }
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseSubmissionUploadIdempotencyKey(value: string | null) {
  const normalized = value?.trim() ?? "";

  if (!UUID_V4_PATTERN.test(normalized)) {
    throw new SubmissionUploadRequestError("INVALID_IDEMPOTENCY_KEY");
  }

  return normalized.toLowerCase();
}

export function normalizeSubmissionPrivateData(formData: FormData) {
  const walletAddress =
    formData.get("walletAddress")?.toString().trim() ?? "";
  const payoutChoiceValue =
    formData.get("payoutChoice")?.toString() ?? "";
  const splitPercentValue = formData.get("splitPercent")?.toString();
  const charityValue =
    formData.get("charity")?.toString().trim() ?? "";

  if (!(["keep", "donate", "split"] as string[]).includes(payoutChoiceValue)) {
    throw new SubmissionUploadRequestError("INVALID_PAYOUT_CHOICE", 422);
  }

  const payoutChoice = payoutChoiceValue as SubmissionPayoutChoice;
  const splitPercent = splitPercentValue
    ? Number.parseInt(splitPercentValue, 10)
    : null;
  const charity = charityValue || null;

  if (walletAddress.length > 512 || (charity?.length ?? 0) > 256) {
    throw new SubmissionUploadRequestError("INVALID_PRIVATE_DATA", 422);
  }

  if (payoutChoice === "keep" && !walletAddress) {
    throw new SubmissionUploadRequestError("WALLET_ADDRESS_REQUIRED", 422);
  }

  if (payoutChoice === "donate" && !charity) {
    throw new SubmissionUploadRequestError("CHARITY_REQUIRED", 422);
  }

  if (
    payoutChoice === "split" &&
    (!walletAddress ||
      !charity ||
      splitPercent === null ||
      splitPercent <= 0 ||
      splitPercent >= 100)
  ) {
    throw new SubmissionUploadRequestError("INVALID_SPLIT", 422);
  }

  return {
    walletAddress: payoutChoice === "donate" ? "" : walletAddress,
    payoutChoice,
    splitPercent: payoutChoice === "split" ? splitPercent : null,
    charity:
      payoutChoice === "donate" || payoutChoice === "split"
        ? charity
        : null,
  } satisfies NormalizedSubmissionPrivateData;
}

export function createSubmissionUploadFingerprint({
  contentSha256,
  privateData,
}: {
  contentSha256: string;
  privateData: NormalizedSubmissionPrivateData;
}) {
  const canonicalPayload = JSON.stringify({
    charity: privateData.charity,
    contentSha256,
    payoutChoice: privateData.payoutChoice,
    splitPercent: privateData.splitPercent,
    walletAddress: privateData.walletAddress,
  });

  return createHash("sha256").update(canonicalPayload).digest("hex");
}

export function createSubmissionContentHash(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

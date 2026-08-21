import { createHash } from "node:crypto";
import { SUBMISSION_MEDIA_PROFILE } from "@/lib/media/profiles";
import { validateSolRecipientAddress } from "@/lib/solana/address";
import {
  normalizeOrganizationName,
  normalizeSafePublicHttpsUrl,
} from "@/lib/organizations/urlValidation";
import type { SubmissionOrganizationSelection } from "@/lib/organizations/types";

export const SUBMISSION_UPLOAD_IDEMPOTENCY_HEADER = "idempotency-key";
export const MAX_SUBMISSION_UPLOAD_SIZE =
  SUBMISSION_MEDIA_PROFILE.maxInputBytes;
export const ALLOWED_SUBMISSION_UPLOAD_TYPES =
  SUBMISSION_MEDIA_PROFILE.allowedBrowserMimeTypes;

export type SubmissionPayoutChoice = "keep" | "donate" | "split";
export type SubmissionWalletSource = "manual" | "profile" | "none";

export type NormalizedSubmissionPrivateData = {
  walletSource: SubmissionWalletSource;
  manualWalletAddress: string | null;
  profileWalletVersion: number | null;
  payoutChoice: SubmissionPayoutChoice;
  splitPercent: number | null;
  charity: string | null;
  organizationSelection: SubmissionOrganizationSelection | null;
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
  const rawWalletAddress =
    formData.get("walletAddress")?.toString().trim() ?? "";
  const walletSourceValue =
    formData.get("walletSource")?.toString().trim() ?? "";
  const profileWalletVersionValue =
    formData.get("profileWalletVersion")?.toString().trim() ?? "";
  const payoutChoiceValue =
    formData.get("payoutChoice")?.toString() ?? "";
  const splitPercentValue = formData.get("splitPercent")?.toString();
  const charityValue =
    formData.get("charity")?.toString().trim() ?? "";
  const organizationSourceValue =
    formData.get("organizationSource")?.toString().trim() ?? "";
  const organizationPublicKey =
    formData.get("organizationPublicKey")?.toString().trim() ?? "";
  const otherOrganizationName =
    formData.get("otherOrganizationName")?.toString() ?? "";
  const otherOrganizationWebsiteUrl =
    formData.get("otherOrganizationWebsiteUrl")?.toString() ?? "";

  if (!(["keep", "donate", "split"] as string[]).includes(payoutChoiceValue)) {
    throw new SubmissionUploadRequestError("INVALID_PAYOUT_CHOICE", 422);
  }

  const payoutChoice = payoutChoiceValue as SubmissionPayoutChoice;
  const walletSource = walletSourceValue as SubmissionWalletSource;
  const splitPercent = splitPercentValue
    ? Number.parseInt(splitPercentValue, 10)
    : null;
  const profileWalletVersion = profileWalletVersionValue
    ? Number.parseInt(profileWalletVersionValue, 10)
    : null;
  const charity = charityValue || null;
  let organizationSelection: SubmissionOrganizationSelection | null = null;

  if (payoutChoice !== "keep") {
    if (
      organizationSourceValue === "catalog" &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(organizationPublicKey) &&
      organizationPublicKey.length <= 80 &&
      charity
    ) {
      organizationSelection = Object.freeze({
        sourceType: "catalog",
        publicKey: organizationPublicKey,
        otherName: null,
        otherWebsiteUrl: null,
      });
    } else if (organizationSourceValue === "other") {
      try {
        organizationSelection = Object.freeze({
          sourceType: "other",
          publicKey: null,
          otherName: normalizeOrganizationName(otherOrganizationName),
          otherWebsiteUrl: normalizeSafePublicHttpsUrl(
            otherOrganizationWebsiteUrl
          ),
        });
      } catch {
        throw new SubmissionUploadRequestError(
          "OTHER_ORGANIZATION_DETAILS_INVALID",
          422
        );
      }
    } else {
      throw new SubmissionUploadRequestError(
        "ORGANIZATION_SELECTION_INVALID",
        422
      );
    }
  }

  if (rawWalletAddress.length > 512 || (charity?.length ?? 0) > 256) {
    throw new SubmissionUploadRequestError("INVALID_PRIVATE_DATA", 422);
  }

  if (
    payoutChoice === "donate" &&
    (walletSource !== "none" ||
      rawWalletAddress !== "" ||
      profileWalletVersion !== null ||
      !charity ||
      organizationSelection === null)
  ) {
    throw new SubmissionUploadRequestError("CHARITY_REQUIRED", 422);
  }

  if (
    payoutChoice === "split" &&
    (!charity ||
      organizationSelection === null ||
      splitPercent === null ||
      splitPercent <= 0 ||
      splitPercent >= 100)
  ) {
    throw new SubmissionUploadRequestError("INVALID_SPLIT", 422);
  }

  if (payoutChoice === "keep" && charity !== null) {
    throw new SubmissionUploadRequestError("INVALID_PRIVATE_DATA", 422);
  }

  let manualWalletAddress: string | null = null;
  if (payoutChoice !== "donate") {
    if (walletSource === "manual") {
      if (profileWalletVersion !== null) {
        throw new SubmissionUploadRequestError("INVALID_PRIVATE_DATA", 422);
      }
      const validation = validateSolRecipientAddress(rawWalletAddress);
      if (!validation.ok) {
        throw new SubmissionUploadRequestError("WALLET_ADDRESS_INVALID", 422);
      }
      manualWalletAddress = validation.address;
    } else if (walletSource === "profile") {
      if (
        rawWalletAddress !== "" ||
        profileWalletVersion === null ||
        !Number.isSafeInteger(profileWalletVersion) ||
        profileWalletVersion <= 0
      ) {
        throw new SubmissionUploadRequestError("INVALID_PRIVATE_DATA", 422);
      }
    } else {
      throw new SubmissionUploadRequestError("WALLET_ADDRESS_REQUIRED", 422);
    }
  }

  return {
    walletSource: payoutChoice === "donate" ? "none" : walletSource,
    manualWalletAddress,
    profileWalletVersion:
      payoutChoice !== "donate" && walletSource === "profile"
        ? profileWalletVersion
        : null,
    payoutChoice,
    splitPercent: payoutChoice === "split" ? splitPercent : null,
    charity:
      payoutChoice === "donate" || payoutChoice === "split"
        ? charity
        : null,
    organizationSelection:
      payoutChoice === "donate" || payoutChoice === "split"
        ? organizationSelection
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
    manualWalletAddress: privateData.manualWalletAddress,
    payoutChoice: privateData.payoutChoice,
    profileWalletVersion: privateData.profileWalletVersion,
    splitPercent: privateData.splitPercent,
    walletSource: privateData.walletSource,
    organizationSelection: privateData.organizationSelection,
  });

  return createHash("sha256").update(canonicalPayload).digest("hex");
}

export function createSubmissionContentHash(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

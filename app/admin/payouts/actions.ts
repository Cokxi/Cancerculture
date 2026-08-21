"use server";

import { revalidatePath } from "next/cache";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { parsePositiveInteger, requireUuid } from "@/lib/payouts/amount";
import { getTeamPayoutContext, managePayoutPlan, preparePayoutPlan, recordPayoutTransaction } from "@/lib/payouts/service.server";
import { parseSolanaTransactionReference, verifyMainnetPayoutTransaction } from "@/lib/solana/payoutVerification.server";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { processStaticImage } from "@/lib/media/processStaticImage";
import { PAYOUT_EVIDENCE_MEDIA_PROFILE } from "@/lib/media/profiles";
import { r2 } from "@/lib/r2";
import { attachPayoutPrivateEvidence } from "@/lib/payouts/service.server";

function value(data: FormData, key: string) { return data.get(key); }
function textValue(data: FormData, key: string) { const raw = value(data, key); return typeof raw === "string" ? raw.trim() : ""; }
function refresh() { revalidatePath("/"); revalidatePath("/admin/payouts"); revalidatePath("/admin/payout-logs"); }

export async function preparePayoutAction(formData: FormData) {
  const authorization = await requireDynamicTeamCapability("winners.manage_payouts");
  await preparePayoutPlan(authorization.discord_user_id, {
    requestId: requireUuid(value(formData, "request_id")), allocationPublicId: requireUuid(value(formData, "allocation_public_id")),
    expectedClaimVersion: parsePositiveInteger(value(formData, "expected_claim_version")),
  });
  refresh();
}

export async function managePayoutPlanAction(formData: FormData) {
  const authorization = await requireDynamicTeamCapability("winners.manage_payouts");
  const operation = textValue(formData, "operation");
  const payload: Record<string, unknown> = {};
  for (const key of ["linePublicId", "recipient", "reason", "pollPublicId", "optionMappings", "expectedPollVersion"]) {
    const raw = textValue(formData, key);
    if (raw) payload[key] = key === "optionMappings" ? JSON.parse(raw) : raw;
  }
  await managePayoutPlan(authorization.discord_user_id, {
    requestId: requireUuid(value(formData, "request_id")), planPublicId: requireUuid(value(formData, "plan_public_id")),
    expectedPlanVersion: parsePositiveInteger(value(formData, "expected_plan_version")), operation, payload,
  });
  refresh();
}

type ContextPlan = { planPublicId?: unknown; lines?: unknown };
type ContextLine = { linePublicId?: unknown; rowVersion?: unknown; recipient?: unknown; amountLamports?: unknown; lineKind?: unknown };

export async function recordPayoutTransactionAction(formData: FormData) {
  const authorization = await requireDynamicTeamCapability("winners.manage_payouts");
  const linePublicId = requireUuid(value(formData, "line_public_id"));
  const context = await getTeamPayoutContext(authorization.discord_user_id, true);
  const lines = context.plans.flatMap((plan) => Array.isArray((plan as ContextPlan).lines) ? (plan as ContextPlan).lines as ContextLine[] : []);
  const line = lines.find((candidate) => candidate.linePublicId === linePublicId);
  if (!line || typeof line.recipient !== "string" || typeof line.amountLamports !== "string" || !/^[0-9]+$/.test(line.amountLamports)) throw new Error("PAYOUT_LINE_UNAVAILABLE");
  const reference = parseSolanaTransactionReference(value(formData, "transaction_reference"));
  const evidenceLevel = textValue(formData, "evidence_level");
  let verification = { verified: false, slot: null as number | null, recipient: line.recipient, lamports: BigInt(line.amountLamports) };
  if (evidenceLevel === "on_chain_verified") {
    verification = await verifyMainnetPayoutTransaction({ signature: reference.signature, expectedRecipient: line.recipient, expectedLamports: BigInt(line.amountLamports) });
    if (!verification.verified) throw new Error("PAYOUT_VERIFICATION_MISMATCH");
  } else if (evidenceLevel !== "operator_confirmed_provider" || line.lineKind !== "donation") {
    throw new Error("PAYOUT_EVIDENCE_LEVEL_INVALID");
  }
  await recordPayoutTransaction(authorization.discord_user_id, {
    requestId: requireUuid(value(formData, "request_id")), linePublicId,
    expectedLineVersion: parsePositiveInteger(value(formData, "expected_line_version")), signature: reference.signature,
    evidenceLevel, providerReference: textValue(formData, "provider_reference") || null,
    verificationSlot: verification.slot, verifiedMainnet: verification.verified, verifiedSuccess: verification.verified,
    verifiedRecipient: verification.verified ? verification.recipient : null,
    verifiedLamports: verification.verified ? verification.lamports : null,
  });
  refresh();
}

export async function attachPayoutEvidenceAction(formData: FormData) {
  const authorization = await requireDynamicTeamCapability("winners.manage_payouts");
  const bucket = process.env.R2_PAYOUT_EVIDENCE_BUCKET_NAME?.trim();
  if (!bucket) throw new Error("PAYOUT_PRIVATE_STORAGE_UNAVAILABLE");
  const file = value(formData, "evidence");
  if (!(file instanceof File) || file.size === 0) throw new Error("PAYOUT_EVIDENCE_REQUIRED");
  const processed = await processStaticImage({ input: Buffer.from(await file.arrayBuffer()), claimedMimeType: file.type, profile: PAYOUT_EVIDENCE_MEDIA_PROFILE });
  const key = `payout-evidence/${crypto.randomUUID()}.webp`;
  await r2.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: processed.buffer, ContentType: "image/webp", CacheControl: "private, no-store" }));
  try {
    await attachPayoutPrivateEvidence(authorization.discord_user_id, {
      requestId: requireUuid(value(formData, "request_id")), transactionPublicId: requireUuid(value(formData, "transaction_public_id")),
      r2Key: key, byteSize: processed.buffer.byteLength, width: processed.width, height: processed.height,
    });
  } catch (error) {
    await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
    throw error;
  }
  refresh();
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { PAYOUT_EVIDENCE_MEDIA_PROFILE } from "@/lib/media/profiles";
import { processStaticImage } from "@/lib/media/processStaticImage";
import { parsePositiveInteger, requireUuid } from "@/lib/payouts/amount";
import { completeAndPublishPayout, getSimpleTeamPayouts, PayoutError } from "@/lib/payouts/service.server";
import { r2 } from "@/lib/r2";
import { validateSolRecipientAddress } from "@/lib/solana/address";
import { inspectMainnetPayoutTransaction, parseSolanaTransactionReference } from "@/lib/solana/payoutVerification.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

type Row = Record<string, unknown>;
type VerifiedTransaction = Readonly<{
  signature: string;
  slot: number;
  recipient: string;
  lamports: string;
}>;
type AmountCheck = Readonly<{
  expectedLamports: string;
  actualLamports: string;
  differenceLamports: string;
  status: "exact" | "underpaid" | "overpaid";
}>;

const MAX_TRANSACTIONS_PER_LINE = 10;

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function jsonRow(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function transactionReferences(formData: FormData, key: string) {
  const references = formData.getAll(key)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseSolanaTransactionReference(value));
  if (references.length === 0 || references.length > MAX_TRANSACTIONS_PER_LINE) {
    throw new Error(`Enter between 1 and ${MAX_TRANSACTIONS_PER_LINE} transactions.`);
  }
  if (new Set(references.map((reference) => reference.signature)).size !== references.length) {
    throw new Error("The same transaction was entered more than once.");
  }
  return references;
}

async function verifyTransactions(
  formData: FormData,
  key: string,
  expectedRecipient: string,
  label: "winner" | "donation"
) {
  const references = transactionReferences(formData, key);
  const inspected = await Promise.all(references.map(async ({ signature }) => {
    const verified = await inspectMainnetPayoutTransaction({ signature, expectedRecipient });
    if (!verified.verified || !verified.slot) {
      throw new Error(`A ${label} transaction is not finalized, failed, or does not pay the exact wallet.`);
    }
    return {
      signature,
      slot: verified.slot,
      recipient: verified.recipient,
      lamports: verified.lamports.toString(),
    } satisfies VerifiedTransaction;
  }));
  return inspected;
}

function checkAmount(expected: bigint, transactions: readonly VerifiedTransaction[]): AmountCheck {
  const actual = transactions.reduce((sum, transaction) => sum + BigInt(transaction.lamports), BigInt(0));
  return {
    expectedLamports: expected.toString(),
    actualLamports: actual.toString(),
    differenceLamports: (actual >= expected ? actual - expected : expected - actual).toString(),
    status: actual === expected ? "exact" : actual < expected ? "underpaid" : "overpaid",
  };
}

function validPublicReason(reason: string) {
  return reason.length >= 3 && reason.length <= 500;
}

export async function POST(request: Request, context: { params: Promise<{ allocationId: string }> }) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  let uploadedKey: string | null = null;
  try {
    const authorization = await requireDynamicTeamCapability("winners.manage_payouts");
    const { allocationId: rawAllocationId } = await context.params;
    const allocationId = requireUuid(rawAllocationId);
    const formData = await request.formData();
    const requestId = requireUuid(text(formData, "requestId"));
    const expectedClaimVersion = parsePositiveInteger(text(formData, "expectedClaimVersion"));
    const contextData = await getSimpleTeamPayouts(authorization.discord_user_id, true);
    const item = contextData.items.find((candidate) => candidate.allocationPublicId === allocationId);
    if (!item || Number(item.claimVersion) !== expectedClaimVersion) throw new Error("This payout changed. Refresh the page and check it again.");

    const winnerLamports = typeof item.winnerLamports === "string" && /^[0-9]+$/u.test(item.winnerLamports) ? BigInt(item.winnerLamports) : null;
    const donationLamports = typeof item.donationLamports === "string" && /^[0-9]+$/u.test(item.donationLamports) ? BigInt(item.donationLamports) : null;
    if (winnerLamports === null || donationLamports === null) throw new Error("The server-calculated payout amounts are unavailable.");

    let winnerTransactions: VerifiedTransaction[] = [];
    let winnerRecipient: string | null = null;
    let winnerAmountCheck: AmountCheck | null = null;
    if (winnerLamports > BigInt(0)) {
      winnerRecipient = typeof item.winnerRecipient === "string" ? item.winnerRecipient : null;
      if (!winnerRecipient) throw new Error("The winner has not confirmed a wallet yet.");
      winnerTransactions = await verifyTransactions(formData, "winnerTransaction", winnerRecipient, "winner");
      winnerAmountCheck = checkAmount(winnerLamports, winnerTransactions);
    }

    let donationTransactions: VerifiedTransaction[] = [];
    let donationRecipient: string | null = null;
    let donationAmountCheck: AmountCheck | null = null;
    if (donationLamports > BigInt(0)) {
      donationRecipient = text(formData, "donationWallet");
      const validRecipient = validateSolRecipientAddress(donationRecipient);
      if (!validRecipient.ok) throw new Error("The donation operation wallet is not a valid Solana address.");
      donationRecipient = validRecipient.address;
      donationTransactions = await verifyTransactions(formData, "donationTransaction", donationRecipient, "donation");
      donationAmountCheck = checkAmount(donationLamports, donationTransactions);
    }

    const signatures = [...winnerTransactions, ...donationTransactions].map((transaction) => transaction.signature);
    if (new Set(signatures).size !== signatures.length) {
      throw new Error("Winner and donation must use separate transactions.");
    }

    const winnerOverpaymentConfirmed = text(formData, "winnerOverpaymentConfirmed") === "true";
    const donationOverpaymentConfirmed = text(formData, "donationOverpaymentConfirmed") === "true";
    const winnerOverpaymentReason = text(formData, "winnerOverpaymentReason");
    const donationOverpaymentReason = text(formData, "donationOverpaymentReason");
    const amountChecks = { winner: winnerAmountCheck, donation: donationAmountCheck };
    const hasUnderpayment = [winnerAmountCheck, donationAmountCheck].some((check) => check?.status === "underpaid");
    const winnerOverpaymentPending = winnerAmountCheck?.status === "overpaid" &&
      (!winnerOverpaymentConfirmed || !validPublicReason(winnerOverpaymentReason));
    const donationOverpaymentPending = donationAmountCheck?.status === "overpaid" &&
      (!donationOverpaymentConfirmed || !validPublicReason(donationOverpaymentReason));
    if (hasUnderpayment || winnerOverpaymentPending || donationOverpaymentPending) {
      return NextResponse.json({
        error: hasUnderpayment
          ? "The verified transactions do not yet cover the complete payout. Add the remaining transaction and check again."
          : "Confirm the overpayment and enter a clear public reason before publishing.",
        verification: amountChecks,
      }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
    }
    if ((winnerAmountCheck?.status !== "overpaid" && (winnerOverpaymentConfirmed || winnerOverpaymentReason)) ||
      (donationAmountCheck?.status !== "overpaid" && (donationOverpaymentConfirmed || donationOverpaymentReason))) {
      throw new Error("Overpayment confirmation is only allowed when the verified total is higher than the payout amount.");
    }

    const receipt = formData.get("receipt");
    let receiptByteSize: number | null = null;
    let receiptWidth: number | null = null;
    let receiptHeight: number | null = null;
    const receiptPublicApproved = text(formData, "receiptPublicApproved") === "true";
    if (receipt instanceof File && receipt.size > 0) {
      if (donationLamports === BigInt(0)) throw new Error("A receipt can only be attached to a donation.");
      const bucket = process.env.R2_PAYOUT_EVIDENCE_BUCKET_NAME?.trim();
      if (!bucket) throw new Error("Receipt storage is not configured yet. Save the payout without a receipt or configure the private evidence bucket first.");
      const processed = await processStaticImage({ input: Buffer.from(await receipt.arrayBuffer()), claimedMimeType: receipt.type, profile: PAYOUT_EVIDENCE_MEDIA_PROFILE });
      uploadedKey = `payout-evidence/${requestId}.webp`;
      await r2.send(new PutObjectCommand({ Bucket: bucket, Key: uploadedKey, Body: processed.buffer, ContentType: "image/webp", CacheControl: receiptPublicApproved ? "public, max-age=31536000, immutable" : "private, no-store" }));
      receiptByteSize = processed.buffer.byteLength;
      receiptWidth = processed.width;
      receiptHeight = processed.height;
    } else if (receiptPublicApproved) {
      throw new Error("Select a receipt before approving it for public display.");
    }

    const result = await completeAndPublishPayout(authorization.discord_user_id, {
      requestId,
      allocationPublicId: allocationId,
      expectedClaimVersion,
      donationOperationRecipient: donationRecipient,
      winnerTransactions,
      winnerOverpaymentConfirmed,
      winnerOverpaymentReason: winnerAmountCheck?.status === "overpaid" ? winnerOverpaymentReason : null,
      donationTransactions,
      donationOverpaymentConfirmed,
      donationOverpaymentReason: donationAmountCheck?.status === "overpaid" ? donationOverpaymentReason : null,
      receiptR2Key: uploadedKey,
      receiptByteSize,
      receiptWidth,
      receiptHeight,
      receiptPublicApproved,
    });
    uploadedKey = null;
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (uploadedKey) {
      const bucket = process.env.R2_PAYOUT_EVIDENCE_BUCKET_NAME?.trim();
      if (bucket) await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: uploadedKey })).catch(() => undefined);
    }
    const status = error instanceof PayoutError ? error.status : 400;
    const errorRow = jsonRow(error);
    const message = error instanceof Error ? error.message : typeof errorRow.code === "string" ? errorRow.code : "Payout could not be published.";
    return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}

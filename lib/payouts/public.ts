export type PublicPayoutTransaction = Readonly<{
  signature: string;
  canonicalExplorerUrl: string;
  verifiedLamports: string;
}>;

export type PublicPayoutDetails = Readonly<{
  state: "paid" | "claim_expired" | "claim_declined" | "donation_change_required" | "donation_review_pending" | "donation_change_expired" | "payout_disqualified";
  payoutChoice: "keep" | "split" | "donate";
  splitPercent: number | null;
  grossLamports: string;
  winnerLamports: string;
  donationLamports: string;
  claimStatus: string;
  winnerRecipient: string | null;
  winnerTransactionUrl: string | null;
  winnerTransactionSignature: string | null;
  winnerTransactions: readonly PublicPayoutTransaction[];
  winnerPaidLamports: string | null;
  winnerOverpaymentReason: string | null;
  organizationName: string | null;
  organizationWebsiteUrl: string | null;
  donationRecipient: string | null;
  donationTransactionUrl: string | null;
  donationTransactionSignature: string | null;
  donationTransactions: readonly PublicPayoutTransaction[];
  donationPaidLamports: string | null;
  donationOverpaymentReason: string | null;
  receiptPublicId: string | null;
  publicReason: string | null;
  publishedAt: string | null;
}>;

const STATES = new Set<PublicPayoutDetails["state"]>(["paid", "claim_expired", "claim_declined", "donation_change_required", "donation_review_pending", "donation_change_expired", "payout_disqualified"]);
const CHOICES = new Set<PublicPayoutDetails["payoutChoice"]>(["keep", "split", "donate"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function nullableString(value: unknown, maximum = 500) {
  return value === null || value === undefined
    ? null
    : typeof value === "string" && value.length <= maximum ? value : undefined;
}

function safePublicUrl(value: unknown, kind: "https" | "solana") {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    if (kind === "solana" && url.hostname !== "explorer.solana.com") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function payoutTransactions(value: unknown) {
  if (!Array.isArray(value) || value.length > 10) return undefined;
  const parsed: PublicPayoutTransaction[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const item = candidate as Record<string, unknown>;
    const signature = nullableString(item.signature, 100);
    const canonicalExplorerUrl = safePublicUrl(item.canonicalExplorerUrl, "solana");
    const verifiedLamports = nullableString(item.verifiedLamports, 30);
    if (!signature || !canonicalExplorerUrl || !verifiedLamports || !/^[0-9]+$/u.test(verifiedLamports)) return undefined;
    parsed.push(Object.freeze({ signature, canonicalExplorerUrl, verifiedLamports }));
  }
  return Object.freeze(parsed);
}

export function parsePublicPayoutDetails(value: unknown): PublicPayoutDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const state = item.state;
  const payoutChoice = item.payoutChoice;
  if (typeof state !== "string" || !STATES.has(state as PublicPayoutDetails["state"]) || typeof payoutChoice !== "string" || !CHOICES.has(payoutChoice as PublicPayoutDetails["payoutChoice"])) return null;
  for (const key of ["grossLamports", "winnerLamports", "donationLamports"] as const) {
    if (typeof item[key] !== "string" || !/^[0-9]+$/u.test(item[key])) return null;
  }
  const splitPercent = item.splitPercent === null || item.splitPercent === undefined ? null : Number(item.splitPercent);
  if (splitPercent !== null && (!Number.isInteger(splitPercent) || splitPercent < 0 || splitPercent > 100)) return null;
  const winnerTransactionUrl = safePublicUrl(item.winnerTransactionUrl, "solana");
  const donationTransactionUrl = safePublicUrl(item.donationTransactionUrl, "solana");
  const winnerTransactions = payoutTransactions(item.winnerTransactions ?? []);
  const donationTransactions = payoutTransactions(item.donationTransactions ?? []);
  const organizationWebsiteUrl = safePublicUrl(item.organizationWebsiteUrl, "https");
  const receiptPublicId = nullableString(item.receiptPublicId, 36);
  if (winnerTransactionUrl === undefined || donationTransactionUrl === undefined || winnerTransactions === undefined || donationTransactions === undefined || organizationWebsiteUrl === undefined || receiptPublicId === undefined || (receiptPublicId !== null && !UUID.test(receiptPublicId))) return null;
  const strings = {
    claimStatus: nullableString(item.claimStatus, 40),
    winnerRecipient: nullableString(item.winnerRecipient, 64),
    winnerTransactionSignature: nullableString(item.winnerTransactionSignature, 100),
    winnerPaidLamports: nullableString(item.winnerPaidLamports, 30),
    winnerOverpaymentReason: nullableString(item.winnerOverpaymentReason, 500),
    organizationName: nullableString(item.organizationName, 160),
    donationRecipient: nullableString(item.donationRecipient, 64),
    donationTransactionSignature: nullableString(item.donationTransactionSignature, 100),
    donationPaidLamports: nullableString(item.donationPaidLamports, 30),
    donationOverpaymentReason: nullableString(item.donationOverpaymentReason, 500),
    publicReason: nullableString(item.publicReason, 500),
    publishedAt: nullableString(item.publishedAt, 50),
  };
  if (Object.values(strings).some((entry) => entry === undefined) || strings.claimStatus === null ||
    (typeof strings.winnerPaidLamports === "string" && !/^[0-9]+$/u.test(strings.winnerPaidLamports)) ||
    (typeof strings.donationPaidLamports === "string" && !/^[0-9]+$/u.test(strings.donationPaidLamports))) return null;
  return Object.freeze({
    state: state as PublicPayoutDetails["state"],
    payoutChoice: payoutChoice as PublicPayoutDetails["payoutChoice"],
    splitPercent,
    grossLamports: item.grossLamports as string,
    winnerLamports: item.winnerLamports as string,
    donationLamports: item.donationLamports as string,
    claimStatus: strings.claimStatus as string,
    winnerRecipient: strings.winnerRecipient as string | null,
    winnerTransactionUrl,
    winnerTransactionSignature: strings.winnerTransactionSignature as string | null,
    winnerTransactions,
    winnerPaidLamports: strings.winnerPaidLamports as string | null,
    winnerOverpaymentReason: strings.winnerOverpaymentReason as string | null,
    organizationName: strings.organizationName as string | null,
    organizationWebsiteUrl,
    donationRecipient: strings.donationRecipient as string | null,
    donationTransactionUrl,
    donationTransactionSignature: strings.donationTransactionSignature as string | null,
    donationTransactions,
    donationPaidLamports: strings.donationPaidLamports as string | null,
    donationOverpaymentReason: strings.donationOverpaymentReason as string | null,
    receiptPublicId,
    publicReason: strings.publicReason as string | null,
    publishedAt: strings.publishedAt as string | null,
  });
}

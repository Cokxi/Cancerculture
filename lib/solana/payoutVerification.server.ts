import "server-only";

import { decodeBase58, validateSolRecipientAddress } from "@/lib/solana/address";

const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{80,100}$/;
const EXPLORER_HOSTS = new Set(["explorer.solana.com", "solscan.io", "solana.fm"]);

export function parseSolanaTransactionReference(input: unknown) {
  if (typeof input !== "string") throw new Error("PAYOUT_SIGNATURE_INVALID");
  let candidate = input.trim();
  if (/^https:\/\//i.test(candidate)) {
    let url: URL;
    try { url = new URL(candidate); } catch { throw new Error("PAYOUT_SIGNATURE_INVALID"); }
    if (!EXPLORER_HOSTS.has(url.hostname.toLowerCase())) throw new Error("PAYOUT_EXPLORER_INVALID");
    const segments = url.pathname.split("/").filter(Boolean);
    const txIndex = segments.findIndex((segment) => segment === "tx");
    candidate = txIndex >= 0 ? segments[txIndex + 1] ?? "" : segments[0] ?? "";
  }
  const decoded = SIGNATURE_PATTERN.test(candidate) ? decodeBase58(candidate) : null;
  if (!decoded || decoded.length !== 64) throw new Error("PAYOUT_SIGNATURE_INVALID");
  return {
    signature: candidate,
    canonicalExplorerUrl: `https://explorer.solana.com/tx/${candidate}?cluster=mainnet-beta`,
  };
}

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function transferFromInstruction(value: unknown) {
  const instruction = objectValue(value);
  const parsed = objectValue(instruction.parsed);
  const info = objectValue(parsed.info);
  const destination = typeof info.destination === "string" ? info.destination : null;
  const lamports = typeof info.lamports === "number" && Number.isSafeInteger(info.lamports)
    ? BigInt(info.lamports)
    : typeof info.lamports === "string" && /^[0-9]+$/.test(info.lamports) ? BigInt(info.lamports) : null;
  return parsed.type === "transfer" && destination && lamports !== null ? { destination, lamports } : null;
}

export async function inspectMainnetPayoutTransaction(input: {
  signature: string;
  expectedRecipient: string;
}) {
  const address = validateSolRecipientAddress(input.expectedRecipient);
  if (!address.ok) throw new Error("PAYOUT_RECIPIENT_INVALID");
  const endpoint = process.env.SOLANA_MAINNET_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [input.signature, { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }] }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("PAYOUT_CHAIN_UNAVAILABLE");
  const payload = objectValue(await response.json());
  const result = objectValue(payload.result);
  const meta = objectValue(result.meta);
  const transaction = objectValue(result.transaction);
  const message = objectValue(transaction.message);
  const outer = Array.isArray(message.instructions) ? message.instructions : [];
  const innerGroups = Array.isArray(meta.innerInstructions) ? meta.innerInstructions : [];
  const inner = innerGroups.flatMap((group) => {
    const instructions = objectValue(group).instructions;
    return Array.isArray(instructions) ? instructions : [];
  });
  const matchingLamports = [...outer, ...inner]
    .map(transferFromInstruction)
    .filter((transfer): transfer is { destination: string; lamports: bigint } => Boolean(transfer))
    .filter((transfer) => transfer.destination === address.address)
    .reduce((total, transfer) => total + transfer.lamports, BigInt(0));
  const slot = typeof result.slot === "number" && Number.isSafeInteger(result.slot) ? result.slot : null;
  return {
    verified: payload.error === undefined && result.transaction !== undefined && meta.err === null && slot !== null && slot > 0 && matchingLamports > BigInt(0),
    slot,
    recipient: address.address,
    lamports: matchingLamports,
  };
}

export async function verifyMainnetPayoutTransaction(input: {
  signature: string;
  expectedRecipient: string;
  expectedLamports: bigint;
}) {
  const inspected = await inspectMainnetPayoutTransaction(input);
  return {
    ...inspected,
    verified: inspected.verified && inspected.lamports === input.expectedLamports,
  };
}

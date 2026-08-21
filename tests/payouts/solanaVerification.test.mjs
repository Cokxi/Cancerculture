import assert from "node:assert/strict";
import test from "node:test";
import { inspectMainnetPayoutTransaction, parseSolanaTransactionReference, verifyMainnetPayoutTransaction } from "../../lib/solana/payoutVerification.server.ts";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(bytes) {
  let value = BigInt(0); for (const byte of bytes) value = value * BigInt(256) + BigInt(byte);
  let encoded = ""; while (value > BigInt(0)) { encoded = alphabet[Number(value % BigInt(58))] + encoded; value /= BigInt(58); }
  for (const byte of bytes) { if (byte !== 0) break; encoded = `1${encoded}`; }
  return encoded || "1";
}

const signature = encodeBase58(Uint8Array.from({ length: 64 }, (_, index) => index + 1));
const recipient = encodeBase58(Uint8Array.from({ length: 32 }, (_, index) => index + 17));

test("known explorer links and raw signatures normalize to one canonical Mainnet link", () => {
  const raw = parseSolanaTransactionReference(signature);
  const explorer = parseSolanaTransactionReference(`https://solscan.io/tx/${signature}?cluster=mainnet`);
  assert.deepEqual(explorer, raw);
  assert.equal(raw.canonicalExplorerUrl, `https://explorer.solana.com/tx/${signature}?cluster=mainnet-beta`);
  assert.throws(() => parseSolanaTransactionReference(`https://example.test/tx/${signature}`), /PAYOUT_EXPLORER_INVALID/u);
  assert.throws(() => parseSolanaTransactionReference("not-a-signature"), /PAYOUT_SIGNATURE_INVALID/u);
});

test("Mainnet verification proves success, exact recipient, and exact Lamports only", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", result: { slot: 123, meta: { err: null, innerInstructions: [] }, transaction: { message: { instructions: [{ parsed: { type: "transfer", info: { destination: recipient, lamports: 12345 } } }] } } } }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const exact = await verifyMainnetPayoutTransaction({ signature, expectedRecipient: recipient, expectedLamports: BigInt(12345) });
    const wrongAmount = await verifyMainnetPayoutTransaction({ signature, expectedRecipient: recipient, expectedLamports: BigInt(12346) });
    const inspected = await inspectMainnetPayoutTransaction({ signature, expectedRecipient: recipient });
    assert.equal(exact.verified, true); assert.equal(exact.slot, 123); assert.equal(exact.lamports.toString(), "12345");
    assert.equal(wrongAmount.verified, false);
    assert.equal(inspected.verified, true); assert.equal(inspected.lamports.toString(), "12345");
  } finally { globalThis.fetch = originalFetch; }
});

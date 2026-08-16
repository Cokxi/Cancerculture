import assert from "node:assert/strict";
import test from "node:test";
import { validateSolRecipientAddress } from "../../lib/solana/address.ts";

test("canonical SOL recipients decode from Base58 to exactly 32 non-zero bytes", () => {
  for (const address of [
    "So11111111111111111111111111111111111111112",
    "Vote111111111111111111111111111111111111111",
  ]) {
    assert.deepEqual(validateSolRecipientAddress(address), {
      ok: true,
      address,
    });
  }
});

test("address normalization is shared and only removes surrounding whitespace", () => {
  const address = "So11111111111111111111111111111111111111112";
  assert.deepEqual(validateSolRecipientAddress(`  ${address}\r\n`), {
    ok: true,
    address,
  });
});

test("invalid alphabet, byte length, and the all-zero system address fail closed", () => {
  assert.equal(validateSolRecipientAddress("").error, "required");
  assert.equal(validateSolRecipientAddress("not-a-sol-address").error, "invalid_length");
  assert.equal(
    validateSolRecipientAddress("0oIl1111111111111111111111111111111111111111").error,
    "invalid_base58"
  );
  assert.equal(
    validateSolRecipientAddress("111111111111111111111111111111111").error,
    "invalid_length"
  );
  assert.equal(
    validateSolRecipientAddress("11111111111111111111111111111111").error,
    "unsuitable_recipient"
  );
});

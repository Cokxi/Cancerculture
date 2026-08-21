import assert from "node:assert/strict";
import test from "node:test";
import { formatLamportsAsSol, parseSolToLamports } from "../../lib/payouts/amount.ts";

test("SOL amounts round-trip through exact Lamports without floating point", () => {
  for (const [sol, lamports] of [["1", "1000000000"], ["0.000000001", "1"], ["12.345678901", "12345678901"]]) {
    assert.equal(parseSolToLamports(sol).toString(), lamports);
    assert.equal(formatLamportsAsSol(lamports), sol);
  }
});

test("invalid, zero, negative, scientific, and over-precision amounts fail closed", () => {
  for (const value of ["", "0", "-1", "1e-9", "0.0000000001", "01", "NaN"]) {
    assert.throws(() => parseSolToLamports(value), /PAYOUT_AMOUNT_INVALID/u);
  }
});

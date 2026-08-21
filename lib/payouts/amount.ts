export const LAMPORTS_PER_SOL = BigInt(1_000_000_000);

export function parseSolToLamports(input: unknown): bigint {
  if (typeof input !== "string") throw new Error("PAYOUT_AMOUNT_INVALID");
  const value = input.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(value)) {
    throw new Error("PAYOUT_AMOUNT_INVALID");
  }
  const [whole, fraction = ""] = value.split(".");
  const lamports = BigInt(whole) * LAMPORTS_PER_SOL + BigInt(fraction.padEnd(9, "0"));
  if (lamports <= BigInt(0) || lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("PAYOUT_AMOUNT_INVALID");
  }
  return lamports;
}

export function formatLamportsAsSol(input: string | bigint): string {
  const lamports = typeof input === "bigint" ? input : BigInt(input);
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function parsePositiveInteger(input: unknown, code = "PAYOUT_INPUT_INVALID") {
  if (typeof input !== "string" || !/^[1-9][0-9]*$/.test(input.trim())) {
    throw new Error(code);
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value)) throw new Error(code);
  return value;
}

export function parseNonnegativeInteger(input: unknown, code = "PAYOUT_INPUT_INVALID") {
  if (typeof input !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(input.trim())) throw new Error(code);
  const value = Number(input);
  if (!Number.isSafeInteger(value)) throw new Error(code);
  return value;
}

export function requireUuid(input: unknown, code = "PAYOUT_INPUT_INVALID") {
  if (
    typeof input !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  ) {
    throw new Error(code);
  }
  return input.toLowerCase();
}

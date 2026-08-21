const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const BASE58_VALUES = new Map(
  Array.from(BASE58_ALPHABET, (character, index) => [character, index] as const)
);

export type SolRecipientAddressError =
  | "required"
  | "invalid_base58"
  | "invalid_length"
  | "unsuitable_recipient";

export type SolRecipientAddressResult =
  | { ok: true; address: string }
  | { ok: false; error: SolRecipientAddressError };

export function decodeBase58(value: string) {
  const bytes = [0];
  let leadingZeroes = 0;

  while (leadingZeroes < value.length && value[leadingZeroes] === "1") {
    leadingZeroes += 1;
  }

  for (const character of value) {
    const digit = BASE58_VALUES.get(character);
    if (digit === undefined) return null;

    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const significantLength =
    bytes.length === 1 && bytes[0] === 0 ? 0 : bytes.length;
  const decoded = new Uint8Array(leadingZeroes + significantLength);
  for (let index = 0; index < significantLength; index += 1) {
    decoded[decoded.length - 1 - index] = bytes[index];
  }
  return decoded;
}

export function validateSolRecipientAddress(
  input: string
): SolRecipientAddressResult {
  const address = input.trim();
  if (!address) return { ok: false, error: "required" };
  if (address.length < 32 || address.length > 44) {
    return { ok: false, error: "invalid_length" };
  }

  const decoded = decodeBase58(address);
  if (!decoded) return { ok: false, error: "invalid_base58" };
  if (decoded.length !== 32) {
    return { ok: false, error: "invalid_length" };
  }
  if (decoded.every((byte) => byte === 0)) {
    return { ok: false, error: "unsuitable_recipient" };
  }

  return { ok: true, address };
}

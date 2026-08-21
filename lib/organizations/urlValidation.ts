const PRIVATE_IPV4_RANGES = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^(?:22[4-9]|23\d|24\d|25[0-5])\./,
] as const;

const INTERNAL_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
] as const;

export function normalizeSafePublicHttpsUrl(
  value: unknown,
  options?: { optional?: false }
): string;
export function normalizeSafePublicHttpsUrl(
  value: unknown,
  options: { optional: true }
): string | null;
export function normalizeSafePublicHttpsUrl(
  value: unknown,
  { optional = false }: { optional?: boolean } = {}
) {
  if (typeof value !== "string") {
    if (optional && (value === null || value === undefined)) return null;
    throw new Error("A public HTTPS URL is required");
  }

  const input = value.trim();
  if (optional && input === "") return null;
  if (input.length < 12 || input.length > 600 || /[\s\u0000-\u001f]/u.test(input)) {
    throw new Error("The URL length or format is invalid");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a valid public HTTPS URL");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    hostname === "localhost" ||
    !hostname.includes(".") ||
    INTERNAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    PRIVATE_IPV4_RANGES.some((pattern) => pattern.test(hostname)) ||
    hostname.includes(":")
  ) {
    throw new Error("The URL must use a public HTTPS host without credentials or a private address");
  }

  url.hostname = hostname;
  if (url.port === "443") url.port = "";
  url.hash = "";
  return url.toString();
}

export function normalizeOrganizationName(
  value: unknown,
  { maximum = 120 }: { maximum?: number } = {}
) {
  if (typeof value !== "string") throw new Error("Organization name is required");
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length < 2 || normalized.length > maximum) {
    throw new Error(`Organization name must be between 2 and ${maximum} characters`);
  }
  return normalized;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ENCODED_UNSAFE_SEPARATOR_OR_CONTROL =
  /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i;

export function getValidatedApplicationOrigin(
  configuredBaseUrl: string | undefined
): URL {
  if (!configuredBaseUrl?.trim()) {
    throw new Error("Application base URL is not configured");
  }

  let parsed: URL;

  try {
    parsed = new URL(configuredBaseUrl);
  } catch {
    throw new Error("Application base URL is invalid");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Application base URL is invalid");
  }

  return new URL(parsed.origin);
}

function hasUnsafeDecodedForm(value: string) {
  let decoded = value;

  for (let pass = 0; pass < 2; pass += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return true;
    }

    if (
      CONTROL_CHARACTERS.test(decoded) ||
      decoded.includes("\\") ||
      decoded.startsWith("//") ||
      ENCODED_UNSAFE_SEPARATOR_OR_CONTROL.test(decoded)
    ) {
      return true;
    }
  }

  return false;
}

export function sanitizeInternalReturnPath(
  value: string | null | undefined,
  applicationOrigin: URL
): string {
  if (
    !value ||
    value !== value.trim() ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    CONTROL_CHARACTERS.test(value) ||
    ENCODED_UNSAFE_SEPARATOR_OR_CONTROL.test(value) ||
    hasUnsafeDecodedForm(value)
  ) {
    return "/";
  }

  try {
    const resolved = new URL(value, applicationOrigin);

    if (resolved.origin !== applicationOrigin.origin) {
      return "/";
    }

    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/";
  }
}

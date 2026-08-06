import "server-only";

const TEST_SITE_KEY = "1x00000000000000000000AA";
const TEST_SECRET_KEY = "1x0000000000000000000000000000000AA";

type TurnstileConfig =
  | {
      available: true;
      mode: "test";
      siteKey: string;
      secretKey: string;
      allowedHostnames: null;
    }
  | {
      available: true;
      mode: "managed";
      siteKey: string;
      secretKey: string;
      allowedHostnames: ReadonlySet<string>;
    }
  | {
      available: false;
      reason: "invalid_mode" | "missing_configuration" | "unsafe_test_configuration";
    };

function readEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function parseAllowedHostnames(value: string | null) {
  if (!value) return new Set<string>();

  return new Set(
    value
      .split(",")
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function getTurnstileConfig(): TurnstileConfig {
  const configuredMode = readEnv("TURNSTILE_MODE");
  const mode =
    configuredMode ?? (process.env.NODE_ENV === "production" ? null : "test");

  if (mode === "test") {
    if (process.env.NODE_ENV === "production") {
      return { available: false, reason: "unsafe_test_configuration" };
    }

    return {
      available: true,
      mode: "test",
      siteKey: TEST_SITE_KEY,
      secretKey: TEST_SECRET_KEY,
      allowedHostnames: null,
    };
  }

  if (mode !== "managed") {
    return {
      available: false,
      reason: mode === null ? "missing_configuration" : "invalid_mode",
    };
  }

  const siteKey = readEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY");
  const secretKey = readEnv("TURNSTILE_SECRET_KEY");
  const allowedHostnames = parseAllowedHostnames(
    readEnv("TURNSTILE_ALLOWED_HOSTNAMES")
  );

  if (!siteKey || !secretKey || allowedHostnames.size === 0) {
    return { available: false, reason: "missing_configuration" };
  }

  if (siteKey === TEST_SITE_KEY || secretKey === TEST_SECRET_KEY) {
    return { available: false, reason: "unsafe_test_configuration" };
  }

  return {
    available: true,
    mode: "managed",
    siteKey,
    secretKey,
    allowedHostnames,
  };
}

export function getTurnstileClientSiteKey() {
  const config = getTurnstileConfig();
  return config.available ? config.siteKey : null;
}

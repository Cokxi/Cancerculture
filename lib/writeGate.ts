export const WRITE_GATE_RETRY_AFTER_SECONDS = 300;

export const WRITE_GATE_MODES = ["open", "drain", "closed"] as const;

export type WriteGateMode = (typeof WRITE_GATE_MODES)[number];

type ResolveWriteGateModeInput = {
  configuredMode: string | null | undefined;
  nodeEnvironment: string | null | undefined;
};

type WriteGateRequestInput = {
  mode: WriteGateMode;
  method: string;
  pathname: string;
  hasWebsiteSession: boolean;
};

export type WriteGateDecision =
  | { allowed: true; reason: "open" | "public_read" | "drain" }
  | {
      allowed: false;
      reason:
        | "closed_method"
        | "closed_session"
        | "closed_path"
        | "drain_path";
    };

const PUBLIC_PAGE_PATTERNS = [
  /^\/$/u,
  /^\/503$/u,
  /^\/cycle-history$/u,
  /^\/faq$/u,
  /^\/profile\/[0-9a-f-]{36}$/iu,
  /^\/rules$/u,
  /^\/spread(?:\/[1-9][0-9]*)?$/u,
  /^\/submissions$/u,
  /^\/wall\/(?:fame|shame)$/u,
] as const;

const PUBLIC_API_PATTERNS = [
  /^\/api\/community-feed$/u,
  /^\/api\/community-feed\/cycles$/u,
  /^\/api\/community-feed\/(?:detail\/)?media\/[1-9][0-9]*$/u,
  /^\/api\/community-feed\/sponsor\/(?:banner|presentation)\/[1-9][0-9]*$/u,
  /^\/api\/cycle-history(?:\/[1-9][0-9]*)?$/u,
  /^\/api\/sponsor\/banner$/u,
  /^\/api\/vote\/submissions$/u,
  /^\/api\/wall\/(?:fame|shame)$/u,
  /^\/profile\/[0-9a-f-]{36}\/avatar$/iu,
] as const;

const STATIC_PATH_PATTERNS = [
  /^\/_next\/(?:image|static)(?:\/|$)/u,
  /^\/icons\/(?:apple-touch-icon|pwa-icon-(?:192|512|maskable-512))[.]png$/u,
  /^\/icons\/pwa-icon[.]svg$/u,
  /^\/(?:file|globe|next|vercel|window)[.]svg$/u,
  /^\/(?:favicon[.]ico|manifest[.]webmanifest|robots[.]txt|sitemap[.]xml|sw[.]js)$/u,
] as const;

const DRAIN_PATHS = new Map<string, ReadonlySet<string>>([
  ["/api/internal/discord/health", new Set(["GET", "HEAD"])],
  ["/api/internal/media-cleanup/process-due", new Set(["POST"])],
]);

function normalizedPathname(pathname: string) {
  if (!pathname.startsWith("/")) return "/__invalid__";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function matchesAny(pathname: string, patterns: readonly RegExp[]) {
  return patterns.some((pattern) => pattern.test(pathname));
}

export function resolveWriteGateMode({
  configuredMode,
  nodeEnvironment,
}: ResolveWriteGateModeInput): WriteGateMode {
  const normalized = configuredMode?.trim().toLowerCase();
  if (WRITE_GATE_MODES.includes(normalized as WriteGateMode)) {
    return normalized as WriteGateMode;
  }

  return nodeEnvironment === "production" ? "closed" : "open";
}

export function isAnonymousPublicReadPath(pathname: string) {
  const normalized = normalizedPathname(pathname);
  return (
    matchesAny(normalized, PUBLIC_PAGE_PATTERNS) ||
    matchesAny(normalized, PUBLIC_API_PATTERNS) ||
    matchesAny(normalized, STATIC_PATH_PATTERNS)
  );
}

export function isDrainRequest(method: string, pathname: string) {
  const allowedMethods = DRAIN_PATHS.get(normalizedPathname(pathname));
  return allowedMethods?.has(method.toUpperCase()) ?? false;
}

export function evaluateWriteGateRequest({
  mode,
  method,
  pathname,
  hasWebsiteSession,
}: WriteGateRequestInput): WriteGateDecision {
  if (mode === "open") return { allowed: true, reason: "open" };

  const normalizedMethod = method.toUpperCase();
  if (mode === "drain") {
    return isDrainRequest(normalizedMethod, pathname)
      ? { allowed: true, reason: "drain" }
      : { allowed: false, reason: "drain_path" };
  }

  if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") {
    return { allowed: false, reason: "closed_method" };
  }
  if (hasWebsiteSession) {
    return { allowed: false, reason: "closed_session" };
  }
  if (!isAnonymousPublicReadPath(pathname)) {
    return { allowed: false, reason: "closed_path" };
  }

  return { allowed: true, reason: "public_read" };
}

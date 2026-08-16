import "server-only";

import { isIP } from "node:net";

type HeaderReader = Pick<Headers, "get">;

function browserFamily(userAgent: string) {
  const value = userAgent.toLowerCase();
  if (value.includes("edg/")) return "edge";
  if (value.includes("opr/") || value.includes("opera")) return "opera";
  if (value.includes("firefox/") || value.includes("fxios/")) return "firefox";
  if (value.includes("chrome/") || value.includes("crios/")) return "chrome";
  if (value.includes("safari/")) return "safari";
  return "other";
}

function platformFamily(userAgent: string) {
  const value = userAgent.toLowerCase();
  if (value.includes("android")) return "android";
  if (value.includes("iphone") || value.includes("ipad")) return "ios";
  if (value.includes("windows")) return "windows";
  if (value.includes("mac os") || value.includes("macintosh")) return "macos";
  if (value.includes("linux")) return "linux";
  return "other";
}

function normalizeIpCandidate(value: string | null) {
  const candidate = value?.split(",", 1)[0]?.trim() ?? "";
  if (candidate.startsWith("[") && candidate.includes("]")) {
    return candidate.slice(1, candidate.indexOf("]"));
  }
  if (isIP(candidate)) return candidate;
  const ipv4WithPort = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/u)?.[1];
  return ipv4WithPort && isIP(ipv4WithPort) ? ipv4WithPort : "";
}

function networkPrefix(ip: string) {
  const version = isIP(ip);
  if (version === 4) {
    return `v4:${ip.split(".").slice(0, 3).join(".")}`;
  }
  if (version === 6) {
    const expanded = ip.toLowerCase().split("::", 2);
    const left = expanded[0] ? expanded[0].split(":") : [];
    const right = expanded[1] ? expanded[1].split(":") : [];
    const missing = Math.max(0, 8 - left.length - right.length);
    const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right]
      .map((group) => group.padStart(4, "0"));
    return `v6:${groups.slice(0, 3).join(":")}`;
  }
  return "unavailable";
}

export function buildCoarseTeamSecurityContext(
  requestHeaders: HeaderReader,
  { allowMissingNetwork = process.env.NODE_ENV !== "production" } = {}
) {
  const userAgent = requestHeaders.get("user-agent")?.trim() ?? "";
  const trustedNetworkValue =
    requestHeaders.get("x-vercel-forwarded-for") ??
    requestHeaders.get("x-forwarded-for") ??
    requestHeaders.get("x-real-ip");
  const network = networkPrefix(normalizeIpCandidate(trustedNetworkValue));
  if (network === "unavailable" && !allowMissingNetwork) {
    throw new Error("TEAM_SECURITY_CONTEXT_UNAVAILABLE");
  }
  return [
    "v1",
    `network=${network}`,
    `browser=${browserFamily(userAgent)}`,
    `platform=${platformFamily(userAgent)}`,
  ].join("|");
}

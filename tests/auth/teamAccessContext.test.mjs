import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCoarseTeamSecurityContext } from "../../lib/auth/teamAccessContext.server.ts";

function headers(values) {
  const normalized = new Map(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value])
  );
  return { get: (name) => normalized.get(name.toLowerCase()) ?? null };
}

const firefoxPixel =
  "Mozilla/5.0 (Linux; Android 16; Pixel 9 Pro) Gecko/20100101 Firefox/142.0";

test("coarse context ignores patch-level browser and host changes inside one IPv4 /24", () => {
  const first = buildCoarseTeamSecurityContext(
    headers({ "x-vercel-forwarded-for": "203.0.113.10", "user-agent": firefoxPixel })
  );
  const second = buildCoarseTeamSecurityContext(
    headers({
      "x-vercel-forwarded-for": "203.0.113.240",
      "user-agent": firefoxPixel.replace("142.0", "142.0.3"),
    })
  );
  assert.equal(first, second);
  assert.match(first, /network=v4:203[.]0[.]113/u);
  assert.match(first, /browser=firefox/u);
  assert.match(first, /platform=android/u);
  assert.doesNotMatch(first, /Pixel|142/u);
});

test("material network or browser-family changes produce a different context", () => {
  const base = buildCoarseTeamSecurityContext(
    headers({ "x-vercel-forwarded-for": "203.0.113.10", "user-agent": firefoxPixel })
  );
  const networkChanged = buildCoarseTeamSecurityContext(
    headers({ "x-vercel-forwarded-for": "198.51.100.10", "user-agent": firefoxPixel })
  );
  const browserChanged = buildCoarseTeamSecurityContext(
    headers({
      "x-vercel-forwarded-for": "203.0.113.10",
      "user-agent": "Mozilla/5.0 (Linux; Android 16) Chrome/140.0 Mobile",
    })
  );
  assert.notEqual(base, networkChanged);
  assert.notEqual(base, browserChanged);
});

test("IPv6 context uses only a /48 prefix and never the device address", () => {
  const first = buildCoarseTeamSecurityContext(
    headers({ "x-vercel-forwarded-for": "2001:db8:1234:1::99", "user-agent": firefoxPixel })
  );
  const second = buildCoarseTeamSecurityContext(
    headers({ "x-vercel-forwarded-for": "2001:db8:1234:ffff::2", "user-agent": firefoxPixel })
  );
  assert.equal(first, second);
  assert.match(first, /network=v6:2001:0db8:1234/u);
  assert.doesNotMatch(first, /ffff|0099/u);
});

test("production-shaped context fails closed without a trusted network header", () => {
  assert.throws(
    () => buildCoarseTeamSecurityContext(headers({ "user-agent": firefoxPixel }), { allowMissingNetwork: false }),
    /TEAM_SECURITY_CONTEXT_UNAVAILABLE/u
  );
});

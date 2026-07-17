import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

process.env.DISCORD_CLIENT_ID = "test-client-id";
process.env.DISCORD_REDIRECT_URI =
  "https://cancerculture.example/api/auth/discord/callback";
process.env.NEXT_PUBLIC_BASE_URL = "https://cancerculture.example";

const { GET: startDiscordOAuth, dynamic: oauthStartDynamicMode } = await import(
  "../../app/api/auth/discord/login/route.ts"
);
const callbackSource = await readFile(
  new URL(
    "../../app/api/auth/discord/callback/route.ts",
    import.meta.url
  ),
  "utf8"
);

function getSetCookies(response) {
  return typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") ?? ""];
}

function getCookieValue(cookies, name) {
  const match = cookies.join("\n").match(
    new RegExp(`(?:^|\\n)${name}=([^;]*)`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}

test("OAuth start redirects temporarily to Discord with state and secure cookies", async () => {
  const response = await startDiscordOAuth(
    new Request(
      "https://cancerculture.example/api/auth/discord/login?state=/upload"
    )
  );
  const location = new URL(response.headers.get("location"));
  const cookies = getSetCookies(response);
  const oauthState = getCookieValue(cookies, "oauth_state");

  assert.equal(response.status, 307);
  assert.equal(oauthStartDynamicMode, "force-dynamic");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(location.protocol, "https:");
  assert.equal(location.hostname, "discord.com");
  assert.equal(location.pathname, "/api/oauth2/authorize");
  assert.equal(location.searchParams.get("state"), oauthState);
  assert.equal(getCookieValue(cookies, "oauth_redirect_path"), "/upload");
  assert.match(cookies.join("\n"), /oauth_state=.*HttpOnly/i);
  assert.match(cookies.join("\n"), /oauth_state=.*SameSite=lax/i);
  assert.match(cookies.join("\n"), /oauth_state=.*Path=\//i);
  assert.equal(response.headers.get("x-middleware-rewrite"), null);
});

test("OAuth start normalizes an external return target to the application root", async () => {
  const response = await startDiscordOAuth(
    new Request(
      "https://cancerculture.example/api/auth/discord/login" +
        "?state=https%3A%2F%2Fevil.example%2Fsteal"
    )
  );

  assert.equal(response.status, 307);
  assert.equal(
    getCookieValue(getSetCookies(response), "oauth_redirect_path"),
    "/"
  );
});

test("OAuth callback redirects access denials without route-handler rewrites", () => {
  assert.doesNotMatch(callbackSource, /NextResponse\.rewrite\s*\(/);
  assert.match(
    callbackSource,
    /error\.status === 403[\s\S]*?NextResponse\.redirect\([\s\S]*?\/banned\?code=/
  );
  assert.match(callbackSource, /clearOAuthCookies\(response\)/);
  assert.match(callbackSource, /expireCookie\(response, "session_id"\)/);
  assert.match(callbackSource, /expireCookie\(response, "discord_user_id"\)/);
});

test("OAuth callback creates a session cookie only after provider and RPC success", () => {
  const tokenExchange = callbackSource.indexOf(
    "https://discord.com/api/oauth2/token"
  );
  const userFetch = callbackSource.indexOf(
    "https://discord.com/api/users/@me"
  );
  const sessionRpc = callbackSource.indexOf(
    'supabaseAdmin.rpc("create_cancerculture_session"'
  );
  const createdOutcome = callbackSource.indexOf(
    'sessionOutcome !== "created"'
  );
  const sessionCookie = callbackSource.indexOf(
    'successResponse.cookies.set("session_id"'
  );

  assert.ok(tokenExchange > -1);
  assert.ok(userFetch > tokenExchange);
  assert.ok(sessionRpc > userFetch);
  assert.ok(createdOutcome > sessionRpc);
  assert.ok(sessionCookie > createdOutcome);
});

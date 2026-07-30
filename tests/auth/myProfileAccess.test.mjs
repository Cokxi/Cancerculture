import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sanitizeInternalReturnPath } from "../../lib/auth/oauth/safeReturnPath.ts";

const readRepoFile = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("anonymous profile access uses the fixed safe Discord return path", async () => {
  const page = await readRepoFile("app/my-profile/page.tsx");
  const anonymousBranch = page.slice(
    page.indexOf('sessionState.status === "anonymous"'),
    page.indexOf('sessionState.status === "restricted"')
  );

  assert.match(page, /const MY_PROFILE_PATH = "\/my-profile"/);
  assert.match(
    page,
    /`\/api\/auth\/discord\/login\?state=\$\{MY_PROFILE_PATH\}`/
  );
  assert.match(anonymousBranch, /redirect\(MY_PROFILE_LOGIN_PATH\)/);
  assert.doesNotMatch(page, /searchParams|requireSession/);
});

test("restricted and unavailable auth states are controlled", async () => {
  const page = await readRepoFile("app/my-profile/page.tsx");
  const restrictedBranch = page.slice(
    page.indexOf('sessionState.status === "restricted"'),
    page.indexOf(
      'sessionState.status === "dependency_unavailable"'
    )
  );
  const unavailableBranch = page.slice(
    page.indexOf(
      'sessionState.status === "dependency_unavailable"'
    ),
    page.indexOf("const session = sessionState.session")
  );

  assert.match(restrictedBranch, /DISCORD_BANNED/);
  assert.match(restrictedBranch, /WEBSITE_BANNED/);
  assert.match(restrictedBranch, /redirect\(`\/banned\?code=\$\{code\}`\)/);
  assert.match(
    unavailableBranch,
    /Profile temporarily unavailable/
  );
  assert.match(unavailableBranch, /role="status"/);
  assert.doesNotMatch(unavailableBranch, /redirect\(/);
});

test("profile data loads only after an authenticated session", async () => {
  const page = await readRepoFile("app/my-profile/page.tsx");
  const sessionState = page.indexOf(
    "const sessionState = await getSessionState()"
  );
  const authenticatedSession = page.indexOf(
    "const session = sessionState.session"
  );
  const profileLookup = page.indexOf(
    "await getUserProfileData(session.discord_user_id)"
  );

  assert.ok(sessionState > -1);
  assert.ok(authenticatedSession > sessionState);
  assert.ok(profileLookup > authenticatedSession);
  assert.doesNotMatch(
    page,
    /team_members|teamRole|teamRoles|requireAdmin|requireModOrAdmin/
  );
});

test("missing profile rows retain existing defaults", async () => {
  const profile = await readRepoFile(
    "lib/profile/getUserProfileData.ts"
  );

  assert.match(profile, /const userLog = userLogResult\.data/);
  assert.match(
    profile,
    /const joinedDate = userLog\?\.first_seen_at[\s\S]*?: null;/
  );
  assert.match(
    profile,
    /showSocialsOnProfile: userLog\?\.show_socials \?\? false/
  );
  assert.match(
    profile,
    /showSocialsOnSubmissions:[\s\S]*?\?\? false/
  );
});

test("OAuth return paths remain internal and reject external input", async () => {
  const origin = new URL("https://cancerculture.example");
  const loginRoute = await readRepoFile(
    "app/api/auth/discord/login/route.ts"
  );

  assert.equal(
    sanitizeInternalReturnPath("/my-profile", origin),
    "/my-profile"
  );
  assert.equal(
    sanitizeInternalReturnPath(
      "https://evil.example/steal",
      origin
    ),
    "/"
  );
  assert.equal(
    sanitizeInternalReturnPath("//evil.example/steal", origin),
    "/"
  );
  assert.match(loginRoute, /sanitizeInternalReturnPath/);
  assert.match(loginRoute, /searchParams\.get\("state"\)/);
});

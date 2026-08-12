import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";

const PUBLIC_PROFILE_ID = "223e4567-e89b-42d3-a456-426614174000";
const DISCORD_USER_ID = "223456789012345678";
const DISCORD_AVATAR = "a".repeat(32);
const AVATAR_UPDATED_AT = "2026-08-10T12:00:00.000Z";

const state = {
  calls: [],
  userLog: null,
  internalSubmissionUserIds: [],
  internalSocialUserIds: [],
};

mock.module(new URL("../../node_modules/next/navigation.js", import.meta.url), {
  namedExports: {
    notFound() {
      throw new Error("not found");
    },
  },
});

const publicSubmission = {
  id: 41,
  cycle_id: 9,
  cycle_number: 7,
  vote_count: 17,
  rank: 2,
  total: 20,
  tie_count: 1,
  destination_href: "/cycle-history?cycle=9#submission-41",
  image_url: "https://images.example/submission.png",
  is_disqualified: false,
  disqualification_reason_code: null,
  disqualification_reason_text: null,
  disqualified_by_discord_username: null,
};

const publicSocial = {
  id: 7,
  platform: "youtube",
  handle: "@creator",
  profile_url: "https://youtube.example/@creator",
  is_verified: true,
  internal_only: "not public",
};

function responseFor(table) {
  if (table === "user_logs") {
    return { data: state.userLog, error: null };
  }

  if (table === "submissions") {
    return {
      data: [
        {
          id: publicSubmission.id,
          hidden_from_profile_at: null,
          public_visibility_status: "visible",
          public_visibility_reason_code: null,
          public_visibility_reason_text: null,
        },
      ],
      error: null,
    };
  }

  if (table === "cycle_results") {
    return {
      data: [{ submission_id: publicSubmission.id }],
      error: null,
    };
  }

  return { data: [], error: null };
}

function builder(table) {
  const chain = {
    select(columns) {
      state.calls.push([table, "select", columns]);
      return chain;
    },
    eq(column, value) {
      state.calls.push([table, "eq", column, value]);
      return chain;
    },
    in(column, values) {
      state.calls.push([table, "in", column, values]);
      return chain;
    },
    maybeSingle() {
      return Promise.resolve(responseFor(table));
    },
    then(resolve, reject) {
      return Promise.resolve(responseFor(table)).then(resolve, reject);
    },
  };

  return chain;
}

mock.module(new URL("../../lib/db/server.ts", import.meta.url), {
  namedExports: {
    supabaseServer: {
      from(table) {
        return builder(table);
      },
    },
  },
});

mock.module(
  new URL("../../lib/queries/getUserSubmissions.ts", import.meta.url),
  {
    namedExports: {
      getUserSubmissions(discordUserId) {
        state.internalSubmissionUserIds.push(discordUserId);
        return Promise.resolve([publicSubmission]);
      },
    },
  }
);

mock.module(
  new URL("../../lib/socials/getUserSocialLinks.ts", import.meta.url),
  {
    namedExports: {
      getUserSocialLinks(discordUserId) {
        state.internalSocialUserIds.push(discordUserId);
        return Promise.resolve([publicSocial]);
      },
    },
  }
);

mock.module(new URL("../../lib/r2/getPublicImageUrl.ts", import.meta.url), {
  namedExports: {
    getPublicImageUrl(key) {
      return key ? `https://images.example/${key}` : null;
    },
  },
});

const { getPublicUserProfileData } = await import(
  "../../lib/profile/getPublicUserProfileData.ts"
);
const {
  createNeutralPublicAvatarResponse,
  proxyPublicDiscordAvatar,
} = await import("../../lib/profile/publicDiscordAvatar.ts");
const { GET: getPublicAvatar } = await import(
  "../../app/profile/[publicProfileId]/avatar/route.ts"
);

const source = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

function setUserLog(overrides = {}) {
  state.userLog = {
    public_profile_id: PUBLIC_PROFILE_ID,
    discord_user_id: DISCORD_USER_ID,
    current_discord_username: "CurrentCreator",
    known_discord_usernames: ["EarlierCreator", "CurrentCreator"],
    avatar_key: null,
    avatar_updated_at: AVATAR_UPDATED_AT,
    discord_avatar: DISCORD_AVATAR,
    show_socials: true,
    ...overrides,
  };
}

test.beforeEach(() => {
  state.calls = [];
  state.internalSubmissionUserIds = [];
  state.internalSocialUserIds = [];
  setUserLog();
});

test("the public profile model keeps the Discord ID internal and returns only an opaque avatar link", async () => {
  const profile = await getPublicUserProfileData(PUBLIC_PROFILE_ID);
  const serialized = JSON.stringify(profile);

  assert.equal(Object.hasOwn(profile, "discordUserId"), false);
  assert.doesNotMatch(serialized, new RegExp(DISCORD_USER_ID, "u"));
  assert.doesNotMatch(serialized, /cdn\.discordapp\.com/u);
  assert.match(
    profile.avatarUrl,
    new RegExp(`^/profile/${PUBLIC_PROFILE_ID}/avatar\\?v=[a-f0-9]{16}$`, "u")
  );
  assert.doesNotMatch(profile.avatarUrl, new RegExp(DISCORD_AVATAR, "u"));
  assert.deepEqual(state.internalSubmissionUserIds, [DISCORD_USER_ID]);
  assert.deepEqual(state.internalSocialUserIds, [DISCORD_USER_ID]);
});

test("uploaded avatars, username history, submissions, and public Socials remain unchanged", async () => {
  setUserLog({ avatar_key: `avatars/${DISCORD_USER_ID}.webp` });

  const profile = await getPublicUserProfileData(PUBLIC_PROFILE_ID);

  assert.match(
    profile.avatarUrl,
    new RegExp(`^/profile/${PUBLIC_PROFILE_ID}/avatar\\?v=[a-f0-9]{16}$`, "u")
  );
  assert.doesNotMatch(profile.avatarUrl, new RegExp(DISCORD_USER_ID, "u"));
  assert.doesNotMatch(profile.avatarUrl, /avatars%2F|images\.example/u);
  assert.deepEqual(profile.knownDiscordUsernames, [
    "EarlierCreator",
    "CurrentCreator",
  ]);
  assert.deepEqual(profile.submissions, [
    {
      id: publicSubmission.id,
      cycle_id: publicSubmission.cycle_id,
      cycle_number: publicSubmission.cycle_number,
      vote_count: publicSubmission.vote_count,
      rank: publicSubmission.rank,
      total: publicSubmission.total,
      tie_count: publicSubmission.tie_count,
      destination_href: publicSubmission.destination_href,
      image_url: publicSubmission.image_url,
      public_visibility_status: "visible",
      public_visibility_reason_code: null,
      public_visibility_reason_text: null,
    },
  ]);
  assert.deepEqual(profile.socialLinks, [
    {
      id: publicSocial.id,
      platform: publicSocial.platform,
      handle: publicSocial.handle,
      profile_url: publicSocial.profile_url,
      is_verified: publicSocial.is_verified,
    },
  ]);
});

test("the opaque public route also transfers an existing uploaded avatar", async () => {
  const originalFetch = globalThis.fetch;
  const imageBytes = Uint8Array.from([82, 73, 70, 70]);
  let upstreamUrl;

  setUserLog({ avatar_key: `avatars/${DISCORD_USER_ID}.webp` });

  try {
    globalThis.fetch = async (url) => {
      upstreamUrl = new URL(url);
      return new Response(imageBytes, {
        status: 200,
        headers: { "Content-Type": "image/webp" },
      });
    };

    const response = await getPublicAvatar(new Request("https://example.test"), {
      params: Promise.resolve({ publicProfileId: PUBLIC_PROFILE_ID }),
    });

    assert.equal(
      upstreamUrl.href,
      `https://images.example/avatars/${DISCORD_USER_ID}.webp`
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.equal(response.headers.get("location"), null);
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      imageBytes
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the opaque public route proxies a valid Discord avatar without redirecting the browser", async () => {
  const originalFetch = globalThis.fetch;
  const imageBytes = Uint8Array.from([137, 80, 78, 71]);
  let upstreamUrl;
  let upstreamInit;

  try {
    globalThis.fetch = async (url, init) => {
      upstreamUrl = new URL(url);
      upstreamInit = init;
      return new Response(imageBytes, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    };

    const response = await getPublicAvatar(new Request("https://example.test"), {
      params: Promise.resolve({ publicProfileId: PUBLIC_PROFILE_ID }),
    });

    assert.equal(upstreamUrl.origin, "https://cdn.discordapp.com");
    assert.equal(
      upstreamUrl.pathname,
      `/avatars/${DISCORD_USER_ID}/${DISCORD_AVATAR}.png`
    );
    assert.equal(upstreamUrl.search, "?size=128");
    assert.equal(upstreamInit.redirect, "error");
    assert.equal(upstreamInit.cache, "force-cache");
    assert.ok(upstreamInit.signal instanceof AbortSignal);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.match(response.headers.get("cache-control"), /s-maxage=86400/u);
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      imageBytes
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing users, invalid uploaded-avatar metadata, and invalid public IDs return the same neutral image", async () => {
  const responses = [];

  state.userLog = null;
  responses.push(
    await getPublicAvatar(new Request("https://example.test"), {
      params: Promise.resolve({ publicProfileId: PUBLIC_PROFILE_ID }),
    })
  );

  setUserLog({ avatar_key: "avatars/not-the-owner.webp" });
  responses.push(
    await getPublicAvatar(new Request("https://example.test"), {
      params: Promise.resolve({ publicProfileId: PUBLIC_PROFILE_ID }),
    })
  );

  responses.push(
    await getPublicAvatar(new Request("https://example.test"), {
      params: Promise.resolve({ publicProfileId: DISCORD_USER_ID }),
    })
  );

  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^image\/svg\+xml/u);
    assert.equal(response.headers.get("location"), null);
    assert.doesNotMatch(await response.text(), new RegExp(DISCORD_USER_ID, "u"));
  }
});

test("invalid Discord metadata never reaches the upstream", async () => {
  let calls = 0;
  const response = await proxyPublicDiscordAvatar({
    discordUserId: "not-a-discord-id",
    discordAvatar: "https://attacker.example/avatar.png",
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not be called");
    },
  });

  assert.equal(calls, 0);
  assert.match(response.headers.get("content-type"), /^image\/svg\+xml/u);
});

test("upstream failures, redirects, forbidden content types, and oversized images fail to a neutral response", async (t) => {
  const cases = [
    {
      name: "network failure",
      fetchImpl: async () => {
        throw new Error("provider detail must stay private");
      },
    },
    {
      name: "upstream redirect",
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: {
            Location: `https://cdn.discordapp.com/avatars/${DISCORD_USER_ID}/${DISCORD_AVATAR}.png`,
          },
        }),
    },
    {
      name: "forbidden content type",
      fetchImpl: async () =>
        new Response("<html>not an image</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    },
    {
      name: "oversized image",
      fetchImpl: async () =>
        new Response(Uint8Array.from([1]), {
          status: 200,
          headers: {
            "Content-Length": String(1024 * 1024 + 1),
            "Content-Type": "image/png",
          },
        }),
    },
    {
      name: "chunked oversized image",
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(700_000));
              controller.enqueue(new Uint8Array(700_000));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "image/png" },
          }
        ),
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const response = await proxyPublicDiscordAvatar({
        discordUserId: DISCORD_USER_ID,
        discordAvatar: DISCORD_AVATAR,
        fetchImpl: testCase.fetchImpl,
      });
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("location"), null);
      assert.match(response.headers.get("content-type"), /^image\/svg\+xml/u);
      assert.doesNotMatch(body, /provider detail|discordapp\.com/u);
      assert.doesNotMatch(body, new RegExp(DISCORD_USER_ID, "u"));
    });
  }
});

test("an elapsed upstream timeout returns the neutral image", async () => {
  const response = await proxyPublicDiscordAvatar({
    discordUserId: DISCORD_USER_ID,
    discordAvatar: DISCORD_AVATAR,
    timeoutMs: 1,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal.reason),
          { once: true }
        );
      }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^image\/svg\+xml/u);
  assert.equal(response.headers.get("location"), null);
});

test("public profile source and markup consumers contain no Discord ID field or CDN avatar URL", async () => {
  const [readModel, page, route, proxy] = await Promise.all([
    source("lib/profile/getPublicUserProfileData.ts"),
    source("app/profile/[publicProfileId]/page.tsx"),
    source("app/profile/[publicProfileId]/avatar/route.ts"),
    source("lib/profile/publicDiscordAvatar.ts"),
  ]);

  const returnedProfile = readModel.slice(readModel.lastIndexOf("return {"));

  assert.doesNotMatch(readModel, /discordUserId:\s*string/u);
  assert.doesNotMatch(returnedProfile, /discordUserId\s*:/u);
  assert.doesNotMatch(
    readModel,
    /submission_private_data|getSubmissionPrivateData|wallet_address|payout_choice|split_percent/u
  );
  assert.doesNotMatch(
    returnedProfile,
    /wallet|payout|charity|discord_user_id/iu
  );
  assert.doesNotMatch(page, /discordUserId|cdn\.discordapp\.com/u);
  assert.match(page, /profile\.knownDiscordUsernames/u);
  assert.match(page, /profile\.submissions/u);
  assert.match(page, /profile\.socialLinks/u);
  assert.match(route, /\.eq\("public_profile_id", publicProfileId\)/u);
  assert.doesNotMatch(route, /redirect\s*\(/u);
  assert.equal(
    (proxy.match(/https:\/\/cdn\.discordapp\.com/gu) ?? []).length,
    1
  );
  assert.doesNotMatch(proxy, /new URL\([^,]+publicProfileId/u);
});

test("neutral avatar responses disclose no technical details", async () => {
  const response = createNeutralPublicAvatarResponse();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("location"), null);
  assert.doesNotMatch(await response.text(), /Discord|database|upstream|error/iu);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";

const state = {
  calls: [],
  responses: new Map(),
};

function builder(table) {
  const chain = {
    select(value) {
      state.calls.push([table, "select", value]);
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
    order(column, options) {
      state.calls.push([table, "order", column, options]);
      return chain;
    },
    limit(value) {
      state.calls.push([table, "limit", value]);
      return chain;
    },
    then(resolve, reject) {
      return Promise.resolve(
        state.responses.get(table) ?? { data: [], error: null }
      ).then(resolve, reject);
    },
  };

  return chain;
}

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      from(table) {
        return builder(table);
      },
    },
  },
});

mock.module(
  new URL("../../lib/discord/formatDiscordUserLabel.ts", import.meta.url),
  {
    namedExports: {
      formatDiscordUserLabel(user) {
        return user.current_display_name ?? user.discord_user_id;
      },
    },
  }
);

mock.module(new URL("../../lib/r2/getPublicImageUrl.ts", import.meta.url), {
  namedExports: {
    getPublicImageUrl(r2Key) {
      return r2Key ? `https://cdn.example/${r2Key}` : null;
    },
  },
});

mock.module(
  new URL("../../lib/r2/getSubmissionThumbnailUrl.ts", import.meta.url),
  {
    namedExports: {
      getSubmissionThumbnailUrl(imageUrl) {
        return `${imageUrl}?w=400,q=75`;
      },
    },
  }
);

const { getSubmissionModerationLogs } = await import(
  "../../lib/admin/moderationLogs.ts"
);

test.beforeEach(() => {
  state.calls = [];
  state.responses = new Map();
});

function setBaseResponses() {
  state.responses.set("moderation_action_logs", {
    data: [
      {
        id: "log-current",
        created_at: "2026-08-04T10:00:00.000Z",
        actor_role: "moderator",
        actor_id: "actor",
        action: "reinstate_submission",
        target_id: "11",
        target_discord_user_id: "submitter",
        reason_code: "spam",
        reason_text: "Admin-only note",
        cycle_id: 7,
      },
      {
        id: "log-legal-review",
        created_at: "2026-08-04T09:00:00.000Z",
        actor_role: "admin",
        actor_id: "actor",
        action: "mark_submission_legal_review",
        target_id: "12",
        target_discord_user_id: "submitter",
        reason_code: "legal_review",
        cycle_id: 6,
      },
      {
        id: "log-removed",
        created_at: "2026-08-04T08:00:00.000Z",
        actor_role: "admin",
        actor_id: "actor",
        action: "remove_submission_from_public",
        target_id: "13",
        target_discord_user_id: "submitter",
        reason_code: "manual_review",
        cycle_id: 6,
      },
      {
        id: "log-disqualified",
        created_at: "2026-08-04T07:00:00.000Z",
        actor_role: "moderator",
        actor_id: "actor",
        action: "disqualify_submission",
        target_id: "14",
        target_discord_user_id: "submitter",
        reason_code: "hate",
        cycle_id: 6,
      },
    ],
    error: null,
  });
  state.responses.set("user_logs", {
    data: [
      {
        discord_user_id: "actor",
        public_profile_id: "actor-profile",
        current_display_name: "Actor",
      },
      {
        discord_user_id: "submitter",
        public_profile_id: "submitter-profile",
        current_display_name: "Submitter",
      },
    ],
    error: null,
  });
  state.responses.set("submissions", {
    data: [
      {
        id: 11,
        cycle_id: 7,
        r2_key: "submissions/11.webp",
        is_disqualified: false,
        public_visibility_status: "visible",
      },
      {
        id: 12,
        cycle_id: 6,
        r2_key: "submissions/12.webp",
        is_disqualified: false,
        public_visibility_status: "legal_review",
      },
      {
        id: 13,
        cycle_id: 6,
        r2_key: "submissions/13.webp",
        is_disqualified: false,
        public_visibility_status: "removed",
      },
      {
        id: 14,
        cycle_id: 6,
        r2_key: "submissions/14.webp",
        is_disqualified: true,
        public_visibility_status: "visible",
      },
    ],
    error: null,
  });
  state.responses.set("voting_cycles", {
    data: [
      { id: 7, status: "submission_open" },
      { id: 6, status: "finished" },
    ],
    error: null,
  });
}

test("moderation logs expose only resolvable canonical links and safe thumbnails", async () => {
  setBaseResponses();

  const result = await getSubmissionModerationLogs();
  const byId = new Map(result.data.map((row) => [row.id, row]));

  assert.equal(result.error, null);
  assert.equal(
    byId.get("log-current")?.submission_href,
    "/submissions?submission=11"
  );
  assert.equal(
    byId.get("log-current")?.submission_thumbnail_url,
    "https://cdn.example/submissions/11.webp?w=400,q=75"
  );
  assert.equal(
    byId.get("log-legal-review")?.submission_href,
    "/cycle-history?cycle=6#submission-12"
  );
  assert.equal(
    byId.get("log-legal-review")?.submission_thumbnail_url,
    null
  );
  assert.equal(byId.get("log-removed")?.submission_href, null);
  assert.equal(byId.get("log-disqualified")?.submission_href, null);
  assert.equal(byId.get("log-current")?.reason, "rules_violation");
  assert.equal(byId.get("log-current")?.reason_text, null);
  assert.equal(
    "r2_key" in (byId.get("log-current") ?? {}),
    false
  );
});

test("submission metadata failures keep the authorized log projection but fail links closed", async () => {
  setBaseResponses();
  state.responses.set("submissions", {
    data: null,
    error: { code: "DB_UNAVAILABLE" },
  });

  const result = await getSubmissionModerationLogs({
    includeAdminDetails: true,
  });

  assert.equal(result.data.length, 4);
  assert.ok(result.data.every((row) => row.submission_href === null));
  assert.ok(
    result.data.every((row) => row.submission_thumbnail_url === null)
  );
  assert.equal(result.data[0].reason, "spam");
  assert.equal(result.data[0].reason_text, "Admin-only note");
});

test("link enrichment queries only the minimum submission metadata", async () => {
  setBaseResponses();

  await getSubmissionModerationLogs();

  assert.deepEqual(
    state.calls.find(
      ([table, operation]) =>
        table === "submissions" && operation === "select"
    ),
    [
      "submissions",
      "select",
      "id, cycle_id, r2_key, is_disqualified, public_visibility_status",
    ]
  );
});

test("each log uses a keyboard-native disclosure without a detail fetch", async () => {
  const source = await readFile(
    new URL(
      "../../app/admin/logs/moderation/moderation-log-list.tsx",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(source, /cycleLogs\.map[\s\S]*?<details/u);
  assert.match(
    source,
    /<summary className="[^"]*focus-visible:ring-2/u
  );
  assert.match(source, /href=\{log\.submission_href\}/u);
  assert.match(source, /src=\{log\.submission_thumbnail_url\}/u);
  assert.doesNotMatch(source, /onToggle=|\/api\/admin\/logs\/moderation\//u);
});

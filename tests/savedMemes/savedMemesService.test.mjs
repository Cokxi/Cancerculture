import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = { calls: [], data: null, error: null };

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      rpc(name, parameters) {
        state.calls.push({ name, parameters });
        return Promise.resolve({ data: state.data, error: state.error });
      },
    },
  },
});

const {
  getOwnSavedMemes,
  getSavedMemeStatus,
  setSavedMeme,
} = await import("../../lib/savedMemes/service.server.ts");

const sessionId = "123e4567-e89b-42d3-a456-426614174000";

test.beforeEach(() => {
  state.calls = [];
  state.data = null;
  state.error = null;
});

test("one atomic RPC saves or removes exactly the requested canonical Submission", async () => {
  state.data = {
    outcome: "saved",
    submissionId: 240,
    saved: true,
    changed: true,
  };
  assert.deepEqual(
    await setSavedMeme({ sessionId, submissionId: 240, saved: true }),
    state.data,
  );
  assert.deepEqual(state.calls, [
    {
      name: "set_account_saved_meme",
      parameters: {
        p_session_id: sessionId,
        p_submission_id: 240,
        p_saved: true,
      },
    },
  ]);
});

test("not-public and malformed mutation outcomes fail closed without private detail", async () => {
  state.data = {
    outcome: "not_public",
    submissionId: 240,
    saved: false,
    changed: false,
    moderationReason: "must not project",
  };
  assert.deepEqual(
    await setSavedMeme({ sessionId, submissionId: 240, saved: true }),
    {
      outcome: "not_public",
      submissionId: 240,
      saved: false,
      changed: false,
    },
  );

  state.data = { outcome: "saved", submissionId: 241, saved: true };
  await assert.rejects(
    setSavedMeme({ sessionId, submissionId: 240, saved: true }),
    (error) => error.status === 503 && error.code === "SAVED_MEMES_RESPONSE_INVALID",
  );
});

test("batch status de-duplicates IDs and accepts only requested positive IDs", async () => {
  state.data = { outcome: "ok", savedSubmissionIds: [240] };
  assert.deepEqual(await getSavedMemeStatus(sessionId, [240, 240, 241]), {
    savedSubmissionIds: [240],
  });
  assert.deepEqual(state.calls[0], {
    name: "get_account_saved_meme_status",
    parameters: {
      p_session_id: sessionId,
      p_submission_ids: [240, 241],
    },
  });

  state.data = { outcome: "ok", savedSubmissionIds: [999] };
  await assert.rejects(
    getSavedMemeStatus(sessionId, [240]),
    (error) => error.code === "SAVED_MEMES_RESPONSE_INVALID",
  );
});

test("saved pages expose public links or neutral tombstones and a bounded cursor", async () => {
  state.data = {
    outcome: "ok",
    items: [
      {
        bookmarkId: 7,
        submissionId: 240,
        savedAt: "2026-08-23T12:00:00.000Z",
        available: true,
        cycleNumber: 12,
        mediaWidth: 1200,
        mediaHeight: 900,
      },
      {
        bookmarkId: 6,
        submissionId: 199,
        savedAt: "2026-08-22T09:30:00.000Z",
        available: false,
        cycleNumber: null,
        mediaWidth: null,
        mediaHeight: null,
      },
    ],
    nextCursor: {
      savedAt: "2026-08-22T09:30:00.000Z",
      bookmarkId: 6,
    },
  };
  const page = await getOwnSavedMemes({ sessionId, limit: 24 });
  assert.equal(page.items.length, 2);
  assert.equal(page.items[1].available, false);
  assert.deepEqual(page.nextCursor, state.data.nextCursor);
  assert.deepEqual(state.calls[0].parameters, {
    p_session_id: sessionId,
    p_before_saved_at: null,
    p_before_id: null,
    p_limit: 24,
  });
});

test("unavailable rows cannot smuggle public or moderation metadata", async () => {
  state.data = {
    outcome: "ok",
    items: [
      {
        bookmarkId: 6,
        submissionId: 199,
        savedAt: "2026-08-22T09:30:00.000Z",
        available: false,
        cycleNumber: 12,
        mediaWidth: null,
        mediaHeight: null,
      },
    ],
    nextCursor: null,
  };
  await assert.rejects(
    getOwnSavedMemes({ sessionId }),
    (error) => error.code === "SAVED_MEMES_RESPONSE_INVALID",
  );
});

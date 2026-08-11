import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = { error: null };

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      rpc() {
        return Promise.resolve({ data: null, error: state.error });
      },
    },
  },
});

const { resetCycleTransactional } = await import(
  "../../lib/cycles/resetCycle.ts"
);

const params = {
  actorDiscordUserId: "owner",
  cycleId: 11,
  reason: "DEV reset verification",
};

test("immutable moderation history blocks reset with a safe conflict", async () => {
  for (const constraint of [
    "submission_disqualification_events_submission_id_fkey",
    "user_flag_cases_submission_id_fkey",
  ]) {
    state.error = {
      code: "23503",
      message: "Foreign key dependency",
      details: `Constraint ${constraint} is still referenced`,
    };

    await assert.rejects(resetCycleTransactional(params), (error) => {
      assert.equal(error.status, 409);
      assert.equal(
        error.message,
        "Cycle contains immutable moderation history and cannot be reset"
      );
      assert.doesNotMatch(error.message, /constraint|foreign key/iu);
      return true;
    });
  }
});

test("unknown reset dependencies log only the bounded database code", async () => {
  state.error = {
    code: "DB_UNAVAILABLE",
    message: "private database detail",
    details: "private dependency detail",
  };
  const consoleError = mock.method(console, "error", () => {});

  await assert.rejects(resetCycleTransactional(params), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.message, "Cycle reset failed");
    return true;
  });

  assert.deepEqual(consoleError.mock.calls[0].arguments, [
    "[cycle reset][rpc]",
    { code: "DB_UNAVAILABLE" },
  ]);
  consoleError.mock.restore();
});

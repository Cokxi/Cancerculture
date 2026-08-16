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
  changeSolProfileWallet,
  getSolProfileWallet,
} = await import("../../lib/solana/profileWallet.server.ts");

const session = {
  discord_user_id: "999999999999999999",
  session_id: "123e4567-e89b-42d3-a456-426614174000",
};

test.beforeEach(() => {
  state.calls = [];
  state.data = null;
  state.error = null;
});

test("owner status reads only the hardened RPC and returns the explicit private projection", async () => {
  state.data = {
    outcome: "ok",
    factorActive: true,
    walletAddress: "So11111111111111111111111111111111111111112",
    version: 4,
    updatedAt: "2026-08-17T00:00:00.000Z",
    internalValue: "not projected",
  };

  assert.deepEqual(await getSolProfileWallet(session), {
    factorActive: true,
    walletAddress: "So11111111111111111111111111111111111111112",
    version: 4,
    updatedAt: "2026-08-17T00:00:00.000Z",
  });
  assert.deepEqual(state.calls, [
    {
      name: "get_account_sol_profile_wallet",
      parameters: { p_session_id: session.session_id },
    },
  ]);
});

test("inactive TOTP never projects a stored address from an invalid database shape", async () => {
  state.data = {
    outcome: "ok",
    factorActive: false,
    walletAddress: "So11111111111111111111111111111111111111112",
    version: 9,
  };
  assert.deepEqual(await getSolProfileWallet(session), {
    factorActive: false,
    walletAddress: null,
    version: null,
    updatedAt: null,
  });
});

test("a valid recipient is normalized before the one atomic mutation RPC", async () => {
  state.data = {
    outcome: "applied",
    reason: "created",
    version: 1,
    updatedAt: "2026-08-17T00:00:00.000Z",
    idempotentReplay: false,
  };
  const operationId = "223e4567-e89b-42d3-a456-426614174000";

  assert.deepEqual(
    await changeSolProfileWallet({
      session,
      operationId,
      expectedVersion: 0,
      address: "  So11111111111111111111111111111111111111112\n",
    }),
    {
      changed: true,
      version: 1,
      updatedAt: "2026-08-17T00:00:00.000Z",
      idempotentReplay: false,
    }
  );
  assert.deepEqual(state.calls, [
    {
      name: "change_account_sol_profile_wallet",
      parameters: {
        p_session_id: session.session_id,
        p_request_id: operationId,
        p_expected_version: 0,
        p_wallet_address: "So11111111111111111111111111111111111111112",
      },
    },
  ]);
});

test("invalid input still reaches the atomic RPC so its approval cannot remain ambiguous", async () => {
  state.data = { outcome: "rejected", reason: "address_invalid", version: 1 };
  await assert.rejects(
    changeSolProfileWallet({
      session,
      operationId: "323e4567-e89b-42d3-a456-426614174000",
      expectedVersion: 1,
      address: "  not-a-sol-address  ",
    }),
    (error) => error.status === 400 && error.code === "SOL_WALLET_ADDRESS_INVALID"
  );
  assert.equal(state.calls[0].parameters.p_wallet_address, "not-a-sol-address");
});

test("stale, no-change, membership, and fresh-step-up failures stay distinct", async () => {
  const cases = [
    [{ outcome: "rejected", reason: "stale_version" }, 409, "SOL_WALLET_STALE"],
    [{ outcome: "rejected", reason: "no_change" }, 409, "SOL_WALLET_NO_CHANGE"],
    [{ outcome: "rejected", reason: "membership_pending" }, 403, "MEMBERSHIP_PENDING"],
    [{ outcome: "rejected", reason: "not_member" }, 403, "NOT_IN_DISCORD"],
  ];
  for (const [data, status, code] of cases) {
    state.data = data;
    await assert.rejects(
      changeSolProfileWallet({
        session,
        operationId: crypto.randomUUID(),
        expectedVersion: 1,
        address: null,
      }),
      (error) => error.status === status && error.code === code
    );
  }

  state.error = { message: "FRESH_STEP_UP_REQUIRED" };
  await assert.rejects(
    changeSolProfileWallet({
      session,
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
      address: null,
    }),
    (error) => error.status === 403 && error.code === "FRESH_STEP_UP_REQUIRED"
  );
});

test("an idempotent database replay is projected without address or audit detail", async () => {
  state.data = {
    outcome: "applied",
    reason: "replaced",
    version: 8,
    updatedAt: "2026-08-17T00:00:00.000Z",
    idempotentReplay: true,
    walletAddress: "must not be projected",
    audit: "must not be projected",
  };
  assert.deepEqual(
    await changeSolProfileWallet({
      session,
      operationId: "423e4567-e89b-42d3-a456-426614174000",
      expectedVersion: 7,
      address: null,
    }),
    {
      changed: true,
      version: 8,
      updatedAt: "2026-08-17T00:00:00.000Z",
      idempotentReplay: true,
    }
  );
});

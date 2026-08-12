import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = {
  earlyClosed: false,
  rpcClosed: false,
  events: [],
};

mock.module(new URL("../../lib/auth/requireSession.ts", import.meta.url), {
  namedExports: {
    requireSession() {
      state.events.push("session");
      return Promise.resolve({ discord_user_id: "report-route-user" });
    },
  },
});

mock.module(
  new URL("../../lib/reports/submissionReportRpc.server.ts", import.meta.url),
  {
    namedExports: {
      assertSubmissionReportCreationOpen() {
        state.events.push("phase-check");
        if (state.earlyClosed) {
          throw new Error("REPORTING_CLOSED");
        }
        return Promise.resolve();
      },
      createSubmissionReport() {
        state.events.push("rpc-create");
        if (state.rpcClosed) {
          throw new Error("REPORTING_CLOSED");
        }
        return Promise.resolve({
          reportId: "10000000-0000-4000-8000-000000000001",
          caseId: "20000000-0000-4000-8000-000000000001",
          createdAt: "2026-08-12T00:00:00.000Z",
          replayed: false,
        });
      },
      submissionReportErrorResponse(error) {
        return error instanceof Error && error.message === "REPORTING_CLOSED"
          ? { status: 409, code: "REPORTING_CLOSED" }
          : { status: 500, code: "REPORT_FAILED" };
      },
    },
  },
);

mock.module(new URL("../../lib/turnstile/verify.server.ts", import.meta.url), {
  namedExports: {
    verifyTurnstileRequest() {
      state.events.push("turnstile");
      return Promise.resolve({ status: "verified" });
    },
  },
});

const { POST } = await import("../../app/api/submission-reports/route.ts");
const { POST: SAFETY_FEEDBACK_POST } = await import(
  "../../app/api/safety-feedback/route.ts"
);

function request() {
  return new Request("http://localhost/api/submission-reports", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-turnstile-token": "synthetic-token",
    },
    body: JSON.stringify({
      submissionId: 42,
      reason: "privacy_or_personal_information",
      subcategory: "doxxing",
      comment: "This exposes private location information.",
      idempotencyKey: "3d4f7a8e-4b35-4a0f-8f89-a36f12d4d5f1",
    }),
  });
}

test("known post-Voting closure rejects before Turnstile", async () => {
  state.events = [];
  state.earlyClosed = true;
  state.rpcClosed = false;

  const response = await POST(request());

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "REPORTING_CLOSED" });
  assert.deepEqual(state.events, ["session", "phase-check"]);
});

test("an open phase reaches Turnstile and the atomic create RPC", async () => {
  state.events = [];
  state.earlyClosed = false;
  state.rpcClosed = false;

  const response = await POST(request());

  assert.equal(response.status, 201);
  assert.deepEqual(state.events, [
    "session",
    "phase-check",
    "turnstile",
    "rpc-create",
  ]);
});

test("the browser-safe endpoint uses the identical guarded creation path", async () => {
  state.events = [];
  state.earlyClosed = false;
  state.rpcClosed = false;

  const response = await SAFETY_FEEDBACK_POST(request());

  assert.equal(response.status, 201);
  assert.deepEqual(state.events, [
    "session",
    "phase-check",
    "turnstile",
    "rpc-create",
  ]);
});

test("a phase change after the early check is rejected by the atomic RPC", async () => {
  state.events = [];
  state.earlyClosed = false;
  state.rpcClosed = true;

  const response = await POST(request());

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "REPORTING_CLOSED" });
  assert.deepEqual(state.events, [
    "session",
    "phase-check",
    "turnstile",
    "rpc-create",
  ]);
});

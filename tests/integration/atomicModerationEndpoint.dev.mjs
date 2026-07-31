import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";

let actorDiscordUserId;

mock.module(
  new URL("../../lib/auth/teamAuthorization.ts", import.meta.url),
  {
    namedExports: {
      getTeamAuthorizationContext: async () => ({
        discord_user_id: actorDiscordUserId,
        role: "admin",
        isAdmin: true,
        resolvedCapabilities: [],
      }),
    },
  }
);

const { supabaseAdmin } = await import("../../lib/db/admin.ts");
const disqualifyRoute = await import(
  "../../app/api/admin/disqualify/route.ts"
);
const reinstateRoute = await import(
  "../../app/api/admin/reinstate/route.ts"
);

function requireData(data, error, label) {
  if (error) throw new Error(`${label} unavailable`);
  return data;
}

async function countRows(table, filters) {
  let query = supabaseAdmin
    .from(table)
    .select("*", { count: "exact", head: true });
  for (const [column, value] of Object.entries(filters)) {
    query = query.eq(column, value);
  }
  const { count, error } = await query;
  if (error || count === null) throw new Error(`${table} count unavailable`);
  return count;
}

async function post(route, operation, submission, phase, expectedState) {
  const idempotencyKey = randomUUID();
  const auditBefore = await countRows("moderation_action_logs", {
    target_type: "submission",
    target_id: String(submission.id),
  });
  const response = await route.POST(
    new Request(`http://localhost/api/admin/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cycleId: submission.cycle_id,
        submissionId: submission.id,
        expectedPhase: phase,
        expectedIsDisqualified: expectedState,
        disqualificationType:
          operation === "disqualify" ? "manual" : null,
        reasonCode: "manual_review",
        reasonText: "Rollback-safe real DEV endpoint verification.",
        idempotencyKey,
      }),
    })
  );
  const body = await response.json();
  const auditAfter = await countRows("moderation_action_logs", {
    target_type: "submission",
    target_id: String(submission.id),
  });
  const ledgerRows = await countRows("submission_moderation_requests", {
    idempotency_key: idempotencyKey,
  });

  assert.equal(response.status, 409);
  assert.deepEqual(body, {
    error: "The moderation state changed. Refresh and try again.",
  });
  assert.equal(auditAfter, auditBefore);
  assert.equal(ledgerRows, 0);
}

const { data: admins, error: adminError } = await supabaseAdmin
  .from("team_members")
  .select("discord_user_id")
  .eq("role", "admin")
  .limit(1);
actorDiscordUserId = requireData(admins, adminError, "DEV admin")?.[0]
  ?.discord_user_id;
if (!actorDiscordUserId) throw new Error("DEV admin unavailable");

const { data: cycles, error: cycleError } = await supabaseAdmin
  .from("voting_cycles")
  .select("id,status")
  .in("status", ["submission_open", "voting_open"])
  .order("id", { ascending: false })
  .limit(1);
const cycle = requireData(cycles, cycleError, "DEV moderation cycle")?.[0];
if (!cycle) throw new Error("DEV moderation cycle unavailable");

const { data: submissions, error: submissionError } = await supabaseAdmin
  .from("submissions")
  .select("id,cycle_id,is_disqualified")
  .eq("cycle_id", cycle.id)
  .limit(500);
requireData(submissions, submissionError, "DEV submissions");
const disqualified = submissions.find(
  (submission) => submission.is_disqualified === true
);
if (!disqualified) {
  throw new Error("DEV stale endpoint fixtures unavailable");
}

const started = performance.now();
await post(
  disqualifyRoute,
  "disqualify",
  disqualified,
  cycle.status,
  false
);
await post(
  reinstateRoute,
  "reinstate",
  disqualified,
  cycle.status === "submission_open" ? "voting_open" : "submission_open",
  true
);

console.log(
  JSON.stringify({
    project: new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(
      "."
    )[0],
    staleDisqualifyStatus: 409,
    reinstatePhaseConflictStatus: 409,
    auditDelta: 0,
    ledgerDelta: 0,
    durationMs: Math.round(performance.now() - started),
  })
);

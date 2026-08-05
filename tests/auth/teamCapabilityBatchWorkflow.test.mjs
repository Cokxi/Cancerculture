import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("permission controls are local, accessible draft toggles with no immediate mutation", async () => {
  const [workflow, roles] = await Promise.all([
    source("app/admin/team/roles/CapabilityDraftWorkflow.tsx"),
    source("app/admin/team/roles/RolesPermissionsClient.tsx"),
  ]);
  const toggle = workflow.slice(
    workflow.indexOf("function toggle("),
    workflow.indexOf("function openReview()"),
  );
  const discard = workflow.slice(
    workflow.indexOf("Discard changes"),
    workflow.indexOf("Review changes"),
  );

  assert.match(toggle, /toggleCapabilityDraft/);
  assert.doesNotMatch(toggle, /fetch\(|router\.refresh/);
  assert.doesNotMatch(discard, /fetch\(|router\.refresh/);
  assert.match(workflow, /✓ Saved · Granted/);
  assert.match(workflow, /Not granted · unchanged/);
  assert.match(workflow, /\+ Grant/);
  assert.match(workflow, /− Revoke/);
  assert.match(workflow, /data-draft-status/);
  assert.match(workflow, /aria-pressed=\{desiredGranted\}/);
  assert.match(workflow, /aria-label=/);
  assert.match(workflow, /roles=\{baseRoles\}/);
  assert.match(roles, /roles=\{readModel\.activeNonAdminRoles\}/);
  assert.doesNotMatch(`${workflow}\n${roles}`, /operation:\s*"set_role_capability"/);
});

test("the compact draft summary and role-management interlock retain local intent", async () => {
  const [workflow, roles] = await Promise.all([
    source("app/admin/team/roles/CapabilityDraftWorkflow.tsx"),
    source("app/admin/team/roles/RolesPermissionsClient.tsx"),
  ]);

  assert.match(workflow, /data-draft-summary/);
  for (const field of [
    "summary.total",
    "summary.grants",
    "summary.revocations",
    "summary.roles",
    "summary.capabilities",
  ]) {
    assert.match(workflow, new RegExp(field.replace(".", "\\."), "u"));
  }
  assert.match(workflow, /Discard changes/);
  assert.match(workflow, /Review changes/);
  assert.match(workflow, /disabled=\{[\s\S]*summary\.total === 0/);
  assert.match(workflow, /beforeunload/);
  assert.match(workflow, /externalSnapshotChanged/);
  assert.match(roles, /permissionDraftBlocked/);
  assert.match(
    roles,
    /Discard or save permission changes before modifying roles\./,
  );
  assert.match(roles, /operation: "create_role"/);
  assert.match(roles, /operation: "update_role"/);
  assert.match(roles, /operation: "set_role_active"/);
});

test("review is complete, frozen, hides free-text Reason, requires exact SAVE, and posts only the batch contract", async () => {
  const [workflow, dialog] = await Promise.all([
    source("app/admin/team/roles/CapabilityDraftWorkflow.tsx"),
    source("app/admin/team/TeamRoleMutationClient.tsx"),
  ]);
  const body = workflow.slice(
    workflow.indexOf("body: JSON.stringify"),
    workflow.indexOf("}),", workflow.indexOf("body: JSON.stringify")) + 3,
  );

  assert.match(workflow, /<ReviewDiff review=\{review\}/);
  assert.match(workflow, /review\.entries\.map/);
  assert.match(workflow, /entry\.roleDisplayName/);
  assert.match(workflow, /entry\.roleKey/);
  assert.match(workflow, /entry\.capabilityDisplayName/);
  assert.match(workflow, /entry\.capabilityKey/);
  assert.match(workflow, /entry\.originalGranted/);
  assert.match(workflow, /entry\.desiredGranted/);
  assert.match(workflow, /confirmationWord: "SAVE"/);
  assert.match(workflow, /reasonInput: "hidden"/);
  assert.match(workflow, /confirmLabel="Apply changes"/);
  assert.match(dialog, /operation\.reasonInput !== "hidden"/);
  assert.match(dialog, /reasonRequired \? \(/);
  assert.match(dialog, /reason\.trim\(\)\.length >= 3/);
  assert.match(dialog, /!confirmDisabled/);
  assert.match(dialog, /confirmationInput === operation\.confirmationWord/);
  assert.match(dialog, /immutable authorization audit and batch ledger/);
  assert.match(
    workflow,
    /PERMISSION_BATCH_REASON\s*=\s*\n?\s*"Permission grants updated through the reviewed SAVE batch\."/u,
  );
  assert.match(body, /roleSnapshots: review\.roleSnapshots/);
  assert.match(body, /capabilitySnapshots: review\.capabilitySnapshots/);
  assert.match(body, /changes: review\.changes/);
  assert.match(body, /reason: PERMISSION_BATCH_REASON/);
  assert.match(body, /idempotencyKey: requestIdentity\.idempotencyKey/);
  assert.doesNotMatch(body, /actor|roleSnapshots\s*:\s*baseRoles/iu);
});

test("non-batch role mutations retain the required append-only audit reason", async () => {
  const [dialog, roles] = await Promise.all([
    source("app/admin/team/TeamRoleMutationClient.tsx"),
    source("app/admin/team/roles/RolesPermissionsClient.tsx"),
  ]);

  assert.match(dialog, /reasonInput\?: "required" \| "hidden"/);
  assert.match(dialog, /operation\.reasonInput !== "hidden"/);
  assert.match(dialog, /label="Reason"/);
  assert.match(dialog, /Stored in the append-only authorization audit/);
  assert.doesNotMatch(roles, /reasonInput: "hidden"/);
});

test("submission has stable retry identity, double-click protection, controlled refresh, and no early clear", async () => {
  const workflow = await source(
    "app/admin/team/roles/CapabilityDraftWorkflow.tsx",
  );
  const apply = workflow.slice(
    workflow.indexOf("async function applyReview"),
    workflow.indexOf("function reloadLatest"),
  );
  const responseFailure = apply.indexOf("if (!response.ok)");
  const confirmed = apply.indexOf("setConfirmed(");
  const refresh = apply.indexOf('setRefreshMode("success")');

  assert.match(apply, /submitLockRef\.current/);
  assert.match(apply, /resolveCapabilityBatchRequestIdentity/);
  assert.match(apply, /crypto\.randomUUID\(\)/);
  assert.match(apply, /Retry keeps the same idempotency key/);
  assert.ok(responseFailure >= 0 && responseFailure < confirmed);
  assert.ok(confirmed < refresh);
  assert.doesNotMatch(apply.slice(0, confirmed), /setDraft\(\[\]\)/);
  assert.match(workflow, /reviewMatchesSnapshot/);
  assert.match(workflow, /router\.refresh\(\)/);
  assert.match(workflow, /rebaseCapabilityDraft/);
  assert.match(workflow, /Reload latest permissions/);
  assert.match(workflow, /requestIdentityRef\.current = null/);
  assert.match(workflow, /confirmed\.result\.replayed/);
  assert.match(
    workflow,
    /confirmDisabled=\{[\s\S]*externalSnapshotChanged/,
  );
  const cancel = workflow.slice(
    workflow.indexOf("onCancel={() =>"),
    workflow.indexOf("onConfirm=", workflow.indexOf("onCancel={() =>")),
  );
  assert.doesNotMatch(cancel, /setDraft\(\[\]\)/);
});

test("the server path derives the actor, revalidates all affected projections, and uses no direct DML", async () => {
  const [route, adapter] = await Promise.all([
    source("app/api/admin/team/roles/route.ts"),
    source("lib/auth/teamRoleMutations.ts"),
  ]);

  assert.ok(route.indexOf("requireAdmin()") < route.indexOf("request.json()"));
  assert.match(route, /admin\.discord_user_id/);
  assert.doesNotMatch(route, /actorDiscordUserId\s*:\s*payload/);
  for (const path of [
    "/admin/team/roles",
    "/admin/team/members",
    "/admin/team/authorization-history",
    "/admin/users",
  ]) {
    assert.match(route, new RegExp(`revalidatePath\\("${path}"\\)`, "u"));
  }
  assert.match(adapter, /supabaseAdmin\.rpc/);
  assert.match(adapter, /"apply_team_role_capability_changes"/);
  assert.match(adapter, /p_actor_discord_user_id: actorDiscordUserId/);
  assert.doesNotMatch(adapter, /\.(?:insert|update|delete)\(/);
  assert.doesNotMatch(
    adapter,
    /team_role_capabilities|team_authorization_batches|team_authorization_audit/,
  );
});

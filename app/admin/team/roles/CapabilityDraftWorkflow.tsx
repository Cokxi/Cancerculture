"use client";

import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import type {
  TeamRoleAdminCapability,
  TeamRoleAdminRole,
} from "@/lib/auth/teamRoleAdminReadModel";
import {
  getTeamCapabilityPermissionTab,
  TEAM_CAPABILITY_PERMISSION_TABS,
  type TeamCapabilityPermissionTab,
} from "@/lib/auth/teamCapabilityPresentation";
import {
  buildCapabilityBatchReview,
  capabilityDraftKey,
  permissionSnapshotFingerprint,
  rebaseCapabilityDraft,
  resolveCapabilityBatchRequestIdentity,
  summarizeCapabilityDraft,
  toggleCapabilityDraft,
  type TeamCapabilityBatchReview,
  type TeamCapabilityDraftConflict,
  type TeamCapabilityDraftEntry,
  type TeamCapabilityBatchRequestIdentity,
} from "@/lib/auth/teamCapabilityBatchDraft";
import {
  buttonClass,
  syncLabels,
  TeamMutationDialog,
} from "../TeamRoleMutationClient";

const builtInRoleLabels: Readonly<Record<string, string>> = {
  trial_moderator: "T Mod",
  moderator: "Mod",
  super_moderator: "S Mod",
};

const permissionTabLabels: Readonly<
  Record<TeamCapabilityPermissionTab, string>
> = {
  view: "View",
  actions: "Actions",
};

const PERMISSION_BATCH_REASON =
  "Permission grants updated through the reviewed SAVE batch.";

function roleLabel(role: TeamRoleAdminRole) {
  return builtInRoleLabels[role.key] ?? role.displayName;
}

type BatchResult = Readonly<{
  operation: "apply_team_role_capability_changes";
  batchId: string;
  replayed: boolean;
  submittedCount: number;
  changedCount: number;
  noopCount: number;
  grantCount: number;
  revokeCount: number;
  affectedRoles: readonly Readonly<{
    roleKey: string;
    rowVersion: number;
  }>[];
}>;

function isBatchResult(value: unknown): value is BatchResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  return (
    result.operation === "apply_team_role_capability_changes" &&
    typeof result.batchId === "string" &&
    typeof result.replayed === "boolean" &&
    typeof result.submittedCount === "number" &&
    typeof result.changedCount === "number" &&
    typeof result.noopCount === "number" &&
    typeof result.grantCount === "number" &&
    typeof result.revokeCount === "number" &&
    Array.isArray(result.affectedRoles)
  );
}

function reviewMatchesSnapshot(
  review: TeamCapabilityBatchReview,
  roles: readonly TeamRoleAdminRole[],
  result: BatchResult
) {
  const roleByKey = new Map(roles.map((role) => [role.key, role]));
  const desiredStatesMatch = review.entries.every((entry) => {
    const role = roleByKey.get(entry.roleKey);
    return (
      role?.grantedCapabilityKeys.includes(entry.capabilityKey) ===
      entry.desiredGranted
    );
  });
  const versionsMatch = result.affectedRoles.every((affected) => {
    const role = roleByKey.get(affected.roleKey);
    return role?.rowVersion === affected.rowVersion;
  });
  return desiredStatesMatch && versionsMatch;
}

function ReviewDiff({
  review,
}: {
  review: TeamCapabilityBatchReview;
}) {
  const summary = summarizeCapabilityDraft(
    review.entries.map((entry) => ({
      roleKey: entry.roleKey,
      capabilityKey: entry.capabilityKey,
      originalGranted: entry.originalGranted,
      desiredGranted: entry.desiredGranted,
    }))
  );

  return (
    <div className="grid gap-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-5">
        <div>
          <dt className="text-white/45">Changes</dt>
          <dd className="font-semibold">{summary.total}</dd>
        </div>
        <div>
          <dt className="text-white/45">Grants</dt>
          <dd className="font-semibold text-green-300">
            {summary.grants}
          </dd>
        </div>
        <div>
          <dt className="text-white/45">Revocations</dt>
          <dd className="font-semibold text-red-300">
            {summary.revocations}
          </dd>
        </div>
        <div>
          <dt className="text-white/45">Roles</dt>
          <dd className="font-semibold">{summary.roles}</dd>
        </div>
        <div>
          <dt className="text-white/45">Capabilities</dt>
          <dd className="font-semibold">{summary.capabilities}</dd>
        </div>
      </dl>

      <ul className="grid max-h-[42vh] gap-2 overflow-y-auto pr-1">
        {review.entries.map((entry) => (
          <li
            key={capabilityDraftKey(
              entry.roleKey,
              entry.capabilityKey
            )}
            className="rounded-md border border-white/10 bg-black/20 p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-sm">
                {entry.capabilityDisplayName}
              </strong>
              <span
                className={
                  entry.desiredGranted
                    ? "text-xs font-semibold text-green-300"
                    : "text-xs font-semibold text-red-300"
                }
              >
                {entry.desiredGranted ? "+ Grant" : "− Revoke"}
              </span>
            </div>
            <p className="mt-1 text-xs text-white/70">
              {entry.roleDisplayName}{" "}
              <code className="text-white/45">
                {entry.roleKey}
              </code>
            </p>
            <p className="mt-1 break-all text-[0.6875rem] text-white/45">
              {entry.capabilityKey}
            </p>
            <p className="mt-2 text-xs text-white/60">
              {entry.originalGranted ? "Granted" : "Not granted"} →{" "}
              {entry.desiredGranted ? "Granted" : "Not granted"}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CapabilityDetails({
  capability,
  detailsId,
  headingId,
  hidden,
}: {
  capability: TeamRoleAdminCapability;
  detailsId: string;
  headingId: string;
  hidden: boolean;
}) {
  return (
    <div
      id={detailsId}
      hidden={hidden}
      role="region"
      aria-labelledby={headingId}
      className="mt-3 grid gap-3 rounded-lg border border-white/10 bg-black/15 p-3 text-xs sm:p-4"
    >
      {capability.description.trim().length > 0 ? (
        <p className="max-w-4xl leading-relaxed text-white/65">
          {capability.description}
        </p>
      ) : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-white/40">Key</dt>
        <dd className="break-all font-mono">{capability.key}</dd>
        <dt className="text-white/40">Category</dt>
        <dd>{capability.category}</dd>
        <dt className="text-white/40">Risk</dt>
        <dd>{capability.riskLevel}</dd>
        <dt className="text-white/40">Registry / catalog</dt>
        <dd>{syncLabels[capability.syncStatus]}</dd>
      </dl>
      {capability.includedActions.length > 0 ? (
        <div>
          <strong className="text-green-300">Included actions</strong>
          <ul className="mt-1 list-disc pl-5 text-white/60">
            {capability.includedActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {capability.excludedActions.length > 0 ? (
        <div>
          <strong className="text-red-300">Exclusions</strong>
          <ul className="mt-1 list-disc pl-5 text-white/60">
            {capability.excludedActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function CapabilityBlock({
  capability,
  roles,
  draft,
  locked,
  onToggle,
}: {
  capability: TeamRoleAdminCapability;
  roles: readonly TeamRoleAdminRole[];
  draft: readonly TeamCapabilityDraftEntry[];
  locked: boolean;
  onToggle: (role: TeamRoleAdminRole) => void;
}) {
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const disabled =
    locked ||
    !capability.mutable ||
    capability.implementationVersion === null ||
    capability.definitionHash === null;
  const headingId = `capability-${capability.key}`;
  const detailsId = `${headingId}-details`;

  return (
    <article
      aria-labelledby={headingId}
      data-capability-block
      className="rounded-lg border border-white/10 bg-white/[0.025] p-3 sm:p-3.5"
    >
      <div
        data-capability-layout
        className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,5fr)] lg:items-center lg:gap-4"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h2
            id={headingId}
            className="text-sm font-semibold leading-snug text-white/90"
          >
            {capability.displayName}
          </h2>
          <button
            type="button"
            aria-expanded={detailsExpanded}
            aria-controls={detailsId}
            aria-label={`${
              detailsExpanded ? "Hide" : "Show"
            } details for ${capability.displayName}`}
            className="inline-flex cursor-pointer items-center gap-1 rounded-sm px-1.5 py-1 text-xs font-medium text-white/55 outline-none hover:bg-white/5 hover:text-white/80 focus-visible:ring-2 focus-visible:ring-orange-300"
            onClick={() =>
              setDetailsExpanded((expanded) => !expanded)
            }
          >
            <span aria-hidden="true">
              {detailsExpanded ? "▾" : "▸"}
            </span>
            Details
          </button>
        </div>

        <div
          data-role-controls
          className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3"
        >
          {roles.map((role) => {
            const originalGranted =
              role.grantedCapabilityKeys.includes(capability.key);
            const draftEntry = draft.find(
              (entry) =>
                entry.roleKey === role.key &&
                entry.capabilityKey === capability.key
            );
            const desiredGranted =
              draftEntry?.desiredGranted ?? originalGranted;
            const status = draftEntry
              ? draftEntry.desiredGranted
                ? "+ Grant"
                : "− Revoke"
              : originalGranted
                ? "✓ Saved · Granted"
                : "Not granted · unchanged";
            const statusClass = draftEntry
              ? draftEntry.desiredGranted
                ? "border-green-500/50 bg-green-950/25 text-green-200"
                : "border-red-500/50 bg-red-950/25 text-red-200"
              : "border-white/10 bg-black/15 text-white/60";

            return (
              <div
                key={role.key}
                data-role-control
                className="flex min-w-0 items-center gap-2 rounded-md border border-white/10 bg-black/10 p-1.5"
              >
                <div className="min-w-0 flex-1 pl-1">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                    <strong className="break-words text-xs leading-snug">
                      {roleLabel(role)}
                    </strong>
                    {!role.isSystem ? (
                      <span className="text-[0.6875rem] text-white/40">
                        Custom
                      </span>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  data-draft-status={
                    draftEntry
                      ? draftEntry.desiredGranted
                        ? "grant"
                        : "revoke"
                      : originalGranted
                        ? "saved"
                        : "unchanged"
                  }
                  aria-pressed={desiredGranted}
                  aria-label={`${role.displayName}: ${status}. Toggle ${capability.displayName}.`}
                  className={`${buttonClass} min-w-[8.5rem] shrink-0 px-2.5 py-1.5 text-xs ${statusClass}`}
                  disabled={disabled}
                  onClick={() => onToggle(role)}
                >
                  {status}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <CapabilityDetails
        capability={capability}
        detailsId={detailsId}
        headingId={headingId}
        hidden={!detailsExpanded}
      />
      {!capability.mutable ? (
        <p className="mt-2 text-xs text-red-300">
          Draft changes are locked while registry and catalog metadata are
          not synchronized.
        </p>
      ) : null}
    </article>
  );
}

function conflictMessage(
  conflict: TeamCapabilityDraftConflict
) {
  return conflict.reason === "role_unavailable"
    ? `${conflict.entry.roleKey} is no longer an active role.`
    : `${conflict.entry.capabilityKey} is no longer available for assignment.`;
}

export default function CapabilityDraftWorkflow({
  roles,
  capabilities,
  roleMutationPending,
  onBlockingChange,
}: {
  roles: readonly TeamRoleAdminRole[];
  capabilities: readonly TeamRoleAdminCapability[];
  roleMutationPending: boolean;
  onBlockingChange: (blocked: boolean) => void;
}) {
  const router = useRouter();
  const [baseRoles, setBaseRoles] = useState(roles);
  const [baseCapabilities, setBaseCapabilities] =
    useState(capabilities);
  const [draft, setDraft] = useState<
    readonly TeamCapabilityDraftEntry[]
  >([]);
  const [conflicts, setConflicts] = useState<
    readonly TeamCapabilityDraftConflict[]
  >([]);
  const [review, setReview] =
    useState<TeamCapabilityBatchReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [reloadAvailable, setReloadAvailable] = useState(false);
  const [externalSnapshotChanged, setExternalSnapshotChanged] =
    useState(false);
  const [refreshMode, setRefreshMode] = useState<
    "success" | "rebase" | null
  >(null);
  const [refreshObserved, setRefreshObserved] = useState(false);
  const [confirmed, setConfirmed] = useState<{
    review: TeamCapabilityBatchReview;
    result: BatchResult;
  } | null>(null);
  const [refreshPending, startRefresh] = useTransition();
  const requestIdentityRef =
    useRef<TeamCapabilityBatchRequestIdentity | null>(null);
  const submitLockRef = useRef(false);
  const [activePermissionTab, setActivePermissionTab] =
    useState<TeamCapabilityPermissionTab>("view");
  const permissionTabRefs = useRef<
    Record<TeamCapabilityPermissionTab, HTMLButtonElement | null>
  >({ view: null, actions: null });

  const incomingFingerprint = useMemo(
    () => permissionSnapshotFingerprint(roles, capabilities),
    [roles, capabilities]
  );
  const baseFingerprint = useMemo(
    () =>
      permissionSnapshotFingerprint(
        baseRoles,
        baseCapabilities
      ),
    [baseRoles, baseCapabilities]
  );
  const summary = useMemo(
    () => summarizeCapabilityDraft(draft),
    [draft]
  );
  const capabilitiesByTab = useMemo(
    () =>
      Object.freeze({
        view: baseCapabilities.filter(
          (capability) =>
            getTeamCapabilityPermissionTab(capability.key) === "view"
        ),
        actions: baseCapabilities.filter(
          (capability) =>
            getTeamCapabilityPermissionTab(capability.key) === "actions"
        ),
      }),
    [baseCapabilities]
  );
  const blocked =
    draft.length > 0 ||
    conflicts.length > 0 ||
    review !== null ||
    busy;

  useEffect(() => {
    onBlockingChange(blocked);
  }, [blocked, onBlockingChange]);

  useEffect(() => {
    if (!blocked) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [blocked]);

  useEffect(() => {
    if (refreshMode && refreshPending) {
      setRefreshObserved(true);
      return;
    }
    if (!refreshMode || !refreshObserved || refreshPending) {
      return;
    }

    if (refreshMode === "success" && confirmed) {
      if (
        reviewMatchesSnapshot(
          confirmed.review,
          roles,
          confirmed.result
        )
      ) {
        setBaseRoles(roles);
        setBaseCapabilities(capabilities);
        setDraft([]);
        setConflicts([]);
        setReview(null);
        setError(null);
        setReloadAvailable(false);
        setExternalSnapshotChanged(false);
        setSuccess(
          confirmed.result.replayed
            ? "Permission changes confirmed from the atomic replay."
            : "Permission changes saved atomically."
        );
        requestIdentityRef.current = null;
      } else {
        setError(
          "The batch succeeded, but the refreshed permission snapshot could not be confirmed. Reload latest permissions before another review."
        );
        setReloadAvailable(true);
      }
    } else if (refreshMode === "rebase") {
      const rebased = rebaseCapabilityDraft(
        draft,
        roles,
        capabilities
      );
      setBaseRoles(roles);
      setBaseCapabilities(capabilities);
      setDraft(rebased.draft);
      setConflicts(rebased.conflicts);
      setReview(null);
      setError(
        rebased.conflicts.length > 0
          ? "Some reviewed roles or capabilities are no longer available. Discard those changes before reviewing again."
          : "Latest permissions loaded. Remaining differences require a new review."
      );
      setReloadAvailable(false);
      setExternalSnapshotChanged(false);
      requestIdentityRef.current = null;
    }

    setConfirmed(null);
    setRefreshMode(null);
    setRefreshObserved(false);
  }, [
    capabilities,
    confirmed,
    draft,
    refreshMode,
    refreshObserved,
    refreshPending,
    roles,
  ]);

  useEffect(() => {
    if (refreshMode) return;
    if (draft.length === 0 && conflicts.length === 0 && !review) {
      setBaseRoles(roles);
      setBaseCapabilities(capabilities);
      setExternalSnapshotChanged(false);
      return;
    }
    if (incomingFingerprint !== baseFingerprint) {
      setExternalSnapshotChanged(true);
      setError(
        "The server snapshot changed while this review was open. Reload latest permissions and review the rebased draft again."
      );
      setReloadAvailable(true);
    }
  }, [
    baseFingerprint,
    capabilities,
    conflicts.length,
    draft.length,
    incomingFingerprint,
    refreshMode,
    review,
    roles,
  ]);

  function toggle(
    role: TeamRoleAdminRole,
    capability: TeamRoleAdminCapability
  ) {
    if (review || busy || roleMutationPending || refreshPending) {
      return;
    }
    const originalGranted =
      role.grantedCapabilityKeys.includes(capability.key);
    setDraft((current) =>
      toggleCapabilityDraft(current, {
        roleKey: role.key,
        capabilityKey: capability.key,
        originalGranted,
      })
    );
    setConflicts([]);
    setError(null);
    setSuccess(null);
    setReloadAvailable(false);
    requestIdentityRef.current = null;
  }

  function openReview() {
    if (
      draft.length === 0 ||
      conflicts.length > 0 ||
      externalSnapshotChanged ||
      roleMutationPending
    ) {
      return;
    }
    try {
      setReview(
        buildCapabilityBatchReview(
          draft,
          baseRoles,
          baseCapabilities
        )
      );
      setError(null);
      setSuccess(null);
      requestIdentityRef.current = null;
    } catch {
      setError(
        "The permission draft is no longer reviewable. Reload latest permissions."
      );
      setReloadAvailable(true);
    }
  }

  async function applyReview() {
    if (
      !review ||
      busy ||
      externalSnapshotChanged ||
      submitLockRef.current
    ) {
      return;
    }
    requestIdentityRef.current =
      resolveCapabilityBatchRequestIdentity(
        requestIdentityRef.current,
        review.fingerprint,
        PERMISSION_BATCH_REASON,
        () => crypto.randomUUID()
      );
    const requestIdentity = requestIdentityRef.current;
    submitLockRef.current = true;
    setBusy(true);
    setError(null);
    setReloadAvailable(false);

    try {
      const response = await fetch("/api/admin/team/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "apply_team_role_capability_changes",
          roleSnapshots: review.roleSnapshots,
          capabilitySnapshots: review.capabilitySnapshots,
          changes: review.changes,
          confirmationWord: "SAVE",
          reason: PERMISSION_BATCH_REASON,
          idempotencyKey: requestIdentity.idempotencyKey,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(
          typeof body?.error === "string"
            ? body.error
            : "The atomic permission batch could not be applied."
        );
        setReloadAvailable(
          response.status === 404 ||
            response.status === 409 ||
            body?.code === "CAPABILITY_REGISTRY_DRIFT"
        );
        if (response.status === 403 || response.status === 503) {
          router.refresh();
        }
        return;
      }

      if (!isBatchResult(body?.result)) {
        setError(
          "The authorization service returned an invalid response. Retry keeps the same idempotency key."
        );
        return;
      }

      setConfirmed({ review, result: body.result });
      setRefreshMode("success");
      setRefreshObserved(false);
      startRefresh(() => router.refresh());
    } catch {
      setError(
        "The authorization service could not be reached. Retry keeps the same idempotency key."
      );
    } finally {
      submitLockRef.current = false;
      setBusy(false);
    }
  }

  function reloadLatest() {
    if (busy || refreshPending) return;
    setReview(null);
    setRefreshMode("rebase");
    setRefreshObserved(false);
    setError(null);
    requestIdentityRef.current = null;
    startRefresh(() => router.refresh());
  }

  return (
    <section aria-labelledby="permission-blocks" className="grid gap-3">
      <div>
        <h2 id="permission-blocks" className="text-lg font-semibold">
          Permissions
        </h2>
        <p className="mt-1 text-sm text-white/55">
          Build a local draft, review every difference, then save the
          complete batch atomically.
        </p>
      </div>

      {success ? (
        <p
          role="status"
          className="rounded-lg border border-green-500/40 bg-green-950/20 p-3 text-sm text-green-200"
        >
          {success}
        </p>
      ) : null}

      <div
        role="tablist"
        aria-label="Permission type"
        className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-black/20 p-1.5"
      >
        {TEAM_CAPABILITY_PERMISSION_TABS.map((tab, index) => {
          const selected = activePermissionTab === tab;
          return (
            <button
              key={tab}
              ref={(element) => {
                permissionTabRefs.current[tab] = element;
              }}
              id={`permission-tab-${tab}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`permission-panel-${tab}`}
              tabIndex={selected ? 0 : -1}
              className={`cursor-pointer rounded-lg px-3 py-2 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-orange-300 ${
                selected
                  ? "bg-orange-500/20 text-orange-200"
                  : "text-white/55 hover:bg-white/5 hover:text-white/85"
              }`}
              onClick={() => setActivePermissionTab(tab)}
              onKeyDown={(event) => {
                let nextIndex = index;
                if (event.key === "ArrowRight") {
                  nextIndex =
                    (index + 1) %
                    TEAM_CAPABILITY_PERMISSION_TABS.length;
                } else if (event.key === "ArrowLeft") {
                  nextIndex =
                    (index - 1 + TEAM_CAPABILITY_PERMISSION_TABS.length) %
                    TEAM_CAPABILITY_PERMISSION_TABS.length;
                } else if (event.key === "Home") {
                  nextIndex = 0;
                } else if (event.key === "End") {
                  nextIndex = TEAM_CAPABILITY_PERMISSION_TABS.length - 1;
                } else {
                  return;
                }
                event.preventDefault();
                const nextTab = TEAM_CAPABILITY_PERMISSION_TABS[nextIndex];
                setActivePermissionTab(nextTab);
                permissionTabRefs.current[nextTab]?.focus();
              }}
            >
              {permissionTabLabels[tab]}{" "}
              <span className="text-xs text-white/45">
                ({capabilitiesByTab[tab].length})
              </span>
            </button>
          );
        })}
      </div>

      <div
        id={`permission-panel-${activePermissionTab}`}
        role="tabpanel"
        aria-labelledby={`permission-tab-${activePermissionTab}`}
        className="grid gap-3"
      >
        {capabilitiesByTab[activePermissionTab].map((capability) => (
          <CapabilityBlock
            key={capability.key}
            capability={capability}
            roles={baseRoles}
            draft={draft}
            locked={
              review !== null ||
              busy ||
              roleMutationPending ||
              refreshPending
            }
            onToggle={(role) => toggle(role, capability)}
          />
        ))}
      </div>

      <div
        data-draft-summary
        className="rounded-xl border border-white/15 bg-neutral-950/95 p-3 shadow-lg sm:p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <strong className="text-sm text-orange-200">
              Permission draft
            </strong>
            {summary.total > 0 ? (
              <p className="mt-1 text-xs text-white/60">
                {summary.total} change(s) · {summary.grants} grant(s) ·{" "}
                {summary.revocations} revocation(s) · {summary.roles}{" "}
                role(s) · {summary.capabilities} capability(s)
              </p>
            ) : (
              <p className="mt-1 text-xs text-white/45">
                No unsaved permission changes.
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={summary.total === 0 || busy}
              onClick={() => {
                setDraft([]);
                setConflicts([]);
                setReview(null);
                setError(null);
                setReloadAvailable(false);
                setExternalSnapshotChanged(false);
                requestIdentityRef.current = null;
              }}
            >
              Discard changes
            </button>
            <button
              type="button"
              className={`${buttonClass} border-orange-400/60 bg-orange-500/15 text-orange-200`}
              disabled={
                summary.total === 0 ||
                conflicts.length > 0 ||
                externalSnapshotChanged ||
                roleMutationPending ||
                busy ||
                refreshPending
              }
              onClick={openReview}
            >
              Review changes
            </button>
          </div>
        </div>

        {externalSnapshotChanged ? (
          <p role="alert" className="mt-3 text-xs text-amber-200">
            The server snapshot changed while this draft was open. Reload
            latest permissions before reviewing.
          </p>
        ) : null}
        {conflicts.length > 0 ? (
          <ul role="alert" className="mt-3 grid gap-1 text-xs text-red-200">
            {conflicts.map((conflict) => (
              <li
                key={capabilityDraftKey(
                  conflict.entry.roleKey,
                  conflict.entry.capabilityKey
                )}
              >
                {conflictMessage(conflict)}
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 text-xs text-red-300">
            {error}
          </p>
        ) : null}
        {reloadAvailable || externalSnapshotChanged ? (
          <button
            type="button"
            className={`${buttonClass} mt-3 text-amber-200`}
            disabled={busy || refreshPending}
            onClick={reloadLatest}
          >
            Reload latest permissions
          </button>
        ) : null}
      </div>

      {review ? (
        <TeamMutationDialog
          key={review.fingerprint}
          operation={{
            title: "Review permission changes",
            successMessage: "Permission changes saved atomically.",
            summary: <ReviewDiff review={review} />,
            warning:
              "Every listed Grant and Revoke is submitted in one all-or-nothing authorization batch.",
            payload: {},
            confirmationWord: "SAVE",
            reasonInput: "hidden",
          }}
          busy={busy || refreshPending}
          confirmDisabled={
            externalSnapshotChanged || review.entries.length === 0
          }
          error={error}
          confirmLabel="Apply changes"
          onCancel={() => {
            if (!busy && !refreshPending) {
              setReview(null);
              setError(null);
              setReloadAvailable(false);
              requestIdentityRef.current = null;
            }
          }}
          onConfirm={() => void applyReview()}
        />
      ) : null}
    </section>
  );
}

"use client";

import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  TeamAuthorizationAuditEntry,
  TeamRoleAdminCapability,
  TeamRoleAdminMember,
  TeamRoleAdminReadModel,
  TeamRoleAdminRole,
  TeamCapabilitySyncStatus,
} from "@/lib/auth/teamRoleAdminReadModel";

type MutationOperation = {
  title: string;
  summary: ReactNode;
  warning?: string;
  successMessage: string;
  payload: Record<string, unknown>;
  requiresAdminWord?: boolean;
};

type MutationMessage = {
  kind: "success" | "error";
  text: string;
};

const inputClass =
  "w-full rounded border border-white/20 bg-black/40 px-3 py-2 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-orange-300 disabled:opacity-50";
const buttonClass =
  "rounded border border-white/20 bg-white/5 px-3 py-2 text-sm font-medium text-white outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-orange-300 disabled:cursor-not-allowed disabled:opacity-40";

const syncLabels: Readonly<
  Record<TeamCapabilitySyncStatus, string>
> = {
  synchronized: "Synchronized",
  code_missing: "Missing from code registry",
  catalog_missing: "Missing from database catalog",
  definition_mismatch: "Definition mismatch",
  version_mismatch: "Version mismatch",
  inactive: "Inactive",
  not_assignable: "Not assignable",
};

const eventLabels: Readonly<Record<string, string>> = {
  role_created: "Role created",
  role_updated: "Role updated",
  role_activated: "Role activated",
  role_deactivated: "Role deactivated",
  capability_granted: "Capability granted",
  capability_revoked: "Capability revoked",
  member_role_changed: "Member role changed",
  admin_role_changed: "Owner access changed",
};

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium text-white/90">{label}</span>
      {children}
      {hint ? (
        <span className="text-xs text-white/50">{hint}</span>
      ) : null}
    </label>
  );
}

function MutationDialog({
  operation,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  operation: MutationOperation;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (reason: string, adminWord: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [adminWord, setAdminWord] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  const valid =
    reason.trim().length >= 3 &&
    (!operation.requiresAdminWord || adminWord === "ADMIN");

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="team-mutation-title"
      aria-describedby="team-mutation-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="m-auto w-[min(620px,calc(100%-2rem))] rounded-xl border border-white/20 bg-neutral-950 p-0 text-white shadow-2xl backdrop:bg-black/80"
    >
      <form
        method="dialog"
        className="grid gap-5 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !busy) {
            onConfirm(reason.trim(), adminWord);
          }
        }}
      >
        <div>
          <h2
            id="team-mutation-title"
            className="text-xl font-semibold text-orange-300"
          >
            {operation.title}
          </h2>
          <div
            id="team-mutation-description"
            className="mt-3 rounded-lg border border-white/10 bg-white/5 p-4 text-sm text-white/80"
          >
            {operation.summary}
          </div>
        </div>

        {operation.warning ? (
          <div
            role="note"
            className="rounded-lg border border-amber-500/50 bg-amber-950/30 p-3 text-sm text-amber-200"
          >
            <strong>Important:</strong> {operation.warning}
          </div>
        ) : null}

        <Field
          label="Reason"
          hint="Required. Stored in the append-only authorization audit."
        >
          <textarea
            autoFocus
            className={`${inputClass} min-h-24`}
            value={reason}
            disabled={busy}
            maxLength={1000}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Explain why this authorization change is required"
          />
        </Field>

        {operation.requiresAdminWord ? (
          <Field
            label='Type "ADMIN" to confirm'
            hint="Owner access is independent from capability grants."
          >
            <input
              className={inputClass}
              value={adminWord}
              disabled={busy}
              autoComplete="off"
              onChange={(event) => setAdminWord(event.target.value)}
            />
          </Field>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-3">
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={`${buttonClass} border-orange-400/60 bg-orange-500/15 text-orange-200`}
            disabled={busy || !valid}
          >
            {busy ? "Applying…" : "Confirm change"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function CreateRoleForm({
  onReview,
}: {
  onReview: (operation: MutationOperation) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [sortOrder, setSortOrder] = useState("50");

  function submit(event: FormEvent) {
    event.preventDefault();
    const numericSortOrder = Number(sortOrder);
    if (
      displayName.trim().length === 0 ||
      !Number.isSafeInteger(numericSortOrder)
    ) {
      return;
    }

    onReview({
      title: "Create non-Admin role",
      successMessage: "Role created with no capability grants.",
      summary: (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-white/50">Before</dt>
          <dd>No role</dd>
          <dt className="text-white/50">After</dt>
          <dd>
            {displayName.trim()} · sort {numericSortOrder} · active ·
            zero grants
          </dd>
          <dt className="text-white/50">Technical key</dt>
          <dd>Generated securely by the database</dd>
        </dl>
      ),
      payload: {
        operation: "create_role",
        displayName: displayName.trim(),
        description: description.trim(),
        sortOrder: numericSortOrder,
      },
    });
  }

  return (
    <form
      onSubmit={submit}
      className="grid gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-5"
    >
      <div>
        <h2 className="text-lg font-semibold">Create role</h2>
        <p className="mt-1 text-sm text-white/60">
          The technical key is generated by the database. New roles
          start active and receive no automatic grants.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Display name">
          <input
            className={inputClass}
            maxLength={100}
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        <Field label="Sort order">
          <input
            className={inputClass}
            type="number"
            min={-100000}
            max={100000}
            required
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
          />
        </Field>
      </div>
      <Field label="Description">
        <textarea
          className={`${inputClass} min-h-20`}
          maxLength={1000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <button
        className={`${buttonClass} justify-self-start text-orange-200`}
        type="submit"
      >
        Review role creation
      </button>
    </form>
  );
}

function RoleCard({
  role,
  onReview,
}: {
  role: TeamRoleAdminRole;
  onReview: (operation: MutationOperation) => void;
}) {
  const [displayName, setDisplayName] = useState(role.displayName);
  const [description, setDescription] = useState(role.description);
  const [sortOrder, setSortOrder] = useState(
    String(role.sortOrder)
  );
  const isAdmin = role.key === "admin";
  const numericSortOrder = Number(sortOrder);
  const changed =
    displayName.trim() !== role.displayName ||
    description.trim() !== role.description ||
    numericSortOrder !== role.sortOrder;

  return (
    <article className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold">{role.displayName}</h3>
            <span className="rounded-full border border-white/20 px-2 py-0.5 text-xs">
              {isAdmin
                ? "Owner / system"
                : role.isSystem
                  ? "Built-in"
                  : "Custom"}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                role.isActive
                  ? "bg-green-950 text-green-300"
                  : "bg-neutral-800 text-white/50"
              }`}
            >
              {role.isActive ? "Active" : "Inactive"}
            </span>
          </div>
          <code className="mt-1 block text-xs text-white/50">
            {role.key}
          </code>
          <p className="mt-2 max-w-3xl text-sm text-white/70">
            {role.description || "No description"}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-3 text-xs text-white/60">
          <dt>Members</dt>
          <dd className="text-right">{role.memberCount}</dd>
          <dt>Capabilities</dt>
          <dd className="text-right">
            {role.grantedCapabilityKeys.length}
          </dd>
          <dt>Sort</dt>
          <dd className="text-right">{role.sortOrder}</dd>
          <dt>Version</dt>
          <dd className="text-right">{role.rowVersion}</dd>
        </dl>
      </div>

      {isAdmin ? (
        <div className="mt-4 rounded border border-orange-500/30 bg-orange-950/20 p-3 text-sm text-orange-200">
          This immutable Owner role is read-only and remains outside
          the capability matrix.
        </div>
      ) : (
        <div className="mt-5 grid gap-4">
          <details className="rounded-lg border border-white/10 p-4">
            <summary className="cursor-pointer font-medium">
              Edit metadata
            </summary>
            <form
              className="mt-4 grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!changed || !Number.isSafeInteger(numericSortOrder)) {
                  return;
                }
                onReview({
                  title: `Update ${role.displayName}`,
                  successMessage: "Role metadata updated.",
                  summary: (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                      <dt className="text-white/50">Before</dt>
                      <dd>
                        {role.displayName} · sort {role.sortOrder}
                      </dd>
                      <dt className="text-white/50">After</dt>
                      <dd>
                        {displayName.trim()} · sort {numericSortOrder}
                      </dd>
                      <dt className="text-white/50">Key</dt>
                      <dd>{role.key} (unchanged)</dd>
                    </dl>
                  ),
                  payload: {
                    operation: "update_role",
                    roleKey: role.key,
                    displayName: displayName.trim(),
                    description: description.trim(),
                    sortOrder: numericSortOrder,
                    expectedRowVersion: role.rowVersion,
                  },
                });
              }}
            >
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Display name">
                  <input
                    className={inputClass}
                    required
                    maxLength={100}
                    value={displayName}
                    onChange={(event) =>
                      setDisplayName(event.target.value)
                    }
                  />
                </Field>
                <Field label="Sort order">
                  <input
                    className={inputClass}
                    type="number"
                    min={-100000}
                    max={100000}
                    required
                    value={sortOrder}
                    onChange={(event) =>
                      setSortOrder(event.target.value)
                    }
                  />
                </Field>
              </div>
              <Field label="Description">
                <textarea
                  className={`${inputClass} min-h-20`}
                  maxLength={1000}
                  value={description}
                  onChange={(event) =>
                    setDescription(event.target.value)
                  }
                />
              </Field>
              <button
                className={buttonClass}
                type="submit"
                disabled={
                  !changed ||
                  !displayName.trim() ||
                  !Number.isSafeInteger(numericSortOrder)
                }
              >
                Review metadata change
              </button>
            </form>
          </details>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={`${buttonClass} ${
                role.isActive ? "text-red-200" : "text-green-200"
              }`}
              disabled={role.isActive && !role.canDeactivate}
              title={
                role.isActive && !role.canDeactivate
                  ? "Move every member to another role first."
                  : undefined
              }
              onClick={() =>
                onReview({
                  title: role.isActive
                    ? `Deactivate ${role.displayName}`
                    : `Activate ${role.displayName}`,
                  successMessage: role.isActive
                    ? "Role deactivated. Existing grants were preserved."
                    : "Role activated with its stored grants.",
                  warning: role.isActive
                    ? "Assigned permissions stop resolving while the role is inactive. Capability grants remain stored."
                    : "Stored capability grants become effective again after activation.",
                  summary: (
                    <p>
                      Change <strong>{role.displayName}</strong> from{" "}
                      {role.isActive ? "active" : "inactive"} to{" "}
                      {role.isActive ? "inactive" : "active"}.
                    </p>
                  ),
                  payload: {
                    operation: "set_role_active",
                    roleKey: role.key,
                    isActive: !role.isActive,
                    expectedRowVersion: role.rowVersion,
                  },
                })
              }
            >
              {role.isActive ? "Deactivate role" : "Activate role"}
            </button>
            {role.isActive && !role.canDeactivate ? (
              <span className="text-xs text-white/50">
                Move all {role.memberCount} assigned member(s) first.
              </span>
            ) : null}
            <span className="text-xs text-white/40">
              Roles are never physically deleted.
            </span>
          </div>
        </div>
      )}
    </article>
  );
}

function CapabilityDetails({
  capability,
}: {
  capability: TeamRoleAdminCapability;
}) {
  return (
    <div className="grid gap-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <strong>{capability.displayName}</strong>
          <span className="rounded border border-white/20 px-2 py-0.5 text-xs">
            Risk: {capability.riskLevel}
          </span>
          <span
            className={`rounded px-2 py-0.5 text-xs ${
              capability.mutable
                ? "bg-green-950 text-green-300"
                : "bg-red-950 text-red-300"
            }`}
          >
            {syncLabels[capability.syncStatus]}
          </span>
        </div>
        <code className="mt-1 block text-xs text-white/50">
          {capability.key}
        </code>
        <p className="mt-2 text-sm text-white/70">
          {capability.description}
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="text-xs font-semibold uppercase text-green-300">
            Included
          </div>
          <ul className="mt-1 list-disc pl-5 text-xs text-white/60">
            {capability.includedActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </div>
        <div>
          <div className="text-xs font-semibold uppercase text-red-300">
            Explicitly excluded
          </div>
          <ul className="mt-1 list-disc pl-5 text-xs text-white/60">
            {capability.excludedActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </div>
      </div>
      {capability.deprecatedAt ? (
        <p className="text-xs text-amber-300">
          Deprecated at{" "}
          {new Date(capability.deprecatedAt).toLocaleString()}
        </p>
      ) : null}
    </div>
  );
}

function CapabilityMatrix({
  readModel,
  onReview,
}: {
  readModel: TeamRoleAdminReadModel;
  onReview: (operation: MutationOperation) => void;
}) {
  const roles = readModel.roles.filter(
    (role) => role.key !== "admin"
  );
  const grouped = useMemo(() => {
    const result = new Map<string, TeamRoleAdminCapability[]>();
    for (const capability of readModel.capabilities) {
      const entries = result.get(capability.category) ?? [];
      entries.push(capability);
      result.set(capability.category, entries);
    }
    return [...result.entries()];
  }, [readModel.capabilities]);

  return (
    <section className="grid gap-5">
      <div>
        <h2 className="text-xl font-semibold">Capability matrix</h2>
        <p className="mt-1 text-sm text-white/60">
          Owner access is deliberately excluded. Capabilities with
          registry or catalog drift remain visible but locked.
        </p>
      </div>

      {grouped.map(([category, capabilities]) => (
        <div
          key={category}
          className="overflow-x-auto rounded-xl border border-white/10"
        >
          <h3 className="border-b border-white/10 bg-white/5 px-4 py-3 font-semibold">
            {category}
          </h3>
          <table className="min-w-full border-collapse text-left">
            <thead>
              <tr className="text-xs uppercase text-white/50">
                <th className="min-w-80 p-4">Capability</th>
                {roles.map((role) => (
                  <th key={role.key} className="min-w-40 p-4">
                    {role.displayName}
                    <span className="block normal-case text-white/40">
                      v{role.rowVersion}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {capabilities.map((capability) => (
                <tr
                  key={capability.key}
                  className="border-t border-white/10 align-top"
                >
                  <td className="p-4">
                    <CapabilityDetails capability={capability} />
                  </td>
                  {roles.map((role) => {
                    const granted =
                      role.grantedCapabilityKeys.includes(
                        capability.key
                      );
                    const disabled =
                      !capability.mutable ||
                      capability.implementationVersion === null ||
                      capability.definitionHash === null;
                    return (
                      <td key={role.key} className="p-4">
                        <div className="grid gap-2">
                          <span className="text-sm">
                            {granted ? "Granted" : "Not granted"}
                          </span>
                          <button
                            type="button"
                            className={`${buttonClass} ${
                              granted
                                ? "text-red-200"
                                : "text-green-200"
                            }`}
                            disabled={disabled}
                            aria-label={`${
                              granted ? "Revoke" : "Grant"
                            } ${capability.displayName} for ${
                              role.displayName
                            }`}
                            onClick={() =>
                              onReview({
                                title: `${
                                  granted ? "Revoke" : "Grant"
                                } capability`,
                                successMessage: granted
                                  ? "Capability revoked."
                                  : "Capability granted.",
                                warning:
                                  capability.riskLevel === "high" ||
                                  capability.riskLevel === "critical"
                                    ? `This is a ${capability.riskLevel}-risk capability. Review every included and excluded action.`
                                    : undefined,
                                summary: (
                                  <div className="grid gap-3">
                                    <p>
                                      <strong>{role.displayName}</strong>
                                      : {granted ? "granted" : "not granted"}{" "}
                                      →{" "}
                                      {granted
                                        ? "not granted"
                                        : "granted"}
                                    </p>
                                    <CapabilityDetails
                                      capability={capability}
                                    />
                                  </div>
                                ),
                                payload: {
                                  operation:
                                    "set_role_capability",
                                  roleKey: role.key,
                                  capabilityKey: capability.key,
                                  granted: !granted,
                                  expectedRoleRowVersion:
                                    role.rowVersion,
                                  expectedCapabilityImplementationVersion:
                                    capability.implementationVersion,
                                  expectedCapabilityDefinitionHash:
                                    capability.definitionHash,
                                },
                              })
                            }
                          >
                            {granted ? "Review revocation" : "Review grant"}
                          </button>
                          {disabled ? (
                            <span className="text-xs text-red-300">
                              Locked:{" "}
                              {syncLabels[capability.syncStatus]}
                            </span>
                          ) : null}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

function MemberRoleForm({
  member,
  readModel,
  onReview,
}: {
  member: TeamRoleAdminMember;
  readModel: TeamRoleAdminReadModel;
  onReview: (operation: MutationOperation) => void;
}) {
  const [roleKey, setRoleKey] = useState(member.roleKey);
  const currentRole = readModel.roles.find(
    (role) => role.key === member.roleKey
  );

  return (
    <form
      className="flex min-w-64 flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (roleKey === member.roleKey) return;
        const targetRole = readModel.activeNonAdminRoles.find(
          (role) => role.key === roleKey
        );
        if (!targetRole) return;
        onReview({
          title: `Change ${member.displayName}'s role`,
          successMessage: "Team member role updated.",
          summary: (
            <p>
              <strong>{currentRole?.displayName ?? member.roleKey}</strong>
              {" → "}
              <strong>{targetRole.displayName}</strong>
            </p>
          ),
          payload: {
            operation: "set_member_non_admin_role",
            targetDiscordUserId: member.discordUserId,
            newRoleKey: targetRole.key,
            expectedPreviousRoleKey: member.roleKey,
          },
        });
      }}
    >
      <select
        className={`${inputClass} max-w-64`}
        aria-label={`Non-Admin role for ${member.displayName}`}
        value={roleKey}
        onChange={(event) => setRoleKey(event.target.value)}
      >
        {!readModel.activeNonAdminRoles.some(
          (role) => role.key === member.roleKey
        ) ? (
          <option value={member.roleKey} disabled>
            {currentRole?.displayName ?? member.roleKey} (inactive)
          </option>
        ) : null}
        {readModel.activeNonAdminRoles.map((role) => (
          <option key={role.key} value={role.key}>
            {role.displayName}
          </option>
        ))}
      </select>
      <button
        className={buttonClass}
        type="submit"
        disabled={roleKey === member.roleKey}
      >
        Review assignment
      </button>
    </form>
  );
}

function TeamMembers({
  readModel,
  onReview,
}: {
  readModel: TeamRoleAdminReadModel;
  onReview: (operation: MutationOperation) => void;
}) {
  const nonAdmins = readModel.members.filter(
    (member) => !member.isAdmin
  );

  return (
    <section className="grid gap-4">
      <div>
        <h2 className="text-xl font-semibold">Team Members</h2>
        <p className="mt-1 text-sm text-white/60">
          Normal assignments can use active non-Admin roles only.
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-white/5 text-xs uppercase text-white/50">
            <tr>
              <th className="p-3">Member</th>
              <th className="p-3">Discord reference</th>
              <th className="p-3">Current role</th>
              <th className="p-3">Assignment</th>
            </tr>
          </thead>
          <tbody>
            {nonAdmins.map((member) => {
              const role = readModel.roles.find(
                (entry) => entry.key === member.roleKey
              );
              return (
                <tr
                  key={member.discordUserId}
                  className="border-t border-white/10"
                >
                  <td className="p-3 font-medium">
                    {member.displayName}
                  </td>
                  <td className="p-3 font-mono text-xs text-white/60">
                    {member.discordUserId}
                  </td>
                  <td className="p-3">
                    {role?.displayName ?? member.roleKey}
                  </td>
                  <td className="p-3">
                    <MemberRoleForm
                      key={`${member.discordUserId}:${member.roleKey}`}
                      member={member}
                      readModel={readModel}
                      onReview={onReview}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OwnerAccounts({
  readModel,
  onReview,
}: {
  readModel: TeamRoleAdminReadModel;
  onReview: (operation: MutationOperation) => void;
}) {
  const [fallbackByMember, setFallbackByMember] = useState<
    Record<string, string>
  >({});
  const admins = readModel.members.filter((member) => member.isAdmin);
  const nonAdmins = readModel.members.filter(
    (member) => !member.isAdmin
  );

  return (
    <section className="grid gap-5 rounded-xl border border-red-500/30 bg-red-950/10 p-5">
      <div>
        <h2 className="text-xl font-semibold text-red-200">
          Owner Accounts
        </h2>
        <p className="mt-1 text-sm text-red-100/70">
          Admin is an immutable Owner role outside the capability
          matrix. The database remains authoritative for last-Admin,
          self-demotion, and fallback checks.
        </p>
      </div>

      <div className="grid gap-3">
        <h3 className="font-semibold">Current Admins</h3>
        {admins.map((member) => {
          const fallback =
            fallbackByMember[member.discordUserId] ??
            readModel.activeNonAdminRoles[0]?.key ??
            "";
          return (
            <div
              key={member.discordUserId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 p-3"
            >
              <div>
                <strong>{member.displayName}</strong>
                {member.isCurrentAdmin ? (
                  <span className="ml-2 rounded bg-orange-950 px-2 py-0.5 text-xs text-orange-200">
                    You
                  </span>
                ) : null}
                <code className="block text-xs text-white/50">
                  {member.discordUserId}
                </code>
              </div>
              {member.isCurrentAdmin ? (
                <span className="text-xs text-white/50">
                  Self-demotion is not offered.
                </span>
              ) : (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!fallback) return;
                    const fallbackRole =
                      readModel.activeNonAdminRoles.find(
                        (role) => role.key === fallback
                      );
                    if (!fallbackRole) return;
                    onReview({
                      title: `Demote Admin ${member.displayName}`,
                      successMessage:
                        "Admin account demoted to the selected fallback role.",
                      warning:
                        "This removes full Owner access. The database will reject self-demotion, an inactive fallback, or removal of the last Admin.",
                      requiresAdminWord: true,
                      summary: (
                        <p>
                          <strong>{member.displayName}</strong>: Admin →{" "}
                          <strong>{fallbackRole.displayName}</strong>
                        </p>
                      ),
                      payload: {
                        operation: "set_member_admin_role",
                        targetDiscordUserId: member.discordUserId,
                        isAdmin: false,
                        expectedPreviousRoleKey: "admin",
                        fallbackRoleKey: fallbackRole.key,
                      },
                    });
                  }}
                >
                  <select
                    className={`${inputClass} max-w-56`}
                    aria-label={`Fallback role for ${member.displayName}`}
                    value={fallback}
                    onChange={(event) =>
                      setFallbackByMember((current) => ({
                        ...current,
                        [member.discordUserId]: event.target.value,
                      }))
                    }
                  >
                    {readModel.activeNonAdminRoles.map((role) => (
                      <option key={role.key} value={role.key}>
                        {role.displayName}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className={`${buttonClass} text-red-200`}
                    disabled={!fallback}
                  >
                    Review demotion
                  </button>
                </form>
              )}
            </div>
          );
        })}
      </div>

      <details className="rounded-lg border border-white/10 p-4">
        <summary className="cursor-pointer font-semibold">
          Promote a team member to Admin
        </summary>
        <div className="mt-4 grid gap-2">
          {nonAdmins.map((member) => (
            <div
              key={member.discordUserId}
              className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 py-3"
            >
              <div>
                <strong>{member.displayName}</strong>
                <span className="ml-2 text-sm text-white/50">
                  {member.roleKey}
                </span>
              </div>
              <button
                type="button"
                className={`${buttonClass} text-red-200`}
                onClick={() =>
                  onReview({
                    title: `Promote ${member.displayName} to Admin`,
                    successMessage:
                      "Team member promoted to Admin.",
                    warning:
                      "This grants complete Owner access independently of all capability grants.",
                    requiresAdminWord: true,
                    summary: (
                      <p>
                        <strong>{member.displayName}</strong>:{" "}
                        {member.roleKey} → <strong>Admin</strong>
                      </p>
                    ),
                    payload: {
                      operation: "set_member_admin_role",
                      targetDiscordUserId: member.discordUserId,
                      isAdmin: true,
                      expectedPreviousRoleKey: member.roleKey,
                      fallbackRoleKey: null,
                    },
                  })
                }
              >
                Promote to Admin
              </button>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(formatAuditValue).join(", ");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.entries(record)
      .map(([key, entry]) => `${key}: ${formatAuditValue(entry)}`)
      .join(" · ");
  }
  return "Unsupported value";
}

function AuditState({
  title,
  state,
}: {
  title: string;
  state: Readonly<Record<string, unknown>>;
}) {
  const entries = Object.entries(state);
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase text-white/40">
        {title}
      </h4>
      {entries.length === 0 ? (
        <p className="mt-1 text-xs text-white/50">Empty</p>
      ) : (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-white/40">{key}</dt>
              <dd className="break-words text-white/70">
                {formatAuditValue(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function AuditEntry({
  entry,
}: {
  entry: TeamAuthorizationAuditEntry;
}) {
  return (
    <article className="rounded-lg border border-white/10 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">
            {eventLabels[entry.eventType] ?? entry.eventType}
          </h3>
          <p className="text-xs text-white/50">
            {new Date(entry.occurredAt).toLocaleString()}
          </p>
        </div>
        <span className="rounded border border-white/20 px-2 py-0.5 text-xs">
          {entry.actorRoleKey}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-white/40">Actor</dt>
        <dd>{entry.actorDiscordUserId}</dd>
        <dt className="text-white/40">Target</dt>
        <dd>
          {entry.targetRoleKey ??
            entry.targetDiscordUserId ??
            "Not recorded"}
        </dd>
        {entry.capabilityKey ? (
          <>
            <dt className="text-white/40">Capability</dt>
            <dd>{entry.capabilityKey}</dd>
          </>
        ) : null}
        <dt className="text-white/40">Reason</dt>
        <dd>{entry.reason}</dd>
      </dl>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <AuditState title="Before" state={entry.beforeState} />
        <AuditState title="After" state={entry.afterState} />
      </div>
    </article>
  );
}

export default function TeamRolesAdminClient({
  readModel,
}: {
  readModel: TeamRoleAdminReadModel;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<MutationOperation | null>(
    null
  );
  const [idempotencyKey, setIdempotencyKey] = useState<
    string | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(
    null
  );
  const [message, setMessage] = useState<MutationMessage | null>(
    null
  );

  function review(operation: MutationOperation) {
    setPending(operation);
    setIdempotencyKey(crypto.randomUUID());
    setDialogError(null);
    setMessage(null);
  }

  async function confirm(reason: string, adminWord: string) {
    if (!pending || !idempotencyKey) return;
    setBusy(true);
    setDialogError(null);

    try {
      const response = await fetch("/api/admin/team/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...pending.payload,
          reason,
          idempotencyKey,
          ...(pending.requiresAdminWord
            ? { confirmationWord: adminWord }
            : {}),
        }),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        const errorMessage =
          typeof body?.error === "string"
            ? body.error
            : "The authorization change could not be applied.";
        setDialogError(errorMessage);
        if (response.status === 409 || response.status === 503) {
          router.refresh();
        }
        return;
      }

      const createdKey =
        typeof body?.result?.role?.key === "string"
          ? ` Technical key: ${body.result.role.key}.`
          : "";
      setMessage({
        kind: "success",
        text: `${pending.successMessage}${createdKey}`,
      });
      setPending(null);
      setIdempotencyKey(null);
      router.refresh();
    } catch {
      setDialogError(
        "The authorization service could not be reached. Retry keeps the same idempotency key."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-[1500px] gap-10 pb-16">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-orange-300">
          Admin only
        </p>
        <h1 className="mt-2 text-3xl font-bold">
          Team Roles &amp; Permissions
        </h1>
        <p className="mt-2 max-w-4xl text-white/60">
          Manage data-driven non-Admin roles, registered capability
          grants, team assignments, Owner accounts, and the immutable
          authorization history.
        </p>
      </header>

      {message ? (
        <div
          role="status"
          className={`rounded-lg border p-4 text-sm ${
            message.kind === "success"
              ? "border-green-500/40 bg-green-950/20 text-green-200"
              : "border-red-500/40 bg-red-950/20 text-red-200"
          }`}
        >
          {message.text}
        </div>
      ) : null}

      <CreateRoleForm onReview={review} />

      <section className="grid gap-4">
        <div>
          <h2 className="text-xl font-semibold">Roles</h2>
          <p className="mt-1 text-sm text-white/60">
            Admin is always first and read-only. Active non-Admin roles
            follow their sort order; inactive roles appear last.
          </p>
        </div>
        {readModel.roles.map((role) => (
          <RoleCard
            key={`${role.key}:${role.rowVersion}`}
            role={role}
            onReview={review}
          />
        ))}
      </section>

      <CapabilityMatrix
        readModel={readModel}
        onReview={review}
      />
      <TeamMembers readModel={readModel} onReview={review} />
      <OwnerAccounts readModel={readModel} onReview={review} />

      <section className="grid gap-4">
        <div>
          <h2 className="text-xl font-semibold">
            Authorization history
          </h2>
          <p className="mt-1 text-sm text-white/60">
            Latest 50 append-only authorization events. This view has
            no edit or delete controls.
          </p>
        </div>
        {readModel.audit.length === 0 ? (
          <div className="rounded-xl border border-white/10 p-5 text-sm text-white/50">
            No authorization changes have been recorded.
          </div>
        ) : (
          <div className="grid gap-3">
            {readModel.audit.map((entry) => (
              <AuditEntry key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </section>

      {pending ? (
        <MutationDialog
          key={idempotencyKey}
          operation={pending}
          busy={busy}
          error={dialogError}
          onCancel={() => {
            if (!busy) {
              setPending(null);
              setIdempotencyKey(null);
              setDialogError(null);
            }
          }}
          onConfirm={confirm}
        />
      ) : null}
    </div>
  );
}

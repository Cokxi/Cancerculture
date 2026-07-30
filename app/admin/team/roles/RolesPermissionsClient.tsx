"use client";

import { useState, type FormEvent } from "react";
import type {
  TeamRoleAdminCapability,
  TeamRoleAdminRole,
} from "@/lib/auth/teamRoleAdminReadModel";
import TeamRoleMutationProvider, {
  buttonClass,
  Field,
  inputClass,
  syncLabels,
  useTeamRoleMutation,
} from "../TeamRoleMutationClient";

export type RolesPermissionsViewModel = Readonly<{
  roles: readonly TeamRoleAdminRole[];
  capabilities: readonly TeamRoleAdminCapability[];
  activeNonAdminRoles: readonly TeamRoleAdminRole[];
}>;

const builtInRoleLabels: Readonly<Record<string, string>> = {
  trial_moderator: "T Mod",
  moderator: "Mod",
  super_moderator: "S Mod",
};

function roleLabel(role: TeamRoleAdminRole) {
  return builtInRoleLabels[role.key] ?? role.displayName;
}

function CreateRoleForm() {
  const { review } = useTeamRoleMutation();
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

    review({
      title: "Create non-Admin role",
      successMessage: "Role created with no capability grants.",
      summary: (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-white/50">Before</dt>
          <dd>No role</dd>
          <dt className="text-white/50">After</dt>
          <dd>
            {displayName.trim()} · sort {numericSortOrder} · active · zero
            grants
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
    <details className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
      <summary className="cursor-pointer rounded-sm text-sm font-medium text-orange-200 outline-none focus-visible:ring-2 focus-visible:ring-orange-300">
        Create Custom Team Role
      </summary>
      <form onSubmit={submit} className="mt-4 grid gap-4">
        <p className="text-xs text-white/50">
          The server generates the technical key. New roles start active
          without automatic grants.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
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
          Create role
        </button>
      </form>
    </details>
  );
}

function RoleManagementItem({ role }: { role: TeamRoleAdminRole }) {
  const { review } = useTeamRoleMutation();
  const [displayName, setDisplayName] = useState(role.displayName);
  const [description, setDescription] = useState(role.description);
  const [sortOrder, setSortOrder] = useState(String(role.sortOrder));
  const numericSortOrder = Number(sortOrder);
  const isAdmin = role.key === "admin";
  const changed =
    displayName.trim() !== role.displayName ||
    description.trim() !== role.description ||
    numericSortOrder !== role.sortOrder;

  return (
    <details className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <summary className="cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-orange-300">
        <span className="inline-flex flex-wrap items-center gap-2">
          <strong>{role.displayName}</strong>
          <code className="text-xs text-white/45">{role.key}</code>
          <span className="rounded-full border border-white/15 px-2 py-0.5 text-xs text-white/60">
            {isAdmin
              ? "Owner / system"
              : role.isSystem
                ? "Built-in"
                : "Custom"}
          </span>
          <span className="text-xs text-white/50">
            {role.isActive ? "Active" : "Inactive"} · {role.memberCount}{" "}
            member(s)
          </span>
        </span>
      </summary>

      {isAdmin ? (
        <p className="mt-3 text-sm text-orange-200/75">
          The immutable Owner role is read-only and remains outside
          capability grants.
        </p>
      ) : (
        <div className="mt-4 grid gap-4">
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !changed ||
                !displayName.trim() ||
                !Number.isSafeInteger(numericSortOrder)
              ) {
                return;
              }
              review({
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
            <div className="grid gap-4 sm:grid-cols-2">
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
              className={`${buttonClass} justify-self-start`}
              type="submit"
              disabled={
                !changed ||
                !displayName.trim() ||
                !Number.isSafeInteger(numericSortOrder)
              }
            >
              Update metadata
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-3 border-t border-white/10 pt-3">
            <button
              type="button"
              className={`${buttonClass} ${
                role.isActive ? "text-red-200" : "text-green-200"
              }`}
              disabled={role.isActive && !role.canDeactivate}
              onClick={() =>
                review({
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
              <span className="text-xs text-white/45">
                Move all assigned members first.
              </span>
            ) : null}
            <span className="text-xs text-white/40">
              Roles are never physically deleted.
            </span>
          </div>
        </div>
      )}
    </details>
  );
}

function CapabilityDetails({
  capability,
}: {
  capability: TeamRoleAdminCapability;
}) {
  return (
    <details className="mt-3 rounded-lg border border-white/10 p-3">
      <summary className="cursor-pointer rounded-sm text-xs font-medium text-white/60 outline-none focus-visible:ring-2 focus-visible:ring-orange-300">
        Technical details
      </summary>
      <div className="mt-3 grid gap-3 text-xs">
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
    </details>
  );
}

function CapabilityBlock({
  capability,
  roles,
}: {
  capability: TeamRoleAdminCapability;
  roles: readonly TeamRoleAdminRole[];
}) {
  const { review } = useTeamRoleMutation();
  const disabled =
    !capability.mutable ||
    capability.implementationVersion === null ||
    capability.definitionHash === null;

  return (
    <article className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-white/90">
            {capability.displayName}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-white/55">
            {capability.description}
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-1 text-xs ${
            capability.mutable
              ? "bg-green-950 text-green-300"
              : "bg-red-950 text-red-300"
          }`}
        >
          {syncLabels[capability.syncStatus]}
        </span>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {roles.map((role) => {
          const granted = role.grantedCapabilityKeys.includes(
            capability.key
          );
          return (
            <div
              key={role.key}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 p-3"
            >
              <div>
                <strong className="text-sm">{roleLabel(role)}</strong>
                {!role.isSystem ? (
                  <span className="ml-2 text-xs text-white/40">
                    Custom
                  </span>
                ) : null}
                <div className="mt-1 text-xs text-white/55">
                  {granted ? "✓ Saved · Granted" : "Not granted"}
                </div>
              </div>
              <button
                type="button"
                className={`${buttonClass} ${
                  granted ? "text-red-200" : "text-green-200"
                }`}
                disabled={disabled}
                aria-label={`${granted ? "Revoke" : "Grant"} ${
                  capability.displayName
                } for ${role.displayName}`}
                onClick={() =>
                  review({
                    title: `${granted ? "Revoke" : "Grant"} capability`,
                    successMessage: granted
                      ? "Capability revoked."
                      : "Capability granted.",
                    warning:
                      capability.riskLevel === "high" ||
                      capability.riskLevel === "critical"
                        ? `This is a ${capability.riskLevel}-risk capability. Review every included and excluded action.`
                        : undefined,
                    summary: (
                      <p>
                        <strong>{role.displayName}</strong>:{" "}
                        {granted ? "granted" : "not granted"} →{" "}
                        {granted ? "not granted" : "granted"}
                      </p>
                    ),
                    payload: {
                      operation: "set_role_capability",
                      roleKey: role.key,
                      capabilityKey: capability.key,
                      granted: !granted,
                      expectedRoleRowVersion: role.rowVersion,
                      expectedCapabilityImplementationVersion:
                        capability.implementationVersion,
                      expectedCapabilityDefinitionHash:
                        capability.definitionHash,
                    },
                  })
                }
              >
                {granted ? "Revoke" : "Grant"}
              </button>
            </div>
          );
        })}
      </div>

      {disabled ? (
        <p className="mt-3 text-xs text-red-300">
          Mutations are locked while registry and catalog metadata are not
          synchronized.
        </p>
      ) : null}
      <CapabilityDetails capability={capability} />
    </article>
  );
}

function RolesPermissionsContent({
  readModel,
}: {
  readModel: RolesPermissionsViewModel;
}) {
  return (
    <div className="grid gap-8">
      <section aria-labelledby="permission-blocks" className="grid gap-3">
        <div>
          <h2 id="permission-blocks" className="text-lg font-semibold">
            Permissions
          </h2>
          <p className="mt-1 text-sm text-white/55">
            Each action applies one Grant or Revoke immediately through the
            existing hardened mutation.
          </p>
        </div>
        {readModel.capabilities.map((capability) => (
          <CapabilityBlock
            key={capability.key}
            capability={capability}
            roles={readModel.activeNonAdminRoles}
          />
        ))}
      </section>

      <section aria-labelledby="role-management" className="grid gap-3">
        <div>
          <h2 id="role-management" className="text-lg font-semibold">
            Role management
          </h2>
          <p className="mt-1 text-sm text-white/55">
            Edit metadata or activation state without deleting role history.
          </p>
        </div>
        <div className="grid gap-2">
          {readModel.roles.map((role) => (
            <RoleManagementItem
              key={`${role.key}:${role.rowVersion}`}
              role={role}
            />
          ))}
        </div>
        <CreateRoleForm />
      </section>
    </div>
  );
}

export default function RolesPermissionsClient({
  readModel,
}: {
  readModel: RolesPermissionsViewModel;
}) {
  return (
    <TeamRoleMutationProvider>
      <RolesPermissionsContent readModel={readModel} />
    </TeamRoleMutationProvider>
  );
}

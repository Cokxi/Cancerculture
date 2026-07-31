"use client";

import { useCallback, useState, type FormEvent } from "react";
import type { RolesPermissionsAdminReadModel } from "@/lib/auth/teamRoleAdminReadModel";
import TeamRoleMutationProvider, {
  buttonClass,
  Field,
  inputClass,
  useTeamRoleMutation,
} from "../TeamRoleMutationClient";
import CapabilityDraftWorkflow from "./CapabilityDraftWorkflow";

export type RolesPermissionsViewModel = RolesPermissionsAdminReadModel;

function CreateRoleForm({
  permissionDraftBlocked,
  onDraftBlocked,
}: {
  permissionDraftBlocked: boolean;
  onDraftBlocked: () => void;
}) {
  const { review, mutationPending } = useTeamRoleMutation();
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [sortOrder, setSortOrder] = useState("50");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (permissionDraftBlocked) {
      onDraftBlocked();
      return;
    }

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
              disabled={mutationPending}
              maxLength={100}
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
          <Field label="Sort order">
            <input
              className={inputClass}
              disabled={mutationPending}
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
            disabled={mutationPending}
            maxLength={1000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <button
          aria-disabled={mutationPending || permissionDraftBlocked}
          className={`${buttonClass} justify-self-start text-orange-200`}
          disabled={mutationPending}
          type="submit"
        >
          Create role
        </button>
      </form>
    </details>
  );
}

function RoleManagementItem({
  role,
  permissionDraftBlocked,
  onDraftBlocked,
}: {
  role: RolesPermissionsViewModel["roles"][number];
  permissionDraftBlocked: boolean;
  onDraftBlocked: () => void;
}) {
  const { review, mutationPending } = useTeamRoleMutation();
  const [displayName, setDisplayName] = useState(role.displayName);
  const [description, setDescription] = useState(role.description);
  const [sortOrder, setSortOrder] = useState(String(role.sortOrder));
  const numericSortOrder = Number(sortOrder);
  const isAdmin = role.key === "admin";
  const changed =
    displayName.trim() !== role.displayName ||
    description.trim() !== role.description ||
    numericSortOrder !== role.sortOrder;

  function requestMutation(action: () => void) {
    if (permissionDraftBlocked) {
      onDraftBlocked();
      return;
    }
    action();
  }

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
          The immutable Owner role is read-only and remains outside capability
          grants.
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
              requestMutation(() =>
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
                }),
              );
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Display name">
                <input
                  className={inputClass}
                  disabled={mutationPending}
                  required
                  maxLength={100}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </Field>
              <Field label="Sort order">
                <input
                  className={inputClass}
                  disabled={mutationPending}
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
                disabled={mutationPending}
                maxLength={1000}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <button
              aria-disabled={
                mutationPending ||
                permissionDraftBlocked ||
                !changed ||
                !displayName.trim() ||
                !Number.isSafeInteger(numericSortOrder)
              }
              className={`${buttonClass} justify-self-start`}
              disabled={
                mutationPending ||
                !changed ||
                !displayName.trim() ||
                !Number.isSafeInteger(numericSortOrder)
              }
              type="submit"
            >
              Update metadata
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-3 border-t border-white/10 pt-3">
            <button
              type="button"
              aria-disabled={
                mutationPending ||
                permissionDraftBlocked ||
                (role.isActive && !role.canDeactivate)
              }
              className={`${buttonClass} ${
                role.isActive ? "text-red-200" : "text-green-200"
              }`}
              disabled={
                mutationPending || (role.isActive && !role.canDeactivate)
              }
              onClick={() =>
                requestMutation(() =>
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
                  }),
                )
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

function RolesPermissionsContent({
  readModel,
}: {
  readModel: RolesPermissionsViewModel;
}) {
  const { mutationPending } = useTeamRoleMutation();
  const [permissionDraftBlocked, setPermissionDraftBlocked] = useState(false);
  const [roleManagementNotice, setRoleManagementNotice] = useState<
    string | null
  >(null);

  const handleBlockingChange = useCallback((blocked: boolean) => {
    setPermissionDraftBlocked(blocked);
    if (!blocked) {
      setRoleManagementNotice(null);
    }
  }, []);
  const handleDraftBlocked = useCallback(() => {
    setRoleManagementNotice(
      "Discard or save permission changes before modifying roles.",
    );
  }, []);

  return (
    <div className="grid gap-8">
      <CapabilityDraftWorkflow
        capabilities={readModel.capabilities}
        onBlockingChange={handleBlockingChange}
        roleMutationPending={mutationPending}
        roles={readModel.activeNonAdminRoles}
      />

      <section aria-labelledby="role-management" className="grid gap-3">
        <div>
          <h2 id="role-management" className="text-lg font-semibold">
            Role management
          </h2>
          <p className="mt-1 text-sm text-white/55">
            Edit metadata or activation state without deleting role history.
          </p>
        </div>
        {roleManagementNotice ? (
          <p
            className="rounded-lg border border-amber-500/40 bg-amber-950/20 p-3 text-sm text-amber-200"
            role="alert"
          >
            {roleManagementNotice}
          </p>
        ) : null}
        <div className="grid gap-2">
          {readModel.roles.map((role) => (
            <RoleManagementItem
              key={`${role.key}:${role.rowVersion}`}
              onDraftBlocked={handleDraftBlocked}
              permissionDraftBlocked={permissionDraftBlocked}
              role={role}
            />
          ))}
        </div>
        <CreateRoleForm
          onDraftBlocked={handleDraftBlocked}
          permissionDraftBlocked={permissionDraftBlocked}
        />
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

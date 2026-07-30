"use client";

import { useState } from "react";
import type {
  TeamRoleAdminMember,
  TeamRoleAdminRole,
} from "@/lib/auth/teamRoleAdminReadModel";
import TeamRoleMutationProvider, {
  buttonClass,
  inputClass,
  useTeamRoleMutation,
} from "../TeamRoleMutationClient";

export type TeamMembersViewModel = Readonly<{
  members: readonly TeamRoleAdminMember[];
  roles: readonly TeamRoleAdminRole[];
  activeNonAdminRoles: readonly TeamRoleAdminRole[];
}>;

function RoleBadge({
  role,
  owner = false,
}: {
  role: TeamRoleAdminRole | undefined;
  owner?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium">
        {role?.displayName ?? "Unknown role"}
      </span>
      <code className="text-xs text-white/45">
        {role?.key ?? "unknown"}
      </code>
      <span
        className={`rounded-full px-2 py-0.5 text-xs ${
          role?.isActive
            ? "bg-green-950 text-green-300"
            : "bg-neutral-800 text-white/55"
        }`}
      >
        {role?.isActive ? "Active" : "Inactive"}
      </span>
      {owner ? (
        <span className="rounded-full border border-orange-400/40 bg-orange-950/30 px-2 py-0.5 text-xs text-orange-200">
          Owner / Admin
        </span>
      ) : null}
    </div>
  );
}

function MemberRoleControl({
  member,
  readModel,
}: {
  member: TeamRoleAdminMember;
  readModel: TeamMembersViewModel;
}) {
  const { review } = useTeamRoleMutation();
  const [roleKey, setRoleKey] = useState(member.roleKey);
  const currentRole = readModel.roles.find(
    (role) => role.key === member.roleKey
  );

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (roleKey === member.roleKey) return;
        const targetRole = readModel.activeNonAdminRoles.find(
          (role) => role.key === roleKey
        );
        if (!targetRole) return;

        review({
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
        className={`${inputClass} min-w-44 flex-1 sm:max-w-64`}
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
        Change role
      </button>
    </form>
  );
}

function StandardMembers({
  readModel,
}: {
  readModel: TeamMembersViewModel;
}) {
  const members = readModel.members.filter(
    (member) => !member.isAdmin
  );

  return (
    <section aria-labelledby="team-members-list" className="grid gap-3">
      <div>
        <h2 id="team-members-list" className="text-lg font-semibold">
          Team Members
        </h2>
        <p className="mt-1 text-sm text-white/55">
          Normal assignments offer active non-Admin roles only.
        </p>
      </div>

      {members.length === 0 ? (
        <p className="rounded-xl border border-white/10 p-4 text-sm text-white/55">
          No non-Owner team accounts are currently listed.
        </p>
      ) : (
        <div className="grid gap-3">
          {members.map((member) => {
            const role = readModel.roles.find(
              (entry) => entry.key === member.roleKey
            );
            return (
              <article
                key={member.discordUserId}
                className="grid gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)] lg:items-center"
              >
                <div className="min-w-0">
                  <h3 className="truncate font-semibold">
                    {member.displayName}
                  </h3>
                  <code className="mt-1 block break-all text-xs text-white/45">
                    {member.discordUserId}
                  </code>
                  <div className="mt-2">
                    <RoleBadge role={role} />
                  </div>
                </div>
                <MemberRoleControl
                  key={`${member.discordUserId}:${member.roleKey}`}
                  member={member}
                  readModel={readModel}
                />
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function OwnerAccounts({
  readModel,
}: {
  readModel: TeamMembersViewModel;
}) {
  const { review } = useTeamRoleMutation();
  const [fallbackByMember, setFallbackByMember] = useState<
    Record<string, string>
  >({});
  const owners = readModel.members.filter((member) => member.isAdmin);
  const nonOwners = readModel.members.filter(
    (member) => !member.isAdmin
  );
  const adminRole = readModel.roles.find(
    (role) => role.key === "admin"
  );

  return (
    <section
      aria-labelledby="owner-accounts"
      className="grid gap-4 rounded-xl border border-orange-500/25 bg-orange-950/10 p-4 sm:p-5"
    >
      <div>
        <h2
          id="owner-accounts"
          className="text-lg font-semibold text-orange-200"
        >
          Owner Accounts
        </h2>
        <p className="mt-1 text-sm text-orange-100/65">
          Owner access is separate from normal role assignments. Last-Owner,
          self-demotion, fallback, and confirmation checks remain enforced by
          the existing server mutation.
        </p>
      </div>

      <div className="grid gap-3">
        {owners.map((member) => {
          const fallback =
            fallbackByMember[member.discordUserId] ??
            readModel.activeNonAdminRoles[0]?.key ??
            "";
          return (
            <article
              key={member.discordUserId}
              className="grid gap-3 rounded-lg border border-white/10 bg-black/15 p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">{member.displayName}</h3>
                  {member.isCurrentAdmin ? (
                    <span className="rounded bg-orange-950 px-2 py-0.5 text-xs text-orange-200">
                      You
                    </span>
                  ) : null}
                </div>
                <code className="mt-1 block break-all text-xs text-white/45">
                  {member.discordUserId}
                </code>
                <div className="mt-2">
                  <RoleBadge role={adminRole} owner />
                </div>
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
                    const fallbackRole =
                      readModel.activeNonAdminRoles.find(
                        (role) => role.key === fallback
                      );
                    if (!fallbackRole) return;

                    review({
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
                    className={`${inputClass} min-w-44 sm:max-w-56`}
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
                    Demote Owner
                  </button>
                </form>
              )}
            </article>
          );
        })}
      </div>

      <details className="rounded-lg border border-white/10 p-3">
        <summary className="cursor-pointer rounded-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-orange-300">
          Promote an existing team member
        </summary>
        <div className="mt-3 grid gap-2">
          {nonOwners.map((member) => (
            <div
              key={member.discordUserId}
              className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 py-3"
            >
              <div className="min-w-0">
                <strong>{member.displayName}</strong>
                <code className="ml-2 text-xs text-white/45">
                  {member.roleKey}
                </code>
              </div>
              <button
                type="button"
                className={`${buttonClass} text-orange-200`}
                onClick={() =>
                  review({
                    title: `Promote ${member.displayName} to Admin`,
                    successMessage: "Team member promoted to Admin.",
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
                Promote to Owner
              </button>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

function TeamMembersContent({
  readModel,
}: {
  readModel: TeamMembersViewModel;
}) {
  return (
    <div className="grid gap-7">
      <StandardMembers readModel={readModel} />
      <OwnerAccounts readModel={readModel} />
      <p className="text-xs text-white/40">
        Team enrollment and removal are intentionally outside this block.
      </p>
    </div>
  );
}

export default function TeamMembersClient({
  readModel,
}: {
  readModel: TeamMembersViewModel;
}) {
  return (
    <TeamRoleMutationProvider>
      <TeamMembersContent readModel={readModel} />
    </TeamRoleMutationProvider>
  );
}

"use client";

import { useState } from "react";
import type { TeamRoleAdminRole } from "@/lib/auth/teamRoleAdminReadModel";
import TeamRoleMutationProvider, {
  buttonClass,
  Field,
  inputClass,
  useTeamRoleMutation,
} from "../../TeamRoleMutationClient";

function AddTeamMemberForm({
  roles,
}: {
  roles: readonly TeamRoleAdminRole[];
}) {
  const { review } = useTeamRoleMutation();
  const [discordUserId, setDiscordUserId] = useState("");
  const [roleKey, setRoleKey] = useState(roles[0]?.key ?? "");

  return (
    <form
      className="grid gap-5 rounded-xl border border-white/10 bg-white/[0.03] p-5 sm:p-6"
      onSubmit={(event) => {
        event.preventDefault();
        const targetDiscordUserId = discordUserId.trim();
        const role = roles.find((entry) => entry.key === roleKey);
        if (!role || !/^[0-9]{5,32}$/u.test(targetDiscordUserId)) {
          return;
        }

        review({
          title: "Add Team Member",
          successMessage: "Team member added.",
          confirmationWord: "ADD",
          redirectOnSuccess:
            "/admin/team/members?status=member-added",
          warning:
            "Only a Discord ID already known to the system can be added. Admin access is never available through this form.",
          summary: (
            <dl className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt className="text-white/45">Discord ID</dt>
              <dd className="break-all font-mono text-xs">
                {targetDiscordUserId}
              </dd>
              <dt className="text-white/45">Initial role</dt>
              <dd>
                {role.displayName}{" "}
                <code className="text-xs text-white/45">
                  {role.key}
                </code>
              </dd>
            </dl>
          ),
          payload: {
            operation: "add_team_member",
            targetDiscordUserId,
            initialRoleKey: role.key,
          },
        });
      }}
    >
      <Field
        label="Discord ID"
        hint="Required. The Discord ID must already be available to the system as a known identity."
      >
        <input
          className={inputClass}
          name="targetDiscordUserId"
          value={discordUserId}
          onChange={(event) => setDiscordUserId(event.target.value)}
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]{5,32}"
          maxLength={32}
          required
          placeholder="123456789012345678"
        />
      </Field>

      <Field
        label="Initial role"
        hint="Only currently active non-Admin roles are available."
      >
        <select
          className={inputClass}
          name="initialRoleKey"
          value={roleKey}
          required
          disabled={roles.length === 0}
          onChange={(event) => setRoleKey(event.target.value)}
        >
          {roles.map((role) => (
            <option key={role.key} value={role.key}>
              {role.displayName} ({role.key})
            </option>
          ))}
        </select>
      </Field>

      <div className="rounded-lg border border-white/10 bg-black/20 p-4 text-sm text-white/60">
        The next step asks for a reason and the explicit confirmation word{" "}
        <strong className="text-white/80">ADD</strong>. The reason is
        stored in the append-only authorization audit.
      </div>

      {roles.length === 0 ? (
        <p role="alert" className="text-sm text-amber-200">
          No active non-Admin role is currently available.
        </p>
      ) : null}

      <div>
        <button
          type="submit"
          className={`${buttonClass} border-orange-400/45 bg-orange-500/10 text-orange-200`}
          disabled={roles.length === 0}
        >
          Review addition
        </button>
      </div>
    </form>
  );
}

export default function AddTeamMemberClient({
  roles,
}: {
  roles: readonly TeamRoleAdminRole[];
}) {
  return (
    <TeamRoleMutationProvider>
      <AddTeamMemberForm roles={roles} />
    </TeamRoleMutationProvider>
  );
}

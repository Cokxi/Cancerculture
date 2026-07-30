"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  CANONICAL_TEAM_ROLES,
  TEAM_ROLE_LABELS,
  type CanonicalTeamRole,
} from "@/lib/auth/teamRoles";

type RoleSelection = CanonicalTeamRole | "remove";

export default function UserRoleActions({
  discordUserId,
  role,
}: {
  discordUserId: string;
  role: CanonicalTeamRole | null;
}) {
  const router = useRouter();
  const [selection, setSelection] = useState<RoleSelection>(
    role ?? "trial_moderator"
  );
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  async function updateRole() {
    const trimmedReason = reason.trim();

    if (!trimmedReason) {
      setMessage({
        kind: "error",
        text: "A reason is required.",
      });
      return;
    }

    const targetLabel =
      selection === "remove"
        ? "remove this user from the team"
        : `assign ${TEAM_ROLE_LABELS[selection]}`;

    if (
      !window.confirm(
        `Confirm: ${targetLabel}?\n\nReason: ${trimmedReason}`
      )
    ) {
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const response = await fetch("/api/admin/team/role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetDiscordId: discordUserId,
          targetRole:
            selection === "remove" ? null : selection,
          reason: trimmedReason,
        }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          data?.error ?? "Failed to update team role."
        );
      }

      setMessage({
        kind: "success",
        text: data?.changed
          ? "Team role updated."
          : "The requested team role was already applied.",
      });
      setReason("");
      router.refresh();
    } catch (error) {
      setMessage({
        kind: "error",
        text:
          error instanceof Error
            ? error.message
            : "Failed to update team role.",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        marginTop: 8,
        display: "grid",
        gap: 6,
        maxWidth: 360,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.8 }}>
        Current role:{" "}
        <strong>
          {role ? TEAM_ROLE_LABELS[role] : "Not on team"}
        </strong>
      </div>

      <select
        aria-label="Team role"
        value={selection}
        disabled={loading}
        onChange={(event) => {
          const value = event.target.value;

          if (
            value === "remove" ||
            CANONICAL_TEAM_ROLES.includes(
              value as CanonicalTeamRole
            )
          ) {
            setSelection(value as RoleSelection);
          }
        }}
        style={{
          padding: "5px 8px",
          background: "#1e1e1e",
          color: "white",
          border: "1px solid #555",
          borderRadius: 4,
        }}
      >
        {CANONICAL_TEAM_ROLES.map((teamRole) => (
          <option key={teamRole} value={teamRole}>
            {TEAM_ROLE_LABELS[teamRole]}
          </option>
        ))}
        <option value="remove">Remove from team</option>
      </select>

      <textarea
        aria-label="Reason for role change"
        placeholder="Reason (required)"
        value={reason}
        disabled={loading}
        onChange={(event) => setReason(event.target.value)}
        style={{
          minHeight: 56,
          padding: 6,
          background: "#1e1e1e",
          color: "white",
          border: "1px solid #555",
          borderRadius: 4,
        }}
      />

      <button
        type="button"
        disabled={loading || reason.trim().length === 0}
        onClick={updateRole}
        style={{
          padding: "5px 10px",
          borderRadius: 4,
          border: "1px solid #555",
          background: "#1e1e1e",
          color: "#8bc34a",
          cursor: loading ? "wait" : "pointer",
          opacity:
            loading || reason.trim().length === 0 ? 0.6 : 1,
        }}
      >
        {loading ? "Saving…" : "Confirm team role change"}
      </button>

      {message ? (
        <div
          role="status"
          style={{
            fontSize: 12,
            color:
              message.kind === "success"
                ? "#8bc34a"
                : "#ff6b6b",
          }}
        >
          {message.text}
        </div>
      ) : null}
    </div>
  );
}

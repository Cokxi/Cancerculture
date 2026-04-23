"use client";

import { useState } from "react";

export default function UserRoleActions({
  discordUserId,
  role,
}: {
  discordUserId: string;
  role: "admin" | "mod" | null;
}) {
  const [loading, setLoading] = useState(false);

  if (role === "admin") {
    return (
      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
        Admin
      </div>
    );
  }

  async function updateRole(action: "mod" | "remove") {
    setLoading(true);

    try {
      const response = await fetch("/api/admin/team/role", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          targetDiscordId: discordUserId,
          role: action,
        }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          data?.error ?? "Failed to update role."
        );
      }

      window.location.reload();
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Failed to update role."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ marginTop: 6 }}>
      {role === "mod" ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => updateRole("remove")}
          style={{
            padding: "4px 10px",
            fontSize: 12,
            borderRadius: 4,
            border: "1px solid #555",
            background: "#1e1e1e",
            color: "#ffe082",
            cursor: "pointer",
            opacity: loading ? 0.6 : 1,
          }}
        >
          Remove Mod
        </button>
      ) : (
        <button
          type="button"
          disabled={loading}
          onClick={() => updateRole("mod")}
          style={{
            padding: "4px 10px",
            fontSize: 12,
            borderRadius: 4,
            border: "1px solid #555",
            background: "#1e1e1e",
            color: "#8bc34a",
            cursor: "pointer",
            opacity: loading ? 0.6 : 1,
          }}
        >
          Make Mod
        </button>
      )}
    </div>
  );
}

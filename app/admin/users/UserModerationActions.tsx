"use client";

import { useState } from "react";
import { banUser } from "@/app/admin/actions/banUser";
import { flagUser } from "@/app/admin/actions/flagUser";
import { unbanUser } from "@/app/admin/actions/unbanUser";

type Props = {
  discordUserId: string;
  isBanned: boolean;
  canCreateFlags: boolean;
  isAdmin: boolean;
  activeFlagStatus?: "open" | "escalated" | null;
};

type FlagCategory =
  | "trolling_low_effort"
  | "suspicious_behavior"
  | "other";

const baseButton: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  borderRadius: 4,
  border: "1px solid #555",
  background: "#1e1e1e",
  color: "#fff",
  cursor: "pointer",
};

const modalBox: React.CSSProperties = {
  marginTop: 8,
  padding: 8,
  border: "1px solid #444",
  background: "#121212",
  borderRadius: 6,
  fontSize: 12,
};

export default function UserModerationActions({
  discordUserId,
  isBanned,
  canCreateFlags,
  isAdmin,
  activeFlagStatus = null,
}: Props) {
  const [showFlag, setShowFlag] = useState(false);
  const [category, setCategory] = useState<FlagCategory>(
    "trolling_low_effort"
  );
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState(false);
  const [flagMessage, setFlagMessage] = useState<string | null>(null);
  const [showBan, setShowBan] = useState(false);
  const [banReason, setBanReason] = useState("");

  async function createFlagCase() {
    setPending(true);
    setFlagMessage(null);

    try {
      const result = await flagUser({
        targetDiscordUserId: discordUserId,
        category,
        reason,
        comment: comment.trim() || undefined,
        idempotencyKey: crypto.randomUUID(),
      });

      if (!result.success) {
        setFlagMessage(result.message);
        return;
      }

      setFlagMessage("Flag case created successfully.");
      setShowFlag(false);
      setReason("");
      setComment("");
    } finally {
      setPending(false);
    }
  }

  if (isBanned) {
    if (!isAdmin) return null;

    return (
      <div style={{ marginTop: 6 }}>
        <button
          style={{ ...baseButton, borderColor: "#a33", color: "#ff6b6b" }}
          onClick={async () => {
            await unbanUser({
              targetDiscordUserId: discordUserId,
              reason: "Manual unban by admin",
            });
            location.reload();
          }}
        >
          Unban
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 6 }}>
      {canCreateFlags && activeFlagStatus ? (
        <span
          role="status"
          style={{ color: "#ff6b6b", fontSize: 12, fontWeight: 700 }}
        >
          🚩 Active flag case: {activeFlagStatus}
        </span>
      ) : canCreateFlags ? (
        <>
          <button
            style={{ ...baseButton, cursor: pending ? "default" : "pointer" }}
            disabled={pending}
            onClick={() => setShowFlag((value) => !value)}
          >
            Create flag case
          </button>

          {showFlag ? (
            <div style={modalBox}>
              <label>
                Category
                <select
                  value={category}
                  disabled={pending}
                  onChange={(event) =>
                    setCategory(event.target.value as FlagCategory)
                  }
                  style={{
                    width: "100%",
                    marginTop: 4,
                    background: "#1e1e1e",
                    color: "#fff",
                  }}
                >
                  <option value="trolling_low_effort">Trolling / low effort</option>
                  <option value="suspicious_behavior">Suspicious behavior</option>
                  <option value="other">Other</option>
                </select>
              </label>

              <label style={{ display: "block", marginTop: 8 }}>
                Reason
                <textarea
                  required
                  maxLength={1000}
                  value={reason}
                  disabled={pending}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Why should this user be reviewed?"
                  style={{
                    width: "100%",
                    marginTop: 4,
                    background: "#1e1e1e",
                    color: "#fff",
                  }}
                />
              </label>

              <label style={{ display: "block", marginTop: 8 }}>
                Optional comment
                <textarea
                  maxLength={2000}
                  value={comment}
                  disabled={pending}
                  onChange={(event) => setComment(event.target.value)}
                  style={{
                    width: "100%",
                    marginTop: 4,
                    background: "#1e1e1e",
                    color: "#fff",
                  }}
                />
              </label>

              <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                <button
                  style={{
                    ...baseButton,
                    cursor:
                      pending || reason.trim().length < 3
                        ? "default"
                        : "pointer",
                  }}
                  disabled={pending || reason.trim().length < 3}
                  onClick={createFlagCase}
                >
                  {pending ? "Creating..." : "Confirm create"}
                </button>
                <button
                  style={{
                    ...baseButton,
                    opacity: 0.7,
                    cursor: pending ? "default" : "pointer",
                  }}
                  disabled={pending}
                  onClick={() => setShowFlag(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {flagMessage ? (
        <p role="status" style={{ marginTop: 6, fontSize: 12 }}>
          {flagMessage}
        </p>
      ) : null}

      {isAdmin ? (
        <>
          <button
            style={{
              ...baseButton,
              marginTop: 6,
              borderColor: "#a33",
              color: "#ff6b6b",
            }}
            onClick={() => setShowBan((value) => !value)}
          >
            Ban
          </button>

          {showBan ? (
            <div style={modalBox}>
              <textarea
                placeholder="Reason for ban (required)"
                value={banReason}
                onChange={(event) => setBanReason(event.target.value)}
                style={{
                  width: "100%",
                  background: "#1e1e1e",
                  color: "#fff",
                }}
              />
              <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
                <button
                  style={{
                    ...baseButton,
                    borderColor: "#a33",
                    color: "#ff6b6b",
                    cursor:
                      banReason.trim().length === 0
                        ? "default"
                        : "pointer",
                  }}
                  disabled={banReason.trim().length === 0}
                  onClick={async () => {
                    await banUser({
                      targetDiscordUserId: discordUserId,
                      reason: banReason,
                    });
                    location.reload();
                  }}
                >
                  Confirm Ban
                </button>
                <button
                  style={{ ...baseButton, opacity: 0.7 }}
                  onClick={() => setShowBan(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

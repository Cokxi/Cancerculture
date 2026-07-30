"use client";

import { useState } from "react";
import { flagUser } from "@/app/admin/actions/flagUser";
import { unflagUser } from "@/app/admin/actions/unflagUser";
import { banUser } from "@/app/admin/actions/banUser";
import { unbanUser } from "@/app/admin/actions/unbanUser";
import {
  hasTeamCapability,
  isAdminTeamRole,
  type CanonicalTeamRole,
} from "@/lib/auth/teamRoles";

type Props = {
  discordUserId: string;
  isFlagged: boolean;
  isBanned: boolean;
  role: CanonicalTeamRole;
};

type FlagReason =
  | "trolling_low_effort"
  | "suspicious_behavior"
  | "other";

type ModerationActionResult = {
  success: boolean;
};

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
  isFlagged,
  isBanned,
  role,
}: Props) {
  const [showFlag, setShowFlag] = useState(false);
  const [showUnflag, setShowUnflag] = useState(false);

  const [flagReason, setFlagReason] = useState<FlagReason>(
    "trolling_low_effort"
  );

  const [flagNote, setFlagNote] = useState("");
  const [unflagReason, setUnflagReason] = useState("");

  const [showBan, setShowBan] = useState(false);
  const [banReason, setBanReason] = useState("");

  async function run(
    action: () => Promise<ModerationActionResult>
  ) {
    await action();
    location.reload();
  }

  

  if (isBanned) {
    if (!isAdminTeamRole(role)) return null;

    return (
      <div style={{ marginTop: 6 }}>
        <button
          style={{ ...baseButton, borderColor: "#a33", color: "#ff6b6b" }}
          onClick={() =>
            run(() =>
              unbanUser({
                targetDiscordUserId: discordUserId,
                reason: "Manual unban by admin",
              })
            )
          }
        >
          Unban
        </button>
      </div>
    );
  }

  

  return (
    <div style={{ marginTop: 6 }}>
      {!isFlagged && hasTeamCapability(role, "canFlagUsers") && (
        <>
          <button
            style={baseButton}
            onClick={() => setShowFlag(!showFlag)}
          >
            🚩 Flag
          </button>

          {showFlag && (
            <div style={modalBox}>
              <div>
                <label>Reason</label>
                <select
                  value={flagReason}
                  onChange={(e) => {
                    const value = e.target.value;

                    if (
                      value === "trolling_low_effort" ||
                      value === "suspicious_behavior" ||
                      value === "other"
                    ) {
                      setFlagReason(value);
                    }
                  }}
                  style={{
                    width: "100%",
                    marginTop: 4,
                    background: "#1e1e1e",
                    color: "#fff",
                  }}
                >
                  <option value="trolling_low_effort">
                    Trolling
                  </option>
                  <option value="suspicious_behavior">
                    Suspicious behavior
                  </option>
                  <option value="other">Other</option>
                </select>
              </div>

              {flagReason === "other" && (
                <textarea
                  placeholder="Describe the issue…"
                  value={flagNote}
                  onChange={(e) => setFlagNote(e.target.value)}
                  style={{
                    width: "100%",
                    marginTop: 6,
                    background: "#1e1e1e",
                    color: "#fff",
                  }}
                />
              )}

              <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
                <button
                  style={baseButton}
                  disabled={
                    flagReason === "other" &&
                    flagNote.trim().length === 0
                  }
                  onClick={() =>
                    run(() =>
                      flagUser({
                        targetDiscordUserId: discordUserId,
                        reasonCode: flagReason,
                        note:
                          flagReason === "other"
                            ? flagNote
                            : undefined,
                      })
                    )
                  }
                >
                  Confirm Flag
                </button>

                <button
                  style={{
                    ...baseButton,
                    opacity: 0.7,
                  }}
                  onClick={() => setShowFlag(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {isFlagged && isAdminTeamRole(role) && (
        <>
          <button
            style={{ ...baseButton, marginRight: 6 }}
            onClick={() => setShowUnflag(!showUnflag)}
          >
            Unflag
          </button>

         <button
  style={{
    ...baseButton,
    borderColor: "#a33",
    color: "#ff6b6b",
  }}
  onClick={() => setShowBan(!showBan)}
>
  ⛔ Ban
</button>

{showBan && (
  <div style={modalBox}>
    <textarea
      placeholder="Reason for ban (required)…"
      value={banReason}
      onChange={(e) => setBanReason(e.target.value)}
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
        }}
        disabled={banReason.trim().length === 0}
        onClick={() =>
          run(() =>
            banUser({
              targetDiscordUserId: discordUserId,
              reason: banReason,
            })
          )
        }
      >
        Confirm Ban
      </button>

      <button
        style={{ ...baseButton, opacity: 0.7 }}
        onClick={() => {
          setShowBan(false);
          setBanReason("");
        }}
      >
        Cancel
      </button>
    </div>
  </div>
)}


          {showUnflag && (
            <div style={modalBox}>
              <textarea
                placeholder="Reason for unflagging (required)…"
                value={unflagReason}
                onChange={(e) => setUnflagReason(e.target.value)}
                style={{
                  width: "100%",
                  background: "#1e1e1e",
                  color: "#fff",
                }}
              />

              <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
                <button
                  style={baseButton}
                  disabled={unflagReason.trim().length === 0}
                  onClick={() =>
                    run(() =>
                      unflagUser({
                        targetDiscordUserId: discordUserId,
                        reason: unflagReason,
                      })
                    )
                  }
                >
                  Confirm Unflag
                </button>

                <button
                  style={{ ...baseButton, opacity: 0.7 }}
                  onClick={() => setShowUnflag(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

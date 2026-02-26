"use client";

type Props = {
  discordUserId: string;
  adminHandled: boolean;
  onDone?: () => void;
};

export default function BlockedUserMetaActions({
  discordUserId,
  adminHandled,
  onDone,
}: Props) {
  if (adminHandled) return null;

  async function markHandled() {
    await fetch("/api/admin/logs/blocked/handled", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        discord_user_id: discordUserId,
      }),
    });

    onDone?.();
  }

  return (
  <button
    onClick={markHandled}
    className="cursor-pointer text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20"
  >
    mark as handled
  </button>
);
}
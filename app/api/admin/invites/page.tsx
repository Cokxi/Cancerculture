// app/admin/invites/page.tsx
"use client";

import { useEffect, useState } from "react";

type InviteLog = {
  invited_discord_user_id: string;
  discord_username: string | null;
  discord_discriminator: string | null;
  discord_avatar: string | null;
  created_at: string;
};

type Invite = {
  id: string;
  invite_slug: string;
  note: string | null;
  created_at: string;
  invite_auth_logs: InviteLog[];
};

export default function AdminInvitesPage() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/invites/logs")
      .then((res) => res.json())
      .then((data) => {
        setInvites(data.invites ?? []);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return <div>Loading invites…</div>;
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Invites</h1>

      {invites.map((invite) => (
        <div
          key={invite.id}
          className="border border-white/10 rounded-lg p-4"
        >
          <div className="mb-2 text-sm text-white/70">
            Invite: <code>{invite.invite_slug}</code>
            {invite.note && <> – {invite.note}</>}
          </div>

          {invite.invite_auth_logs.length === 0 ? (
            <div className="text-white/40 text-sm">
              No one has used this invite yet.
            </div>
          ) : (
            <div className="space-y-2 mt-3">
              {invite.invite_auth_logs.map((log) => (
                <div
                  key={log.invited_discord_user_id + log.created_at}
                  className="flex items-center justify-between bg-white/5 rounded px-3 py-2"
                >
                  <div className="flex items-center gap-3">
                    {log.discord_avatar ? (
                      <img
                        src={`https://cdn.discordapp.com/avatars/${log.invited_discord_user_id}/${log.discord_avatar}.png`}
                        className="w-8 h-8 rounded-full"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-white/10" />
                    )}

                    <div>
                      <div className="text-sm">
                        {log.discord_username ?? "Unknown"}
                        {log.discord_discriminator &&
                          `#${log.discord_discriminator}`}
                      </div>
                      <div className="text-xs text-white/40">
                        {new Date(log.created_at).toLocaleString()}
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={async () => {
                      await fetch("/api/admin/team/role", {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                        },
                        body: JSON.stringify({
                          targetDiscordId:
                            log.invited_discord_user_id,
                          role: "mod",
                        }),
                      });

                      alert("User promoted to mod");
                    }}
                    className="text-sm px-3 py-1 rounded bg-green-600 hover:bg-green-700"
                  >
                    Make Mod
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

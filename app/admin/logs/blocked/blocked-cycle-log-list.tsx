"use client";

import { useEffect, useState } from "react";
import BlockedUserMetaActions from "./BlockedUserMetaActions";
import UserProfileLink from "../shared/UserProfileLink";

type BlockedUser = {
  discord_user_id: string;
  blocked_cycles: number[];
  block_count: number;
  latest_cycle: number;
  admin_handled: boolean;
  public_profile_id: string | null;
};

export default function BlockedCycleLogList({
  isAdmin,
}: {
  isAdmin: boolean;
}) {

  const [users, setUsers] = useState<BlockedUser[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [sort, setSort] = useState<"latest" | "general">("latest");

  async function load() {
    const res = await fetch(`/api/admin/logs/blocked?sort=${sort}`);
    const json = await res.json();
    setUsers(json.users ?? []);
  }

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/admin/logs/blocked?sort=${sort}`)
      .then((response) => response.json())
      .then((json) => {
        if (!cancelled) {
          setUsers(json.users ?? []);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sort]);

  function toggle(id: string) {
    setOpen((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  }

  return (
    <div className="space-y-2">
      
      <div className="flex gap-2 mb-4">
        <button
  onClick={() => setSort("latest")}
  className={`cursor-pointer ${sort === "latest" ? "font-bold" : ""}`}
>
  Latest
</button>

<button
  onClick={() => setSort("general")}
  className={`cursor-pointer ${sort === "general" ? "font-bold" : ""}`}
>
  Most Blocked
</button>
      </div>

      
      {users.map((u) => (
        <div
          key={u.discord_user_id}
          className="border rounded p-3"
        >
          <div className="flex justify-between items-center">

 
  <div className="flex items-center gap-2">

    
    <button
      onClick={() => toggle(u.discord_user_id)}
      className="cursor-pointer text-xs opacity-70 hover:opacity-100"
    >
      {open[u.discord_user_id] ? "▼" : "▶"}
    </button>

    
    <UserProfileLink
      discordUserId={u.discord_user_id}
      label={u.discord_user_id}
      publicProfileId={u.public_profile_id}
    />

  </div>

            <div className="flex gap-3 items-center">

                

  {isAdmin && !u.admin_handled && (
  <BlockedUserMetaActions
    discordUserId={u.discord_user_id}
    adminHandled={u.admin_handled}
    onDone={load}
  />
)}

  {u.admin_handled && (
    <span className="text-xs bg-green-600 px-2 py-1 rounded">
      handled
    </span>
  )}

  <span className="text-xs opacity-60">
    {u.block_count} blocks
  </span>
</div>
          </div>

          {open[u.discord_user_id] && (
  <div className="mt-2 pl-4 text-sm space-y-1">


    {u.blocked_cycles.map((cycle) => (
      <div key={cycle}>Cycle {cycle}</div>
    ))}
  </div>
)}
        </div>
      ))}
    </div>
  );
}

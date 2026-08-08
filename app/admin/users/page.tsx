export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/db/admin";
import { formatDiscordUserLabel } from "@/lib/discord/formatDiscordUserLabel";
import { getUserDirectoryQuery } from "@/lib/admin/userDirectoryAccess";
import {
  getUserFlagActiveStatus,
  listUserFlagCases,
} from "@/lib/admin/userFlagCases";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  getTeamAuthorizationContext,
  hasResolvedTeamCapability,
  type TeamAuthorizationContext,
} from "@/lib/auth/teamAuthorization";
import UserSubmissionsDropdown from "./UserSubmissionsDropdown";
import UserModerationActions from "./UserModerationActions";
import UserFlagCaseCreateForm from "./UserFlagCaseCreateForm";
import UserFlagHistoryDisclosure from "./UserFlagHistoryDisclosure";


type UserLog = {
  discord_user_id: string;
  public_profile_id?: string | null;
  current_discord_username: string | null;
  current_discord_handle?: string | null;
  current_display_name?: string | null;
  current_guild_nickname?: string | null;
  known_discord_usernames?: string[] | null;
  username_change_count?: number;
  submission_count?: number;

  
  is_banned?: boolean;
  website_ban_version?: number;
  ban_reason?: string | null;
  first_seen_at?: string;
  last_seen_at?: string;
};

type UserIdentityProjection = {
  discord_user_id: string;
  public_profile_id: string | null;
  current_discord_username: string | null;
  current_discord_handle: string | null;
  current_display_name: string | null;
  current_guild_nickname: string | null;
  is_banned?: boolean;
  website_ban_version?: number;
  ban_reason?: string | null;
};



export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string; q?: string }>;
}) {
  const params = await searchParams;
  const focusUserId = params?.focus ?? null;
  const query =
    typeof params?.q === "string"
      ? params.q.trim()
      : "";

  let authorization: TeamAuthorizationContext;

  try {
    authorization = await getTeamAuthorizationContext();
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);

    if (destination) {
      redirect(destination);
    }

    throw error;
  }

  const canViewBasicDirectory = hasResolvedTeamCapability(
    authorization,
    "users.directory.basic.view"
  );
  const canViewFullDirectory = hasResolvedTeamCapability(
    authorization,
    "users.directory.full.view"
  );
  const canViewDisqualificationHistory = hasResolvedTeamCapability(
    authorization,
    "users.disqualified_submissions.view"
  );
  const canViewDirectory = canViewBasicDirectory || canViewFullDirectory;
  const canCreateFlags = hasResolvedTeamCapability(
    authorization,
    "users.flag.create"
  );
  const canViewFlags = hasResolvedTeamCapability(
    authorization,
    "users.flag.view"
  );
  const canViewWebsiteBans = hasResolvedTeamCapability(
    authorization,
    "users.website_bans.view"
  );
  const canCreateWebsiteBan = hasResolvedTeamCapability(
    authorization,
    "users.website_bans.create"
  );
  const canRevokeWebsiteBan = hasResolvedTeamCapability(
    authorization,
    "users.website_bans.revoke"
  );

  if (
    !canViewDirectory &&
    !canCreateFlags &&
    !canViewFlags &&
    !canViewDisqualificationHistory
  ) {
    redirect("/403");
  }

  if (!canViewDirectory) {
    if (canViewDisqualificationHistory) {
      redirect("/admin/users/disqualifications");
    }

    return (
      <div style={{ padding: 24 }}>
        <h1>User flag access</h1>
        {canCreateFlags ? <UserFlagCaseCreateForm /> : null}
        {canViewFlags ? (
          <p style={{ marginTop: 16 }}>
            <Link href="/admin/flags">Open user flag cases and history</Link>
          </p>
        ) : null}
      </div>
    );
  }

  const directoryQuery = getUserDirectoryQuery(canViewFullDirectory);
  const isFullView = directoryQuery.isFullView;
  const { data: users, error } = await supabaseAdmin
    .from(directoryQuery.relation)
    .select(directoryQuery.select)
    .order(directoryQuery.orderBy, { ascending: false });

  const typedUsers = (users ?? []) as unknown as UserLog[];
  const flagPages = canViewFlags
    ? await Promise.all([
        listUserFlagCases({ section: "active", limit: 100 }),
        listUserFlagCases({ section: "history", limit: 100 }),
      ])
    : [];
  const flagCases = flagPages.flatMap((page) => page.items);
  const flagCasesByUser = new Map<
    string,
    readonly (typeof flagCases)[number][]
  >();

  for (const flagCase of flagCases) {
    const existing = flagCasesByUser.get(flagCase.discordUserId) ?? [];
    flagCasesByUser.set(
      flagCase.discordUserId,
      Object.freeze([...existing, flagCase])
    );
  }
  const filteredUsers =
    query === ""
      ? typedUsers
      : typedUsers.filter((user) => {
        const qLower = query.toLowerCase();
        const currentNames = [
          user.current_discord_username,
          user.current_discord_handle,
          user.current_display_name,
          user.current_guild_nickname,
        ];
        const searchableNames = isFullView
          ? [
              ...currentNames,
              ...(user.known_discord_usernames ?? []),
            ]
          : currentNames;

        return (
          user.discord_user_id.includes(query) ||
          searchableNames.some((name) =>
            name?.toLowerCase().includes(qLower)
          )
        );
      });

  const activeFlagStatusByUser = new Map<
    string,
    "open" | "escalated"
  >();
  if (canCreateFlags) {
    if (canViewFlags) {
      for (const flagCase of flagCases) {
        if (flagCase.status === "open" || flagCase.status === "escalated") {
          activeFlagStatusByUser.set(
            flagCase.discordUserId,
            flagCase.status
          );
        }
      }
    } else {
      const statuses = await Promise.all(
        filteredUsers.map(async (user) => [
          user.discord_user_id,
          await getUserFlagActiveStatus(user.discord_user_id),
        ] as const)
      );
      for (const [discordUserId, status] of statuses) {
        if (status.active && status.status) {
          activeFlagStatusByUser.set(discordUserId, status.status);
        }
      }
    }
  }


  if (error) {
    console.error("USER LOG VIEW ERROR", error);
    return <div style={{ padding: 24 }}>Failed to load user logs</div>;
  }

  const discordUserIds =
    (filteredUsers ?? []).map(
      (user: UserLog) => user.discord_user_id
    );
  const needsWebsiteBanState =
    canViewWebsiteBans || canCreateWebsiteBan || canRevokeWebsiteBan;
  const identitySelect = [
    "discord_user_id",
    "public_profile_id",
    "current_discord_username",
    "current_discord_handle",
    "current_display_name",
    "current_guild_nickname",
    ...(needsWebsiteBanState ? ["is_banned", "website_ban_version"] : []),
    ...(canViewWebsiteBans ? ["ban_reason"] : []),
  ].join(", ");
  const publicProfilesResult =
    discordUserIds.length > 0
      ? await supabaseAdmin
          .from("user_logs")
          .select(identitySelect)
          .in("discord_user_id", discordUserIds)
      : { data: [], error: null };
  const identityRows = (publicProfilesResult.data ?? []) as unknown as
    UserIdentityProjection[];

  const userLabelByDiscordUserId = new Map(
    identityRows.map((row) => [
      row.discord_user_id,
      formatDiscordUserLabel(row),
    ])
  );
  const publicProfileIdByDiscordUserId = new Map(
    identityRows.map((row) => [
      row.discord_user_id,
      row.public_profile_id,
    ])
  );
  const websiteBanStateByDiscordUserId = new Map(
    identityRows.map((row) => [
      row.discord_user_id,
      {
        isBanned: Boolean(row.is_banned),
        version:
          typeof row.website_ban_version === "number"
            ? row.website_ban_version
            : 0,
        reason: typeof row.ban_reason === "string" ? row.ban_reason : null,
      },
    ])
  );
  return (
    <div style={{ padding: 24 }}>
      <h1>{isFullView ? "Full User Directory" : "Users"}</h1>

      <form method="get" style={{ marginTop: 12 }}>
  <input
    type="text"
    name="q"
    placeholder="Filter by Discord ID or username"
    defaultValue={query}
    style={{
      padding: "4px 8px",
      fontSize: 13,
      width: 320,
      background: "#0b0b0b",
      border: "1px solid #333",
      color: "white",
    }}
  />

  
</form>


      {!filteredUsers || filteredUsers.length === 0 ? (
        <p style={{ marginTop: 16, opacity: 0.7 }}>No users found.</p>
      ) : (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            marginTop: 16,
          }}
        >
          <thead>
            <tr>
              <th align="left">User</th>
              <th align="left">Discord ID</th>
              {canViewFlags ? <th align="left">Flag cases</th> : null}
              {isFullView ? <th align="left">Stats</th> : null}
              {isFullView ? <th align="left">Activity</th> : null}
            </tr>
          </thead>

          <tbody>
            {filteredUsers.map((user: UserLog) => {
  const userLabel =
    userLabelByDiscordUserId.get(user.discord_user_id) ??
    formatDiscordUserLabel(user);
  const isMatch =
    query !== "" &&
    (
      user.discord_user_id.includes(query) ||
      [
        user.current_discord_username,
        user.current_discord_handle,
        user.current_display_name,
        user.current_guild_nickname,
        ...(isFullView ? user.known_discord_usernames ?? [] : []),
      ].some((name) =>
        name?.toLowerCase().includes(query.toLowerCase())
      )
    );

  return (
    <tr
      key={user.discord_user_id}
      style={{
        borderTop: "1px solid #333",
        verticalAlign: "top",
        background: isMatch ? "#141414" : undefined,
      }}
    >


                
                <td style={{ padding: "8px 0" }}>
  {publicProfileIdByDiscordUserId.get(user.discord_user_id) ? (
    <Link
      href={`/profile/${publicProfileIdByDiscordUserId.get(user.discord_user_id)}`}
      style={{
        color: "#ff9f1c",
        textDecoration: "underline",
        textUnderlineOffset: 4,
      }}
    >
      <strong>
        {userLabel}
      </strong>
    </Link>
  ) : (
    <strong>
      {userLabel}
    </strong>
  )}

{canViewWebsiteBans &&
  websiteBanStateByDiscordUserId.get(user.discord_user_id)?.isBanned &&
  websiteBanStateByDiscordUserId.get(user.discord_user_id)?.reason && (
  <div
    style={{
      marginTop: 6,
      fontSize: 12,
      background: "#1a0e0e",
      border: "1px solid #553333",
      borderRadius: 4,
      padding: "6px 8px",
      color: "#ff6b6b",
    }}
  >
    <strong>BANNED</strong>
    <div style={{ marginTop: 2 }}>
      {websiteBanStateByDiscordUserId.get(user.discord_user_id)?.reason}
    </div>
  </div>
)}


  
  <UserModerationActions
    discordUserId={user.discord_user_id}
    isBanned={
      websiteBanStateByDiscordUserId.get(user.discord_user_id)?.isBanned ??
      false
    }
    websiteBanVersion={
      websiteBanStateByDiscordUserId.get(user.discord_user_id)?.version ?? 0
    }
    canCreateFlags={canCreateFlags}
    canCreateWebsiteBan={canCreateWebsiteBan}
    canRevokeWebsiteBan={canRevokeWebsiteBan}
    activeFlagStatus={
      activeFlagStatusByUser.get(user.discord_user_id) ?? null
    }
  />

  {canViewDisqualificationHistory &&
  publicProfileIdByDiscordUserId.get(user.discord_user_id) ? (
    <div style={{ marginTop: 8 }}>
      <Link
        href={`/admin/users/disqualifications/${encodeURIComponent(
          publicProfileIdByDiscordUserId.get(user.discord_user_id)!
        )}`}
        style={{
          display: "inline-block",
          border: "1px solid #ff9f1c",
          borderRadius: 999,
          padding: "5px 10px",
          color: "#ff9f1c",
          fontSize: 12,
          textDecoration: "none",
        }}
      >
        View User Moderation History
      </Link>
    </div>
  ) : null}

</td>


                
                <td
                  style={{
                    fontFamily: "monospace",
                    fontSize: 12,
                    padding: "8px 0",
                    opacity: 0.8,
                  }}
                >
                  {user.discord_user_id}
                </td>

                {canViewFlags ? (
                  <td style={{ padding: "8px 16px 8px 0" }}>
                    <UserFlagHistoryDisclosure
                      flagCases={
                        flagCasesByUser.get(user.discord_user_id) ?? []
                      }
                      userLabel={userLabel}
                    />
                  </td>
                ) : null}

                  

                
                {isFullView ? <td style={{ padding: "8px 0" }}>
                  <div>
                    Submissions: <strong>{user.submission_count}</strong>
                  </div>

                  <div>
                    Name changes:{" "}
                    <strong>{user.username_change_count}</strong>
                  </div>

                  {user.known_discord_usernames &&
                    user.known_discord_usernames.length > 1 && (
                      <details style={{ marginTop: 4, fontSize: 12 }}>
                        <summary
                          style={{ cursor: "pointer", opacity: 0.8 }}
                        >
                          Known names
                        </summary>
                        <ul style={{ marginTop: 4, paddingLeft: 16 }}>
                          {user.known_discord_usernames.map((name, i) => (
                            <li key={i}>{name}</li>
                          ))}
                        </ul>
                      </details>
                    )}

                  <UserSubmissionsDropdown
                    discordUserId={user.discord_user_id}
                    defaultOpen={focusUserId === user.discord_user_id}
                    includeDisqualified={authorization.isAdmin}
                    includeVoteCounts={authorization.isAdmin}
                  />

                </td> : null}

                
                {isFullView ? <td
                  style={{
                    padding: "8px 0",
                    fontSize: 12,
                    opacity: 0.8,
                  }}
                >
                  <div>
                    First seen:
                    <br />
                    {user.first_seen_at
                      ? new Date(user.first_seen_at).toLocaleString()
                      : "—"}
                  </div>

                  <div style={{ marginTop: 4 }}>
                    Last seen:
                    <br />
                    {user.last_seen_at
                      ? new Date(user.last_seen_at).toLocaleString()
                      : "—"}
                  </div>
                </td> : null}
                           </tr>
            );
          })}

          </tbody>
        </table>
      )}
      
    </div>
  );
}

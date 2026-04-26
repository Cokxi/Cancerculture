import "server-only";
export async function checkDiscordMembership(userId: string) {
  try {
    const res = await fetch(
      `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${userId}`,
      {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        },
      }
    )

    if (res.status === 404) {
      return { isMember: false }
    }

    if (!res.ok) {
      throw new Error("Discord API error")
    }

    const data = await res.json()

    return {
      isMember: true,
      joinedAt: data.joined_at,
    }
  } catch (err) {
    console.error("Discord membership check failed:", err)

    throw new Error("Could not verify Discord membership")
  }
}

import {
  DISCORD_SYNC_DELAY_NOTICE_BODY,
  DISCORD_SYNC_DELAY_NOTICE_GUIDANCE,
  DISCORD_SYNC_DELAY_NOTICE_TITLE,
} from "@/lib/eligibility/discordSyncDelayNotice";

export default function DiscordSyncDelayNotice({
  className = "",
}: {
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="font-semibold">{DISCORD_SYNC_DELAY_NOTICE_TITLE}</p>
      <p className="mt-3">{DISCORD_SYNC_DELAY_NOTICE_BODY}</p>
      <p className="mt-3">{DISCORD_SYNC_DELAY_NOTICE_GUIDANCE}</p>
    </div>
  );
}

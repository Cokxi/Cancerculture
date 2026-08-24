export const dynamic = "force-dynamic";

import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { loadCommunityCommentModerationLog } from "@/lib/comments/commentModeration.server";

export default async function CommunityCommentModerationLogPage() {
  await requireTeamCapabilityPage("logs.community_comment_moderation.view", "/admin/logs/comment-moderation");
  const data = await loadCommunityCommentModerationLog();
  const items = Array.isArray(data.items) ? data.items as Record<string, unknown>[] : [];
  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-['Permanent_Marker'] text-4xl text-[var(--orange-main)]">Comment Moderation Log</h1>
        <p className="mt-2 text-white/65">Redacted append-only Remove and Restore history. Report facts, Spam signals, internal reasons, and Discord IDs are excluded.</p>
      </header>
      <ol className="space-y-3">
        {items.map((item) => (
          <li key={String(item.id)} className="rounded-2xl border border-white/10 bg-black/35 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-semibold">{String(item.action ?? "action")} · Comment {String(item.publicCommentId ?? "")}</p>
              <time className="text-xs text-white/50">{typeof item.createdAt === "string" ? new Date(item.createdAt).toLocaleString("en-GB") : ""}</time>
            </div>
            <p className="mt-2 text-sm text-white/60">Submission #{String(item.submissionId ?? "-")} · moderation v{String(item.moderationVersion ?? "-")}</p>
            <p className="mt-1 text-xs text-white/45">{String(item.actorDisplayName ?? "Team member")} · {String(item.actorRole ?? "team")}{typeof item.sourceTopic === "string" ? ` · ${item.sourceTopic.replaceAll("_", " ")}` : ""}</p>
          </li>
        ))}
      </ol>
      {items.length === 0 ? <p className="rounded-2xl border border-white/10 p-6 text-white/60">No Comment moderation events.</p> : null}
    </section>
  );
}

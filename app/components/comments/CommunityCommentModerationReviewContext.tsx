import type { CommunityCommentModerationReviewContext } from "@/lib/comments/commentClient";

export default function CommunityCommentModerationReviewContextView({
  context,
  showStoredText = true,
}: {
  context: CommunityCommentModerationReviewContext;
  showStoredText?: boolean;
}) {
  const latest = context.lastModeration;
  return (
    <section className="mt-3 rounded-xl border border-orange-300/20 bg-orange-500/5 p-3">
      {showStoredText ? (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-orange-200/70">
            Stored Comment text · version {context.textVersion}
          </p>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-white/85">
            {context.text}
          </p>
        </>
      ) : null}
      {latest ? (
        <div className={showStoredText ? "mt-3 border-t border-white/10 pt-3" : ""}>
          <p className="text-xs font-semibold uppercase tracking-wide text-white/55">
            Latest moderation · {latest.action} · version {latest.moderationVersion}
          </p>
          <p className="mt-1 text-xs text-white/50">
            {latest.actorDisplayName} · {latest.actorRole} · {new Date(latest.createdAt).toLocaleString("en-GB")}
          </p>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-white/75">
            Reason: {latest.reason}
          </p>
        </div>
      ) : null}
    </section>
  );
}

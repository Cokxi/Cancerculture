"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import TurnstileWidget from "@/app/components/TurnstileWidget";
import {
  CommunityCommentClientError,
  searchCommunityCommentMentions,
  type CommunityCommentMentionTarget,
  type CommunityCommentMutationReceipt,
} from "@/lib/comments/commentClient";
import type { CommunityCommentPublicDto } from "@/lib/comments/commentDto";
import { TURNSTILE_ACTIONS } from "@/lib/turnstile/shared";

type SelectedMention = {
  targetPublicProfileId: string;
  displayName: string;
  startIndex: number;
  endIndex: number;
  sourceText: string;
};

type MentionQuery = {
  query: string;
  startUtf16: number;
  endUtf16: number;
};

function codePointLength(value: string) {
  return Array.from(value).length;
}

function mentionText(mention: SelectedMention) {
  return mention.sourceText;
}

function reconcileMentions(
  previousBody: string,
  nextBody: string,
  mentions: SelectedMention[],
) {
  const previous = Array.from(previousBody);
  const next = Array.from(nextBody);
  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < next.length &&
    previous[prefix] === next[prefix]
  ) prefix += 1;

  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix += 1;

  const oldSuffixStart = previous.length - suffix;
  const delta = next.length - previous.length;
  return mentions.flatMap((mention) => {
    let startIndex = mention.startIndex;
    let endIndex = mention.endIndex;
    if (mention.endIndex <= prefix) {
      // The edit is after this Mention.
    } else if (mention.startIndex >= oldSuffixStart) {
      startIndex += delta;
      endIndex += delta;
    } else {
      return [];
    }
    if (
      next.slice(startIndex, endIndex).join("") !== mentionText(mention)
    ) return [];
    return [{ ...mention, startIndex, endIndex }];
  });
}

function getMentionQuery(body: string, caretUtf16: number): MentionQuery | null {
  const beforeCaret = body.slice(0, caretUtf16);
  const at = beforeCaret.lastIndexOf("@");
  if (at < 0 || (at > 0 && /[\p{L}\p{N}_@]/u.test(beforeCaret[at - 1]))) {
    return null;
  }
  const query = beforeCaret.slice(at + 1);
  if (
    query !== query.trim() ||
    query.length < 2 ||
    query.length > 64 ||
    /[\n\r@]/u.test(query)
  ) return null;
  return { query, startUtf16: at, endUtf16: caretUtf16 };
}

function messageForError(error: CommunityCommentClientError) {
  switch (error.code) {
    case "TEXT_EMPTY":
      return "Write some text before posting.";
    case "TEXT_TOO_LONG":
    case "TEXT_TOO_LARGE":
      return "This comment is over the allowed text limit.";
    case "EXTERNAL_LINK_REJECTED":
      return "External links and domains are not allowed in comments.";
    case "MENTION_ONLY_REJECTED":
      return "Add some text of your own alongside the mention.";
    case "STALE_THREAD":
      return "The conversation updated while you posted. Your draft is still here and the latest comments were loaded.";
    case "STALE_COMMENT":
      return "This comment changed elsewhere. Your draft is still here; review the latest version before trying again.";
    case "ROOT_UNAVAILABLE":
    case "TARGET_UNAVAILABLE":
    case "BRANCH_CLOSED":
      return "This reply target is no longer available. Your draft is still here.";
    case "EDIT_WINDOW_CLOSED":
      return "The 15-minute editing window has closed.";
    case "COOLDOWN":
      return "Please wait a moment before trying again. Your text is still here.";
    case "TURNSTILE_REQUIRED":
      return "Please complete the verification below. Your text is still here.";
    case "READ_ONLY":
      return "Comments are currently read-only. Your text has not been sent.";
    case "NOT_AUTHENTICATED":
      return "Your session ended. Sign in again before posting.";
    case "IDEMPOTENCY_CONFLICT":
      return "This request changed while it was being retried. Please try once more.";
    default:
      return error.status >= 500
        ? "Comments are temporarily unavailable. Your text is still here."
        : "The comment could not be saved. Your text is still here.";
  }
}

export default function CommunityCommentComposer({
  initialBody = "",
  initialMentions = [],
  label,
  submitLabel,
  turnstileSiteKey,
  autoFocus = false,
  onCancel,
  onSubmit,
  onSuccess,
}: {
  initialBody?: string;
  initialMentions?: CommunityCommentPublicDto["mentions"];
  label: string;
  submitLabel: string;
  turnstileSiteKey: string | null;
  autoFocus?: boolean;
  onCancel?: () => void;
  onSubmit: (input: {
    body: string;
    mentions: Array<{
      targetPublicProfileId: string;
      startIndex: number;
      endIndex: number;
    }>;
    requestId: string;
    turnstileToken: string | null;
  }) => Promise<CommunityCommentMutationReceipt>;
  onSuccess: (receipt: CommunityCommentMutationReceipt) => void;
}) {
  const [body, setBody] = useState(initialBody);
  const [mentions, setMentions] = useState<SelectedMention[]>(
    initialMentions.map((mention) => ({
      targetPublicProfileId: mention.targetPublicProfileId,
      displayName: mention.displayName,
      startIndex: mention.startIndex,
      endIndex: mention.endIndex,
      sourceText: Array.from(initialBody)
        .slice(mention.startIndex, mention.endIndex)
        .join(""),
    })),
  );
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [targets, setTargets] = useState<CommunityCommentMentionTarget[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "error">("idle");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [turnstileRequired, setTurnstileRequired] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const requestRef = useRef({ body: initialBody, requestId: crypto.randomUUID() });
  const busyRef = useRef(false);
  const statusId = useId();

  useEffect(() => {
    if (!autoFocus) return;
    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
      textareaRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus]);

  useEffect(() => {
    if (!query) {
      setTargets([]);
      setSearchState("idle");
      return;
    }
    const controller = new AbortController();
    setSearchState("loading");
    const timer = window.setTimeout(() => {
      searchCommunityCommentMentions(query.query)
        .then((items) => {
          if (!controller.signal.aborted) {
            setTargets(items);
            setSearchState("idle");
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setTargets([]);
            setSearchState("error");
          }
        });
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  const characterCount = useMemo(() => codePointLength(body), [body]);
  const byteCount = useMemo(
    () => new TextEncoder().encode(body).byteLength,
    [body],
  );
  const nearLimit = characterCount >= 9_000 || byteCount >= 36_000;

  function updateBody(nextBody: string, caretUtf16: number) {
    setMentions((current) => reconcileMentions(body, nextBody, current));
    setBody(nextBody);
    setStatus(null);
    setQuery(getMentionQuery(nextBody, caretUtf16));
    if (requestRef.current.body !== nextBody) {
      requestRef.current = { body: nextBody, requestId: crypto.randomUUID() };
    }
  }

  function selectMention(target: CommunityCommentMentionTarget) {
    if (!query) return;
    const token = `@${target.displayName}`;
    const nextBody =
      body.slice(0, query.startUtf16) + token + body.slice(query.endUtf16);
    const startIndex = codePointLength(body.slice(0, query.startUtf16));
    const endIndex = startIndex + codePointLength(token);
    setBody(nextBody);
    setMentions((current) => [
      ...reconcileMentions(body, nextBody, current).filter(
        (mention) => mention.targetPublicProfileId !== target.publicProfileId,
      ),
      {
        targetPublicProfileId: target.publicProfileId,
        displayName: target.displayName,
        startIndex,
        endIndex,
        sourceText: token,
      },
    ].sort((left, right) => left.startIndex - right.startIndex));
    requestRef.current = { body: nextBody, requestId: crypto.randomUUID() };
    setQuery(null);
    window.requestAnimationFrame(() => {
      const caret = query.startUtf16 + token.length;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }

  async function submit() {
    if (busyRef.current || (turnstileRequired && !turnstileToken)) return;
    busyRef.current = true;
    setBusy(true);
    setStatus(null);
    try {
      const receipt = await onSubmit({
        body,
        mentions: mentions.map(({ targetPublicProfileId, startIndex, endIndex }) => ({
          targetPublicProfileId,
          startIndex,
          endIndex,
        })),
        requestId: requestRef.current.requestId,
        turnstileToken,
      });
      setTurnstileToken(null);
      setTurnstileResetKey((current) => current + 1);
      onSuccess(receipt);
    } catch (error) {
      if (error instanceof CommunityCommentClientError) {
        if (error.code === "TURNSTILE_REQUIRED") setTurnstileRequired(true);
        setStatus(messageForError(error));
      } else {
        setStatus("Comments are temporarily unavailable. Your text is still here.");
      }
      if (turnstileToken) {
        setTurnstileToken(null);
        setTurnstileResetKey((current) => current + 1);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-orange-500/25 bg-black/45 p-3 sm:p-4">
      <label className="block text-sm font-semibold text-orange-100">
        {label}
        <textarea
          ref={textareaRef}
          rows={4}
          value={body}
          onChange={(event) =>
            updateBody(event.target.value, event.target.selectionStart)
          }
          onClick={(event) =>
            setQuery(
              getMentionQuery(
                event.currentTarget.value,
                event.currentTarget.selectionStart,
              ),
            )
          }
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              setQuery(null);
            }
          }}
          className="mt-2 block min-h-28 w-full resize-y rounded-xl border border-white/15 bg-neutral-950 px-3 py-3 text-base font-normal text-white outline-none placeholder:text-white/35 focus:border-orange-400 focus:ring-2 focus:ring-orange-400/35"
          placeholder="Write a comment…"
          aria-describedby={status ? statusId : undefined}
        />
      </label>

      {query ? (
        <div className="mt-2 rounded-xl border border-white/10 bg-neutral-950 p-2" role="listbox" aria-label="Mention suggestions">
          {searchState === "loading" ? (
            <p className="px-2 py-2 text-sm text-white/60">Searching people…</p>
          ) : searchState === "error" ? (
            <p className="px-2 py-2 text-sm text-red-200">Mention search is unavailable.</p>
          ) : targets.length === 0 ? (
            <p className="px-2 py-2 text-sm text-white/60">No matching people.</p>
          ) : (
            targets.map((target) => (
              <button
                key={target.publicProfileId}
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => selectMention(target)}
                className="flex min-h-11 w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
              >
                <span>@{target.displayName}</span>
                {target.isBanned ? (
                  <span className="rounded-full border border-white/15 px-2 py-0.5 text-xs text-white/60">Banned</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : null}

      {nearLimit ? (
        <p className="mt-2 text-xs text-yellow-200" role="status">
          Near the comment limit: {characterCount.toLocaleString("en-GB")} / 10,000 characters and {byteCount.toLocaleString("en-GB")} / 40,000 bytes.
        </p>
      ) : null}

      {turnstileRequired ? (
        <div className="mt-3">
          <TurnstileWidget
            action={TURNSTILE_ACTIONS.communityComment}
            siteKey={turnstileSiteKey}
            resetKey={turnstileResetKey}
            onTokenChange={setTurnstileToken}
          />
        </div>
      ) : null}

      {status ? (
        <p id={statusId} className="mt-2 text-sm text-red-200" role="alert">
          {status}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="min-h-11 rounded-full border border-white/15 px-4 py-2 text-sm font-semibold text-white hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:opacity-50"
          >
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || (turnstileRequired && !turnstileToken)}
          aria-busy={busy}
          className="min-h-11 rounded-full bg-[var(--orange-main)] px-5 py-2 text-sm font-bold text-black hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-55"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

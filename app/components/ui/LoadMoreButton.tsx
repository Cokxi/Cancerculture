"use client";

export default function LoadMoreButton({
  error,
  hasMore,
  isLoading,
  onLoadMore,
}: {
  error: string | null;
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
}) {
  if (!hasMore) {
    return null;
  }

  return (
    <div className="mt-8 flex flex-col items-center gap-3">
      {error ? (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        disabled={isLoading}
        aria-busy={isLoading}
        onClick={onLoadMore}
        className="min-h-11 cursor-pointer rounded-full border border-[var(--orange-dark)]/60 bg-black/60 px-6 py-2 text-sm font-semibold text-white transition hover:border-[var(--orange-dark)] hover:bg-[var(--orange-dark)]/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-dark)] focus-visible:ring-offset-2 focus-visible:ring-offset-black active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isLoading
          ? "Loading..."
          : error
            ? "Retry"
            : "Load more"}
      </button>
    </div>
  );
}

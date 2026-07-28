"use client";

import { useCallback, useRef, useState } from "react";
import type { PublicPage } from "./publicPagination";
import { mergePublicPageItems } from "./mergePublicPageItems";

function isPublicPage<T>(value: unknown): value is PublicPage<T> {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as PublicPage<T>).items) ||
    typeof (value as PublicPage<T>).hasMore !== "boolean"
  ) {
    return false;
  }

  const nextCursor = (value as PublicPage<T>).nextCursor;
  return (
    nextCursor === null ||
    (typeof nextCursor === "string" && nextCursor.length > 0)
  );
}

export function usePublicPagination<T>({
  fetchPage,
  getKey,
  initialPage,
}: {
  fetchPage: (cursor: string) => Promise<PublicPage<T>>;
  getKey: (item: T) => string | number;
  initialPage: PublicPage<T>;
}) {
  const [items, setItems] = useState(initialPage.items);
  const [nextCursor, setNextCursor] = useState(
    initialPage.nextCursor
  );
  const [hasMore, setHasMore] = useState(initialPage.hasMore);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const loadMore = useCallback(async () => {
    if (
      loadingRef.current ||
      !hasMore ||
      !nextCursor
    ) {
      return;
    }

    loadingRef.current = true;
    setIsLoading(true);
    setError(null);

    try {
      const page = await fetchPage(nextCursor);

      if (!isPublicPage<T>(page)) {
        throw new Error("INVALID_PAGE_RESPONSE");
      }

      setItems((current) =>
        mergePublicPageItems(current, page.items, getKey)
      );
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      setError("Could not load more. Please try again.");
    } finally {
      loadingRef.current = false;
      setIsLoading(false);
    }
  }, [fetchPage, getKey, hasMore, nextCursor]);

  const loadUntil = useCallback(
    async (predicate: (item: T) => boolean) => {
      const existingItem = items.find(predicate);

      if (existingItem) {
        return existingItem;
      }

      if (
        loadingRef.current ||
        !hasMore ||
        !nextCursor
      ) {
        return null;
      }

      loadingRef.current = true;
      setIsLoading(true);
      setError(null);

      let accumulatedItems = items;
      let cursor: string | null = nextCursor;
      let pageHasMore: boolean = hasMore;

      try {
        while (pageHasMore && cursor) {
          const page = await fetchPage(cursor);

          if (!isPublicPage<T>(page)) {
            throw new Error("INVALID_PAGE_RESPONSE");
          }

          accumulatedItems = mergePublicPageItems(
            accumulatedItems,
            page.items,
            getKey
          );
          cursor = page.nextCursor;
          pageHasMore = page.hasMore;

          setItems(accumulatedItems);
          setNextCursor(cursor);
          setHasMore(pageHasMore);

          const foundItem = accumulatedItems.find(predicate);

          if (foundItem) {
            return foundItem;
          }
        }

        return null;
      } catch {
        setError("Could not load more. Please try again.");
        return null;
      } finally {
        loadingRef.current = false;
        setIsLoading(false);
      }
    },
    [
      fetchPage,
      getKey,
      hasMore,
      items,
      nextCursor,
    ]
  );

  return {
    error,
    hasMore,
    isLoading,
    items,
    loadMore,
    loadUntil,
  };
}

import {
  getCommunityFeedCanonicalUrl,
  getCommunityFeedDetailMediaPath,
} from "@/lib/feed/communityFeedDetail";

export const COMMUNITY_FEED_SHARE_TITLE = "CancerCulture meme";
export const COMMUNITY_FEED_SHARE_TEXT = "A meme from CancerCulture.";

const COMMUNITY_FEED_SHARE_MEDIA_TYPE = "image/webp";
const COMMUNITY_FEED_SHARE_MEDIA_MAX_BYTES = 4_000_000;

type ShareNavigator = {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data?: ShareData) => boolean;
};

type FileFactory = (
  fileBits: BlobPart[],
  fileName: string,
  options: FilePropertyBag,
) => File;

export type CommunityFeedShareOutcome =
  | "shared"
  | "aborted"
  | "unsupported"
  | "failed";

function isAbortError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

async function loadPublicMemeFile({
  submissionId,
  fetchImpl,
  fileFactory,
}: {
  submissionId: number;
  fetchImpl: typeof fetch;
  fileFactory: FileFactory;
}) {
  try {
    const response = await fetchImpl(
      getCommunityFeedDetailMediaPath(submissionId),
      {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: COMMUNITY_FEED_SHARE_MEDIA_TYPE },
        redirect: "error",
      },
    );
    const contentType =
      response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() ?? "";
    if (!response.ok || response.redirected || contentType !== COMMUNITY_FEED_SHARE_MEDIA_TYPE) {
      return null;
    }

    const blob = await response.blob();
    if (
      blob.type !== COMMUNITY_FEED_SHARE_MEDIA_TYPE ||
      blob.size === 0 ||
      blob.size > COMMUNITY_FEED_SHARE_MEDIA_MAX_BYTES
    ) {
      return null;
    }

    return fileFactory([blob], "cancerculture-meme.webp", {
      type: COMMUNITY_FEED_SHARE_MEDIA_TYPE,
    });
  } catch {
    return null;
  }
}

export function getCommunityFeedBaseShareData(submissionId: number): ShareData {
  return {
    title: COMMUNITY_FEED_SHARE_TITLE,
    text: COMMUNITY_FEED_SHARE_TEXT,
    url: getCommunityFeedCanonicalUrl(submissionId),
  };
}

export async function shareCommunityFeedMeme({
  submissionId,
  navigatorImpl = navigator,
  fetchImpl = fetch,
  fileFactory = (fileBits, fileName, options) =>
    new File(fileBits, fileName, options),
}: {
  submissionId: number;
  navigatorImpl?: ShareNavigator;
  fetchImpl?: typeof fetch;
  fileFactory?: FileFactory;
}): Promise<CommunityFeedShareOutcome> {
  if (typeof navigatorImpl.share !== "function") return "unsupported";

  const baseShareData = getCommunityFeedBaseShareData(submissionId);
  let shareData = baseShareData;

  if (typeof navigatorImpl.canShare === "function") {
    const file = await loadPublicMemeFile({
      submissionId,
      fetchImpl,
      fileFactory,
    });
    if (file) {
      const fileShareData: ShareData = { ...baseShareData, files: [file] };
      try {
        if (navigatorImpl.canShare(fileShareData)) shareData = fileShareData;
      } catch {
        // A browser with incomplete File Share support still receives text and URL.
      }
    }
  }

  try {
    await navigatorImpl.share(shareData);
    return "shared";
  } catch (error) {
    return isAbortError(error) ? "aborted" : "failed";
  }
}

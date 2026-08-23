import type { Metadata } from "next";
import {
  getCommunityFeedCanonicalUrl,
  getCommunityFeedDetailMediaUrl,
} from "@/lib/feed/communityFeedDetail";

export type CommunityFeedMetadataSource = {
  submissionId: number;
  mediaWidth: number | null;
  mediaHeight: number | null;
};

const TITLE = "Meme on CancerCulture";
const DESCRIPTION = "View this public meme in The Spread on CancerCulture.";

export function createCommunityFeedMetadata(
  source: CommunityFeedMetadataSource | null,
): Metadata {
  if (!source) {
    return {
      title: "CancerCulture",
      description: "CancerCulture",
      robots: { index: false, follow: false },
    };
  }

  const canonicalUrl = getCommunityFeedCanonicalUrl(source.submissionId);
  const imageUrl = getCommunityFeedDetailMediaUrl(source.submissionId);
  const hasDimensions =
    Number.isSafeInteger(source.mediaWidth) &&
    Number(source.mediaWidth) > 0 &&
    Number.isSafeInteger(source.mediaHeight) &&
    Number(source.mediaHeight) > 0;
  const image = {
    url: imageUrl,
    alt: "Community meme on CancerCulture",
    type: "image/webp",
    ...(hasDimensions
      ? { width: source.mediaWidth as number, height: source.mediaHeight as number }
      : {}),
  };

  return {
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: TITLE,
      description: DESCRIPTION,
      url: canonicalUrl,
      siteName: "CancerCulture",
      type: "website",
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title: TITLE,
      description: DESCRIPTION,
      images: [imageUrl],
    },
  };
}

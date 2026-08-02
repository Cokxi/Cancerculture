export const SUBMISSION_THUMBNAIL_TRANSFORM = "w=400,q=75";

export function getSubmissionThumbnailUrl(imageUrl: string) {
  const url = new URL(imageUrl);

  return `${url.origin}/cdn-cgi/image/${SUBMISSION_THUMBNAIL_TRANSFORM}${url.pathname}${url.search}`;
}

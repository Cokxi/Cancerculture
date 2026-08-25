const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type CommentOwnerCursor = Readonly<{
  kind: "comments" | "mentions";
  snapshotAt: string;
  at: string;
  id: string;
}>;

export function encodeCommentOwnerCursor(cursor: CommentOwnerCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function parseCommentOwnerCursor(
  value: string | null | undefined,
  expectedKind: CommentOwnerCursor["kind"]
) {
  if (!value || value.length < 4 || value.length > 768) return null;
  try {
    const candidate = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    if (
      candidate.kind !== expectedKind ||
      typeof candidate.snapshotAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.snapshotAt)) ||
      typeof candidate.at !== "string" ||
      !Number.isFinite(Date.parse(candidate.at)) ||
      typeof candidate.id !== "string" ||
      !UUID_PATTERN.test(candidate.id)
    ) {
      return null;
    }
    return Object.freeze({
      kind: expectedKind,
      snapshotAt: candidate.snapshotAt,
      at: candidate.at,
      id: candidate.id,
    });
  } catch {
    return null;
  }
}

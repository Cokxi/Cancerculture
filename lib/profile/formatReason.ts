export function formatReason(reason: string) {
  return reason
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

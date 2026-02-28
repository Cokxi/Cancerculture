export function getPublicImageUrl(
  r2_key: string | null | undefined
): string | undefined {
  if (!r2_key) return undefined;

  const base = process.env.R2_PUBLIC_BASE_URL;

  if (!base) {
    console.warn("Missing R2_PUBLIC_BASE_URL");
    return undefined;
  }

  return `${base}/${r2_key}`;
}
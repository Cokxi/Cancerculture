export function getPublicImageUrl(r2_key: string | null | undefined) {
  if (!r2_key) return null;

  const base = process.env.R2_PUBLIC_BASE_URL;

  if (!base) {
    console.warn("Missing R2_PUBLIC_BASE_URL");
    return null;
  }

  return `${base}/${r2_key}`;
}
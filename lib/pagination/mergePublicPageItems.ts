export function mergePublicPageItems<T>(
  existing: T[],
  incoming: T[],
  getKey: (item: T) => string | number
) {
  const seen = new Set(existing.map(getKey));
  const merged = [...existing];

  for (const item of incoming) {
    const key = getKey(item);

    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }

  return merged;
}


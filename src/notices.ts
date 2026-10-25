/** Merge several attachment notices into one (deduplicated; truncated when too long so the toast fits) */
export function mergeNotices(notices: string[]): string {
  const unique = [...new Set(notices)];
  if (unique.length === 0) return "";
  const merged = unique.join("；");
  return merged.length > 300 ? `${merged.slice(0, 297)}…` : merged;
}

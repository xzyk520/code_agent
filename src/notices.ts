/** 把多条附件提示合并成一条（去重；过长时截断，toast 放得下） */
export function mergeNotices(notices: string[]): string {
  const unique = [...new Set(notices)];
  if (unique.length === 0) return "";
  const merged = unique.join("；");
  return merged.length > 300 ? `${merged.slice(0, 297)}…` : merged;
}

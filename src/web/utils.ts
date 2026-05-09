export function diffNewItems(prev: string[], curr: string[]): string[] {
  const prevSet = new Set(prev);
  return curr.filter((item) => !prevSet.has(item));
}

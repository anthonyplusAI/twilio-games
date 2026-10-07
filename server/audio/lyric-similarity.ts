/** Conservative match for a single recognized word inside an already-verified lyric time window. */
export function lyricSimilarity(expected: string, recognized: string, locale: string): number {
  const left = normalizedWord(expected, locale);
  const right = normalizedWord(recognized, locale);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const length = Math.max(left.length, right.length);
  // Short words are too easy to confuse; keep them exact even with strong audio timing.
  if (length < 6 || length > 64 || left[0] !== right[0]
    || Math.abs(left.length - right.length) > 1 || !oneEditApart(left, right)) return 0;
  return 1 - 1 / length;
}

function normalizedWord(value: string, locale: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLocaleLowerCase(locale)
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function oneEditApart(left: string, right: string): boolean {
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    if (++edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else { leftIndex += 1; rightIndex += 1; }
  }
  return edits + Number(leftIndex < left.length || rightIndex < right.length) === 1;
}

// "Did you mean …?" for a mistyped command or flag.

export function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** The closest candidate, if it is close enough to be a typo (or the word is a prefix of exactly one candidate). */
export function closest(word: string, candidates: Iterable<string>): string | undefined {
  const list = [...candidates];
  const prefixed = list.filter((c) => c.startsWith(word));
  if (word.length >= 2 && prefixed.length === 1) return prefixed[0];
  let best: string | undefined;
  let bestScore = Infinity;
  for (const c of list) {
    const d = distance(word, c);
    if (d < bestScore) {
      best = c;
      bestScore = d;
    }
  }
  return best !== undefined && bestScore <= Math.max(1, Math.floor(word.length / 3)) ? best : undefined;
}

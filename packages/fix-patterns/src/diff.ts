/**
 * Text edits and a unified diff built directly from them (M53).
 *
 * The rewriter produces character-range edits on the original text. The diff is derived from
 * those exact edits (expanded to whole lines, three lines of context), so it is the precise
 * difference between the original and the patched text and applies with `git apply`.
 */

export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let at = 0;
  for (const e of sorted) {
    if (e.start < at) throw new Error('overlapping edits');
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + text.slice(at);
}

/** True when no two edits overlap (touching ranges are allowed). */
export function editsDisjoint(edits: readonly TextEdit[]): boolean {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as TextEdit;
    const cur = sorted[i] as TextEdit;
    if (cur.start < prev.end) return false;
  }
  return true;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts: readonly number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function splitLines(text: string): { lines: string[]; endsWithNewline: boolean } {
  if (text.length === 0) return { lines: [], endsWithNewline: true };
  const endsWithNewline = text.endsWith('\n');
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n');
  return { lines, endsWithNewline };
}

interface Region {
  /** 0-based first original line and exclusive end line. */
  readonly from: number;
  readonly to: number;
  readonly newLines: readonly string[];
  readonly newEndsWithNewline: boolean;
}

/**
 * A git-style unified diff (`--- a/path`, `+++ b/path`) of `text` and `applyEdits(text, edits)`.
 * Returns an empty string when the edits change nothing.
 */
export function unifiedDiff(path: string, text: string, edits: readonly TextEdit[], context = 3): string {
  if (edits.length === 0) return '';
  const starts = lineStarts(text);
  const total = splitLines(text);
  const lineCount = total.lines.length;
  const lineStart = (i: number) => (i < starts.length ? (starts[i] as number) : text.length);
  const lineEnd = (i: number) => (i + 1 < starts.length ? (starts[i + 1] as number) : text.length);

  // Expand each edit to whole lines and merge edits whose line spans overlap.
  const spans = [...edits]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((e) => {
      const from = lineOf(starts, e.start);
      const lastPos = e.end > e.start ? e.end - 1 : e.start;
      const to = Math.min(lineOf(starts, lastPos), Math.max(lineCount - 1, 0)) + 1;
      return { from, to, edits: [e] };
    });
  const merged: Array<{ from: number; to: number; edits: TextEdit[] }> = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.from < last.to) {
      last.to = Math.max(last.to, s.to);
      last.edits.push(...s.edits);
    } else merged.push({ from: s.from, to: s.to, edits: [...s.edits] });
  }
  const regions: Region[] = merged.map((m) => {
    const a = lineStart(m.from);
    const b = lineEnd(m.to - 1);
    const local = m.edits.map((e) => ({ start: e.start - a, end: e.end - a, text: e.text }));
    const replaced = applyEdits(text.slice(a, b), local);
    const split = splitLines(replaced);
    // Trim lines the edit left unchanged at either end of the region.
    let from = m.from;
    let to = m.to;
    let newLines = split.lines;
    const lastOriginal = m.to === lineCount;
    while (from < to && newLines.length > 0 && newLines[0] === total.lines[from]) {
      if (from === lineCount - 1 && !total.endsWithNewline) break;
      from++;
      newLines = newLines.slice(1);
    }
    while (
      from < to &&
      newLines.length > 0 &&
      newLines[newLines.length - 1] === total.lines[to - 1] &&
      !(lastOriginal && to === lineCount && total.endsWithNewline !== split.endsWithNewline)
    ) {
      to--;
      newLines = newLines.slice(0, -1);
    }
    return { from, to, newLines, newEndsWithNewline: to === lineCount ? split.endsWithNewline : true };
  });

  const changes = regions.filter((r) => r.from < r.to || r.newLines.length > 0);
  const changed = changes.some((r) => {
    const old = total.lines.slice(r.from, r.to);
    return old.length !== r.newLines.length || old.some((l, i) => l !== r.newLines[i]);
  });
  if (!changed) return '';

  // Group regions into hunks when their context would touch.
  const hunks: Region[][] = [];
  for (const r of changes) {
    const last = hunks[hunks.length - 1];
    const prev = last?.[last.length - 1];
    if (last && prev && r.from - prev.to <= 2 * context) last.push(r);
    else hunks.push([r]);
  }

  const out = [`--- a/${path}`, `+++ b/${path}`];
  let delta = 0;
  const noNewline = '\\ No newline at end of file';
  for (const group of hunks) {
    const first = group[0] as Region;
    const last = group[group.length - 1] as Region;
    const from = Math.max(0, first.from - context);
    const to = Math.min(lineCount, last.to + context);
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    let cursor = from;
    const pushContext = (i: number) => {
      body.push(` ${total.lines[i] as string}`);
      if (i === lineCount - 1 && !total.endsWithNewline) body.push(noNewline);
      oldCount++;
      newCount++;
    };
    for (const r of group) {
      for (; cursor < r.from; cursor++) pushContext(cursor);
      for (let i = r.from; i < r.to; i++) {
        body.push(`-${total.lines[i] as string}`);
        if (i === lineCount - 1 && !total.endsWithNewline) body.push(noNewline);
        oldCount++;
      }
      r.newLines.forEach((l, i) => {
        body.push(`+${l}`);
        if (i === r.newLines.length - 1 && r.to === lineCount && !r.newEndsWithNewline) body.push(noNewline);
        newCount++;
      });
      cursor = r.to;
    }
    for (; cursor < to; cursor++) pushContext(cursor);
    const oldStart = oldCount === 0 ? from : from + 1;
    const newStart = newCount === 0 ? from + delta : from + delta + 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body);
    delta += newCount - oldCount;
  }
  return `${out.join('\n')}\n`;
}

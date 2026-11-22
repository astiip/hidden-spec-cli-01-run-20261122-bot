// mend: one patch tool for every AI edit format (SPEC.md, hidden-spec-cli-01-run-20261122).
// Node 22, the standard library alone. Run as `node main.ts [options] [PATCH]`.
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON
// edits), finds the lines each edit names at the first of three matching tiers, and
// writes every change or none. Deterministic: no randomness, no clocks, no model calls.
// In a trial (MAKEFUN_ENV_URL set) the last lines hand over to runner.ts; keep them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: exactly one line, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (SPEC.md section 3). */
function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** Trailing spaces and tabs removed. */
function trimEndST(s: string): string {
  let e = s.length;
  while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e -= 1;
  return s.slice(0, e);
}

/** Leading and trailing spaces and tabs removed. */
function trimST(s: string): string {
  let b = 0;
  while (b < s.length && (s[b] === ' ' || s[b] === '\t')) b += 1;
  let e = s.length;
  while (e > b && (s[e - 1] === ' ' || s[e - 1] === '\t')) e -= 1;
  return s.slice(b, e);
}

/** The leading spaces and tabs of a line. */
function leadST(s: string): string {
  let b = 0;
  while (b < s.length && (s[b] === ' ' || s[b] === '\t')) b += 1;
  return s.slice(0, b);
}

/** True when the line holds only spaces and tabs (an empty line included). */
function onlyST(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** A file as lines: its break, its lines, and whether it ends with a break. */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

/** A file's text read as lines (SPEC.md section 3). */
function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

/** A file's lines written back as text. */
function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, text: string | null): void {
    this.now.set(p, text);
  }

  /** A move that succeeded: the old path deleted, the new path written. */
  move(oldP: string, newP: string, text: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, text);
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

/** One line of O against one line of the file, at a tier (SPEC.md section 5). */
function lineEq(o: string, f: string, tier: number): boolean {
  if (tier === 0) return o === f;
  if (tier === 1) return trimEndST(o) === trimEndST(f);
  return trimST(o) === trimST(f);
}

/** Every 0-based position at or after `from` where O matches the file's lines at a tier. */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const n = O.length;
  if (n === 0) return out;
  for (let p = from; p + n <= lines.length; p++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!lineEq(O[j]!, lines[p + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(p);
  }
  return out;
}

/** The first tier (0, 1, 2) at which O occurs at or after `from`, or -1 when it occurs at none. */
function firstTier(O: string[], lines: string[], from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    if (occurrences(O, lines, t, from).length > 0) return t;
  }
  return -1;
}

/** The first line at or after the cursor equal to the anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let k = cursor; k < lines.length; k++) {
      if (lineEq(anchor, lines[k]!, t)) return k;
    }
  }
  return -1;
}

/** Tier-2 re-indentation of one new line (SPEC.md section 5). */
function reindent(line: string, P: string, F: string): string {
  if (onlyST(line)) return line;
  if (!line.startsWith(P)) return line;
  return F + line.slice(P.length);
}

/** One line of N: a context line (its index among the context lines) or an added line. */
interface NLine {
  text: string;
  ctx: number | null;
}

/** O and N of a hunk or chunk body, with each context line's index in O. */
interface ON {
  O: string[];
  N: NLine[];
  ctxOIndex: number[];
}

function buildON(body: Array<{ kind: string; text: string }>): ON {
  const O: string[] = [];
  const N: NLine[] = [];
  const ctxOIndex: number[] = [];
  let ctxCount = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      ctxOIndex.push(O.length);
      O.push(b.text);
      N.push({ text: b.text, ctx: ctxCount });
      ctxCount += 1;
    } else if (b.kind === 'old') {
      O.push(b.text);
    } else if (b.kind === 'new') {
      N.push({ text: b.text, ctx: null });
    }
  }
  return { O, N, ctxOIndex };
}

/** N written out: a context line as the file's own matched line, an added line as it is (re-indented at tier 2). */
function buildN(n: ON, fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const P = n.O.length > 0 ? leadST(n.O[0]!) : '';
  const F = leadST(fileLines[pos]!);
  for (const l of n.N) {
    if (l.ctx !== null) out.push(fileLines[pos + n.ctxOIndex[l.ctx]]!);
    else if (tier === 2) out.push(reindent(l.text, P, F));
    else out.push(l.text);
  }
  return out;
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(body: Array<{ kind: string; text: string }>): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') last = k;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === 'back';
}

/** One unified hunk: its old-file line number and its body lines. */
interface Hunk {
  A: number;
  body: Array<{ kind: string; text: string }>;
}

/** One hunk applied to a file; d is the cumulative length delta of the hunks before it. */
function applyHunk(f: FileState, h: Hunk, d: number, strict: boolean, path: string): { file: FileState; d: number } {
  const on = buildON(h.body);
  const lines = f.lines;
  if (on.O.length === 0) {
    // Insert after the first A + d lines: all of them when the file has fewer, and none
    // when A + d has run below zero (an earlier hunk removed more lines than it added).
    const at = Math.min(Math.max(h.A + d, 0), lines.length);
    const added = on.N.map((l) => l.text);
    const file: FileState = {
      lines: [...lines.slice(0, at), ...added, ...lines.slice(at)],
      br: f.br,
      finalBreak: at === lines.length ? !backslashAfterLast(h.body) : f.finalBreak,
    };
    return { file, d: d + on.N.length };
  }
  const tier = firstTier(on.O, lines, 0, strict);
  if (tier < 0) throw new Fail('no-match', path);
  const occ = occurrences(on.O, lines, tier, 0);
  const target = h.A - 1 + d;
  let pos = occ[0]!;
  let best = Math.abs(pos - target);
  for (const p of occ) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      pos = p;
      best = dist;
    }
  }
  const nprime = buildN(on, lines, pos, tier);
  const file: FileState = {
    lines: [...lines.slice(0, pos), ...nprime, ...lines.slice(pos + on.O.length)],
    br: f.br,
    finalBreak: pos + on.O.length === lines.length ? !backslashAfterLast(h.body) : f.finalBreak,
  };
  return { file, d: d + (on.N.length - on.O.length) };
}

/** Every hunk of a section applied in order, each to the result of the ones before it. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let f = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const r = applyHunk(f, h, d, strict, path);
    f = r.file;
    d = r.d;
  }
  return renderFile(f);
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, spaces removed. */
function diffPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!;
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** One unified section: the paths each of its header lines named, and its hunks. */
interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  renOld: string | null;
  renNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The section's old and new path (`/dev/null` means no file); a `---`/`+++` line names its side, then a rename line, then the `diff --git` line. */
function uniPaths(s: UniSection): { oldP: string | null; newP: string | null } {
  const oldRaw = s.dashOld ?? s.renOld ?? s.diffOld;
  const newRaw = s.dashNew ?? s.renNew ?? s.diffNew;
  return {
    oldP: oldRaw === null || oldRaw === '/dev/null' ? null : oldRaw,
    newP: newRaw === null || newRaw === '/dev/null' ? null : newRaw,
  };
}

/** A unified patch read as one edit per section (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let pairSeen = false;
  const finish = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
    inHeader = false;
    pairSeen = false;
  };
  const isDiffGit = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isDiffGit(line)) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finish();
      cur = {
        diffOld: m[1]!.trim(),
        diffNew: m[2]!.trim(),
        dashOld: null,
        dashNew: null,
        renOld: null,
        renNew: null,
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !pairSeen) {
        cur.dashOld = diffPath(line);
        cur.dashNew = diffPath(lines[i + 1]!);
        pairSeen = true;
        i += 2;
        continue;
      }
      finish();
      cur = {
        diffOld: null,
        diffNew: null,
        dashOld: diffPath(line),
        dashNew: diffPath(lines[i + 1]!),
        renOld: null,
        renNew: null,
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      inHeader = true;
      pairSeen = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseInt(m[1]!, 10);
      i += 1;
      const body: Hunk['body'] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (isDiffGit(bl)) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith('@@')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push({
            kind: bl === '' ? 'ctx' : bl[0] === ' ' ? 'ctx' : bl[0] === '-' ? 'old' : bl[0] === '+' ? 'new' : 'back',
            text: bl === '' ? '' : bl.slice(1),
          });
          i += 1;
        } else break;
      }
      while (body.length > 0) {
        const lastB = body[body.length - 1]!;
        if (lastB.kind === 'ctx' && lastB.text === '') body.pop();
        else break;
      }
      cur.hunks.push({ A, body });
      inHeader = false;
      continue;
    }
    // A `--- ` line that is not half of a `--- ` + `+++ ` pair starts a section whose second header line is not `+++ `.
    if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (cur !== null && inHeader) {
      if (line.startsWith('+++ ')) {
        cur.dashNew = diffPath(line);
        pairSeen = true;
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (cur.renOld === null) cur.renOld = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (cur.renNew === null) cur.renNew = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  finish();
  return sections.map((s) => uniEdit(s, strict));
}

/** One unified section as one edit: a creation, a deletion, a move, or a change of one path. */
function uniEdit(s: UniSection, strict: boolean): Edit {
  const { oldP, newP } = uniPaths(s);
  const isCreate = oldP === null || s.isCreate;
  const isDelete = newP === null || s.isDelete;
  return (tree: Tree) => {
    if (isCreate) {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) {
        for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      }
      let finalBreak = true;
      let lastH: Hunk | null = null;
      for (const h of s.hunks) if (h.body.some((b) => b.kind === 'new')) lastH = h;
      if (lastH !== null) finalBreak = !backslashAfterLast(lastH.body);
      tree.set(newP, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.move(oldP, newP, applyHunks(cur, s.hunks, strict, oldP));
      return;
    }
    const p = oldP ?? newP;
    if (p === null) return;
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.set(p, applyHunks(cur, s.hunks, strict, p));
  };
}

/** One SEARCH/REPLACE block as one edit (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = parseFile(cur);
    const tier = firstTier(oldLines, f.lines, 0, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occ = occurrences(oldLines, f.lines, tier, 0);
    if (occ.length > 1) throw new Fail('ambiguous', path);
    const pos = occ[0]!;
    let nprime: string[];
    if (tier === 2) {
      const P = leadST(oldLines[0]!);
      const F = leadST(f.lines[pos]!);
      nprime = newLines.map((l) => reindent(l, P, F));
    } else {
      nprime = [...newLines];
    }
    const lines = [...f.lines.slice(0, pos), ...nprime, ...f.lines.slice(pos + oldLines.length)];
    tree.set(path, renderFile({ lines, br: f.br, finalBreak: f.finalBreak }));
  };
}

/** A SEARCH/REPLACE patch read as one edit per block (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const s = i;
      let path: string | null = null;
      for (let j = s - 1; j > prevReplaceEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new Exit2(`error: parse ${s + 1}`);
      }
      let eq = -1;
      for (let j = s + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
      const oldLines = lines.slice(s + 1, eq);
      const newLines = lines.slice(eq + 1, rep);
      edits.push(srEdit(path, oldLines, newLines, strict));
      prevPath = path;
      prevReplaceEnd = rep;
      i = rep + 1;
      continue;
    }
    i += 1;
  }
  return edits;
}

/** One V4A chunk: its anchor (null: none), its body lines, and whether it is anchored to the end of the file. */
interface V4AChunk {
  anchor: string | null;
  body: Array<{ kind: string; text: string }>;
  eof: boolean;
}

/** One V4A chunk's body, read until the next chunk, the end of the file, or the section's end. */
function parseV4AChunk(lines: string[], start: number, last: number, anchor: string | null): [V4AChunk, number] {
  const body: V4AChunk['body'] = [];
  let eof = false;
  let i = start;
  while (i < last) {
    const l = lines[i]!;
    if (l === '*** End of File') {
      eof = true;
      i += 1;
      break;
    }
    if (l.startsWith('@@')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      body.push({
        kind: l === '' ? 'ctx' : l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new',
        text: l === '' ? '' : l.slice(1),
      });
      i += 1;
    } else break;
  }
  return [{ anchor, body, eof }, i];
}

/** A V4A Add File section as one edit: the file is the section's lines, ended by a line break. */
function v4aAddEdit(path: string, content: string[]): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
  };
}

/** A V4A Delete File section as one edit. */
function v4aDeleteEdit(path: string): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.set(path, null);
  };
}

/** A V4A Update File section as one edit: its chunks apply in order, with a cursor from line 0. */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const idx = findAnchor(f.lines, ch.anchor, cursor, strict);
        if (idx < 0) throw new Fail('no-match', path);
        cursor = idx + 1;
      }
      const on = buildON(ch.body);
      if (on.O.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const added = on.N.map((l) => l.text);
        f = { lines: [...f.lines.slice(0, at), ...added, ...f.lines.slice(at)], br: f.br, finalBreak: f.finalBreak };
        cursor = at + added.length;
      } else {
        const tier = firstTier(on.O, f.lines, cursor, strict);
        if (tier < 0) throw new Fail('no-match', path);
        let occ = occurrences(on.O, f.lines, tier, cursor);
        if (ch.eof) occ = occ.filter((p) => p + on.O.length === f.lines.length);
        if (occ.length === 0) throw new Fail('no-match', path);
        const pos = occ[0]!;
        const nprime = buildN(on, f.lines, pos, tier);
        f = {
          lines: [...f.lines.slice(0, pos), ...nprime, ...f.lines.slice(pos + on.O.length)],
          br: f.br,
          finalBreak: f.finalBreak,
        };
        cursor = pos + nprime.length;
      }
    }
    const result = renderFile(f);
    if (moveTo !== null) tree.move(path, moveTo, result);
    else tree.set(path, result);
  };
}

/** A V4A patch read as one edit per section (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      i += 1;
      const content: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('+')) {
          content.push(l.slice(1));
          i += 1;
        } else if (l === '') {
          content.push('');
          i += 1;
        } else break;
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      edits.push(v4aAddEdit(path, content));
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      i += 1;
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i += 1;
      }
      const chunks: V4AChunk[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          const [ch, ni] = parseV4AChunk(lines, i + 1, last, anchor === '' ? null : anchor);
          chunks.push(ch);
          i = ni;
        } else if (chunks.length === 0 && (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+'))) {
          const [ch, ni] = parseV4AChunk(lines, i, last, null);
          chunks.push(ch);
          i = ni;
        } else break;
      }
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        while (lc.body.length > 0) {
          const b = lc.body[lc.body.length - 1]!;
          if (b.kind === 'ctx' && b.text === '') lc.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = parseFile(before);
      if (lineNo < 0 || lineNo > f.lines.length) throw new Fail('no-match', p);
      const lines = [...f.lines];
      lines.splice(lineNo, 0, ...add);
      tree.set(p, renderFile({ lines, br: f.br, finalBreak: f.finalBreak }));
    };
  }
  return null;
}

/** A JSON patch read as one edit per object: one array, or one object per line (SPEC.md section 9). */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** The format `--format=auto` detects, or null when none of the four holds (SPEC.md section 4). */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/** One run of the CLI: its exit code and the lines it writes to standard output. */
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  // One line per changed path, in byte order; a move's R line replaces its D and A pair and sorts by its new path.
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (
      tree.original(oldP) !== null &&
      tree.now.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.now.get(newP) !== null
    ) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

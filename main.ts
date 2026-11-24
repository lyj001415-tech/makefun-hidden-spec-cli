// mend, the CLI SPEC.md specifies: it applies an AI-written edit in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits) to a tree of text files, finding the lines each edit names at the
// first of three matching tiers, and writes every change or none. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, as [old path, new path], for the R lines of section 2. */
  readonly moves: [string, string][] = [];
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
}

type Edit = (tree: Tree) => void;

/** A file read as lines: its own line break, its lines, and whether it ends with a break. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** Section 5: one line of the file against one named line, at a tier. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  return a.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') === b.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every position at which O occurs in lines at a tier; occurrences may overlap. */
function occurrences(lines: string[], O: string[], tier: number): number[] {
  const res: number[] = [];
  outer: for (let i = 0; i + O.length <= lines.length; i += 1) {
    for (let k = 0; k < O.length; k += 1) if (!lineEq(lines[i + k]!, O[k]!, tier)) continue outer;
    res.push(i);
  }
  return res;
}

/** The tiers a run tries, in order: only tier 0 under --strict. */
const tiers = (strict: boolean): number[] => (strict ? [0] : [0, 1, 2]);

/** The first tier at which O occurs at least once, and its occurrences there. */
function findTier(lines: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (const tier of tiers(strict)) {
    const occ = occurrences(lines, O, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One line of N: a context line, by its index in O, or a new line of text. */
type NLine = { ctx: number } | { plus: string };

/**
 * The lines a match writes: a context line is the file's own matched line; at tier 2 every other line is
 * re-indented, the leading spaces and tabs of O's first line replaced by those of the file's first matched line.
 */
function buildN(N: NLine[], fileLines: string[], pos: number, O: string[], tier: number): string[] {
  const lead = (s: string): string => /^[ \t]*/.exec(s)![0];
  const F = tier === 2 ? lead(fileLines[pos]!) : '';
  const P = tier === 2 ? lead(O[0]!) : '';
  return N.map((e) => {
    if ('ctx' in e) return fileLines[pos + e.ctx]!;
    let L = e.plus;
    if (tier === 2 && L !== '' && !/^[ \t]+$/.test(L) && L.startsWith(P)) L = F + L.slice(P.length);
    return L;
  });
}

/** O and N read from body lines whose first character is ' ' (context), '-' (old) or '+' (new). */
function readON(body: string[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const raw of body) {
    const tag = raw === '' ? ' ' : raw[0]!;
    const text = raw === '' ? '' : raw.slice(1);
    if (tag === ' ') {
      O.push(text);
      N.push({ ctx: O.length - 1 });
    } else if (tag === '-') O.push(text);
    else if (tag === '+') N.push({ plus: text });
  }
  return { O, N };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

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

/** A unified hunk (section 6): its A, its O and N, and whether a `\` line follows its last context or + line. */
interface Hunk {
  A: number;
  O: string[];
  N: NLine[];
  noEol: boolean;
}

function readHunk(A: number, body: string[]): Hunk {
  const { O, N } = readON(body.filter((l) => !l.startsWith('\\')));
  let lastNew = -1;
  body.forEach((raw, idx) => {
    if (raw.startsWith('\\')) return;
    if (raw === '' || raw[0] === ' ' || raw[0] === '+') lastNew = idx;
  });
  return { A, O, N, noEol: lastNew >= 0 && (body[lastNew + 1] ?? '').startsWith('\\') };
}

/** A unified section under way (section 6): what its header named, and its hunks. */
interface Section {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string;
  pairNew?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The edit one unified section makes, once its paths are settled. */
function sectionEdit(s: Section, strict: boolean): Edit {
  let oldPath: string | null;
  let newPath: string | null;
  if (s.pairOld !== undefined) {
    oldPath = s.pairOld === '/dev/null' ? null : s.pairOld;
    newPath = s.pairNew === '/dev/null' ? null : s.pairNew;
  } else {
    oldPath = s.renameFrom ?? s.gitOld ?? null;
    newPath = s.renameTo ?? s.gitNew ?? null;
  }
  const creation = s.newFile || (s.pairOld !== undefined && oldPath === null);
  const deletion = s.delFile || (s.pairNew !== undefined && newPath === null);
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (creation) {
      const p = newPath ?? oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let noEol = false;
      for (const h of s.hunks) {
        let has = false;
        for (const e of h.N) {
          if ('plus' in e) {
            out.push(e.plus);
            has = true;
          }
        }
        if (has) noEol = h.noEol;
      }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (deletion) {
      const p = oldPath ?? newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const from = oldPath ?? '';
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    const move = newPath !== null && newPath !== from;
    if (move && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
    const f = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      if (h.O.length === 0) {
        const add = h.N.map((e) => ('plus' in e ? e.plus : ''));
        const pos = Math.min(Math.max(h.A + d, 0), f.lines.length);
        const atEnd = pos === f.lines.length;
        f.lines.splice(pos, 0, ...add);
        if (atEnd) f.final = !h.noEol;
        d += add.length;
      } else {
        const found = findTier(f.lines, h.O, strict);
        if (found === null) throw new Fail('no-match', from);
        const target = h.A - 1 + d;
        let pos = found.occ[0]!;
        for (const p of found.occ) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
        const written = buildN(h.N, f.lines, pos, h.O, found.tier);
        const runsToEnd = pos + h.O.length === f.lines.length;
        f.lines.splice(pos, h.O.length, ...written);
        if (runsToEnd) f.final = !h.noEol;
        d += h.N.length - h.O.length;
      }
    }
    const text = joinFile(f);
    if (move) {
      tree.now.set(newPath!, text);
      tree.now.set(from, null);
      tree.moves.push([from, newPath!]);
    } else tree.now.set(from, text);
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: Section[] = [];
  let cur: Section | null = null;
  const fresh = (): Section => ({ newFile: false, delFile: false, hunks: [] });
  const strip = (l: string): string => {
    let p = l.slice(4).split('\t')[0]!.trim();
    if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
    return p;
  };
  let i = 0;
  while (i < lines.length) {
    const L = lines[i]!;
    if (L.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*?) b\/(.+)$/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { ...fresh(), gitOld: m[1]!, gitNew: m[2]! };
      secs.push(cur);
      i += 1;
      continue;
    }
    if (L.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const o = strip(L);
      const n = strip(lines[i + 1]!);
      if (cur !== null && cur.hunks.length === 0 && cur.pairOld === undefined) {
        cur.pairOld = o;
        cur.pairNew = n;
      } else {
        cur = { ...fresh(), pairOld: o, pairNew: n };
        secs.push(cur);
      }
      i += 2;
      continue;
    }
    if (L.startsWith('--- ') && cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
    if (L.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const B = lines[j]!;
        if (B.startsWith('diff --git ')) break;
        if (B.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (B === '' || B[0] === ' ' || B[0] === '-' || B[0] === '+' || B[0] === '\\') {
          body.push(B);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(readHunk(Number(m[1]), body));
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (L.startsWith('rename from ')) cur.renameFrom = L.slice(12).trim();
      else if (L.startsWith('rename to ')) cur.renameTo = L.slice(10).trim();
      else if (L.startsWith('new file mode')) cur.newFile = true;
      else if (L.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return secs.map((s) => sectionEdit(s, strict));
}

/** SEARCH/REPLACE blocks (section 7). */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  for (;;) {
    let s = -1;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j >= searchFrom; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let en = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        en = j;
        break;
      }
    }
    if (en < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, en);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const written = buildN(
        newLines.map((t) => ({ plus: t })),
        f.lines,
        pos,
        oldLines,
        found.tier,
      );
      f.lines.splice(pos, oldLines.length, ...written);
      tree.now.set(p, joinFile(f));
    });
    prevPath = path;
    searchFrom = en + 1;
    i = en + 1;
  }
  return edits;
}

/** One V4A chunk (section 8): its anchor, its body lines, and whether `*** End of File` closed it. */
interface Chunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      lastNB = j;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (l: string): 'add' | 'del' | 'upd' | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : l.startsWith('*** Update File: ') ? 'upd' : null;
  const edits: Edit[] = [];
  let i = firstNB + 1;
  while (i < lastNB) {
    const L = lines[i]!;
    if (blank(L)) {
      i += 1;
      continue;
    }
    const kind = secStart(L);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const startLine = i + 1;
    const path = L.slice(L.indexOf(': ') + 2).trim();
    const body: { line: string; num: number }[] = [];
    let j = i + 1;
    while (j < lastNB && secStart(lines[j]!) === null) {
      body.push({ line: lines[j]!, num: j + 1 });
      j += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.line)) body.pop();
    if (kind === 'add') {
      const out: string[] = [];
      for (const b of body) {
        if (b.line.startsWith('+')) out.push(b.line.slice(1));
        else if (b.line === '') out.push('');
        else throw new Exit2(`error: parse ${b.num}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, out.length === 0 ? '' : out.join('\n') + '\n');
      });
    } else if (kind === 'del') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.num}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (body.length > 0 && body[0]!.line.startsWith('*** Move to: ')) {
        moveTo = body[0]!.line.slice(13).trim();
        idx = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      for (; idx < body.length; idx += 1) {
        const b = body[idx]!;
        if (b.line.startsWith('@@')) {
          cur = { anchor: b.line.slice(2).trim() || null, body: [], eof: false };
          chunks.push(cur);
        } else if (b.line === '' || b.line[0] === ' ' || b.line[0] === '-' || b.line[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push(b.line);
        } else if (b.line.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${b.num}`);
          cur.eof = true;
          cur = null;
        } else throw new Exit2(`error: parse ${b.num}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      const to = moveTo;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (to !== null && !safe(to)) throw new Fail('unsafe', to);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
        const f = splitFile(before);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            let at = -1;
            for (const tier of tiers(strict)) {
              for (let p = cursor; p < f.lines.length; p += 1) {
                if (lineEq(f.lines[p]!, ch.anchor, tier)) {
                  at = p;
                  break;
                }
              }
              if (at >= 0) break;
            }
            if (at < 0) throw new Fail('no-match', path);
            cursor = at + 1;
          }
          const { O, N } = readON(ch.body);
          if (O.length === 0) {
            const add = N.map((e) => ('plus' in e ? e.plus : ''));
            const pos = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
            f.lines.splice(pos, 0, ...add);
            cursor = pos + add.length;
          } else {
            let pos = -1;
            let tierUsed = 0;
            for (const tier of tiers(strict)) {
              const occ = occurrences(f.lines, O, tier).filter((p) => p >= cursor && (!ch.eof || p + O.length === f.lines.length));
              if (occ.length > 0) {
                pos = occ[0]!;
                tierUsed = tier;
                break;
              }
            }
            if (pos < 0) throw new Fail('no-match', path);
            const written = buildN(N, f.lines, pos, O, tierUsed);
            f.lines.splice(pos, O.length, ...written);
            cursor = pos + written.length;
          }
        }
        const text = joinFile(f);
        if (to !== null) {
          tree.now.set(to, text);
          tree.now.set(path, null);
          tree.moves.push([path, to]);
        } else tree.now.set(path, text);
      });
    }
    i = j;
  }
  return edits;
}

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Section 2's lines: one per changed path in byte order, a successful move as one R line sorted by its new path.
  const renamed = new Map<string, string>();
  const renamedFrom = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null && !renamedFrom.has(o) && !renamed.has(n)) {
      renamed.set(n, o);
      renamedFrom.add(o);
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!check) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
    if (renamedFrom.has(p)) continue;
    if (renamed.has(p)) rows.push({ key: p, line: `R ${renamed.get(p)!} -> ${p}` });
    else rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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

// src/codeSearch.ts
//
// Dependency-free code search for errix. No VS Code imports, so it can be tested
// from plain Node (see tools/eval-retrieval.js).
//
// How it works:
//   1. Chunk every file by function / class / method (not by fixed size), keeping the
//      file path and symbol name with each chunk.
//   2. Rank chunks with BM25 after splitting identifiers (save_record, saveRecord ->
//      save, record). Symbol names and file paths count extra.
//   3. Add "neighbors": chunks for functions that the best matches call.

export interface Chunk {
  id: number;
  file: string; // relative path, forward slashes
  language: string;
  startLine: number; // 1-based
  endLine: number;
  symbol: string; // "save_record", "Storage.save", "(imports)" or ""
  text: string;
}

export interface Hit {
  chunk: Chunk;
  score: number;
  via: 'match' | 'callee';
}

export interface SearchOptions {
  maxChars: number; // total characters of chunk text to return
  maxChunks?: number; // best matches to return (default 8)
  maxCallees?: number; // extra neighbor chunks (default 3)
  excludeFiles?: Set<string>;
}

type Lang = 'python' | 'ruby' | 'js' | 'go' | 'rust' | 'jvm' | 'c' | 'other';

const LANG_BY_EXT: Record<string, Lang> = {
  py: 'python',
  rb: 'ruby',
  js: 'js',
  jsx: 'js',
  ts: 'js',
  tsx: 'js',
  mjs: 'js',
  cjs: 'js',
  go: 'go',
  rs: 'rust',
  java: 'jvm',
  cs: 'jvm',
  kt: 'jvm',
  kts: 'jvm',
  swift: 'jvm',
  scala: 'jvm',
  dart: 'jvm',
  c: 'c',
  h: 'c',
  cpp: 'c',
  cc: 'c',
  cxx: 'c',
  hpp: 'c',
  php: 'other',
  lua: 'other',
  sh: 'other',
  sql: 'other'
};

export const CODE_EXTENSIONS: string[] = Object.keys(LANG_BY_EXT);

const K1 = 1.2;
const B = 0.75;
const MAX_FILE_CHARS = 300_000;
const MAX_FILE_LINES = 6000;
const MAX_CHUNK_LINES = 120;
const WINDOW = 80;
const OVERLAP = 10;

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'how', 'what',
  'where', 'when', 'why', 'which', 'who', 'this', 'that', 'these', 'those', 'in', 'on', 'at',
  'to', 'of', 'for', 'with', 'from', 'by', 'and', 'or', 'not', 'it', 'its', 'if', 'then',
  'than', 'can', 'could', 'should', 'would', 'will', 'we', 'you', 'me', 'my', 'our', 'your',
  'there', 'here', 'about', 'into', 'as', 'so', 'any', 'all', 'some', 'please', 'explain',
  'show', 'find', 'tell', 'code', 'file', 'files', 'project', 'happen', 'happens', 'work',
  'works'
]);

function stem(w: string): string {
  if (w.length <= 3) return w;
  let s = w;
  if (s.endsWith('ing') && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith('ed') && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith('es') && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith('s') && !s.endsWith('ss') && s.length > 3) s = s.slice(0, -1);
  if (s.endsWith('e') && s.length > 3) s = s.slice(0, -1);
  return s;
}

/** Splits identifiers (snake_case, camelCase) and returns lower-cased, stemmed tokens. */
export function tokenize(text: string, dropStopwords = false): string[] {
  const out: string[] = [];
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;

  const push = (w: string): void => {
    if (w.length < 2) return;
    if (dropStopwords && STOPWORDS.has(w)) return;
    out.push(stem(w));
  };

  while ((m = re.exec(text))) {
    const id = m[0];
    const whole = id.toLowerCase().replace(/^_+|_+$/g, '');
    const parts = id
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[_\s]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length > 1);

    if (parts.length > 1) {
      push(whole); // keep the full identifier searchable too
      parts.forEach(push);
    } else if (parts.length === 1) {
      push(parts[0]);
    }
  }
  return out;
}

function identifiersIn(text: string): Set<string> {
  const out = new Set<string>();
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[0].toLowerCase());
  return out;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

interface Boundary {
  line: number; // 0-based line where a definition starts
  symbol: string;
}

interface RawChunk {
  startLine: number;
  endLine: number;
  symbol: string;
  text: string;
}

function languageOf(file: string): Lang | undefined {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return undefined;
  return LANG_BY_EXT[file.slice(dot + 1).toLowerCase()];
}

function indentOf(line: string): number {
  const l = line.replace(/\t/g, '    ');
  return l.length - l.trimStart().length;
}

/** Python and Ruby: definitions found by indentation. */
function indentBoundaries(lines: string[], re: RegExp, classWord: RegExp): Boundary[] {
  const out: Boundary[] = [];
  let currentClass = '';
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '    ').length;
    const name = m[2];
    if (indent === 0) {
      currentClass = classWord.test(lines[i]) ? name : '';
      out.push({ line: i, symbol: name });
    } else if (currentClass && indent <= 4) {
      out.push({ line: i, symbol: `${currentClass}.${name}` });
    }
  }
  return out;
}

const JS_DECLS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/
];
const JS_METHOD =
  /^\s{1,8}(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{\s*$/;
const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'with',
  'new', 'await', 'typeof'
]);

/** JavaScript / TypeScript: declarations at the file's base indent, plus class methods. */
function jsBoundaries(lines: string[]): Boundary[] {
  const found = new Map<number, { indent: number; symbol: string; isClass: boolean }>();
  for (let i = 0; i < lines.length; i++) {
    for (const re of JS_DECLS) {
      const m = re.exec(lines[i]);
      if (m) {
        found.set(i, { indent: indentOf(lines[i]), symbol: m[1], isClass: /\bclass\s/.test(lines[i]) });
        break;
      }
    }
  }
  if (found.size === 0) return [];

  let base = Infinity;
  for (const f of found.values()) base = Math.min(base, f.indent);

  const out: Boundary[] = [];
  let currentClass = '';
  for (let i = 0; i < lines.length; i++) {
    const f = found.get(i);
    if (f) {
      if (f.indent > base) continue; // nested declaration stays inside its parent
      currentClass = f.isClass ? f.symbol : '';
      out.push({ line: i, symbol: f.symbol });
      continue;
    }
    if (!currentClass) continue;
    const m = JS_METHOD.exec(lines[i]);
    if (!m || JS_KEYWORDS.has(m[1])) continue;
    const ind = indentOf(lines[i]);
    if (ind > base && ind <= base + 4) out.push({ line: i, symbol: `${currentClass}.${m[1]}` });
  }
  return out;
}

const C_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'return', 'else', 'typedef', 'sizeof', 'do', 'case'
]);

/** Go, Rust, Java-like and C-like languages: simple declaration patterns. */
function patternBoundaries(lang: Lang, lines: string[]): Boundary[] {
  let pats: { re: RegExp; maxIndent: number }[] = [];
  if (lang === 'go') {
    pats = [
      { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, maxIndent: 0 },
      { re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, maxIndent: 0 }
    ];
  } else if (lang === 'rust') {
    pats = [
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, maxIndent: 4 },
      { re: /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\b\s*(?:<[^>]*>\s*)?([A-Za-z_]\w*)/, maxIndent: 0 }
    ];
  } else if (lang === 'jvm') {
    pats = [
      {
        re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial|data|open)\s+)*(?:class|interface|enum|struct|record|object|trait)\s+([A-Za-z_]\w*)/,
        maxIndent: 4
      },
      {
        re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized|suspend|open)\s+)+(?:[\w<>[\],.?*&]+\s+)+([A-Za-z_]\w*)\s*\([^;]*$/,
        maxIndent: 8
      }
    ];
  } else if (lang === 'c') {
    pats = [
      { re: /^[A-Za-z_][\w\s*&:<>,]*?\s\**([A-Za-z_]\w*)\s*\([^;]*$/, maxIndent: 0 },
      { re: /^\s*(?:class|struct)\s+([A-Za-z_]\w*)/, maxIndent: 0 }
    ];
  }

  const out: Boundary[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const { re, maxIndent } of pats) {
      const m = re.exec(lines[i]);
      if (m && indentOf(lines[i]) <= maxIndent && !C_KEYWORDS.has(m[1])) {
        out.push({ line: i, symbol: m[1] });
        break;
      }
    }
  }
  return out;
}

function boundariesFor(lang: Lang, lines: string[]): Boundary[] {
  switch (lang) {
    case 'python':
      return indentBoundaries(lines, /^(\s*)(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/, /^\s*class\b/);
    case 'ruby':
      return indentBoundaries(
        lines,
        /^(\s*)(?:def|class|module)\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/,
        /^\s*(?:class|module)\b/
      );
    case 'js':
      return jsBoundaries(lines);
    case 'other':
      return [];
    default:
      return patternBoundaries(lang, lines);
  }
}

function makeRaw(lines: string[], from: number, to: number, symbol: string): RawChunk | undefined {
  let s = from;
  let e = to;
  while (s <= e && !lines[s].trim()) s++;
  while (e >= s && !lines[e].trim()) e--;
  if (s > e) return undefined;
  return { startLine: s + 1, endLine: e + 1, symbol, text: lines.slice(s, e + 1).join('\n') };
}

/** One chunk for the range, or overlapping windows if it is very long. */
function splitRange(
  lines: string[],
  from: number,
  to: number,
  symbol: string,
  windowSize = WINDOW
): RawChunk[] {
  const out: RawChunk[] = [];
  if (to - from + 1 <= MAX_CHUNK_LINES) {
    const c = makeRaw(lines, from, to, symbol);
    if (c) out.push(c);
    return out;
  }
  let s = from;
  while (s <= to) {
    const e = Math.min(s + windowSize - 1, to);
    const c = makeRaw(lines, s, e, symbol);
    if (c) out.push(c);
    if (e >= to) break;
    s = e - OVERLAP + 1;
  }
  return out;
}

/** Pulls comments and decorators directly above a definition into its chunk. */
function attachLeading(lines: string[], line: number, lower: number): number {
  let s = line;
  while (s - 1 >= lower) {
    const t = lines[s - 1].trim();
    if (t.startsWith('#') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('@')) {
      s--;
    } else {
      break;
    }
  }
  return s;
}

function chunkFile(lang: Lang, lines: string[]): RawChunk[] {
  const bounds = boundariesFor(lang, lines);
  if (bounds.length === 0) return splitRange(lines, 0, lines.length - 1, '', 60);

  const starts = bounds.map((b, i) => attachLeading(lines, b.line, i > 0 ? bounds[i - 1].line + 1 : 0));
  const out: RawChunk[] = [];

  if (starts[0] > 0) {
    out.push(...splitRange(lines, 0, starts[0] - 1, '(imports)'));
  }
  for (let i = 0; i < bounds.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] - 1 : lines.length - 1;
    out.push(...splitRange(lines, starts[i], end, bounds[i].symbol));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Index + search
// ---------------------------------------------------------------------------

const IGNORED_CALLEES = new Set([
  'main', 'init', 'self', 'this', 'test', 'setup', 'teardown', 'close', 'open', 'read',
  'write', 'update', 'delete', 'render', 'handle', 'constructor', 'build', 'start', 'stop',
  'reset', 'clear', 'load'
]);

export class CodeIndex {
  private chunks: Chunk[] = [];
  private tfs: Map<string, number>[] = [];
  private lens: number[] = [];
  private df = new Map<string, number>();
  private symbols = new Map<string, Chunk[]>();
  private fileSet = new Set<string>();
  private avgLen = 1;
  private built = false;

  addFile(file: string, text: string): void {
    const lang = languageOf(file);
    if (!lang || text.length > MAX_FILE_CHARS) return;

    const lines = text.split(/\r?\n/);
    if (lines.length > MAX_FILE_LINES) return;
    if (text.length / Math.max(lines.length, 1) > 250) return; // minified or generated

    const rel = file.replace(/\\/g, '/');
    const pathTokens = tokenize(rel);

    for (const raw of chunkFile(lang, lines)) {
      const chunk: Chunk = { id: this.chunks.length, file: rel, language: lang, ...raw };
      const tf = new Map<string, number>();
      const bump = (t: string, n: number): void => {
        tf.set(t, (tf.get(t) ?? 0) + n);
      };
      tokenize(chunk.text).forEach((t) => bump(t, 1));
      tokenize(chunk.symbol).forEach((t) => bump(t, 4)); // names matter most
      pathTokens.forEach((t) => bump(t, 2));

      let len = 0;
      tf.forEach((n) => (len += n));

      this.chunks.push(chunk);
      this.tfs.push(tf);
      this.lens.push(len);

      if (chunk.symbol && !chunk.symbol.startsWith('(')) {
        const key = (chunk.symbol.split('.').pop() ?? '').toLowerCase();
        const list = this.symbols.get(key) ?? [];
        list.push(chunk);
        this.symbols.set(key, list);
      }
    }
    this.fileSet.add(rel);
    this.built = false;
  }

  build(): void {
    this.df.clear();
    let total = 0;
    for (let i = 0; i < this.tfs.length; i++) {
      this.tfs[i].forEach((_n, term) => this.df.set(term, (this.df.get(term) ?? 0) + 1));
      total += this.lens[i];
    }
    this.avgLen = this.chunks.length ? total / this.chunks.length : 1;
    this.built = true;
  }

  stats(): { files: number; chunks: number; chars: number } {
    let chars = 0;
    for (const c of this.chunks) chars += c.text.length;
    return { files: this.fileSet.size, chunks: this.chunks.length, chars };
  }

  search(query: string, opts: SearchOptions): Hit[] {
    if (!this.built) this.build();

    const qTokens = Array.from(new Set(tokenize(query, true)));
    if (qTokens.length === 0 || this.chunks.length === 0) return [];

    const qLower = query.toLowerCase();
    const wantsTests = /\btests?\b|\bspec\b|pytest|jest|unittest/.test(qLower);
    const n = this.chunks.length;
    const idf = qTokens.map((t) => {
      const df = this.df.get(t) ?? 0;
      return df === 0 ? 0 : Math.log(1 + (n - df + 0.5) / (df + 0.5));
    });

    const scored: { i: number; score: number }[] = [];
    for (let i = 0; i < n; i++) {
      const c = this.chunks[i];
      if (opts.excludeFiles?.has(c.file)) continue;

      const tf = this.tfs[i];
      const norm = K1 * (1 - B + (B * this.lens[i]) / this.avgLen);
      let s = 0;
      for (let q = 0; q < qTokens.length; q++) {
        const f = tf.get(qTokens[q]);
        if (f) s += idf[q] * ((f * (K1 + 1)) / (f + norm));
      }
      if (s <= 0) continue;

      // Exact-name boosts: the question literally names the function or file.
      const simple = (c.symbol.split('.').pop() ?? '').toLowerCase();
      if (simple.length > 2 && !simple.startsWith('(') && qLower.includes(simple)) s *= 1.5;
      const base = (c.file.split('/').pop() ?? '').replace(/\.[^.]+$/, '').toLowerCase();
      if (base.length > 2 && qLower.includes(base)) s *= 1.3;

      // Test files rarely answer "how does X work".
      if (!wantsTests && /(^|\/)(tests?|__tests__|spec)(\/|$)|(^|\/)test_|[._]test\.|\.spec\./.test(c.file)) {
        s *= 0.6;
      }
      scored.push({ i, score: s });
    }
    if (scored.length === 0) return [];
    scored.sort((a, b) => b.score - a.score);

    const maxChunks = opts.maxChunks ?? 8;
    const top = scored[0].score;
    const hits: Hit[] = [];
    let used = 0;

    for (const { i, score } of scored) {
      if (hits.length >= maxChunks || score < top * 0.35) break;
      const chunk = this.chunks[i];
      if (used + chunk.text.length > opts.maxChars) continue;
      hits.push({ chunk, score, via: 'match' });
      used += chunk.text.length;
    }

    // Neighbors: definitions of functions that the best matches call.
    const included = new Set(hits.map((h) => h.chunk.id));
    const counts = new Map<number, number>();
    for (const h of hits) {
      for (const ident of identifiersIn(h.chunk.text)) {
        const defs = this.symbols.get(ident);
        if (!defs || defs.length > 3 || ident.length < 4 || IGNORED_CALLEES.has(ident)) continue;
        for (const d of defs) {
          if (included.has(d.id) || opts.excludeFiles?.has(d.file)) continue;
          counts.set(d.id, (counts.get(d.id) ?? 0) + 1);
        }
      }
    }
    const ranked = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, opts.maxCallees ?? 3);
    for (const [id] of ranked) {
      const chunk = this.chunks[id];
      if (used + chunk.text.length > opts.maxChars) continue;
      hits.push({ chunk, score: 0, via: 'callee' });
      used += chunk.text.length;
    }

    return hits;
  }
}
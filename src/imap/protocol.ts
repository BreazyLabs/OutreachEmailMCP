// IMAP command tokenizer + sequence-set parsing.

// A token is a string (atom / quoted / literal content) or a nested array for
// a parenthesized list. Section atoms like BODY.PEEK[HEADER.FIELDS (FROM)]<0.64>
// are kept as ONE token including bracket/partial content.
export type Token = string | Token[];

export interface CommandSegments {
  // Alternating text chunks and literal buffers, in wire order
  parts: (string | Buffer)[];
}

class Cursor {
  pos = 0;
  constructor(readonly text: string) {}
  peek(): string | undefined {
    return this.text[this.pos];
  }
  eof(): boolean {
    return this.pos >= this.text.length;
  }
}

function readQuoted(cur: Cursor): string {
  cur.pos++; // opening quote
  let out = '';
  while (!cur.eof()) {
    const ch = this_char(cur);
    if (ch === '\\' && cur.pos + 1 < cur.text.length) {
      out += cur.text[cur.pos + 1];
      cur.pos += 2;
      continue;
    }
    if (ch === '"') {
      cur.pos++;
      return out;
    }
    out += ch;
    cur.pos++;
  }
  return out;
}

function this_char(cur: Cursor): string {
  return cur.text[cur.pos]!;
}

function readAtom(cur: Cursor): string {
  let out = '';
  let bracketDepth = 0;
  while (!cur.eof()) {
    const ch = this_char(cur);
    if (bracketDepth === 0 && (ch === ' ' || ch === '(' || ch === ')')) break;
    if (ch === '[') bracketDepth++;
    if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    out += ch;
    cur.pos++;
  }
  // optional partial suffix <a.b> directly after a bracketed section
  if (!cur.eof() && this_char(cur) === '<' && out.includes(']')) {
    while (!cur.eof()) {
      const ch = this_char(cur);
      out += ch;
      cur.pos++;
      if (ch === '>') break;
    }
  }
  return out;
}

// Literals are injected as plain string tokens at their wire position.
export function tokenize(segments: CommandSegments): Token[] {
  const out: Token[] = [];
  const stack: Token[][] = [out];
  for (const part of segments.parts) {
    if (Buffer.isBuffer(part)) {
      stack[stack.length - 1]!.push(part.toString('utf8'));
      continue;
    }
    // track paren depth across segments by re-implementing inline
    const cur = new Cursor(part);
    while (!cur.eof()) {
      const ch = cur.text[cur.pos]!;
      if (ch === ' ') {
        cur.pos++;
      } else if (ch === '(') {
        cur.pos++;
        const list: Token[] = [];
        stack[stack.length - 1]!.push(list);
        stack.push(list);
      } else if (ch === ')') {
        cur.pos++;
        if (stack.length > 1) stack.pop();
      } else if (ch === '"') {
        stack[stack.length - 1]!.push(readQuoted(cur));
      } else {
        stack[stack.length - 1]!.push(readAtom(cur));
      }
    }
  }
  return out;
}

export function atom(token: Token | undefined): string {
  return typeof token === 'string' ? token : '';
}

// "1,3:5,7:*" against a max value; returns ascending unique numbers.
export function parseSequenceSet(spec: string, max: number): number[] {
  if (max === 0) return [];
  const result = new Set<number>();
  for (const part of spec.split(',')) {
    const [rawA, rawB] = part.split(':');
    const a = rawA === '*' ? max : Number(rawA);
    if (!Number.isInteger(a) || a < 1) continue;
    if (rawB === undefined) {
      if (a <= max) result.add(a);
      continue;
    }
    const b = rawB === '*' ? max : Number(rawB);
    if (!Number.isInteger(b)) continue;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    for (let n = lo; n <= Math.min(hi, max); n++) result.add(n);
  }
  return [...result].sort((x, y) => x - y);
}

// UID variant: match against an arbitrary ascending uid list ('*' = highest).
export function parseUidSet(spec: string, uids: number[]): Set<number> {
  const result = new Set<number>();
  if (uids.length === 0) return result;
  const maxUid = uids[uids.length - 1]!;
  const uidSet = new Set(uids);
  for (const part of spec.split(',')) {
    const [rawA, rawB] = part.split(':');
    const a = rawA === '*' ? maxUid : Number(rawA);
    if (!Number.isFinite(a)) continue;
    if (rawB === undefined) {
      if (uidSet.has(a)) result.add(a);
      continue;
    }
    const b = rawB === '*' ? maxUid : Number(rawB);
    if (!Number.isFinite(b)) continue;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    for (const uid of uids) if (uid >= lo && uid <= hi) result.add(uid);
  }
  return result;
}

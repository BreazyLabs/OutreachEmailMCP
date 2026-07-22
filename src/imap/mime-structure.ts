import type { CachedEnvelope, EnvelopeAddress } from './index-store.js';

// Lightweight MIME tree over a raw RFC822 buffer, preserving byte offsets so
// BODY[n] part fetches can slice the original bytes.

export interface MimeNode {
  type: string; // e.g. 'text'
  subtype: string; // e.g. 'plain'
  params: Record<string, string>;
  encoding: string;
  contentId: string | null;
  description: string | null;
  disposition: string | null;
  headerStart: number;
  bodyStart: number;
  bodyEnd: number;
  lines: number; // body line count (for text/* and message/*)
  children: MimeNode[];
}

function findHeaderEnd(raw: Buffer, from: number, to: number): number {
  const idxCrlf = raw.indexOf('\r\n\r\n', from);
  if (idxCrlf !== -1 && idxCrlf < to) return idxCrlf + 4;
  const idxLf = raw.indexOf('\n\n', from);
  if (idxLf !== -1 && idxLf < to) return idxLf + 2;
  return to;
}

function headerBlock(raw: Buffer, start: number, end: number): Map<string, string> {
  const text = raw.subarray(start, end).toString('latin1').replace(/\r?\n[ \t]+/g, ' ');
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    if (!map.has(key)) map.set(key, line.slice(idx + 1).trim());
  }
  return map;
}

function parseContentType(value: string | undefined): {
  type: string;
  subtype: string;
  params: Record<string, string>;
} {
  if (!value) return { type: 'text', subtype: 'plain', params: { charset: 'us-ascii' } };
  const [mime = '', ...paramParts] = value.split(';');
  const [type = 'text', subtype = 'plain'] = mime.trim().toLowerCase().split('/');
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    let val = part.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (key) params[key] = val;
  }
  return { type, subtype, params };
}

function countLines(raw: Buffer, start: number, end: number): number {
  let count = 0;
  for (let i = start; i < end; i++) if (raw[i] === 0x0a) count++;
  return count;
}

export function parseMimeStructure(
  raw: Buffer,
  start = 0,
  end = raw.length,
  depth = 0,
): MimeNode {
  const bodyStart = findHeaderEnd(raw, start, end);
  const headers = headerBlock(raw, start, bodyStart);
  const { type, subtype, params } = parseContentType(headers.get('content-type'));
  const node: MimeNode = {
    type,
    subtype,
    params,
    encoding: headers.get('content-transfer-encoding')?.toLowerCase() ?? '7bit',
    contentId: headers.get('content-id') ?? null,
    description: headers.get('content-description') ?? null,
    disposition: headers.get('content-disposition')?.split(';')[0]?.trim().toLowerCase() ?? null,
    headerStart: start,
    bodyStart,
    bodyEnd: end,
    lines: countLines(raw, bodyStart, end),
    children: [],
  };

  if (type === 'multipart' && params.boundary && depth < 8) {
    const boundary = `--${params.boundary}`;
    const positions: number[] = [];
    let searchFrom = bodyStart;
    for (;;) {
      const idx = raw.indexOf(boundary, searchFrom);
      if (idx === -1 || idx >= end) break;
      positions.push(idx);
      searchFrom = idx + boundary.length;
    }
    for (let i = 0; i < positions.length - 1; i++) {
      const partStart = raw.indexOf('\n', positions[i]!) + 1;
      if (partStart === 0) break;
      let partEnd = positions[i + 1]!;
      // trim the CRLF that precedes the next boundary
      if (raw[partEnd - 1] === 0x0a) partEnd--;
      if (raw[partEnd - 1] === 0x0d) partEnd--;
      if (partStart < partEnd) {
        node.children.push(parseMimeStructure(raw, partStart, partEnd, depth + 1));
      }
    }
  }
  return node;
}

// "1.2" → nested part; returns null when the path doesn't exist.
export function findPart(root: MimeNode, path: string): MimeNode | null {
  let node = root;
  for (const seg of path.split('.')) {
    const idx = Number(seg) - 1;
    if (!Number.isInteger(idx) || idx < 0) return null;
    if (node.children.length === 0) {
      // A non-multipart message's part 1 is its own body
      if (idx === 0) continue;
      return null;
    }
    const child = node.children[idx];
    if (!child) return null;
    node = child;
  }
  return node;
}

// --- IMAP wire serialization ---

export function quoted(value: string | null): string {
  if (value === null) return 'NIL';
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(/[\r\n]/g, ' ')}"`;
}

function paramList(params: Record<string, string>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return 'NIL';
  return `(${entries.map(([k, v]) => `${quoted(k)} ${quoted(v)}`).join(' ')})`;
}

export function serializeBodyStructure(node: MimeNode): string {
  if (node.type === 'multipart') {
    const parts = node.children.map(serializeBodyStructure).join('');
    return `(${parts} ${quoted(node.subtype.toUpperCase())})`;
  }
  const base = [
    quoted(node.type.toUpperCase()),
    quoted(node.subtype.toUpperCase()),
    paramList(node.params),
    quoted(node.contentId),
    quoted(node.description),
    quoted(node.encoding.toUpperCase()),
    String(Math.max(0, node.bodyEnd - node.bodyStart)),
  ];
  if (node.type === 'text') base.push(String(node.lines));
  return `(${base.join(' ')})`;
}

function addressListImap(list: EnvelopeAddress[]): string {
  if (list.length === 0) return 'NIL';
  return `(${list
    .map((a) => {
      const [mailbox = null, host = null] = a.address ? a.address.split('@') : [null, null];
      return `(${quoted(a.name)} NIL ${quoted(mailbox)} ${quoted(host)})`;
    })
    .join('')})`;
}

export function serializeEnvelope(env: CachedEnvelope): string {
  const from = addressListImap(env.from);
  const sender = from;
  const replyTo = from;
  return [
    '(',
    quoted(env.date ? new Date(env.date).toUTCString() : null),
    ' ',
    quoted(env.subject),
    ` ${from} ${sender} ${replyTo} `,
    addressListImap(env.to),
    ' ',
    addressListImap(env.cc),
    ' NIL ', // bcc
    quoted(env.inReplyTo),
    ' ',
    quoted(env.messageId),
    ')',
  ].join('');
}

// INTERNALDATE format: "01-Jan-2026 12:34:56 +0000"
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function imapDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

// SEARCH SINCE date: "1-Jan-2026" (day may be unpadded)
export function parseImapDate(value: string): number | null {
  const match = value.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return null;
  const month = MONTHS.findIndex((m) => m.toLowerCase() === match[2]!.toLowerCase());
  if (month === -1) return null;
  return Date.UTC(Number(match[3]), month, Number(match[1]));
}

// Index of the first body byte (after the blank line); raw.length if headers only.
export function headerBodySplit(raw: Buffer): { bodyStart: number; sepStart: number; eol: string } {
  const crlf = raw.indexOf('\r\n\r\n');
  if (crlf !== -1) return { bodyStart: crlf + 4, sepStart: crlf + 2, eol: '\r\n' };
  const lf = raw.indexOf('\n\n');
  if (lf !== -1) return { bodyStart: lf + 2, sepStart: lf + 1, eol: '\n' };
  return { bodyStart: raw.length, sepStart: raw.length, eol: '\r\n' };
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g;

// All addresses appearing in the given recipient headers (lowercased).
export function recipientHeaderAddresses(raw: Buffer, names = ['to', 'cc', 'bcc']): Set<string> {
  const { sepStart } = headerBodySplit(raw);
  const head = raw.subarray(0, sepStart).toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const found = new Set<string>();
  for (const line of head.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    if (!names.includes(line.slice(0, idx).trim().toLowerCase())) continue;
    for (const match of line.slice(idx + 1).match(EMAIL_RE) ?? []) {
      found.add(match.toLowerCase());
    }
  }
  return found;
}

// Provider APIs (Gmail raw send, Graph MIME sendMail) deliver to HEADER
// recipients, not the SMTP envelope. Standards-compliant clients put BCC
// recipients only in the envelope — without this, BCC mail silently vanishes.
// Injects a Bcc header for any envelope recipient missing from To/Cc/Bcc.
export function ensureEnvelopeRecipients(raw: Buffer, envelopeTo: string[]): Buffer {
  const inHeaders = recipientHeaderAddresses(raw);
  const missing = [...new Set(envelopeTo.map((a) => a.toLowerCase()))].filter(
    (a) => !inHeaders.has(a),
  );
  if (missing.length === 0) return raw;
  const { sepStart, eol } = headerBodySplit(raw);
  return Buffer.concat([
    raw.subarray(0, sepStart),
    Buffer.from(`Bcc: ${missing.join(', ')}${eol}`),
    raw.subarray(sepStart),
  ]);
}

// Cheap single-header extraction from raw RFC822 without a full MIME parse.
export function extractHeader(raw: Buffer, name: string): string | null {
  const headerEnd = raw.indexOf('\r\n\r\n');
  const head = raw
    .subarray(0, headerEnd === -1 ? Math.min(raw.length, 64 * 1024) : headerEnd)
    .toString('utf8');
  // unfold continuation lines, then match the header
  const pattern = new RegExp(`^${name}:[ \\t]*(.+)$`, 'im');
  const match = head.replace(/\r?\n[ \t]+/g, ' ').match(pattern);
  return match?.[1]?.trim() ?? null;
}

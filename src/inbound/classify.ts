/**
 * Classify an inbound message as a delivery-status notification (bounce), a
 * reply to something we sent, or ordinary mail.
 *
 * Both classifications are correlated back to a send job by RFC822
 * Message-ID, which is the only identifier that survives the round trip
 * through the receiving mail system:
 *
 *   - Bounces: RFC 3464 wraps the original message (or its headers) in a
 *     `multipart/report; report-type=delivery-status` part, whose
 *     message/delivery-status section carries the enhanced status code and
 *     the failed recipient. Providers that skip the RFC (or mangle it) still
 *     name the original in `In-Reply-To`/`References`, or list the address in
 *     `X-Failed-Recipients` — all three are tried.
 *   - Replies: `In-Reply-To`, falling back to the last id in `References`.
 *
 * This module is pure: it never touches the database, so the parsing rules
 * can be unit-tested against real-world bounce samples.
 */

import type { ParsedMail } from 'mailparser';

export interface BounceInfo {
  kind: 'bounce';
  /** Message-ID of the mail that bounced, when the report names it. */
  originalMessageId: string | null;
  /** Permanent (5.x.x) vs transient (4.x.x). */
  type: 'hard' | 'soft';
  /** Enhanced status code, e.g. "5.1.1". */
  code: string | null;
  recipient: string | null;
  diagnostic: string | null;
}

export interface ReplyInfo {
  kind: 'reply';
  /** Message-ID this is a reply to. */
  inReplyTo: string;
}

export type InboundKind = BounceInfo | ReplyInfo | { kind: 'normal' };

/** Normalize a Message-ID for comparison: angle brackets and surrounding
 *  whitespace vary between systems, the id inside them does not. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const match = /<([^>]+)>/.exec(trimmed);
  const id = (match?.[1] ?? trimmed).trim();
  return id.length > 0 ? id.toLowerCase() : null;
}

function headerString(parsed: ParsedMail, name: string): string | null {
  const value = parsed.headers.get(name);
  if (!value) return null;
  if (typeof value === 'string') return value;
  // mailparser returns structured objects for some headers; the raw text is
  // good enough for the id/address extraction we do here.
  const asAny = value as { text?: string; value?: unknown };
  if (typeof asAny.text === 'string') return asAny.text;
  return String(value);
}

/** Message-IDs referenced by this message, most specific first. */
function referencedIds(parsed: ParsedMail): string[] {
  const ids: string[] = [];
  const inReplyTo = normalizeMessageId(headerString(parsed, 'in-reply-to'));
  if (inReplyTo) ids.push(inReplyTo);
  const references = headerString(parsed, 'references');
  if (references) {
    const found = references.match(/<[^>]+>/g) ?? [];
    // Last reference is the immediate parent.
    for (const ref of found.reverse()) {
      const id = normalizeMessageId(ref ?? null);
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

const DAEMON_ADDRESSES =
  /(mailer-daemon|postmaster|no-?reply@.*(mail|smtp)|delivery.*subsystem)/i;

/** Does this look like a delivery-status notification at all? */
function looksLikeDsn(parsed: ParsedMail, rawHeaders: string): boolean {
  if (/report-type=["']?delivery-status/i.test(rawHeaders)) return true;
  if (/content-type:\s*message\/delivery-status/i.test(rawHeaders)) return true;
  const from = parsed.from?.text ?? '';
  if (DAEMON_ADDRESSES.test(from)) return true;
  // Auto-Submitted is set by every RFC-compliant auto-responder; combined
  // with a failure-ish subject it is a strong bounce signal.
  const autoSubmitted = headerString(parsed, 'auto-submitted') ?? '';
  const subject = parsed.subject ?? '';
  return (
    /auto-replied|auto-generated/i.test(autoSubmitted) &&
    /undeliver|delivery status|failure notice|returned mail|delivery has failed/i.test(subject)
  );
}

/** Pull the enhanced status code out of a delivery-status part or, failing
 *  that, out of the human-readable body ("550 5.1.1 User unknown"). */
export function extractStatusCode(body: string): string | null {
  const status = /^\s*Status:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(body);
  if (status?.[1]) return status[1];
  const inline = /\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(body);
  if (inline?.[1]) return inline[1];
  // Bare SMTP reply code as a last resort — map 5xx/4xx to a coarse class.
  const bare = /\b(5\d{2}|4\d{2})[\s-]/.exec(body);
  if (bare?.[1]) return `${bare[1].charAt(0)}.0.0`;
  return null;
}

function extractRecipient(body: string, parsed: ParsedMail): string | null {
  const finalRcpt = /^\s*(?:Final|Original)-Recipient:\s*(?:rfc822;)?\s*(\S+)/im.exec(body);
  if (finalRcpt?.[1]) return finalRcpt[1].replace(/[<>]/g, '');
  const failed = headerString(parsed, 'x-failed-recipients');
  if (failed) return (failed.split(',')[0] ?? '').trim().replace(/[<>]/g, '') || null;
  const inBody = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(body.replace(/mailer-daemon@\S+/gi, ''));
  return inBody?.[0] ?? null;
}

function extractDiagnostic(body: string): string | null {
  const diag = /^\s*Diagnostic-Code:\s*(?:smtp;)?\s*(.+)$/im.exec(body);
  if (diag?.[1]) return diag[1].trim().slice(0, 500);
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^\d{3}[\s-]|user unknown|does not exist|mailbox (full|unavailable)/i.test(l));
  return line ? line.slice(0, 500) : null;
}

/**
 * @param parsed  the mailparser output
 * @param raw     the raw RFC822 source (used for report-type detection and
 *                for scanning the delivery-status part, which mailparser
 *                exposes inconsistently across providers)
 */
export function classifyInbound(parsed: ParsedMail, raw: string): InboundKind {
  const headerEnd = raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') : raw.indexOf('\n\n');
  const rawHeaders = headerEnd > 0 ? raw.slice(0, headerEnd) : raw.slice(0, 4000);

  if (looksLikeDsn(parsed, rawHeaders)) {
    // The status/recipient/diagnostic fields live in the machine-readable
    // part; scanning the whole source finds them wherever it was placed.
    const code = extractStatusCode(raw);
    const type: 'hard' | 'soft' = code?.startsWith('4') ? 'soft' : 'hard';
    const referenced = referencedIds(parsed);
    const original: string | null =
      referenced[0] ??
      normalizeMessageId(
        /^\s*(?:Original-)?Message-ID:\s*(<[^>]+>)/im.exec(raw.slice(rawHeaders.length))?.[1] ?? null,
      );
    return {
      kind: 'bounce',
      originalMessageId: original,
      type,
      code,
      recipient: extractRecipient(raw, parsed),
      diagnostic: extractDiagnostic(raw),
    };
  }

  const referenced = referencedIds(parsed);
  const parent = referenced[0];
  if (parent) return { kind: 'reply', inReplyTo: parent };
  return { kind: 'normal' };
}

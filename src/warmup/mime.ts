/**
 * MIME builders for warmup traffic: openers, replies (with provider-style
 * quoting), forwards and read receipts (MDNs). Messages carry no marker of
 * their own: identification is by the Message-ID registry in identity.ts,
 * plus the optional per-workspace body tag when it is switched on.
 */

import { buildMime } from '../api/messages-send.js';
import { fullName, type Persona } from './content/persona.js';

export type ClientStyle = 'gmail' | 'outlook';

export interface Party {
  email: string;
  persona: Persona;
  style: ClientStyle;
}

export function addressOf(p: Party): string {
  return `"${fullName(p.persona).replaceAll('"', '')}" <${p.email}>`;
}

export function styleFor(provider: string): ClientStyle {
  return provider === 'microsoft' ? 'outlook' : 'gmail';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LONG_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December',
];

function gmailDate(at: number): string {
  const d = new Date(at);
  const h = d.getUTCHours();
  const hh = h % 12 === 0 ? 12 : h % 12;
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} at ${hh}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}

function outlookDate(at: number): string {
  const d = new Date(at);
  const h = d.getUTCHours();
  const hh = h % 12 === 0 ? 12 : h % 12;
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${LONG_DAYS[d.getUTCDay()]}, ${LONG_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${hh}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}

export interface OriginalMessage {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  sentAt: number;
  text: string;
}

/** The quoted block a reply carries beneath the new text. */
export function quoteBlock(style: ClientStyle, original: OriginalMessage): { text: string; html: string } {
  if (style === 'outlook') {
    const text = [
      '',
      '________________________________',
      `From: ${original.fromName} <${original.fromEmail}>`,
      `Sent: ${outlookDate(original.sentAt)}`,
      `To: ${original.to}`,
      `Subject: ${original.subject}`,
      '',
      original.text,
    ].join('\n');
    const html = `<hr style="display:inline-block;width:98%" tabindex="-1"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt" color="#000000"><b>From:</b> ${escapeHtml(original.fromName)} &lt;${escapeHtml(original.fromEmail)}&gt;<br><b>Sent:</b> ${escapeHtml(outlookDate(original.sentAt))}<br><b>To:</b> ${escapeHtml(original.to)}<br><b>Subject:</b> ${escapeHtml(original.subject)}</font><div>&nbsp;</div></div><div>${textToHtml(original.text)}</div>`;
    return { text, html };
  }
  const attribution = `On ${gmailDate(original.sentAt)}, ${original.fromName} <${original.fromEmail}> wrote:`;
  const text = ['', attribution, ...original.text.split('\n').map((l) => `> ${l}`)].join('\n');
  const html = `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(attribution)}<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${textToHtml(original.text)}</blockquote></div>`;
  return { text, html };
}

/** The forwarded-message block. */
export function forwardBlock(style: ClientStyle, original: OriginalMessage): { text: string; html: string } {
  if (style === 'outlook') return quoteBlock('outlook', original);
  const header = [
    '---------- Forwarded message ---------',
    `From: ${original.fromName} <${original.fromEmail}>`,
    `Date: ${gmailDate(original.sentAt)}`,
    `Subject: ${original.subject}`,
    `To: ${original.to}`,
  ];
  const text = ['', ...header, '', '', original.text].join('\n');
  const html = `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">${header.map(escapeHtml).join('<br>')}<br></div><br><br>${textToHtml(original.text)}</div>`;
  return { text, html };
}

export function replySubject(subject: string): string {
  return /^re:\s/i.test(subject) ? subject : `Re: ${subject}`;
}

export function forwardSubject(subject: string, style: ClientStyle): string {
  const stripped = subject.replace(/^(re|fwd?|fw):\s*/i, '');
  return style === 'outlook' ? `FW: ${stripped}` : `Fwd: ${stripped}`;
}

export interface CommonMessage {
  from: Party;
  to: Party[];
  cc?: Party[];
  subject: string;
  text: string;
  html: string | null;
  /** `<...>` form. */
  messageIdHeader: string;
  normalizedMessageId: string;
  inReplyTo?: string | null;
  references?: string[];
  requestReceipt?: boolean;
  /** Ask the recipient's client for an MDN — only on openers. */
  sentAt?: number;
}

// No marker header: identification is by registry (both ends are ours), so
// the message carries nothing a receiver could pattern-match across senders.
export async function buildWarmupMime(m: CommonMessage): Promise<Buffer> {
  const headers: Record<string, string> = {};
  if (m.requestReceipt) {
    headers['Disposition-Notification-To'] = addressOf(m.from);
  }
  const raw = await buildMime({
    from: addressOf(m.from),
    to: m.to.map(addressOf),
    cc: m.cc?.map(addressOf),
    subject: m.subject,
    text: m.text,
    html: m.html ?? undefined,
    messageId: m.messageIdHeader,
    inReplyTo: m.inReplyTo ?? undefined,
    references: m.references?.length ? m.references.join(' ') : undefined,
    headers,
    date: m.sentAt ? new Date(m.sentAt) : undefined,
  });
  return raw;
}

/** RFC 8098 message disposition notification ("read receipt"). Hand-built:
 *  multipart/report is outside what MailComposer models. */
export function buildMdnMime(input: {
  from: Party;
  to: Party;
  originalMessageIdHeader: string;
  originalSubject: string;
  messageIdHeader: string;
  normalizedMessageId: string;
  displayedAt: number;
}): Buffer {
  const boundary = `----=_MDN_${input.normalizedMessageId.replace(/[^a-z0-9]/gi, '').slice(0, 24)}`;
  const date = new Date(input.displayedAt).toUTCString().replace('GMT', '+0000');
  const ua = input.from.style === 'outlook' ? 'Microsoft Outlook' : 'Gmail';
  const human =
    `Your message\n\n  To: ${input.to.email}\n  Subject: ${input.originalSubject}\n  Sent: ${date}\n\n` +
    `was read on ${date}.`;
  const lines = [
    `From: ${addressOf(input.from)}`,
    `To: ${addressOf(input.to)}`,
    `Subject: Read: ${input.originalSubject}`,
    `Message-ID: ${input.messageIdHeader}`,
    `In-Reply-To: ${input.originalMessageIdHeader}`,
    `References: ${input.originalMessageIdHeader}`,
    `Date: ${date}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-replied',
    `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    human,
    '',
    `--${boundary}`,
    'Content-Type: message/disposition-notification',
    '',
    `Reporting-UA: ${input.from.email}; ${ua}`,
    `Original-Recipient: rfc822;${input.from.email}`,
    `Final-Recipient: rfc822;${input.from.email}`,
    `Original-Message-ID: ${input.originalMessageIdHeader}`,
    'Disposition: manual-action/MDN-sent-manually; displayed',
    '',
    `--${boundary}--`,
    '',
  ];
  return Buffer.from(lines.join('\r\n'));
}

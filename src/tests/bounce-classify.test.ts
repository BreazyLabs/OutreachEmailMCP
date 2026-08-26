import { describe, it, expect } from 'vitest';
import { simpleParser } from 'mailparser';

process.env.MASTER_KEY = Buffer.alloc(32, 5).toString('base64');
process.env.DATA_DIR = './data-test/bounce';

const { classifyInbound, normalizeMessageId, extractStatusCode } = await import(
  '../inbound/classify.js'
);

/** A Gmail-shaped hard bounce: multipart/report with a delivery-status part. */
const GMAIL_HARD_BOUNCE = [
  'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
  'To: sender@example.com',
  'Subject: Delivery Status Notification (Failure)',
  'In-Reply-To: <original-123@mail.example.com>',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=UTF-8',
  '',
  'Address not found. Your message wasn\'t delivered to nobody@nowhere.test',
  '',
  '--b1',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; googlemail.com',
  'Final-Recipient: rfc822; nobody@nowhere.test',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.',
  '',
  '--b1--',
  '',
].join('\r\n');

/** A transient (soft) failure — mailbox full. */
const SOFT_BOUNCE = [
  'From: postmaster@corp.example',
  'To: sender@example.com',
  'Subject: Undeliverable: Quick question',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="x"',
  '',
  '--x',
  'Content-Type: message/delivery-status',
  '',
  'Final-Recipient: rfc822; full@corp.example',
  'Action: delayed',
  'Status: 4.2.2',
  'Diagnostic-Code: smtp; 452 4.2.2 Mailbox full',
  '',
  '--x--',
  '',
].join('\r\n');

const HUMAN_REPLY = [
  'From: Alice <alice@corp.example>',
  'To: sender@example.com',
  'Subject: Re: Quick question',
  'In-Reply-To: <original-456@mail.example.com>',
  'References: <original-456@mail.example.com>',
  'Content-Type: text/plain',
  '',
  'Sure, send it over.',
  '',
].join('\r\n');

const COLD_INBOUND = [
  'From: Newsletter <news@example.org>',
  'To: sender@example.com',
  'Subject: Weekly digest',
  'Content-Type: text/plain',
  '',
  'Hello there.',
  '',
].join('\r\n');

describe('inbound classification', () => {
  it('recognises a hard bounce and extracts code, recipient and diagnostic', async () => {
    const parsed = await simpleParser(GMAIL_HARD_BOUNCE);
    const result = classifyInbound(parsed, GMAIL_HARD_BOUNCE);
    expect(result.kind).toBe('bounce');
    if (result.kind !== 'bounce') return;
    expect(result.type).toBe('hard');
    expect(result.code).toBe('5.1.1');
    expect(result.recipient).toBe('nobody@nowhere.test');
    expect(result.diagnostic).toContain('does not exist');
    // Correlation back to the original send.
    expect(result.originalMessageId).toBe('original-123@mail.example.com');
  });

  it('classifies a 4.x.x status as a soft bounce', async () => {
    const parsed = await simpleParser(SOFT_BOUNCE);
    const result = classifyInbound(parsed, SOFT_BOUNCE);
    expect(result.kind).toBe('bounce');
    if (result.kind !== 'bounce') return;
    expect(result.type).toBe('soft');
    expect(result.code).toBe('4.2.2');
    expect(result.recipient).toBe('full@corp.example');
  });

  it('treats a human reply as a reply, not a bounce', async () => {
    const parsed = await simpleParser(HUMAN_REPLY);
    const result = classifyInbound(parsed, HUMAN_REPLY);
    expect(result.kind).toBe('reply');
    if (result.kind !== 'reply') return;
    expect(result.inReplyTo).toBe('original-456@mail.example.com');
  });

  it('leaves unrelated inbound mail alone', async () => {
    const parsed = await simpleParser(COLD_INBOUND);
    expect(classifyInbound(parsed, COLD_INBOUND).kind).toBe('normal');
  });

  it('normalises Message-IDs so <id> and id compare equal', () => {
    expect(normalizeMessageId('<abc@host>')).toBe('abc@host');
    expect(normalizeMessageId('  ABC@Host  ')).toBe('abc@host');
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId('')).toBeNull();
  });

  it('falls back to a bare SMTP code when no enhanced status is present', () => {
    expect(extractStatusCode('Status: 5.7.1 blocked')).toBe('5.7.1');
    expect(extractStatusCode('550 sorry, no mailbox here')).toBe('5.0.0');
    expect(extractStatusCode('nothing numeric here')).toBeNull();
  });
});

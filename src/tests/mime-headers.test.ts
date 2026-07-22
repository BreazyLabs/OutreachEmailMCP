import { describe, it, expect } from 'vitest';
import {
  extractHeader,
  ensureEnvelopeRecipients,
  recipientHeaderAddresses,
} from '../utils/mime-headers.js';

const raw = Buffer.from(
  [
    'From: Tester <tester@gmail.com>',
    'To: dest@example.com',
    'Subject: a folded',
    ' subject line',
    'Message-ID: <abc123@mailer.example>',
    'Content-Type: text/plain',
    '',
    'Subject: not-a-header, this is the body',
    'Message-ID: <fake@body>',
  ].join('\r\n'),
);

describe('extractHeader', () => {
  it('extracts a simple header', () => {
    expect(extractHeader(raw, 'Message-ID')).toBe('<abc123@mailer.example>');
  });

  it('unfolds continuation lines', () => {
    expect(extractHeader(raw, 'Subject')).toBe('a folded subject line');
  });

  it('is case-insensitive', () => {
    expect(extractHeader(raw, 'message-id')).toBe('<abc123@mailer.example>');
  });

  it('ignores body content past the header block', () => {
    const noSuch = Buffer.from('From: x@y.z\r\n\r\nX-Custom: only-in-body\r\n');
    expect(extractHeader(noSuch, 'X-Custom')).toBeNull();
  });

  it('returns null for missing headers', () => {
    expect(extractHeader(raw, 'Reply-To')).toBeNull();
  });
});

describe('ensureEnvelopeRecipients (BCC preservation)', () => {
  const mime = Buffer.from(
    'From: t@g.com\r\nTo: Alice <alice@x.com>, bob@y.com\r\nCc: carol@z.com\r\nSubject: s\r\n\r\nbody',
  );

  it('collects addresses from To and Cc', () => {
    expect(recipientHeaderAddresses(mime)).toEqual(
      new Set(['alice@x.com', 'bob@y.com', 'carol@z.com']),
    );
  });

  it('injects a Bcc header for envelope-only recipients', () => {
    const out = ensureEnvelopeRecipients(mime, [
      'alice@x.com',
      'bob@y.com',
      'carol@z.com',
      'hidden@secret.com',
      'other@secret.com',
    ]);
    const headers = out.toString().split('\r\n\r\n')[0]!;
    expect(headers).toContain('Bcc: hidden@secret.com, other@secret.com');
    expect(out.toString().endsWith('body')).toBe(true);
  });

  it('is a no-op when headers cover the envelope (case-insensitively)', () => {
    const out = ensureEnvelopeRecipients(mime, ['ALICE@X.COM', 'bob@y.com']);
    expect(out).toBe(mime);
  });

  it('handles LF-only messages', () => {
    const lf = Buffer.from('To: a@b.c\n\nbody');
    const out = ensureEnvelopeRecipients(lf, ['a@b.c', 'x@y.z']).toString();
    expect(out).toBe('To: a@b.c\nBcc: x@y.z\n\nbody');
  });
});

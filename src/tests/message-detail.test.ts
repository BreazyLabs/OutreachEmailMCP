import { describe, it, expect } from 'vitest';
import { simpleParser } from 'mailparser';
import { messageDetailOf } from '../api/message-detail.js';

const raw = (headers: string[], body = 'Hello') => Buffer.from([...headers, 'Content-Type: text/plain', '', body].join('\r\n'));

describe('messageDetailOf', () => {
  it('returns Reply-To and the full References chain', async () => {
    const parsed = await simpleParser(
      raw([
        'From: Jane Doe <jane@acme.com>',
        'To: Us <us@breazy.app>',
        'Cc: Henry de Vries <henry@acme.com>, ops@acme.com',
        'Reply-To: Henry de Vries <henry@acme.com>',
        'Subject: Re: Pilot',
        'Message-ID: <reply-1@acme.com>',
        'In-Reply-To: <fwd-1@acme.com>',
        'References: <cs-root@thread.breazyleads.com> <fwd-1@acme.com>',
      ]),
    );
    const detail = messageDetailOf('p-1', parsed, false);
    expect(detail.replyTo).toBe('"Henry de Vries" <henry@acme.com>');
    expect(detail.references).toEqual(['<cs-root@thread.breazyleads.com>', '<fwd-1@acme.com>']);
    expect(detail.inReplyTo).toBe('<fwd-1@acme.com>');
    expect(detail.cc).toBe('"Henry de Vries" <henry@acme.com>, ops@acme.com');
    expect(detail.to).toBe('"Us" <us@breazy.app>');
  });

  it('a forward that names the original only in References still carries it', async () => {
    const parsed = await simpleParser(
      raw(['From: henry@acme.com', 'To: us@breazy.app', 'Subject: Fwd: Pilot', 'Message-ID: <h-1@acme.com>', 'References: <cs-root@thread.breazyleads.com>']),
    );
    const detail = messageDetailOf('p-2', parsed, false);
    expect(detail.inReplyTo).toBeNull();
    expect(detail.references).toEqual(['<cs-root@thread.breazyleads.com>']);
  });

  it('absent headers are null / empty, never undefined', async () => {
    const parsed = await simpleParser(raw(['From: a@b.c', 'To: us@breazy.app', 'Subject: hi', 'Message-ID: <x@b.c>']));
    const detail = messageDetailOf('p-3', parsed, true);
    expect(detail).toMatchObject({ replyTo: null, references: [], inReplyTo: null, cc: null, warmup: true });
  });
});

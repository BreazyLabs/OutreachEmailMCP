import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'node:net';

process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.DATA_DIR = './data-test/imap-e2e';
process.env.BASE_URL = 'http://localhost:3000'; // vite injects BASE_URL='/'
process.env.IMAP_ALLOW_INSECURE_AUTH = 'true';
process.env.IMAP_BACKFILL_COUNT = '0';

const RAW_A = Buffer.from(
  [
    'From: Alice <alice@example.com>',
    'To: tester@gmail.com',
    'Subject: First reply',
    'Message-ID: <reply-1@example.com>',
    'In-Reply-To: <campaign-42@proxy>',
    'Date: Mon, 20 Jul 2026 10:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Sounds interesting, tell me more!',
  ].join('\r\n'),
);
const RAW_B = Buffer.from(
  [
    'From: Bob <bob@example.com>',
    'To: tester@gmail.com',
    'Subject: Multipart hello',
    'Message-ID: <hello-2@example.com>',
    'Date: Mon, 20 Jul 2026 11:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="BB"',
    '',
    '--BB',
    'Content-Type: text/plain',
    '',
    'plain version',
    '--BB',
    'Content-Type: text/html',
    '',
    '<p>html version</p>',
    '--BB--',
    '',
  ].join('\r\n'),
);
const RAWS: Record<string, Buffer> = { 'prov-a': RAW_A, 'prov-b': RAW_B };

vi.mock('../providers/index.js', () => ({
  providerFor: () => ({
    async getMessageRaw(_accountId: string, messageId: string) {
      const raw = RAWS[messageId];
      if (!raw) throw new Error('unknown message');
      return raw;
    },
    async pollChanges(_accountId: string, cursor: string) {
      return { newMessageIds: [], nextCursor: cursor };
    },
    async initCursor() {
      return 'cursor-0';
    },
    async listMessages() {
      return { messages: [], nextPageToken: null };
    },
    async listFolders() {
      return [];
    },
    async sendRaw() {
      return null;
    },
  }),
}));

let server: net.Server;
let port: number;
let username: string;
let password: string;

beforeAll(async () => {
  const { runMigrations, db, schema } = await import('../db/index.js');
  runMigrations();
  const { nanoid } = await import('nanoid');
  const now = Date.now();
  const accountId = `imap-test-${nanoid(6)}`;
  db.insert(schema.accounts)
    .values({
      id: accountId,
      provider: 'google',
      email: `tester-${accountId}@gmail.com`,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(schema.syncState)
    .values({ accountId, cursor: 'cursor-0', imapBackfilled: 1 })
    .run();

  const { createSmtpCredential } = await import('../smtp/credentials.js');
  const account = db
    .select()
    .from(schema.accounts)
    .where((await import('drizzle-orm')).eq(schema.accounts.id, accountId))
    .get()!;
  const cred = createSmtpCredential(account);
  username = cred.username;
  password = cred.password;

  const { indexMessage } = await import('../imap/index-store.js');
  const { simpleParser } = await import('mailparser');
  indexMessage(accountId, 'prov-a', RAW_A, await simpleParser(RAW_A));
  indexMessage(accountId, 'prov-b', RAW_B, await simpleParser(RAW_B));

  const { ImapSession } = await import('../imap/session.js');
  const selfsigned = (await import('selfsigned')).default;
  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1 });
  server = net.createServer((socket) => {
    new ImapSession(socket, { key: pems.private, cert: pems.cert });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(() => {
  server?.close();
});

async function connect() {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: '127.0.0.1',
    port,
    secure: false,
    disableAutoIdle: true,
    tls: { rejectUnauthorized: false },
    auth: { user: username, pass: password },
    logger:
      process.env.IMAP_TEST_DEBUG === '1'
        ? {
            debug: (o: object) => console.error('[imap]', JSON.stringify(o)),
            info: () => {},
            warn: (o: object) => console.error('[imap warn]', JSON.stringify(o)),
            error: (o: object) => console.error('[imap err]', JSON.stringify(o)),
          }
        : false,
  });
  await client.connect();
  return client;
}

describe('IMAP end-to-end (real client over STARTTLS)', () => {
  it('logs in, selects INBOX, searches and fetches', async () => {
    const client = await connect();
    const mailbox = await client.mailboxOpen('INBOX');
    expect(mailbox.exists).toBe(2);

    // UID SEARCH by header (reply detection pattern)
    const replies = await client.search(
      { header: { 'in-reply-to': 'campaign-42@proxy' } },
      { uid: true },
    );
    expect(replies).toEqual([1]);

    const unseen = await client.search({ seen: false }, { uid: true });
    expect([...(unseen || [])].sort()).toEqual([1, 2]);

    // envelope + size + internaldate
    const meta = await client.fetchOne('1', { envelope: true, internalDate: true, size: true }, { uid: true });
    expect(meta && meta.envelope?.subject).toBe('First reply');
    expect(meta && meta.envelope?.from?.[0]?.address).toBe('alice@example.com');
    expect(meta && meta.size).toBe(RAW_A.length);

    // full body download
    const dl = await client.download('1', undefined, { uid: true });
    const chunks: Buffer[] = [];
    for await (const chunk of dl.content) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toContain('Sounds interesting');

    // bodystructure of the multipart message + part fetch
    const bs = await client.fetchOne('2', { bodyStructure: true }, { uid: true });
    expect(bs && bs.bodyStructure?.type).toBe('multipart/alternative');
    const part = await client.download('2', '2', { uid: true });
    const partChunks: Buffer[] = [];
    for await (const chunk of part.content) partChunks.push(chunk as Buffer);
    expect(Buffer.concat(partChunks).toString()).toContain('<p>html version</p>');

    // flags: mark msg 1 seen (imapflow downloads use BODY.PEEK, which never marks)
    await client.messageFlagsAdd('1', ['\\Seen'], { uid: true });
    const seenNow = await client.search({ seen: true }, { uid: true });
    expect(seenNow).toContain(1);

    // STORE flags
    await client.messageFlagsAdd('2', ['\\Flagged'], { uid: true });
    const flagged = await client.search({ flagged: true }, { uid: true });
    expect(flagged).toEqual([2]);

    // APPEND to Sent (the save-sent-copy pattern), then read it back
    const sentRaw = Buffer.from(
      [
        'From: tester@gmail.com',
        'To: alice@example.com',
        'Subject: my outbound copy',
        'Message-ID: <out-1@proxy>',
        'Date: Mon, 20 Jul 2026 12:00:00 +0000',
        '',
        'what I sent',
      ].join('\r\n'),
    );
    await client.append('Sent', sentRaw, ['\\Seen']);
    const sent = await client.mailboxOpen('Sent');
    expect(sent.exists).toBe(1);
    const copy = await client.download('1', undefined, { uid: true });
    const copyChunks: Buffer[] = [];
    for await (const chunk of copy.content) copyChunks.push(chunk as Buffer);
    expect(Buffer.concat(copyChunks).toString()).toContain('what I sent');
    const sentSeen = await client.search({ seen: true }, { uid: true });
    expect(sentSeen).toEqual([1]);

    await client.logout();
  }, 20_000);

  it('rejects wrong credentials', async () => {
    const { ImapFlow } = await import('imapflow');
    const bad = new ImapFlow({
      host: '127.0.0.1',
      port,
      secure: false,
      tls: { rejectUnauthorized: false },
      auth: { user: username, pass: 'wrong' },
      logger: false,
    });
    await expect(bad.connect()).rejects.toThrow();
  }, 20_000);
});

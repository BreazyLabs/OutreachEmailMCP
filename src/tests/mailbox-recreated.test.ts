import { describe, it, expect, beforeAll, vi } from 'vitest';

process.env.MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.DATA_DIR = './data-test/mailbox-recreated';
process.env.BASE_URL = 'http://localhost:3000';
process.env.SAAS_MODE = 'false';

vi.mock('../auth/tokens.js', () => ({
  getAccessToken: async () => 'fake-access-token',
}));

// A provider whose folder listing we script per test.
const listings: Record<string, string[]> = {};
vi.mock('../providers/index.js', () => ({
  providerFor: () => ({
    listMessageIds: async (_accountId: string, folder: string) => listings[folder] ?? [],
  }),
}));

let account: any;
let db: any;
let schema: any;

function seed(ids: string[], folder = 'INBOX', localPath: string | null = null) {
  const base = Math.max(0, ...rows(folder).map((r: any) => r.uid));
  for (const [i, id] of ids.entries()) {
    db.insert(schema.imapMessages)
      .values({
        id: `${folder}-${id}`,
        accountId: account.id,
        folder,
        uid: base + i + 1,
        providerMessageId: id,
        internalDate: Date.now(),
        size: 10,
        envelopeJson: '{}',
        seen: 0,
        answered: 0,
        flagged: 0,
        deleted: 0,
        createdAt: Date.now(),
        localPath,
        warmup: 0,
      })
      .run();
  }
}
const rows = (folder?: string) =>
  db.select().from(schema.imapMessages).all().filter((r: any) => r.accountId === account.id && (!folder || r.folder === folder));
const clear = () => db.delete(schema.imapMessages).run();

beforeAll(async () => {
  ({ db, schema } = await import('../db/index.js'));
  const { runMigrations } = await import('../db/index.js');
  runMigrations();
  const { createOrgWithOwner } = await import('../tenancy/orgs.js');
  const org = createOrgWithOwner({ orgName: 'M', email: 'm@m.test', password: 'password-abc' });
  const now = Date.now();
  account = { id: 'ms-recreated', orgId: org.orgId, provider: 'microsoft', email: 'fons@example.nl', status: 'active', createdAt: now, updatedAt: now };
  db.insert(schema.accounts).values(account).run();
});

describe('a mailbox the provider replaced', () => {
  it('is told apart from a single stale id by the Graph error code', async () => {
    const { throwForResponse, isMailboxRecreated, isMessageGone } = await import('../providers/errors.js');
    const res = (status: number, body: object) => new Response(JSON.stringify(body), { status });
    const recreated = await throwForResponse(res(404, { error: { code: 'ErrorInvalidMailboxItemId', message: 'belongs to a different mailbox' } }), 'Graph GET').catch((e) => e);
    expect(isMailboxRecreated(recreated)).toBe(true);
    expect(isMessageGone(recreated)).toBe(true); // every existing stale-id handler still applies
    const gone = await throwForResponse(res(404, { error: { code: 'ErrorNonExistentMailbox', message: 'No mailbox with such guid.' } }), 'Graph GET').catch((e) => e);
    expect(isMailboxRecreated(gone)).toBe(true);
    const single = await throwForResponse(res(404, { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } }), 'Graph GET').catch((e) => e);
    expect(isMessageGone(single)).toBe(true);
    expect(isMailboxRecreated(single)).toBe(false);
    const unlicensed = await throwForResponse(res(404, { error: { code: 'MailboxNotEnabledForRESTAPI', message: 'inactive' } }), 'Graph GET').catch((e) => e);
    expect(isMailboxRecreated(unlicensed)).toBe(false);
    expect(isMessageGone(unlicensed)).toBe(false);
  });

  it('resets the index and sync state once, keeps locally stored mail, and logs it', async () => {
    const { resetMailboxIndex } = await import('../imap/index-store.js');
    clear();
    seed(['old-1', 'old-2', 'old-3'], 'INBOX');
    seed(['old-s1'], 'Spam');
    seed(['draft-1'], 'INBOX', '/nonexistent/draft-1.eml');
    db.insert(schema.syncState).values({ accountId: account.id, cursor: 'https://graph/delta?token=old', imapBackfilled: 1, lastPolledAt: 1, lastError: null }).run();

    const t0 = 1_000_000_000_000;
    expect(resetMailboxIndex(account, 'ErrorInvalidMailboxItemId', t0)).toBe(4);
    expect(rows().map((r: any) => r.providerMessageId)).toEqual(['draft-1']);
    const state = db.select().from(schema.syncState).all().find((s: any) => s.accountId === account.id);
    expect(state.cursor).toBeNull();
    expect(state.imapBackfilled).toBe(0);
    const log = db.select().from(schema.activityLog).all().filter((a: any) => a.accountId === account.id && a.action === 'mailbox-reset');
    expect(log).toHaveLength(1);
    expect(log[0].detail).toMatch(/4 stale message\(s\) forgotten/);

    // A second trip over the same error moments later is a no-op.
    seed(['new-1'], 'INBOX');
    expect(resetMailboxIndex(account, 'again', t0 + 60_000)).toBe(0);
    expect(rows('INBOX').map((r: any) => r.providerMessageId).sort()).toEqual(['draft-1', 'new-1']);
  });

  it('prunes rows that left the folder, but only from a complete, non-empty listing', async () => {
    const { pruneVanished, PRUNE_INTERVAL_MS } = await import('../imap/index-store.js');
    clear();
    seed(['a', 'b', 'c'], 'INBOX');
    seed(['local'], 'INBOX', '/nonexistent/local.eml');
    let now = 2_000_000_000_000;

    // Listing as long as the window: could be a page of a big mailbox, keep everything.
    listings.INBOX = ['b', 'c'];
    expect(await pruneVanished(account, 'INBOX', 2, now)).toBe(0);
    expect(rows('INBOX')).toHaveLength(4);

    // Empty listing: suspicious, keep everything.
    now += PRUNE_INTERVAL_MS;
    listings.INBOX = [];
    expect(await pruneVanished(account, 'INBOX', 50, now)).toBe(0);
    expect(rows('INBOX')).toHaveLength(4);

    // Complete listing: a is gone upstream, the local draft is not upstream at all and stays.
    now += PRUNE_INTERVAL_MS;
    listings.INBOX = ['b', 'c'];
    expect(await pruneVanished(account, 'INBOX', 50, now)).toBe(1);
    expect(rows('INBOX').map((r: any) => r.providerMessageId).sort()).toEqual(['b', 'c', 'local']);

    // Rate-limited: nothing happens within the interval even if more vanished.
    listings.INBOX = ['c'];
    expect(await pruneVanished(account, 'INBOX', 50, now + 1000)).toBe(0);
    expect(rows('INBOX')).toHaveLength(3);
  });
});

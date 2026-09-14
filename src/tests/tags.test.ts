import { describe, it, expect, beforeAll } from 'vitest';

process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.DATA_DIR = './data-test/tags';
process.env.BASE_URL = 'http://localhost:3000';
process.env.SAAS_MODE = 'false';

describe('mailbox tags', () => {
  let orgId: string;
  const ids: string[] = [];

  beforeAll(async () => {
    const { runMigrations, db, schema } = await import('../db/index.js');
    runMigrations();
    const { createOrgWithOwner } = await import('../tenancy/orgs.js');
    orgId = createOrgWithOwner({ orgName: 'Tags Co', email: 'owner@tags.test', password: 'pw-pw-pw-pw-1' }).orgId;
    const now = Date.now();
    for (const email of ['a@tags.test', 'b@tags.test', 'c@tags.test']) {
      const id = 'acc-' + email.split('@')[0];
      ids.push(id);
      db.insert(schema.accounts)
        .values({ id, orgId, provider: 'google', email, displayName: null, status: 'active', createdAt: now, updatedAt: now })
        .run();
    }
  });

  it('normalises, de-duplicates case-insensitively and caps the list', async () => {
    const { normalizeTags, splitTagInput, normalizeTag } = await import('../accounts/tags.js');
    expect(splitTagInput(' Campaign A, q4;  q4 \n Client-X ')).toEqual(['Campaign A', 'q4', 'q4', 'Client-X']);
    expect(normalizeTags(['q4', 'Q4', 'Campaign A', 'campaign a', ''])).toEqual(['Campaign A', 'q4']);
    expect(normalizeTag('x'.repeat(50)).length).toBe(32);
    expect(normalizeTags(Array.from({ length: 40 }, (_, i) => 't' + i)).length).toBe(25);
  });

  it('adds and removes tags across mailboxes and counts them per workspace', async () => {
    const { editAccountTags, orgTagCounts, parseTags, setAccountTags } = await import('../accounts/tags.js');
    const { db, schema } = await import('../db/index.js');
    const { eq } = await import('drizzle-orm');
    editAccountTags(ids, { add: ['campaign-a', 'Q4'] });
    editAccountTags([ids[0]!], { remove: ['q4'] });
    const tagsOf = (id: string) =>
      parseTags(db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get()!.tagsJson);
    expect(tagsOf(ids[0]!)).toEqual(['campaign-a']);
    expect(tagsOf(ids[1]!)).toEqual(['campaign-a', 'Q4']);
    expect(orgTagCounts(orgId)).toEqual([
      { tag: 'campaign-a', count: 3 },
      { tag: 'Q4', count: 2 },
    ]);
    expect(setAccountTags(ids[2]!, [])).toEqual([]);
    expect(tagsOf(ids[2]!)).toEqual([]);
  });

  it('is reachable through the warmup bulk endpoint and the public account shape', async () => {
    const { runBulk } = await import('../warmup/api.js');
    const { publicAccount } = await import('../api/accounts.js');
    const { db, schema } = await import('../db/index.js');
    const { eq } = await import('drizzle-orm');
    const { results } = runBulk(orgId, { accountIds: [ids[2]!, 'not-mine'], action: 'tags', tags: { add: ['batch 2'] } });
    expect(results).toEqual([{ accountId: ids[2], ok: true }]);
    const row = db.select().from(schema.accounts).where(eq(schema.accounts.id, ids[2]!)).get()!;
    expect(publicAccount(row).tags).toEqual(['batch 2']);
  });
});

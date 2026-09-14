import { describe, it, expect, beforeAll } from 'vitest';

process.env.MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.DATA_DIR = './data-test/reputation';
process.env.BASE_URL = 'http://localhost:3000';
process.env.SAAS_MODE = 'false';
process.env.WARMUP_MIN_POOL_SIZE = '2';

describe('reputation controller protection delay', () => {
  let orgId: string;
  const sender = 'acc-sender';
  const receiver = 'acc-receiver';

  beforeAll(async () => {
    const { runMigrations, db, schema } = await import('../db/index.js');
    runMigrations();
    const { createOrgWithOwner } = await import('../tenancy/orgs.js');
    orgId = createOrgWithOwner({ orgName: 'Rep Co', email: 'owner@rep.test', password: 'pw-pw-pw-pw-1' }).orgId;
    const now = Date.now();
    for (const [id, email] of [[sender, 's@rep.test'], [receiver, 'r@other.test']] as const) {
      db.insert(schema.accounts)
        .values({ id, orgId, provider: 'google', email, displayName: null, status: 'active', createdAt: now, updatedAt: now })
        .run();
    }
    const { enableWarmup } = await import('../warmup/state.js');
    enableWarmup(sender);
    enableWarmup(receiver);
    // Twelve of fifteen placements in spam over the last day: far past the pause threshold.
    const ins = db.insert(schema.warmupLandings);
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 15; i++) {
      ins
        .values({
          id: `l${i}`,
          messageId: `m${i}`,
          fromAccountId: sender,
          toAccountId: receiver,
          localDate: day,
          landed: i < 12 ? 'spam' : 'inbox',
          landedAt: now - 3600_000,
          createdAt: now - 3600_000,
        })
        .run();
    }
  });

  it('neither throttles nor pauses a mailbox inside the protection delay, and lifts an old throttle', async () => {
    const { db, schema } = await import('../db/index.js');
    const { eq } = await import('drizzle-orm');
    const { loadMember } = await import('../warmup/pool.js');
    const { applyReputation } = await import('../warmup/reputation.js');
    const { getWarmupAccount } = await import('../warmup/state.js');
    db.update(schema.warmupAccounts).set({ throttlePercent: 50 }).where(eq(schema.warmupAccounts.accountId, sender)).run();
    const member = loadMember(sender);
    expect(member).not.toBeNull();
    applyReputation(member!, Date.now(), 'daily');
    const warm = getWarmupAccount(sender)!;
    expect(warm.state).toBe('ramping');
    expect(warm.throttlePercent).toBe(100);
  });

  it('pauses the same mailbox once the protection delay has passed', async () => {
    const { db, schema } = await import('../db/index.js');
    const { eq } = await import('drizzle-orm');
    const { loadMember } = await import('../warmup/pool.js');
    const { applyReputation } = await import('../warmup/reputation.js');
    const { getWarmupAccount } = await import('../warmup/state.js');
    db.update(schema.warmupAccounts)
      .set({ startedAt: Date.now() - 20 * 24 * 3600_000 })
      .where(eq(schema.warmupAccounts.accountId, sender))
      .run();
    applyReputation(loadMember(sender)!, Date.now(), 'daily');
    const warm = getWarmupAccount(sender)!;
    expect(warm.state).toBe('auto_paused');
    expect(warm.pauseReason).toMatch(/80% of warmup mail/);
  });
});

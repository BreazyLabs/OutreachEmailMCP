import { describe, it, expect, beforeAll } from 'vitest';

process.env.MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.DATA_DIR = './data-test/bounce-stats';
process.env.BASE_URL = 'http://localhost:3000';

/**
 * The correlation path end to end at the data layer: a send job goes out, a
 * DSN comes back naming its Message-ID, and the bounce shows up on the job,
 * in the stats rollup, and in the bounce list — exactly once, no matter how
 * many times the same DSN is processed.
 */
describe('bounce correlation and stats', () => {
  let accountId: string;
  let jobId: string;
  const messageId = 'msg-under-test@thread.example.com';

  beforeAll(async () => {
    const { runMigrations, db, schema } = await import('../db/index.js');
    runMigrations();
    const { seedTenancy } = await import('../tenancy/orgs.js');
    seedTenancy();
    const now = Date.now();
    accountId = 'acc-bounce-test';
    db.insert(schema.accounts)
      .values({
        id: accountId,
        orgId: 'org_default',
        provider: 'google',
        email: 'sender@example.com',
        displayName: 'Sender',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    jobId = 'job-bounce-test';
    db.insert(schema.sendJobs)
      .values({
        id: jobId,
        accountId,
        source: 'api',
        status: 'sent',
        envelopeJson: JSON.stringify({ from: 'sender@example.com', to: ['nobody@nowhere.test'] }),
        subject: 'Quick question',
        messageId: `<${messageId}>`,
        nextAttemptAt: now,
        createdAt: now,
        sentAt: now,
      })
      .onConflictDoNothing()
      .run();
  });

  it('finds the send job from a DSN Message-ID, including angle brackets', async () => {
    const { findSendJobByMessageId } = await import('../inbound/correlate.js');
    expect(findSendJobByMessageId(accountId, messageId)?.id).toBe(jobId);
    expect(findSendJobByMessageId(accountId, `<${messageId}>`)?.id).toBe(jobId);
    expect(findSendJobByMessageId(accountId, 'unrelated@example.com')).toBeUndefined();
    // A bounce arriving at a different mailbox must not match.
    expect(findSendJobByMessageId('other-account', messageId)).toBeUndefined();
  });

  it('records a bounce once and reflects it in stats and the bounce list', async () => {
    const { db, schema, sqlite } = await import('../db/index.js');
    const { findSendJobByMessageId, recordBounce } = await import('../inbound/correlate.js');
    const account = db.select().from(schema.accounts).get()!;
    const job = findSendJobByMessageId(accountId, messageId)!;

    const first = recordBounce(account, job, {
      kind: 'bounce',
      originalMessageId: messageId,
      type: 'hard',
      code: '5.1.1',
      recipient: 'nobody@nowhere.test',
      diagnostic: 'smtp; 550 5.1.1 no such user',
    });
    expect(first).toBe(true);

    // The same DSN again (duplicate delivery, or a poller re-read) is a no-op.
    const second = recordBounce(account, job, {
      kind: 'bounce',
      originalMessageId: messageId,
      type: 'hard',
      code: '5.1.1',
      recipient: 'nobody@nowhere.test',
      diagnostic: 'smtp; 550 5.1.1 no such user',
    });
    expect(second).toBe(false);

    const row = sqlite
      .prepare('SELECT bounce_type, bounce_code, bounce_recipient FROM send_jobs WHERE id = ?')
      .get(jobId) as { bounce_type: string; bounce_code: string; bounce_recipient: string };
    expect(row.bounce_type).toBe('hard');
    expect(row.bounce_code).toBe('5.1.1');
    expect(row.bounce_recipient).toBe('nobody@nowhere.test');

    // Same aggregate the /stats route serves.
    const stats = sqlite
      .prepare(
        `SELECT COALESCE(SUM(j.status = 'sent'), 0) AS sent,
                COALESCE(SUM(j.bounced_at IS NOT NULL), 0) AS bounced,
                COALESCE(SUM(j.bounce_type = 'hard'), 0) AS hardBounced,
                COALESCE(SUM(j.replied_at IS NOT NULL), 0) AS replied
         FROM send_jobs j JOIN accounts a ON a.id = j.account_id
         WHERE a.org_id = 'org_default'`,
      )
      .get() as { sent: number; bounced: number; hardBounced: number; replied: number };
    expect(stats.sent).toBe(1);
    expect(stats.bounced).toBe(1);
    expect(stats.hardBounced).toBe(1);
    expect(stats.replied).toBe(0);
  });

  it('records a reply once', async () => {
    const { db, schema } = await import('../db/index.js');
    const { findSendJobByMessageId, recordReply } = await import('../inbound/correlate.js');
    const account = db.select().from(schema.accounts).get()!;
    const job = findSendJobByMessageId(accountId, messageId)!;
    expect(
      recordReply(account, job, { messageId: 'inbound-1', from: 'them@x.test', snippet: 'sure' }),
    ).toBe(true);
    // A later message in the same thread is not a second reply.
    expect(
      recordReply(account, job, { messageId: 'inbound-2', from: 'them@x.test', snippet: 'also' }),
    ).toBe(false);
  });
});

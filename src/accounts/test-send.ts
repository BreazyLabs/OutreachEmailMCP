/**
 * A plain test email from each of a set of mailboxes to one address, so a
 * person can see with their own eyes which mailboxes still deliver and where
 * the mail lands. Goes through the normal send queue, so each send shows up
 * in the send log with its result.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { buildMime } from '../api/messages-send.js';
import { enqueueSend } from '../queue/sendQueue.js';
import { logActivity } from '../observability/activity.js';

export interface TestSendResult {
  accountId: string;
  email: string;
  ok: boolean;
  jobId?: string;
  error?: string;
}

const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export function isAddress(s: string): boolean {
  return ADDRESS.test(s);
}

export async function sendTestEmails(orgId: string, accountIds: string[], to: string, now = new Date()): Promise<TestSendResult[]> {
  const address = to.trim();
  if (!isAddress(address)) throw new Error(`"${to}" is not an email address`);
  const accounts = accountIds.length
    ? db.select().from(schema.accounts).where(and(eq(schema.accounts.orgId, orgId), inArray(schema.accounts.id, accountIds))).all()
    : [];
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  const results: TestSendResult[] = [];
  for (const account of accounts) {
    if (account.status !== 'active') {
      results.push({ accountId: account.id, email: account.email, ok: false, error: account.status === 'auth_error' ? 'needs reconnecting first' : 'disabled' });
      continue;
    }
    try {
      const from = account.displayName ? `"${account.displayName.replaceAll('"', '')}" <${account.email}>` : account.email;
      const raw = await buildMime({
        from,
        to: [address],
        subject: `Test from ${account.email}`,
        text: `This is a test message from ${account.email}, sent ${stamp} UTC to check that the mailbox delivers.\n\nIf it is here, the mailbox can send. Check the spam folder too if it is not.`,
      });
      const job = enqueueSend({ accountId: account.id, source: 'api', raw, envelope: { from: account.email, to: [address] }, subject: `Test from ${account.email}` });
      logActivity({ category: 'api', action: 'test-send', status: 'ok', accountId: account.id, detail: `job=${job.id} to=${address}` });
      results.push({ accountId: account.id, email: account.email, ok: true, jobId: job.id });
    } catch (err) {
      results.push({ accountId: account.id, email: account.email, ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 200) });
    }
  }
  return results;
}

import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { db, sqlite, schema } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export type ActivityCategory =
  | 'smtp'
  | 'imap'
  | 'api'
  | 'mcp'
  | 'delivery'
  | 'poll'
  | 'webhook'
  | 'oauth';

export interface ActivityEvent {
  category: ActivityCategory;
  action: string;
  status: 'ok' | 'failed';
  orgId?: string;
  accountId?: string;
  accountEmail?: string;
  detail?: string;
  error?: string;
}

// Never let observability break the operation being observed: swallow errors,
// resolve org/email from the account when not supplied.
export function logActivity(event: ActivityEvent): void {
  try {
    let { orgId, accountEmail } = event;
    if (event.accountId && (!orgId || !accountEmail)) {
      const account = db
        .select({ orgId: schema.accounts.orgId, email: schema.accounts.email })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, event.accountId))
        .get();
      orgId = orgId ?? account?.orgId;
      accountEmail = accountEmail ?? account?.email;
    }
    db.insert(schema.activityLog)
      .values({
        id: nanoid(),
        orgId: orgId ?? 'org_default',
        accountId: event.accountId ?? null,
        accountEmail: accountEmail ?? null,
        category: event.category,
        action: event.action,
        status: event.status,
        detail: event.detail?.slice(0, 500) ?? null,
        error: event.error?.slice(0, 1000) ?? null,
        createdAt: Date.now(),
      })
      .run();
    // Mirror failures into the structured process log as well
    if (event.status === 'failed') {
      logger.warn(
        { category: event.category, action: event.action, account: accountEmail, err: event.error },
        'activity failed',
      );
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'failed to write activity log');
  }
}

export function pruneActivityLog(): number {
  const cutoff = Date.now() - config.ACTIVITY_RETENTION_DAYS * 24 * 3600_000;
  const result = sqlite.prepare(`DELETE FROM activity_log WHERE created_at < ?`).run(cutoff);
  return result.changes;
}

export function startActivityPruner(): () => void {
  const timer = setInterval(() => {
    const pruned = pruneActivityLog();
    if (pruned > 0) logger.info({ pruned }, 'pruned old activity log rows');
  }, 6 * 3600_000);
  timer.unref();
  return () => clearInterval(timer);
}

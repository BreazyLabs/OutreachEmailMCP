import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { deleteAccountSpoolFiles } from '../queue/sendQueue.js';
import { purgeAccountTasks } from '../warmup/tasks.js';

/** Disconnects a mailbox. Cascades wipe tokens, SMTP credentials, jobs, webhooks, sync state. */
export function deleteAccount(accountId: string): void {
  deleteAccountSpoolFiles(accountId);
  purgeAccountTasks(accountId);
  db.delete(schema.accounts).where(eq(schema.accounts.id, accountId)).run();
}

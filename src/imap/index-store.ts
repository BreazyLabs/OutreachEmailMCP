import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import { and, asc, eq } from 'drizzle-orm';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import { db, sqlite, schema } from '../db/index.js';
import { providerFor } from '../providers/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { Account, ImapMessage } from '../db/schema.js';

// Emits ('indexed', accountId) whenever new messages land — IMAP IDLE hooks this.
export const imapIndexEvents = new EventEmitter();

export interface EnvelopeAddress {
  name: string | null;
  address: string | null;
}

export interface CachedEnvelope {
  date: string | null;
  subject: string | null;
  from: EnvelopeAddress[];
  to: EnvelopeAddress[];
  cc: EnvelopeAddress[];
  messageId: string | null;
  inReplyTo: string | null;
}

function addresses(obj: AddressObject | AddressObject[] | undefined): EnvelopeAddress[] {
  const list = Array.isArray(obj) ? obj : obj ? [obj] : [];
  return list.flatMap((o) =>
    o.value.map((v) => ({ name: v.name || null, address: v.address ?? null })),
  );
}

export function envelopeFromParsed(parsed: ParsedMail): CachedEnvelope {
  return {
    date: parsed.date?.toISOString() ?? null,
    subject: parsed.subject ?? null,
    from: addresses(parsed.from),
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
  };
}

function nextUid(accountId: string, folder: string): number {
  const row = sqlite
    .prepare(
      `SELECT COALESCE(MAX(uid), 0) + 1 AS next FROM imap_messages WHERE account_id = ? AND folder = ?`,
    )
    .get(accountId, folder) as { next: number };
  return row.next;
}

// Idempotent: returns the new row id, or null if already indexed.
export function indexMessage(
  accountId: string,
  providerMessageId: string,
  raw: Buffer,
  parsed: ParsedMail,
  folder = 'INBOX',
  localPath: string | null = null,
): string | null {
  const existing = db
    .select({ id: schema.imapMessages.id })
    .from(schema.imapMessages)
    .where(
      and(
        eq(schema.imapMessages.accountId, accountId),
        eq(schema.imapMessages.providerMessageId, providerMessageId),
      ),
    )
    .get();
  if (existing) return null;
  const id = nanoid();
  db.insert(schema.imapMessages)
    .values({
      id,
      accountId,
      folder,
      uid: nextUid(accountId, folder),
      providerMessageId,
      internalDate: parsed.date?.getTime() ?? Date.now(),
      size: raw.length,
      envelopeJson: JSON.stringify(envelopeFromParsed(parsed)),
      localPath,
      createdAt: Date.now(),
    })
    .run();
  imapIndexEvents.emit('indexed', accountId);
  return id;
}

// One-time seed of recent INBOX messages so a freshly connected account isn't
// empty over IMAP until new mail arrives.
export async function backfillAccount(account: Account): Promise<void> {
  const state = db
    .select()
    .from(schema.syncState)
    .where(eq(schema.syncState.accountId, account.id))
    .get();
  if (state?.imapBackfilled) return;
  if (config.IMAP_BACKFILL_COUNT > 0) {
    const provider = providerFor(account.provider);
    try {
      const { messages } = await provider.listMessages(account.id, {
        limit: config.IMAP_BACKFILL_COUNT,
      });
      // Oldest first so UIDs ascend with message age
      for (const summary of [...messages].reverse()) {
        try {
          const raw = await provider.getMessageRaw(account.id, summary.id);
          const parsed = await simpleParser(raw);
          indexMessage(account.id, summary.id, raw, parsed);
        } catch (err) {
          logger.warn(
            { account: account.email, messageId: summary.id, err: String(err) },
            'imap backfill: failed to index message',
          );
        }
      }
      logger.info({ account: account.email, count: messages.length }, 'imap backfill complete');
    } catch (err) {
      logger.warn({ account: account.email, err: String(err) }, 'imap backfill failed');
      return; // retry on next SELECT
    }
  }
  db.insert(schema.syncState)
    .values({ accountId: account.id, cursor: null, imapBackfilled: 1 })
    .onConflictDoUpdate({ target: schema.syncState.accountId, set: { imapBackfilled: 1 } })
    .run();
}

export function messagesFor(accountId: string, folder = 'INBOX'): ImapMessage[] {
  return db
    .select()
    .from(schema.imapMessages)
    .where(
      and(eq(schema.imapMessages.accountId, accountId), eq(schema.imapMessages.folder, folder)),
    )
    .orderBy(asc(schema.imapMessages.uid))
    .all();
}

export type FlagName = 'Seen' | 'Answered' | 'Flagged' | 'Deleted';
const FLAG_COLUMNS: Record<FlagName, 'seen' | 'answered' | 'flagged' | 'deleted'> = {
  Seen: 'seen',
  Answered: 'answered',
  Flagged: 'flagged',
  Deleted: 'deleted',
};

export function flagsOf(msg: ImapMessage): string[] {
  const flags: string[] = [];
  if (msg.seen) flags.push('\\Seen');
  if (msg.answered) flags.push('\\Answered');
  if (msg.flagged) flags.push('\\Flagged');
  if (msg.deleted) flags.push('\\Deleted');
  return flags;
}

// mode: 'set' replaces, 'add'/'remove' adjust. Flags are proxy-local only —
// the upstream mailbox is never modified (Gmail scope is read-only).
export function applyFlags(
  messageRowId: string,
  flagNames: FlagName[],
  mode: 'set' | 'add' | 'remove',
): void {
  const updates: Record<string, number> = {};
  if (mode === 'set') {
    for (const col of Object.values(FLAG_COLUMNS)) updates[col] = 0;
  }
  for (const name of flagNames) {
    updates[FLAG_COLUMNS[name]] = mode === 'remove' ? 0 : 1;
  }
  db.update(schema.imapMessages)
    .set(updates)
    .where(eq(schema.imapMessages.id, messageRowId))
    .run();
}

// Local-only expunge: drops \Deleted rows from the index (upstream untouched).
export function expunge(accountId: string, folder = 'INBOX'): number[] {
  const doomed = db
    .select()
    .from(schema.imapMessages)
    .where(
      and(
        eq(schema.imapMessages.accountId, accountId),
        eq(schema.imapMessages.folder, folder),
        eq(schema.imapMessages.deleted, 1),
      ),
    )
    .all();
  for (const msg of doomed) {
    if (msg.localPath) fs.rmSync(msg.localPath, { force: true });
    db.delete(schema.imapMessages).where(eq(schema.imapMessages.id, msg.id)).run();
  }
  return doomed.map((m) => m.uid);
}

export function distinctFolders(accountId: string): string[] {
  const rows = sqlite
    .prepare(`SELECT DISTINCT folder FROM imap_messages WHERE account_id = ?`)
    .all(accountId) as { folder: string }[];
  const folders = new Set(['INBOX', 'Sent', ...rows.map((r) => r.folder)]);
  return [...folders];
}

export function uidValidity(account: Account): number {
  return Math.max(1, Math.floor(account.createdAt / 1000));
}

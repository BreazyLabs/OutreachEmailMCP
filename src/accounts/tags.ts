/**
 * Free-form labels on mailboxes, so a workspace can bundle them per
 * campaign, client or batch and act on the bundle. Stored as a JSON array on
 * the account; every reader goes through parseTags so a bad value is an
 * empty list, never a crash.
 */

import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

export const MAX_TAGS_PER_ACCOUNT = 25;
export const MAX_TAG_LENGTH = 32;

export function parseTags(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** Trim, collapse whitespace, drop separators; empty when nothing is left. */
export function normalizeTag(raw: string): string {
  return raw.replace(/[,;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH);
}

/** Case-insensitive de-duplication that keeps the first spelling, sorted. */
export function normalizeTags(raw: Iterable<string>): string[] {
  const seen = new Map<string, string>();
  for (const r of raw) {
    const t = normalizeTag(r);
    if (!t) continue;
    const k = t.toLowerCase();
    if (!seen.has(k)) seen.set(k, t);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b)).slice(0, MAX_TAGS_PER_ACCOUNT);
}

/** "a, b; c" → ["a", "b", "c"]. */
export function splitTagInput(input: string): string[] {
  return input.split(/[,;\n]/).map(normalizeTag).filter(Boolean);
}

export function setAccountTags(accountId: string, tags: Iterable<string>): string[] {
  const list = normalizeTags(tags);
  db.update(schema.accounts)
    .set({ tagsJson: list.length ? JSON.stringify(list) : null, updatedAt: Date.now() })
    .where(eq(schema.accounts.id, accountId))
    .run();
  return list;
}

/** Add and remove tags on many mailboxes at once; returns the new list per mailbox. */
export function editAccountTags(
  accountIds: string[],
  change: { add?: string[]; remove?: string[] },
): Record<string, string[]> {
  if (accountIds.length === 0) return {};
  const add = normalizeTags(change.add ?? []);
  const remove = new Set(normalizeTags(change.remove ?? []).map((t) => t.toLowerCase()));
  const rows = db
    .select({ id: schema.accounts.id, tagsJson: schema.accounts.tagsJson })
    .from(schema.accounts)
    .where(inArray(schema.accounts.id, accountIds))
    .all();
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    const current = parseTags(row.tagsJson).filter((t) => !remove.has(t.toLowerCase()));
    out[row.id] = setAccountTags(row.id, [...current, ...add]);
  }
  return out;
}

/** Every tag in use across a workspace, with how many mailboxes carry it. */
export function orgTagCounts(orgId: string): { tag: string; count: number }[] {
  const rows = db
    .select({ tagsJson: schema.accounts.tagsJson })
    .from(schema.accounts)
    .where(eq(schema.accounts.orgId, orgId))
    .all();
  const counts = new Map<string, { tag: string; count: number }>();
  for (const r of rows) {
    for (const t of parseTags(r.tagsJson)) {
      const k = t.toLowerCase();
      const cur = counts.get(k);
      if (cur) cur.count++;
      else counts.set(k, { tag: t, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}

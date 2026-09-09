/**
 * Warmup settings: one schema, three layers.
 *
 *   instance defaults (this file + env caps)
 *     ← org defaults      (orgs.warmup_defaults_json, partial)
 *       ← account override (warmup_accounts.settings_json, partial)
 *
 * A field that is null/absent at a layer inherits from the layer above.
 * `resolveWarmupSettings()` is the only way any loop reads configuration;
 * it returns a fully populated, validated object with hard caps applied,
 * plus a per-field record of which layer supplied the value (for the UI).
 */

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { isValidTimezone, parseHHMM } from './clock.js';
import type { Org, WarmupAccount } from '../db/schema.js';

const pct = (def: number) => z.number().int().min(0).max(100).default(def);
const hhmm = (def: string) =>
  z
    .string()
    .refine((v) => {
      try {
        parseHHMM(v);
        return true;
      } catch {
        return false;
      }
    }, 'Expected HH:MM')
    .default(def);

export const warmupSettingsSchema = z.object({
  // --- volume and ramp ---
  startVolume: z.number().int().min(1).max(10).default(3),
  increasePerDay: z.number().int().min(0).max(10).default(2),
  dailyLimit: z.number().int().min(1).max(500).default(30),
  slowStart: z.boolean().default(true),
  randomizePercent: z.number().int().min(0).max(50).default(20),
  // --- calendar ---
  timezone: z
    .string()
    .refine(isValidTimezone, 'Unknown IANA timezone')
    .default('UTC'),
  weekdaysOnly: z.boolean().default(false),
  weekendFactor: z.number().min(0).max(1).default(0.3),
  sendWindowStart: hhmm('08:00'),
  sendWindowEnd: hhmm('18:30'),
  minGapMinutes: z.number().int().min(3).max(120).default(12),
  // --- conversation shape ---
  replyRate: pct(35),
  maxThreadTurns: z.number().int().min(1).max(6).default(4),
  replyDelayMinMinutes: z.number().int().min(1).max(10080).default(20),
  replyDelayMaxMinutes: z.number().int().min(1).max(10080).default(2160),
  // Share of openers that go to a same-domain (or same-org) mailbox: the
  // "internal" threads a real company has, which then get replied to or
  // forwarded like any other.
  internalShare: pct(15),
  // Share of openers that Cc a third pool mailbox; replies on those threads
  // go to everyone ("reply all").
  ccRate: pct(10),
  // Share of received messages forwarded on to a third pool mailbox.
  forwardRate: pct(7),
  // --- client-side engagement ---
  readRate: pct(85),
  readDelayMinMinutes: z.number().int().min(1).max(1440).default(2),
  readDelayMaxMinutes: z.number().int().min(1).max(2880).default(480),
  starRate: pct(8),
  markImportantRate: pct(15),
  // Openers carrying a Disposition-Notification-To header, and how often a
  // recipient honours one with an MDN ("read receipt").
  readReceiptRequestRate: pct(10),
  readReceiptSendRate: pct(60),
  // --- placement protection ---
  spamRescueRate: pct(100),
  rescueDelayMinMinutes: z.number().int().min(0).max(1440).default(3),
  rescueDelayMaxMinutes: z.number().int().min(0).max(1440).default(40),
  fixCategory: z.boolean().default(true),
  // --- inbound protection ---
  // null = dailyLimit × 1.5
  receiveLimit: z.number().int().min(1).max(500).nullable().default(null),
  // --- content ---
  languages: z.array(z.string().min(2).max(8)).min(1).default(['en']),
  register: z.enum(['mixed', 'casual', 'business']).default('mixed'),
  // --- tidy-up in the human owner's real inbox ---
  cleanupMode: z.enum(['none', 'archive', 'label', 'trash']).default('archive'),
  cleanupAfterDays: z.number().int().min(1).max(30).default(3),
  // --- pairing ---
  allowSameDomain: z.boolean().default(true),
  allowSameOrg: z.boolean().default(true),
  preferCrossProvider: z.boolean().default(true),
  // --- adaptive throttling ---
  autoThrottle: z.boolean().default(true),
  slowAtSpamRate: pct(10),
  pauseAtSpamRate: pct(25),
  cooldownDays: z.number().int().min(1).max(14).default(2),
  // Optional combined cap on warmup + real sends per day; warmup yields.
  maxTotalPerDay: z.number().int().min(1).max(5000).nullable().default(null),
});

export type WarmupSettings = z.infer<typeof warmupSettingsSchema>;
export type WarmupSettingsPatch = Partial<WarmupSettings>;
export type SettingsLayer = 'instance' | 'org' | 'account' | 'cap';

export const WARMUP_SETTING_KEYS = Object.keys(warmupSettingsSchema.shape) as (keyof WarmupSettings)[];

/** Partial schema: every field optional, nullable (null = "inherit"). */
export const warmupSettingsPatchSchema = z
  .object(
    Object.fromEntries(
      Object.entries(warmupSettingsSchema.shape).map(([k, v]) => [
        k,
        (v as z.ZodTypeAny).nullable().optional(),
      ]),
    ) as { [K in keyof WarmupSettings]: z.ZodOptional<z.ZodNullable<z.ZodTypeAny>> },
  )
  .strict();

export const INSTANCE_DEFAULTS: WarmupSettings = warmupSettingsSchema.parse({});

/** Parse a stored partial JSON blob, dropping unknown/invalid keys rather
 *  than failing: a bad row must never stop the engine. */
export function parsePatch(json: string | null | undefined): WarmupSettingsPatch {
  if (!json) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const key of WARMUP_SETTING_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    const field = warmupSettingsSchema.shape[key] as z.ZodTypeAny;
    const parsed = field.safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as WarmupSettingsPatch;
}

/** Validate a patch coming from the API/UI: unknown keys and bad values are
 *  errors here (the user should hear about them), null means "inherit". */
export function validatePatch(input: unknown): WarmupSettingsPatch {
  const parsed = warmupSettingsPatchSchema.parse(input ?? {});
  const out: Record<string, unknown> = {};
  for (const key of WARMUP_SETTING_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (value === undefined) continue;
    out[key] = value; // null kept: it clears the override
  }
  const merged = out as Record<string, unknown>;
  if (
    typeof merged.replyDelayMinMinutes === 'number' &&
    typeof merged.replyDelayMaxMinutes === 'number' &&
    merged.replyDelayMinMinutes > merged.replyDelayMaxMinutes
  ) {
    throw new z.ZodError([
      { code: 'custom', path: ['replyDelayMaxMinutes'], message: 'must be ≥ replyDelayMinMinutes' },
    ]);
  }
  return out as WarmupSettingsPatch;
}

/**
 * A form that shows every field pre-filled with the effective value must
 * not turn every field into an override on save. Keep only what differs
 * from the layer above; fields equal to it are cleared (null) so they keep
 * inheriting.
 */
export function diffAgainstBaseline(patch: WarmupSettingsPatch, baseline: WarmupSettings): WarmupSettingsPatch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const base = (baseline as Record<string, unknown>)[key];
    const same = value !== null && JSON.stringify(value) === JSON.stringify(base);
    out[key] = same ? null : value;
  }
  return out as WarmupSettingsPatch;
}

/** Apply a validated patch to a stored blob: null removes the key. */
export function mergePatch(existingJson: string | null, patch: WarmupSettingsPatch): string {
  const current = parsePatch(existingJson) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete current[key];
    else if (value !== undefined) current[key] = value;
  }
  return JSON.stringify(current);
}

export interface ResolvedWarmupSettings {
  settings: WarmupSettings;
  /** Which layer each field's value came from. */
  sources: Record<keyof WarmupSettings, SettingsLayer>;
  /** Plan/instance ceiling on dailyLimit that was applied. */
  dailyCap: number;
}

export function planWarmupCap(org: Pick<Org, 'plan'>): number {
  const instanceCap = config.WARMUP_MAX_DAILY_PER_ACCOUNT;
  if (!config.SAAS_MODE) return instanceCap;
  const planCap = org.plan === 'pro' ? config.PLAN_PRO_WARMUP_DAILY : config.PLAN_FREE_WARMUP_DAILY;
  return Math.min(instanceCap, planCap);
}

export function resolveWarmupSettings(
  org: Pick<Org, 'plan' | 'warmupDefaultsJson'>,
  account: Pick<WarmupAccount, 'settingsJson'> | null | undefined,
): ResolvedWarmupSettings {
  const orgPatch = parsePatch(org.warmupDefaultsJson);
  const accountPatch = parsePatch(account?.settingsJson);
  const settings = { ...INSTANCE_DEFAULTS } as Record<string, unknown>;
  const sources = {} as Record<keyof WarmupSettings, SettingsLayer>;
  for (const key of WARMUP_SETTING_KEYS) {
    sources[key] = 'instance';
    if (orgPatch[key] !== undefined) {
      settings[key] = orgPatch[key];
      sources[key] = 'org';
    }
    if (accountPatch[key] !== undefined) {
      settings[key] = accountPatch[key];
      sources[key] = 'account';
    }
  }
  const resolved = settings as WarmupSettings;
  const dailyCap = planWarmupCap(org);
  if (resolved.dailyLimit > dailyCap) {
    resolved.dailyLimit = dailyCap;
    sources.dailyLimit = 'cap';
  }
  if (resolved.startVolume > resolved.dailyLimit) resolved.startVolume = resolved.dailyLimit;
  if (resolved.replyDelayMaxMinutes < resolved.replyDelayMinMinutes) {
    resolved.replyDelayMaxMinutes = resolved.replyDelayMinMinutes;
  }
  if (resolved.readDelayMaxMinutes < resolved.readDelayMinMinutes) {
    resolved.readDelayMaxMinutes = resolved.readDelayMinMinutes;
  }
  if (resolved.rescueDelayMaxMinutes < resolved.rescueDelayMinMinutes) {
    resolved.rescueDelayMaxMinutes = resolved.rescueDelayMinMinutes;
  }
  if (parseHHMM(resolved.sendWindowEnd) <= parseHHMM(resolved.sendWindowStart) + 30) {
    // A window shorter than half an hour cannot hold a day's sends.
    resolved.sendWindowStart = INSTANCE_DEFAULTS.sendWindowStart;
    resolved.sendWindowEnd = INSTANCE_DEFAULTS.sendWindowEnd;
  }
  return { settings: resolved, sources, dailyCap };
}

export function effectiveReceiveLimit(s: WarmupSettings): number {
  return s.receiveLimit ?? Math.ceil(s.dailyLimit * 1.5);
}

/** Convenience: resolve for an account id (org + warmup row looked up). */
export function resolveForAccount(accountId: string): ResolvedWarmupSettings {
  const account = db
    .select({ orgId: schema.accounts.orgId })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  const org = account
    ? db.select().from(schema.orgs).where(eq(schema.orgs.id, account.orgId)).get()
    : undefined;
  const warm = db
    .select()
    .from(schema.warmupAccounts)
    .where(eq(schema.warmupAccounts.accountId, accountId))
    .get();
  return resolveWarmupSettings(org ?? { plan: 'free', warmupDefaultsJson: null }, warm);
}

// --- UI field catalogue -----------------------------------------------------
// One list drives the org-defaults form, the per-account override form and
// the bulk-apply form, so a new setting is added in exactly two places (the
// schema above and here).

export type FieldType = 'int' | 'number' | 'bool' | 'percent' | 'time' | 'text' | 'select' | 'list';

export interface FieldSpec {
  key: keyof WarmupSettings;
  label: string;
  type: FieldType;
  group: string;
  help: string;
  /** Shown only under "Advanced": worth having, rarely worth changing. */
  advanced?: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
}

export const WARMUP_FIELDS: FieldSpec[] = [
  { key: 'startVolume', label: 'Start volume', type: 'int', group: 'Volume', min: 1, max: 10, help: 'Sends on the first day of the ramp.' },
  { key: 'increasePerDay', label: 'Increase per day', type: 'int', group: 'Volume', min: 0, max: 10, help: 'Added to the target every sending day until the daily limit.' },
  { key: 'dailyLimit', label: 'Daily limit', type: 'int', group: 'Volume', min: 1, max: 500, help: 'Steady-state warmup sends per day (capped by the instance/plan).' },
  { key: 'slowStart', label: 'Slow start', type: 'bool', group: 'Volume', help: 'Off starts at the daily limit on day one (for mailboxes already warm elsewhere).' },
  { key: 'randomizePercent', label: 'Randomize ±%', type: 'percent', group: 'Volume', min: 0, max: 50, help: 'Daily target varies by up to this much so counts never form a straight line.' },
  { key: 'maxTotalPerDay', label: 'Max total sends/day', type: 'int', group: 'Volume', min: 1, max: 5000, help: 'Optional cap on warmup + real sends combined; warmup yields to real mail.' },

  { key: 'timezone', label: 'Timezone', type: 'text', group: 'Calendar', help: 'IANA name, e.g. Europe/Amsterdam. Anchors the send window and the day boundary.' },
  { key: 'sendWindowStart', label: 'Window start', type: 'time', group: 'Calendar', help: 'Earliest local send time.' },
  { key: 'sendWindowEnd', label: 'Window end', type: 'time', group: 'Calendar', help: 'Latest local send time.' },
  { key: 'weekdaysOnly', label: 'Weekdays only', type: 'bool', group: 'Calendar', help: 'No sends on Saturday or Sunday.' },
  { key: 'weekendFactor', label: 'Weekend factor', type: 'number', group: 'Calendar', min: 0, max: 1, step: 0.05, help: 'When weekends are on, multiply the target by this.' },
  { key: 'minGapMinutes', label: 'Min gap (min)', type: 'int', group: 'Calendar', min: 3, max: 120, help: 'Minimum minutes between two sends from the same mailbox.' },

  { key: 'replyRate', label: 'Reply rate', type: 'percent', group: 'Conversation', min: 0, max: 100, help: 'Chance a received warmup message gets a reply.' },
  { key: 'maxThreadTurns', label: 'Max thread turns', type: 'int', group: 'Conversation', min: 1, max: 6, help: 'Upper bound on messages in one thread; most threads are shorter.' },
  { key: 'replyDelayMinMinutes', label: 'Reply delay min (min)', type: 'int', group: 'Conversation', min: 1, max: 10080, help: 'Fastest reply.' },
  { key: 'replyDelayMaxMinutes', label: 'Reply delay max (min)', type: 'int', group: 'Conversation', min: 1, max: 10080, help: 'Slowest reply (36 h = 2160).' },
  { key: 'internalShare', label: 'Internal threads', type: 'percent', group: 'Conversation', min: 0, max: 100, help: 'Share of openers sent to a same-domain (or same-workspace) mailbox.' },
  { key: 'ccRate', label: 'Cc a third mailbox', type: 'percent', group: 'Conversation', min: 0, max: 100, help: 'Share of openers that Cc another pool mailbox; replies go to everyone.' },
  { key: 'forwardRate', label: 'Forward rate', type: 'percent', group: 'Conversation', min: 0, max: 100, help: 'Share of received messages forwarded on to a third pool mailbox.' },

  { key: 'readRate', label: 'Read rate', type: 'percent', group: 'Engagement', min: 0, max: 100, help: 'Chance a received message is marked read (open rate).' },
  { key: 'readDelayMinMinutes', label: 'Read delay min (min)', type: 'int', group: 'Engagement', min: 1, max: 1440, help: '' },
  { key: 'readDelayMaxMinutes', label: 'Read delay max (min)', type: 'int', group: 'Engagement', min: 1, max: 2880, help: '' },
  { key: 'starRate', label: 'Star rate', type: 'percent', group: 'Engagement', min: 0, max: 100, help: 'Chance of starring/flagging.' },
  { key: 'markImportantRate', label: 'Mark important', type: 'percent', group: 'Engagement', min: 0, max: 100, help: 'Gmail: IMPORTANT label. Microsoft: high importance.' },
  { key: 'readReceiptRequestRate', label: 'Request read receipts', type: 'percent', group: 'Engagement', min: 0, max: 100, help: 'Share of openers asking for a read receipt.' },
  { key: 'readReceiptSendRate', label: 'Send read receipts', type: 'percent', group: 'Engagement', min: 0, max: 100, help: 'How often a receipt request is honoured with an MDN.' },

  { key: 'spamRescueRate', label: 'Spam protection', type: 'percent', group: 'Placement', min: 0, max: 100, help: 'Chance a message found in Spam is moved to the inbox and marked not-spam.' },
  { key: 'rescueDelayMinMinutes', label: 'Rescue delay min (min)', type: 'int', group: 'Placement', min: 0, max: 1440, help: '' },
  { key: 'rescueDelayMaxMinutes', label: 'Rescue delay max (min)', type: 'int', group: 'Placement', min: 0, max: 1440, help: '' },
  { key: 'fixCategory', label: 'Fix category', type: 'bool', group: 'Placement', help: 'Gmail Promotions/Updates → Primary; Outlook Other → Focused.' },
  { key: 'receiveLimit', label: 'Receive limit/day', type: 'int', group: 'Placement', min: 1, max: 500, help: 'Max warmup mail this mailbox receives per day (blank = 1.5 × daily limit).' },

  { key: 'languages', label: 'Languages', type: 'list', group: 'Content', help: 'Comma-separated ISO codes; a pair talks in a language both list.' },
  { key: 'register', label: 'Register', type: 'select', group: 'Content', help: '', options: [{ value: 'mixed', label: 'Mixed' }, { value: 'casual', label: 'Casual' }, { value: 'business', label: 'Business' }] },
  { key: 'cleanupMode', label: 'Cleanup', type: 'select', group: 'Content', help: 'What happens to warmup mail in the owner\'s real inbox after engagement.', options: [{ value: 'none', label: 'Leave in inbox' }, { value: 'archive', label: 'Archive' }, { value: 'label', label: 'Move to "Warmup" label/folder' }, { value: 'trash', label: 'Trash' }] },
  { key: 'cleanupAfterDays', label: 'Cleanup after (days)', type: 'int', group: 'Content', min: 1, max: 30, help: '' },

  { key: 'allowSameDomain', label: 'Allow same domain', type: 'bool', group: 'Pairing', help: 'Needed for internal threads.' },
  { key: 'allowSameOrg', label: 'Allow same workspace', type: 'bool', group: 'Pairing', help: '' },
  { key: 'preferCrossProvider', label: 'Prefer cross-provider', type: 'bool', group: 'Pairing', help: 'Weight Gmail↔Microsoft pairs up.' },

  { key: 'autoThrottle', label: 'Auto-throttle', type: 'bool', group: 'Protection', help: 'Let the engine slow or pause the ramp when placement degrades.' },
  { key: 'slowAtSpamRate', label: 'Slow at spam rate', type: 'percent', group: 'Protection', min: 0, max: 100, help: '7-day spam+missing rate that holds the ramp and halves volume.' },
  { key: 'pauseAtSpamRate', label: 'Pause at spam rate', type: 'percent', group: 'Protection', min: 0, max: 100, help: 'Rate that auto-pauses the mailbox.' },
  { key: 'cooldownDays', label: 'Cooldown (days)', type: 'int', group: 'Protection', min: 1, max: 14, help: 'How long an auto-pause lasts.' },
];

// The handful of settings people actually tune: how much, when, in what
// language, how chatty. Everything else is a good default under Advanced.
const PRIMARY: Set<keyof WarmupSettings> = new Set([
  'startVolume', 'increasePerDay', 'dailyLimit', 'weekdaysOnly', 'timezone',
  'sendWindowStart', 'sendWindowEnd', 'replyRate', 'languages',
]);
for (const f of WARMUP_FIELDS) if (!PRIMARY.has(f.key)) f.advanced = true;

/** Coerce a flat form submission (strings) into a validated patch. Empty
 *  string = leave unchanged (undefined); the literal "__inherit" = clear the
 *  override (null). */
export function patchFromForm(body: Record<string, unknown>): WarmupSettingsPatch {
  const out: Record<string, unknown> = {};
  for (const field of WARMUP_FIELDS) {
    const raw = body[field.key];
    if (raw === undefined) continue;
    const value = Array.isArray(raw) ? String(raw[raw.length - 1] ?? '') : String(raw);
    if (value === '') continue;
    if (value === '__inherit') {
      out[field.key] = null;
      continue;
    }
    switch (field.type) {
      case 'int':
      case 'percent':
        out[field.key] = Number.parseInt(value, 10);
        break;
      case 'number':
        out[field.key] = Number(value);
        break;
      case 'bool':
        out[field.key] = value === 'true' || value === 'on' || value === '1';
        break;
      case 'list':
        out[field.key] = value
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        break;
      default:
        out[field.key] = value;
    }
  }
  return validatePatch(out);
}

/**
 * The script pool: generated conversations kept ahead of demand, picked by
 * language and register, varied at send time, retired after enough use.
 */

import { nanoid } from 'nanoid';
import { and, eq, sql } from 'drizzle-orm';
import { db, sqlite, schema } from '../../db/index.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { logActivity } from '../../observability/activity.js';
import { generateScripts, llmAvailable } from './llm.js';
import {
  TEMPLATE_SCRIPTS,
  ACK_PHRASES,
  FORWARD_NOTES,
  FORWARD_REPLIES,
  GREETINGS,
  SIGN_OFFS,
  localized,
} from './templates.js';
import type { Rng } from '../rng.js';
import type { WarmupScript } from '../../db/schema.js';
import type { Persona } from './persona.js';

/**
 * Spintax: "{quick|short|brief} question" → one alternative per render, chosen
 * by the seeded rng so a retry produces the same text. Scripts without
 * spintax get a light rotation of common phrases instead.
 */
export function spin(text: string, rng: Rng): string {
  const spun = text.replace(/\{([^{}]*\|[^{}]*)\}/g, (_m, inner: string) => {
    const options = inner.split('|').map((o) => o.trim());
    return rng.pick(options) ?? options[0] ?? '';
  });
  if (spun !== text) return spun;
  return rotatePhrases(spun, rng);
}

const ROTATIONS: [RegExp, string[]][] = [
  [/\bquick\b/gi, ['quick', 'short', 'brief']],
  [/\bthanks\b/gi, ['thanks', 'thank you', 'many thanks']],
  [/\blet me know\b/gi, ['let me know', 'tell me', 'give me a shout']],
  [/\bno rush\b/gi, ['no rush', 'no hurry', 'whenever suits']],
  [/\bsounds good\b/gi, ['sounds good', 'works for me', 'fine by me']],
  [/\bnext week\b/gi, ['next week', 'early next week', 'in the coming week']],
  [/\bthis week\b/gi, ['this week', 'later this week', 'in the next few days']],
  [/\bhappy to\b/gi, ['happy to', 'glad to', 'more than happy to']],
  [/\bI think\b/g, ['I think', 'I believe', 'I suspect']],
  [/\bmakes sense\b/gi, ['makes sense', 'seems sensible', 'sounds right']],
  [/\bgreat\b/gi, ['great', 'good', 'excellent']],
  [/\bcatch up\b/gi, ['catch up', 'touch base', 'have a chat']],
];

function rotatePhrases(text: string, rng: Rng): string {
  let out = text;
  for (const [re, options] of ROTATIONS) {
    out = out.replace(re, (m) => {
      if (!rng.chance(55)) return m;
      const pick = rng.pick(options) ?? m;
      return m.charAt(0) === m.charAt(0).toUpperCase() && m.charAt(0) !== m.charAt(0).toLowerCase()
        ? pick.charAt(0).toUpperCase() + pick.slice(1)
        : pick;
    });
  }
  return out;
}

/** Seed the bundled templates once so picking is one code path. */
export function seedTemplateScripts(): number {
  const existing = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM warmup_scripts WHERE source = 'template'`)
    .get() as { n: number };
  if (existing.n >= TEMPLATE_SCRIPTS.length) return 0;
  const known = new Set(
    (
      sqlite
        .prepare(`SELECT subject, language FROM warmup_scripts WHERE source = 'template'`)
        .all() as { subject: string; language: string }[]
    ).map((r) => `${r.language}:${r.subject}`),
  );
  let inserted = 0;
  const now = Date.now();
  for (const t of TEMPLATE_SCRIPTS) {
    if (known.has(`${t.language}:${t.subject}`)) continue;
    db.insert(schema.warmupScripts)
      .values({
        id: nanoid(),
        language: t.language,
        register: t.register,
        topic: t.topic,
        subject: t.subject,
        turnsJson: JSON.stringify(t.turns),
        source: 'template',
        createdAt: now,
      })
      .run();
    inserted++;
  }
  return inserted;
}

export function unusedScriptCount(language: string): number {
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM warmup_scripts
       WHERE language = ? AND retired = 0 AND used_count = 0 AND source = 'llm'`,
    )
    .get(language) as { n: number };
  return row.n;
}

/** Languages any opted-in mailbox lists, so the supplier knows what to stock. */
export function languagesInUse(): string[] {
  const rows = sqlite
    .prepare(
      `SELECT w.settings_json AS s, o.warmup_defaults_json AS d
       FROM warmup_accounts w JOIN accounts a ON a.id = w.account_id
       JOIN orgs o ON o.id = a.org_id WHERE w.enabled = 1`,
    )
    .all() as { s: string | null; d: string | null }[];
  const langs = new Set<string>();
  for (const r of rows) {
    for (const json of [r.s, r.d]) {
      if (!json) continue;
      try {
        const parsed = JSON.parse(json) as { languages?: string[] };
        for (const l of parsed.languages ?? []) langs.add(l);
      } catch {
        // ignore
      }
    }
  }
  if (langs.size === 0) langs.add('en');
  return [...langs];
}

/** Keep every in-use language stocked. Called on a timer; cheap when full. */
export async function replenishScripts(): Promise<void> {
  if (!llmAvailable()) return;
  for (const language of languagesInUse()) {
    if (unusedScriptCount(language) >= config.WARMUP_SCRIPT_POOL_MIN) continue;
    try {
      const scripts = await generateScripts(language, 'mixed', 12);
      const now = Date.now();
      for (const s of scripts) {
        db.insert(schema.warmupScripts)
          .values({
            id: nanoid(),
            language: s.language,
            register: s.register,
            topic: s.topic,
            subject: s.subject,
            turnsJson: JSON.stringify(s.turns),
            source: 'llm',
            createdAt: now,
          })
          .run();
      }
      logActivity({
        category: 'warmup',
        action: 'scripts-generated',
        status: 'ok',
        detail: `${scripts.length} ${language} scripts added to the pool`,
      });
    } catch (err) {
      logger.warn({ language, err: String(err) }, 'warmup script generation failed');
      return; // breaker/budget handled inside; do not hammer other languages
    }
    if (!llmAvailable()) return;
  }
}

export interface PickedScript {
  script: WarmupScript;
  turns: string[];
}

/**
 * Pick a script for a conversation. About WARMUP_SCRIPT_REUSE_PERCENT of the
 * time an already-used script is reused (its rotating words re-roll at
 * render time); otherwise the freshest unused one, LLM-sourced first.
 * `exclude` lets a pair avoid a script it already used together.
 */
export function pickScript(
  language: string,
  register: 'mixed' | 'casual' | 'business',
  rng: Rng,
  exclude: Set<string> = new Set(),
): PickedScript | null {
  const registerClause = register === 'mixed' ? '' : `AND register = '${register}'`;
  const all = (
    sqlite
      .prepare(
        `SELECT * FROM warmup_scripts WHERE language = ? AND retired = 0 ${registerClause}
         ORDER BY CASE source WHEN 'llm' THEN 0 ELSE 1 END, used_count ASC, created_at ASC`,
      )
      .all(language) as Record<string, unknown>[]
  ).map(rowToScript);
  // A script that already opened its share of conversations today is out,
  // whatever its lifetime use count: repetition on the same day is what a
  // receiver notices.
  const dayStart = Date.now() - 24 * 3600_000;
  const usedToday = new Map(
    (
      sqlite
        .prepare(`SELECT script_id, COUNT(*) AS n FROM warmup_threads WHERE created_at > ? AND script_id IS NOT NULL GROUP BY script_id`)
        .all(dayStart) as { script_id: string; n: number }[]
    ).map((r) => [r.script_id, r.n]),
  );
  const candidates = all.filter(
    (s) => !exclude.has(s.id) && (usedToday.get(s.id) ?? 0) < config.WARMUP_SCRIPT_MAX_USES_PER_DAY,
  );
  const pool = candidates.length > 0 ? candidates : all.filter((s) => !exclude.has(s.id));
  if (pool.length === 0) {
    if (language !== 'en') return pickScript('en', register, rng, exclude);
    return null;
  }
  const used = pool.filter((s) => s.usedCount > 0);
  const fresh = pool.filter((s) => s.usedCount === 0);
  const reuse = used.length > 0 && (fresh.length === 0 || rng.chance(config.WARMUP_SCRIPT_REUSE_PERCENT));
  // Reuse: weight toward the less-worn scripts so use spreads evenly. Fresh:
  // randomise among the first few so two mailboxes planning at the same
  // moment do not both pick the very same script.
  const script = reuse
    ? rng.weighted(used, (s) => 1 / (1 + s.usedCount))!
    : rng.pick(fresh.slice(0, Math.min(8, fresh.length)))!;
  return { script, turns: JSON.parse(script.turnsJson) as string[] };
}

export function markScriptUsed(scriptId: string): void {
  sqlite
    .prepare(
      `UPDATE warmup_scripts SET used_count = used_count + 1,
         retired = CASE WHEN used_count + 1 >= ? AND source = 'llm' THEN 1 ELSE retired END
       WHERE id = ?`,
    )
    .run(config.WARMUP_SCRIPT_MAX_USES, scriptId);
}

export function scriptById(id: string): WarmupScript | undefined {
  return db.select().from(schema.warmupScripts).where(eq(schema.warmupScripts.id, id)).get();
}

function rowToScript(r: Record<string, unknown>): WarmupScript {
  return {
    id: r.id,
    language: r.language,
    register: r.register,
    topic: r.topic,
    subject: r.subject,
    turnsJson: r.turns_json,
    source: r.source,
    usedCount: r.used_count,
    retired: r.retired,
    createdAt: r.created_at,
  } as WarmupScript;
}

// --- rendering ---------------------------------------------------------------

export interface RenderedBody {
  text: string;
  html: string | null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toHtml(paragraphs: string[]): string {
  return paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

/** Turn a script turn into a message body: greeting, text, sign-off,
 *  varied per message but deterministically for the given rng. */
export function renderTurn(
  body: string,
  language: string,
  from: Persona,
  to: Persona | null,
  rng: Rng,
  opts: { includeHtml?: boolean; tag: string | null; lowercaseOpener?: boolean } = { tag: null },
): RenderedBody {
  const greetings = localized(GREETINGS, language);
  const signOffs = localized(SIGN_OFFS, language);
  const greeting = rng
    .pick(greetings)!
    .replace('{name}', to?.firstName ?? '')
    .replace(/\s+,/, ',')
    .trim();
  const signOff = from.signOff && rng.chance(60) ? `${from.signOff},` : rng.pick(signOffs)!;
  let main = spin(body.trim(), rng);
  if (opts.lowercaseOpener && rng.chance(12)) {
    main = main.charAt(0).toLowerCase() + main.slice(1);
  }
  const paragraphs = main.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const signature = rng.chance(70) ? from.firstName : `${from.firstName}${from.company ? `\n${from.company}` : ''}`;
  const blocks = [greeting, ...paragraphs, `${signOff}\n${signature}`];
  const textParts = [...blocks];
  if (opts.tag) textParts.push(opts.tag);
  // Real mail has slightly irregular whitespace.
  const text = textParts.join(rng.chance(85) ? '\n\n' : '\n\n\n');
  let html: string | null = null;
  if (opts.includeHtml) {
    const tagHtml = opts.tag
      ? `<p style="color:#888888;font-size:11px">${escapeHtml(opts.tag)}</p>`
      : '';
    html = `<div>${toHtml(blocks)}${tagHtml}</div>`;
  }
  return { text, html };
}

export function ackPhrase(language: string, rng: Rng): string {
  return spin(rng.pick(localized(ACK_PHRASES, language))!, rng);
}

export function forwardNote(language: string, rng: Rng): string {
  return spin(rng.pick(localized(FORWARD_NOTES, language))!, rng);
}

export function forwardReply(language: string, rng: Rng): string {
  return spin(rng.pick(localized(FORWARD_REPLIES, language))!, rng);
}

/** The subject a thread is opened with: spun once, then fixed for the thread. */
export function spinSubject(subject: string, rng: Rng): string {
  return spin(subject, rng);
}

/** Share of recent warmup messages written from LLM scripts, for the UI. */
export function contentSourceMix(days = 7): { llm: number; template: number; other: number } {
  const since = Date.now() - days * 24 * 3600_000;
  const rows = db
    .select({
      source: schema.warmupMessages.contentSource,
      n: sql<number>`count(*)`,
    })
    .from(schema.warmupMessages)
    .where(and(sql`${schema.warmupMessages.createdAt} > ${since}`, eq(schema.warmupMessages.kind, 'open')))
    .groupBy(schema.warmupMessages.contentSource)
    .all();
  const mix = { llm: 0, template: 0, other: 0 };
  for (const r of rows) {
    if (r.source === 'llm') mix.llm += r.n;
    else if (r.source === 'template') mix.template += r.n;
    else mix.other += r.n;
  }
  return mix;
}

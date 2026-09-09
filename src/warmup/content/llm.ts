/**
 * OpenAI-compatible chat-completions client for generating conversation
 * scripts, wrapped in a circuit breaker and a daily call budget. A dead or
 * expensive API degrades to the template corpus; it never blocks a send.
 */

import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { logActivity } from '../../observability/activity.js';

export interface GeneratedScript {
  language: string;
  register: 'casual' | 'business';
  topic: string;
  subject: string;
  turns: string[];
}

interface Breaker {
  failures: number;
  openUntil: number;
}

const breaker: Breaker = { failures: 0, openUntil: 0 };
const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 15 * 60_000;

let budgetDay = '';
let budgetUsed = 0;

export function llmConfigured(): boolean {
  return Boolean(config.WARMUP_LLM_BASE_URL && config.WARMUP_LLM_API_KEY);
}

export function llmStatus(): {
  configured: boolean;
  breakerOpen: boolean;
  openUntil: number | null;
  callsToday: number;
  budget: number;
} {
  rollBudget();
  return {
    configured: llmConfigured(),
    breakerOpen: breaker.openUntil > Date.now(),
    openUntil: breaker.openUntil > Date.now() ? breaker.openUntil : null,
    callsToday: budgetUsed,
    budget: config.WARMUP_LLM_DAILY_CALL_BUDGET,
  };
}

function rollBudget(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDay) {
    budgetDay = today;
    budgetUsed = 0;
  }
}

export function llmAvailable(): boolean {
  if (!llmConfigured()) return false;
  if (breaker.openUntil > Date.now()) return false;
  rollBudget();
  return budgetUsed < config.WARMUP_LLM_DAILY_CALL_BUDGET;
}

const SYSTEM_PROMPT = `You write short, ordinary email conversations between two professionals who know each other slightly: colleagues, a client and a supplier, two people who met at an event. The conversations are used as realistic filler traffic and must read like real mail a person would send.

Rules:
- Each script has a subject and 1 to 4 turns; each turn is one message. The first turn is 25 to 100 words of plain prose in 1 to 3 short paragraphs; later turns may be shorter, down to a single line, the way real threads tail off.
- Turns alternate between the two people. No greeting line and no sign-off; those are added later.
- Each script is reused several times, so mark 3 to 6 places per turn where a word or short phrase can rotate, using spintax: {quick|short|brief}, {let me know|tell me|give me a shout}. Alternatives must all fit the sentence. Subjects may carry one spintax group too.
- No links, URLs, email addresses, phone numbers, prices, product names, company names, or placeholders like [Name].
- No sales language, no offers, no "reaching out", no exclamation marks beyond one per script.
- Vary the topics: scheduling, follow-ups, small questions, thanks, feedback, logistics, out-of-office notes, casual catch-ups, recommendations, weekend plans.
- Subjects are 2 to 6 words and never clickbait.
- Write in the requested language and register.
Return JSON with exactly one key, "scripts", holding an array of OBJECTS (never arrays) shaped exactly like this example:
{"scripts":[{"language":"en","register":"business","topic":"scheduling","subject":"Moving our {call|chat}","turns":["Something came up on Thursday and I need to {move|shift|push} our call. Would the same time on Friday work, or {early next week|Monday} if that is easier for you?","Friday is fine. Same time, same link. If anything changes on my side I will {let you know|tell you} by Thursday evening."]}]}`;

// Spintax groups {a|b|c} are allowed; any other braces are a placeholder.
const BANNED = /(https?:\/\/|www\.|@[\w-]+\.\w|\+?\d[\d\s().-]{6,}\d|\[[^\]]+\]|\{[^{}|]*\}|unsubscribe|limited time|special offer|free trial|book a (call|demo)|reaching out|click here|\$\d|€\d|£\d)/i;

function spintaxBalanced(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth < 0 || depth > 1) return false;
  }
  return depth === 0;
}

/** Small models drift on the output shape: a script may come back as a flat
 *  array [language, register, topic, subject, ...turns], and a spintax group
 *  may be closed with "]" instead of "}". Repair what is unambiguous. */
function normalizeScript(item: unknown): unknown {
  if (Array.isArray(item) && item.length >= 5 && item.every((x) => typeof x === 'string')) {
    const [language, register, topic, subject, ...turns] = item as string[];
    return { language, register, topic, subject, turns };
  }
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const o = item as Record<string, unknown>;
    const fix = (t: unknown) => (typeof t === 'string' ? t.replace(/\{([^{}[\]]*\|[^{}[\]]*)\]/g, '{$1}') : t);
    return { ...o, subject: fix(o.subject), turns: Array.isArray(o.turns) ? o.turns.map(fix) : o.turns };
  }
  return item;
}

/** Pull the complete top-level-array objects out of a truncated JSON text
 *  by brace matching (string-aware). The trailing partial object is dropped. */
export function salvageObjects(text: string): unknown[] {
  const out: unknown[] = [];
  const stack: string[] = [];
  let start = -1;
  let startDepth = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') {
      // An object that sits directly inside an array is a candidate item.
      if (ch === '{' && stack[stack.length - 1] === '[' && start < 0) {
        start = i;
        startDepth = stack.length + 1;
      }
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      if (start >= 0 && ch === '}' && stack.length === startDepth) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // malformed item — skip
        }
        start = -1;
      }
      stack.pop();
    }
  }
  return out;
}

/** Models occasionally return the list under a different key ("scripts2",
 *  "emails") or as a bare array: take every array of script-like items. */
function collectScripts(parsed: unknown): unknown[] {
  const items: unknown[] = [];
  if (Array.isArray(parsed)) items.push(...parsed);
  else if (parsed && typeof parsed === 'object') {
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) items.push(...v);
    }
  }
  return items.map(normalizeScript);
}

export function validateScript(raw: unknown, language: string): GeneratedScript | null {
  const r = checkScript(raw, language);
  return 'script' in r ? r.script : null;
}

/** Why a model output was rejected, so a bad prompt/model pairing is
 *  diagnosable from the log instead of showing up as "accepted 0". */
export function checkScript(raw: unknown, language: string): { script: GeneratedScript } | { reason: string } {
  if (!raw || typeof raw !== 'object') return { reason: 'not an object' };
  const s = raw as Partial<GeneratedScript>;
  if (typeof s.subject !== 'string' || !Array.isArray(s.turns)) return { reason: 'missing subject/turns' };
  const subject = s.subject.trim();
  if (subject.length < 3 || subject.length > 70) return { reason: `subject length ${subject.length}` };
  if (BANNED.test(subject)) return { reason: `subject banned content: ${subject}` };
  if (/^(re|fwd?):/i.test(subject)) return { reason: 'subject starts with Re/Fwd' };
  const turns = s.turns.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean);
  if (turns.length < 1 || turns.length > 5) return { reason: `${turns.length} turns` };
  let exclamations = 0;
  // An opener has to carry the conversation; later turns are often a line
  // ("Sounds good, see you then."), which is exactly how real threads end.
  for (const [i, t] of turns.entries()) {
    if (!spintaxBalanced(t)) return { reason: 'unbalanced braces' };
    const words = t.replace(/\{[^{}]*\}/g, 'x').split(/\s+/).length;
    const min = i === 0 ? 15 : 4;
    if (words < min || words > 130) return { reason: `turn ${i + 1} of ${words} words` };
    const banned = BANNED.exec(t);
    if (banned) return { reason: `banned content "${banned[0]}"` };
    exclamations += (t.match(/!/g) ?? []).length;
  }
  if (exclamations > 1) return { reason: `${exclamations} exclamation marks` };
  const register = s.register === 'casual' || s.register === 'business' ? s.register : 'business';
  return {
    script: {
      language,
      register,
      topic: typeof s.topic === 'string' ? s.topic.slice(0, 60) : 'general',
      subject,
      turns,
    },
  };
}

/** One batch request. Returns validated scripts; throws on transport or
 *  parse failure (the caller feeds the breaker). */
export async function generateScripts(
  language: string,
  register: 'casual' | 'business' | 'mixed',
  count = 20,
): Promise<GeneratedScript[]> {
  if (!llmAvailable()) throw new Error('LLM unavailable (not configured, breaker open, or budget spent)');
  rollBudget();
  budgetUsed++;
  const registerText =
    register === 'mixed' ? 'a mix of casual and business registers' : `the ${register} register`;
  const body = {
    model: config.WARMUP_LLM_MODEL,
    temperature: 0.95,
    // ~200 tokens per script plus spintax; an explicit ceiling because some
    // gateways default to 1–2k and truncate the JSON mid-string.
    max_tokens: Math.min(8000, 400 * count + 500),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Write ${count} distinct scripts in language "${language}" using ${registerText}. Make the topics and thread lengths varied.`,
      },
    ],
  };
  const url = `${config.WARMUP_LLM_BASE_URL!.replace(/\/$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.WARMUP_LLM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`LLM HTTP ${res.status} ${text}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned no content');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Fenced JSON despite json mode, or output cut off by a token limit:
      // keep every complete script object that made it through.
      const m = /\{[\s\S]*\}/.exec(content);
      try {
        parsed = m ? JSON.parse(m[0]) : null;
      } catch {
        parsed = salvageObjects(content);
        logger.warn({ language, salvaged: (parsed as unknown[]).length }, 'warmup script JSON was truncated; salvaged complete objects');
      }
    }
    const checked = collectScripts(parsed).map((s) => checkScript(s, language));
    const scripts = checked.flatMap((c) => ('script' in c ? [c.script] : []));
    const reasons = checked.flatMap((c) => ('reason' in c ? [c.reason] : []));
    breaker.failures = 0;
    logger.info(
      { language, requested: count, accepted: scripts.length, rejected: reasons.length, reasons: reasons.slice(0, 5) },
      'warmup scripts generated',
    );
    if (scripts.length === 0 && reasons.length > 0) {
      logActivity({
        category: 'warmup',
        action: 'scripts-rejected',
        status: 'failed',
        error: `Model returned ${reasons.length} scripts, none usable: ${reasons.slice(0, 3).join('; ')}`.slice(0, 900),
      });
    }
    return scripts;
  } catch (err) {
    breaker.failures++;
    if (breaker.failures >= BREAKER_THRESHOLD && breaker.openUntil <= Date.now()) {
      breaker.openUntil = Date.now() + BREAKER_OPEN_MS;
      logActivity({
        category: 'warmup',
        action: 'llm-breaker-open',
        status: 'failed',
        error: `${breaker.failures} consecutive failures; using templates for 15 minutes. Last: ${String(err)}`,
      });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

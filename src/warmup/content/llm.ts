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
- Each script has a subject and 1 to 4 turns; each turn is one message, 25 to 100 words, plain prose in 1 to 3 short paragraphs.
- Turns alternate between the two people. No greeting line and no sign-off; those are added later.
- No links, URLs, email addresses, phone numbers, prices, product names, company names, or placeholders like [Name].
- No sales language, no offers, no "reaching out", no exclamation marks beyond one per script.
- Vary the topics: scheduling, follow-ups, small questions, thanks, feedback, logistics, out-of-office notes, casual catch-ups, recommendations, weekend plans.
- Subjects are 2 to 6 words and never clickbait.
- Write in the requested language and register.
Return JSON: {"scripts":[{"language":"en","register":"business","topic":"...","subject":"...","turns":["...","..."]}]}`;

const BANNED = /(https?:\/\/|www\.|@[\w-]+\.\w|\+?\d[\d\s().-]{6,}\d|\[[^\]]+\]|\{[^}]+\}|unsubscribe|limited time|special offer|free trial|book a (call|demo)|reaching out|click here|\$\d|€\d|£\d)/i;

export function validateScript(raw: unknown, language: string): GeneratedScript | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<GeneratedScript>;
  if (typeof s.subject !== 'string' || !Array.isArray(s.turns)) return null;
  const subject = s.subject.trim();
  if (subject.length < 3 || subject.length > 70 || BANNED.test(subject)) return null;
  if (/^(re|fwd?):/i.test(subject)) return null;
  const turns = s.turns.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean);
  if (turns.length < 1 || turns.length > 5) return null;
  let exclamations = 0;
  for (const t of turns) {
    const words = t.split(/\s+/).length;
    if (words < 12 || words > 130) return null;
    if (BANNED.test(t)) return null;
    exclamations += (t.match(/!/g) ?? []).length;
  }
  if (exclamations > 1) return null;
  const register = s.register === 'casual' || s.register === 'business' ? s.register : 'business';
  return {
    language,
    register,
    topic: typeof s.topic === 'string' ? s.topic.slice(0, 60) : 'general',
    subject,
    turns,
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
      // Some models wrap JSON in fences despite json mode.
      const m = /\{[\s\S]*\}/.exec(content);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    const list = Array.isArray((parsed as { scripts?: unknown })?.scripts)
      ? ((parsed as { scripts: unknown[] }).scripts)
      : Array.isArray(parsed)
        ? (parsed as unknown[])
        : [];
    const scripts = list
      .map((s) => validateScript(s, language))
      .filter((s): s is GeneratedScript => s !== null);
    breaker.failures = 0;
    logger.info({ language, requested: count, accepted: scripts.length }, 'warmup scripts generated');
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

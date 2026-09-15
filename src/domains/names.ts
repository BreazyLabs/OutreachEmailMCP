/**
 * Domain name suggestions for a cold-email batch: a brand word wrapped in
 * the prefixes and suffixes that read as a real company (getbreazy.nl,
 * breazygrowth.nl), never the bare brand itself. The caller checks what is
 * free; this only proposes.
 */

export const PREFIXES = ['get', 'try', 'go', 'hello', 'meet', 'use', 'with', 'join', 'my', 'team'];
export const SUFFIXES = [
  'growth', 'sales', 'business', 'solutions', 'systems', 'tech', 'group', 'partners', 'works',
  'services', 'hq', 'labs', 'digital', 'online', 'app', 'now', 'pro', 'consulting', 'agency', 'studio',
];
export const DEFAULT_TLDS = ['com', 'nl', 'co', 'io', 'net'];

export function normalizeBrand(raw: string): string {
  return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[./\s]/)[0]!.replace(/[^a-z0-9-]/g, '');
}

export interface Suggestion {
  domain: string;
  sld: string;
  tld: string;
  /** How the name was formed, for the UI. */
  shape: 'prefix' | 'suffix' | 'both';
}

export function suggestDomains(
  brand: string,
  opts: { tlds?: string[]; max?: number; prefixes?: string[]; suffixes?: string[]; exclude?: Iterable<string> } = {},
): Suggestion[] {
  const b = normalizeBrand(brand);
  if (!b) return [];
  const tlds = (opts.tlds?.length ? opts.tlds : DEFAULT_TLDS).map((t) => t.replace(/^\./, '').toLowerCase());
  const prefixes = opts.prefixes ?? PREFIXES;
  const suffixes = opts.suffixes ?? SUFFIXES;
  const exclude = new Set([...(opts.exclude ?? [])].map((d) => d.toLowerCase()));
  const slds: { sld: string; shape: Suggestion['shape'] }[] = [];
  for (const s of suffixes) slds.push({ sld: b + s, shape: 'suffix' });
  for (const p of prefixes) slds.push({ sld: p + b, shape: 'prefix' });
  for (const p of prefixes.slice(0, 3)) for (const s of suffixes.slice(0, 4)) slds.push({ sld: p + b + s, shape: 'both' });
  const out: Suggestion[] = [];
  // Interleave TLDs so the first page is not all .com.
  for (const { sld, shape } of slds) {
    if (sld.length > 40) continue;
    for (const tld of tlds) {
      const domain = `${sld}.${tld}`;
      if (exclude.has(domain)) continue;
      out.push({ domain, sld, tld, shape });
    }
  }
  return out.slice(0, opts.max ?? 60);
}

/** "a.com, b.nl\nc.co" → ["a.com", "b.nl", "c.co"] */
export function parseDomainList(input: string): string[] {
  return [...new Set(input.split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)))];
}

export function splitDomain(domain: string): { sld: string; tld: string } {
  const i = domain.indexOf('.');
  return { sld: domain.slice(0, i), tld: domain.slice(i + 1) };
}

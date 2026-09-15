/**
 * Address patterns: how a persona's name becomes the local part of the
 * mailbox. Premium Inboxes takes the literal local parts ("dave",
 * "dave.spies"), so a pattern is rendered per persona before it is sent.
 */

export const ADDRESS_PATTERNS = [
  { key: 'first', label: 'first', example: 'dave@' },
  { key: 'first.last', label: 'first.last', example: 'dave.spies@' },
  { key: 'first.l', label: 'first.l', example: 'dave.s@' },
  { key: 'f.last', label: 'f.last', example: 'd.spies@' },
  { key: 'firstlast', label: 'firstlast', example: 'davespies@' },
  { key: 'flast', label: 'flast', example: 'dspies@' },
  { key: 'last', label: 'last', example: 'spies@' },
] as const;

export type PatternKey = (typeof ADDRESS_PATTERNS)[number]['key'];

const clean = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

/** "dave.spies" for ("first.last", "Dave", "Spies"); empty when the name lacks what the pattern needs. */
export function renderPattern(key: string, firstName: string, lastName: string): string {
  const f = clean(firstName);
  const l = clean(lastName);
  switch (key) {
    case 'first': return f;
    case 'first.last': return f && l ? `${f}.${l}` : '';
    case 'first.l': return f && l ? `${f}.${l[0]}` : '';
    case 'f.last': return f && l ? `${f[0]}.${l}` : '';
    case 'firstlast': return f && l ? `${f}${l}` : '';
    case 'flast': return f && l ? `${f[0]}${l}` : '';
    case 'last': return l;
    default: return clean(key); // a literal local part typed by hand
  }
}

/** Distinct, non-empty local parts for a persona, in the order given. */
export function localParts(patterns: string[], firstName: string, lastName: string): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    const v = renderPattern(p, firstName, lastName);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * A persona is the voice a mailbox writes in: the name on the From line, the
 * name partners greet it by, a company for the sign-off. Derived from what
 * the account already tells us (display name, address, domain) and editable.
 */

import { rngFrom } from '../rng.js';
import type { Account } from '../../db/schema.js';

export interface Persona {
  firstName: string;
  lastName: string | null;
  role: string | null;
  company: string | null;
  signOff: string | null;
}

const SIGN_OFFS = ['Best', 'Thanks', 'Cheers', 'Kind regards', 'Talk soon', 'Regards', 'Best regards'];

const GENERIC_LOCAL_PARTS = new Set([
  'info', 'hello', 'hi', 'contact', 'sales', 'team', 'support', 'admin', 'office', 'mail',
  'marketing', 'hr', 'careers', 'jobs', 'press', 'help', 'noreply', 'no-reply',
]);

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function nameFromLocalPart(localPart: string): { first: string; last: string | null } | null {
  const cleaned = localPart.toLowerCase().replace(/\d+$/, '');
  if (GENERIC_LOCAL_PARTS.has(cleaned)) return null;
  const parts = cleaned.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2 && parts[0]!.length > 1) {
    return { first: titleCase(parts[0]!), last: titleCase(parts[parts.length - 1]!) };
  }
  // "j.doe": the first name is unknown; the surname is the only usable name.
  if (parts.length >= 2 && parts[parts.length - 1]!.length > 2) {
    return { first: titleCase(parts[parts.length - 1]!), last: null };
  }
  if (parts.length === 1 && parts[0]!.length >= 3 && parts[0]!.length <= 12) {
    return { first: titleCase(parts[0]!), last: null };
  }
  return null;
}

export function companyFromDomain(email: string): string | null {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;
  const freeMail = /(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|proton|protonmail)\./;
  if (freeMail.test(domain)) return null;
  const label = domain.split('.')[0] ?? '';
  if (label.length < 2) return null;
  return label
    .split(/[-_]/)
    .map(titleCase)
    .join(' ');
}

export function derivePersona(account: Pick<Account, 'id' | 'email' | 'displayName'>): Persona {
  let first: string | null = null;
  let last: string | null = null;
  const display = (account.displayName ?? '').trim();
  if (display && !display.includes('@')) {
    const parts = display.split(/\s+/);
    first = parts[0] ?? null;
    last = parts.length > 1 ? parts[parts.length - 1]! : null;
  }
  if (!first) {
    const fromLocal = nameFromLocalPart(account.email.split('@')[0] ?? '');
    if (fromLocal) {
      first = fromLocal.first;
      last = fromLocal.last;
    }
  }
  const rng = rngFrom('persona', account.id);
  return {
    // A mailbox without a recognisable name still needs one to sign with.
    firstName: first ?? rng.pick(['Alex', 'Sam', 'Jordan', 'Robin', 'Taylor', 'Morgan'])!,
    lastName: last,
    role: null,
    company: companyFromDomain(account.email),
    signOff: rng.pick(SIGN_OFFS)!,
  };
}

export function parsePersona(json: string | null | undefined, fallback: Persona): Persona {
  if (!json) return fallback;
  try {
    const raw = JSON.parse(json) as Partial<Persona>;
    return {
      firstName: (raw.firstName ?? '').trim() || fallback.firstName,
      lastName: raw.lastName?.trim() || fallback.lastName,
      role: raw.role?.trim() || null,
      company: raw.company === '' ? null : raw.company?.trim() ?? fallback.company,
      signOff: raw.signOff?.trim() || fallback.signOff,
    };
  } catch {
    return fallback;
  }
}

export function fullName(p: Persona): string {
  return p.lastName ? `${p.firstName} ${p.lastName}` : p.firstName;
}

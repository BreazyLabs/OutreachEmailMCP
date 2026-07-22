import crypto from 'node:crypto';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomBase62(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += BASE62[bytes[i]! % 62];
  return out;
}

// --- API keys: high-entropy random, SHA-256 is sufficient and fast per-request ---

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `oem_live_${randomBase62(32)}`;
  return { key, prefix: key.slice(0, 12), hash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// --- SMTP passwords: encrypted at rest (must stay exportable), constant-time verify ---

export function generateSmtpPassword(): string {
  return randomBase62(24);
}

export function verifySmtpPassword(provided: string, stored: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- User passwords (SaaS signups): scrypt, no native deps ---

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split(':');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), 32);
  const expected = Buffer.from(hashB64, 'base64');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

// --- Generic session tokens (UI sessions) ---

export function generateSessionToken(): { token: string; hash: string } {
  const token = randomBase62(48);
  return { token, hash: crypto.createHash('sha256').update(token).digest('hex') };
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

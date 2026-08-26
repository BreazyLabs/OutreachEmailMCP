import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq, lt } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  generateSessionToken,
  hashSessionToken,
  verifyPassword,
} from '../crypto/credentials.js';
import { SELFHOST_ADMIN_EMAIL } from '../tenancy/orgs.js';
import { config } from '../config.js';
import type { User, Org } from '../db/schema.js';

export const SESSION_COOKIE = 'ep_session';
const SESSION_TTL_MS = 7 * 24 * 3600_000;

export interface SessionContext {
  user: User;
  /** The workspace this session is acting in. For a superadmin that is
   *  whichever workspace they switched into; for everyone else it is their
   *  own and cannot be changed. */
  org: Org;
  /** Platform-level access: may enter and create any workspace. */
  isSuperuser: boolean;
}

// Self-hosted mode: password-only login against the seeded admin user.
// SaaS mode: email + password against the users table.
export function authenticateUser(email: string | null, password: string): User | null {
  const lookupEmail = config.SAAS_MODE ? (email ?? '').toLowerCase() : SELFHOST_ADMIN_EMAIL;
  if (!lookupEmail || !password) return null;
  const user = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, lookupEmail))
    .get();
  if (!user || !verifyPassword(password, user.passwordHash)) return null;
  return user;
}

export function createUiSession(reply: FastifyReply, userId: string): void {
  const { token, hash } = generateSessionToken();
  const now = Date.now();
  db.insert(schema.uiSessions)
    .values({ tokenHash: hash, userId, createdAt: now, expiresAt: now + SESSION_TTL_MS })
    .run();
  db.delete(schema.uiSessions).where(lt(schema.uiSessions.expiresAt, now)).run();
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.BASE_URL.startsWith('https://'),
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function destroyUiSession(req: FastifyRequest, reply: FastifyReply): void {
  const token = req.cookies[SESSION_COOKIE];
  if (token) {
    db.delete(schema.uiSessions)
      .where(eq(schema.uiSessions.tokenHash, hashSessionToken(token)))
      .run();
  }
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function currentSession(req: FastifyRequest): SessionContext | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = db
    .select()
    .from(schema.uiSessions)
    .where(eq(schema.uiSessions.tokenHash, hashSessionToken(token)))
    .get();
  if (!session || session.expiresAt < Date.now() || !session.userId) return null;
  const user = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, session.userId))
    .get();
  if (!user) return null;
  const isSuperuser = user.role === 'superadmin';
  // Only a superadmin may act outside their own workspace. A stale
  // acting_org_id (workspace deleted, role revoked) silently falls back
  // rather than logging the session out.
  const targetOrgId =
    isSuperuser && session.actingOrgId ? session.actingOrgId : user.orgId;
  const org =
    db.select().from(schema.orgs).where(eq(schema.orgs.id, targetOrgId)).get() ??
    db.select().from(schema.orgs).where(eq(schema.orgs.id, user.orgId)).get();
  if (!org) return null;
  return { user, org, isSuperuser };
}

/** Enter another workspace. Superadmins only — the caller must have
 *  established that; this writes the choice onto the session row. */
export function setActingOrg(req: FastifyRequest, orgId: string | null): void {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return;
  db.update(schema.uiSessions)
    .set({ actingOrgId: orgId })
    .where(eq(schema.uiSessions.tokenHash, hashSessionToken(token)))
    .run();
}

/** Every workspace on the instance — the superadmin's switcher list. */
export function allOrgs(): { id: string; name: string; accounts: number }[] {
  const orgs = db.select().from(schema.orgs).all();
  return orgs
    .map((o) => ({
      id: o.id,
      name: o.name,
      accounts: db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.orgId, o.id))
        .all().length,
    }))
    .sort((a, b) => b.accounts - a.accounts || a.name.localeCompare(b.name));
}

export function hasValidUiSession(req: FastifyRequest): boolean {
  return currentSession(req) !== null;
}

// Redirects to login when unauthenticated; returns the session context or null.
export function requireUiSession(req: FastifyRequest, reply: FastifyReply): SessionContext | null {
  const session = currentSession(req);
  if (session) return session;
  reply.redirect('/ui/login');
  return null;
}

// CSRF token is derived from the session token, so it needs no extra storage.
export function csrfTokenFor(req: FastifyRequest): string {
  const token = req.cookies[SESSION_COOKIE] ?? '';
  return crypto.createHmac('sha256', config.masterKey).update(`csrf:${token}`).digest('hex');
}

export function verifyCsrf(req: FastifyRequest): boolean {
  const body = req.body as { _csrf?: string } | null;
  const provided = body?._csrf ?? '';
  const expected = csrfTokenFor(req);
  return (
    provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  );
}

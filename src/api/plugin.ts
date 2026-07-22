import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { db, schema } from '../db/index.js';
import { hashApiKey } from '../crypto/credentials.js';
import { AuthError, PermanentError, RetryableError } from '../providers/errors.js';
import { QuotaError } from '../tenancy/orgs.js';

export async function apiKeyAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  const key = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!key) {
    return reply.code(401).send({ error: 'Missing Authorization: Bearer <api key>' });
  }
  const row = db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.keyHash, hashApiKey(key)))
    .get();
  if (!row || row.revokedAt) {
    return reply.code(401).send({ error: 'Invalid or revoked API key' });
  }
  db.update(schema.apiKeys)
    .set({ lastUsedAt: Date.now() })
    .where(eq(schema.apiKeys.id, row.id))
    .run();
  const enriched = req as FastifyRequest & { orgId?: string; scopes?: string[] };
  enriched.orgId = row.orgId;
  enriched.scopes = JSON.parse(row.scopes) as string[];
}

// The org the request's API key belongs to (set by apiKeyAuth).
export function orgOf(req: FastifyRequest): string {
  return (req as FastifyRequest & { orgId?: string }).orgId ?? 'org_default';
}

export type ApiScope = 'send' | 'read' | 'accounts' | 'webhooks' | 'export';
export const ALL_SCOPES: ApiScope[] = ['send', 'read', 'accounts', 'webhooks', 'export'];

export function hasScope(scopes: string[] | undefined, scope: ApiScope): boolean {
  return !!scopes && (scopes.includes('*') || scopes.includes(scope));
}

// Per-route guard: replies 403 and returns false when the key lacks the scope.
export function requireScope(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: ApiScope,
): boolean {
  const scopes = (req as FastifyRequest & { scopes?: string[] }).scopes;
  if (hasScope(scopes, scope)) return true;
  void reply.code(403).send({ error: `This API key lacks the "${scope}" permission` });
  return false;
}

// Account lookup scoped to the requesting org — cross-tenant ids read as 404.
export function loadAccount(accountId: string, req?: FastifyRequest) {
  const account = db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!account) return undefined;
  if (req && account.orgId !== orgOf(req)) return undefined;
  return account;
}

// Uniform error envelope for API routes, including provider passthrough errors.
export function registerApiErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'Validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof QuotaError) {
      return reply.code(429).send({ error: err.message });
    }
    if (err instanceof AuthError) {
      return reply
        .code(503)
        .send({ error: 'Account authentication failed; reconnect the account', detail: err.message });
    }
    if (err instanceof RetryableError) {
      return reply.code(502).send({ error: 'Upstream provider error', detail: err.message });
    }
    if (err instanceof PermanentError) {
      return reply.code(400).send({ error: 'Provider rejected the request', detail: err.message });
    }
    req.log.error({ err }, 'unhandled API error');
    const fastifyErr = err as { statusCode?: number; message?: string };
    const statusCode =
      typeof fastifyErr.statusCode === 'number' ? fastifyErr.statusCode : 500;
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? 'Internal server error' : fastifyErr.message ?? 'Error',
    });
  });
}

import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { ssoEnabled } from '../auth/sso.js';
import { internalSsoAvailable } from '../auth/internal-network.js';
import {
  requireUiSession,
  csrfTokenFor,
  verifyCsrf,
  allOrgs,
  type SessionContext,
} from './session.js';

type Req = FastifyRequest;
type Rep = FastifyReply;

export function guard(req: Req, reply: Rep): SessionContext | null {
  return requireUiSession(req, reply);
}

export function guardPost(req: Req, reply: Rep): SessionContext | null {
  const session = requireUiSession(req, reply);
  if (!session) return null;
  if (!verifyCsrf(req)) {
    reply.code(403).send('Invalid CSRF token');
    return null;
  }
  return session;
}

export function baseLocals(req: Req, session?: SessionContext | null) {
  return {
    csrf: csrfTokenFor(req),
    googleEnabled: config.googleEnabled,
    microsoftEnabled: config.microsoftEnabled,
    saasMode: config.SAAS_MODE,
    stripeEnabled: config.stripeEnabled,
    ssoEnabled: ssoEnabled(),
    // Pocket ID is offered only to traffic that actually came through the
    // tailnet gateway — id.internal does not resolve anywhere else, so
    // showing the button publicly would be a dead end.
    internalSso: internalSsoAvailable(req),
    orgName: session?.org.name ?? null,
    // Match the switcher's current selection on id, never on name: workspace
    // names are not unique (two customers with the same company name is
    // ordinary), and matching by name silently marks the wrong one current.
    orgId: session?.org.id ?? null,
    // Superadmins see every workspace and can switch between them; for
    // everyone else these are absent and the nav renders as before.
    superuser: session?.isSuperuser ?? false,
    orgs: session?.isSuperuser ? allOrgs() : [],
    baseUrl: config.BASE_URL.replace(/\/$/, ''),
    error: (req.query as { error?: string }).error ?? null,
    notice: ((req.query as { notice?: string }).notice ?? null) as string | null,
  };
}


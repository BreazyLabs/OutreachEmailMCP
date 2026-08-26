/**
 * "Did this request come from the Breazy tailnet?"
 *
 * Two signals, ANDed, because either alone is forgeable:
 *
 *   Host      Traefik has no router for <app>.internal, so a request from the
 *             public internet carrying that Host 404s at the edge before it
 *             ever reaches this process. This is the strong signal.
 *   Secret    Covers the residual case: any container on the primary can dial
 *             the gateway's tailnet IP directly, but won't know the secret.
 *             nginx *overwrites* the header on every proxied request, so a
 *             client cannot smuggle their own value through it.
 *
 * `!!secret` makes the whole thing fail CLOSED when the env var is missing —
 * an unconfigured deploy grants nothing rather than everything.
 *
 * The counterpart on the public edge is mandatory: Traefik forwards arbitrary
 * client headers, so a `strip-internal-trust` middleware must blank
 * X-Internal-Gateway on every public domain. Without it this check is a
 * public authentication bypass, not a safeguard. (breazyinsights.nl, 2026-08-02.)
 */

import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';

export function isInternalRequest(req: FastifyRequest): boolean {
  const host = String(req.headers.host ?? '')
    .split(':')[0]
    ?.toLowerCase();
  const secret = config.INTERNAL_GATEWAY_SECRET;
  const presented = req.headers['x-internal-gateway'];
  return (
    host === config.INTERNAL_HOSTNAME.toLowerCase() &&
    !!secret &&
    typeof presented === 'string' &&
    presented === secret
  );
}

/** Whether to offer — and honour — Pocket ID sign-in for this request. */
export function internalSsoAvailable(req: FastifyRequest): boolean {
  return config.internalSsoConfigured && isInternalRequest(req);
}

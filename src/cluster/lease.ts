/**
 * Leader election for the background loops, on a single SQLite row.
 *
 * Any number of app instances may share the data volume (a rolling deploy
 * runs two for a minute; a crash-restart may briefly overlap). Only the
 * holder of the 'workers' lease runs the pollers, queues and the warmup
 * engine; everyone serves SMTP, IMAP and HTTP. The lease is a heartbeat: the
 * holder renews it every few seconds, and a follower takes it the moment it
 * has expired, so a dead leader is replaced within one TTL.
 */

import os from 'node:os';
import { sqlite } from '../db/index.js';
import { logger } from '../logger.js';

export const INSTANCE_ID = `${os.hostname()}-${process.pid}`;

const LEASE = 'workers';
export const LEASE_TTL_MS = 30_000;
export const HEARTBEAT_MS = 5_000;

/** Take or renew the lease atomically. True when this instance holds it. */
export function tryAcquire(holder = INSTANCE_ID, now = Date.now(), ttl = LEASE_TTL_MS): boolean {
  const expiresAt = now + ttl;
  // Renew if ours, take if expired, otherwise leave it alone — one statement
  // so two instances racing cannot both win.
  const updated = sqlite
    .prepare(
      `UPDATE leases SET holder = @holder, expires_at = @expiresAt,
         acquired_at = CASE WHEN holder = @holder THEN acquired_at ELSE @now END
       WHERE name = @name AND (holder = @holder OR expires_at < @now)`,
    )
    .run({ holder, expiresAt, now, name: LEASE });
  if (updated.changes > 0) return true;
  const inserted = sqlite
    .prepare(
      `INSERT OR IGNORE INTO leases (name, holder, acquired_at, expires_at) VALUES (@name, @holder, @now, @expiresAt)`,
    )
    .run({ name: LEASE, holder, now, expiresAt });
  return inserted.changes > 0;
}

/** Give the lease up immediately so a peer can take over without waiting
 *  for the TTL (called on graceful shutdown). */
export function release(holder = INSTANCE_ID): void {
  sqlite
    .prepare(`UPDATE leases SET expires_at = 0 WHERE name = ? AND holder = ?`)
    .run(LEASE, holder);
}

export function currentHolder(): { holder: string; expiresAt: number } | null {
  const row = sqlite
    .prepare(`SELECT holder, expires_at AS expiresAt FROM leases WHERE name = ?`)
    .get(LEASE) as { holder: string; expiresAt: number } | undefined;
  return row ?? null;
}

export interface LeaderCallbacks {
  onElected: () => void;
  onLost: () => void;
}

/**
 * Run the election loop. `onElected` fires when this instance gains the
 * lease, `onLost` when it fails to renew (clock jump, long stall, or a peer
 * took over after our TTL lapsed). Returns a stop function that also
 * releases the lease when we hold it.
 */
export function startLeaderLoop(cb: LeaderCallbacks): () => void {
  let leader = false;
  const tick = () => {
    let held: boolean;
    try {
      held = tryAcquire();
    } catch (err) {
      logger.warn({ err: String(err) }, 'lease heartbeat failed');
      held = false;
    }
    if (held && !leader) {
      leader = true;
      logger.info({ instance: INSTANCE_ID }, 'this instance is the worker leader');
      try {
        cb.onElected();
      } catch (err) {
        logger.error({ err: String(err) }, 'starting workers failed');
      }
    } else if (!held && leader) {
      leader = false;
      logger.warn({ instance: INSTANCE_ID, holder: currentHolder()?.holder }, 'lost the worker lease; stopping workers');
      try {
        cb.onLost();
      } catch (err) {
        logger.error({ err: String(err) }, 'stopping workers failed');
      }
    }
  };
  tick();
  const timer = setInterval(tick, HEARTBEAT_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    if (leader) {
      leader = false;
      try {
        cb.onLost();
      } finally {
        release();
      }
    }
  };
}

export function isLeader(): boolean {
  const row = currentHolder();
  return !!row && row.holder === INSTANCE_ID && row.expiresAt > Date.now();
}

/**
 * Keeps provisioner orders current: every ten minutes, and once shortly
 * after boot, every workspace with Premium Inboxes connected has its orders
 * mirrored so delivered mailboxes show up without anyone pressing refresh.
 */

import { logger } from '../logger.js';
import { syncAllOrders } from './service.js';

export function startOrderSync(): () => void {
  const run = () => {
    syncAllOrders().catch((err) => logger.warn({ err: String(err) }, 'order sync tick failed'));
  };
  const first = setTimeout(run, 20_000);
  first.unref();
  const timer = setInterval(run, 10 * 60_000);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

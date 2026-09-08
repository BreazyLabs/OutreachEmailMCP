/**
 * Warmup engine wiring: the loops, in one place, behind the kill switch.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import { planAll } from './planner.js';
import { startWarmupExecutor, executorTick } from './executor.js';
import { spamSweepTick, missingSweepTick } from './detector.js';
import { seedTemplateScripts, replenishScripts } from './content/scripts.js';
import { pruneTasks } from './tasks.js';

export function startWarmupEngine(): () => void {
  if (!config.WARMUP_ENABLED) {
    logger.info('warmup engine disabled (WARMUP_ENABLED=false)');
    return () => {};
  }
  const seeded = seedTemplateScripts();
  if (seeded > 0) logger.info({ seeded }, 'warmup template scripts seeded');

  const stopExecutor = startWarmupExecutor();

  const safe = (name: string, fn: () => unknown) => () => {
    try {
      const result = fn();
      if (result instanceof Promise) {
        result.catch((err) => logger.error({ err: String(err) }, `warmup ${name} failed`));
      }
    } catch (err) {
      logger.error({ err: String(err) }, `warmup ${name} failed`);
    }
  };

  const planner = setInterval(safe('planner', () => planAll()), 60_000);
  planner.unref();
  const sweeper = setInterval(safe('spam sweep', () => spamSweepTick()), 30_000);
  sweeper.unref();
  const missing = setInterval(safe('missing sweep', () => missingSweepTick()), 10 * 60_000);
  missing.unref();
  const supplier = setInterval(safe('script supplier', () => replenishScripts()), 10 * 60_000);
  supplier.unref();
  const pruner = setInterval(safe('task pruner', () => pruneTasks()), 6 * 3600_000);
  pruner.unref();

  // First pass right away so a restart picks the day back up within seconds.
  setTimeout(safe('planner', () => planAll()), 2_000).unref();
  setTimeout(safe('script supplier', () => replenishScripts()), 5_000).unref();
  setTimeout(safe('executor', () => executorTick()), 4_000).unref();

  logger.info('warmup engine started');
  return () => {
    stopExecutor();
    clearInterval(planner);
    clearInterval(sweeper);
    clearInterval(missing);
    clearInterval(supplier);
    clearInterval(pruner);
  };
}

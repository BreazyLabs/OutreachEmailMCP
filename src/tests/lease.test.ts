import { describe, it, expect, beforeAll } from 'vitest';

process.env.MASTER_KEY = Buffer.alloc(32, 13).toString('base64');
process.env.DATA_DIR = './data-test/lease';
process.env.BASE_URL = 'http://localhost:3000';
process.env.SAAS_MODE = 'false';

describe('worker lease', () => {
  beforeAll(async () => {
    const { runMigrations } = await import('../db/index.js');
    runMigrations();
  });

  it('is exclusive, renewable by the holder, and taken over only after expiry or release', async () => {
    const { tryAcquire, release, currentHolder } = await import('../cluster/lease.js');
    const t0 = 1_000_000;
    expect(tryAcquire('a', t0, 30_000)).toBe(true);
    expect(tryAcquire('b', t0 + 1_000, 30_000)).toBe(false);
    // Holder renews; the expiry moves forward, acquired_at stays.
    expect(tryAcquire('a', t0 + 10_000, 30_000)).toBe(true);
    expect(currentHolder()).toMatchObject({ holder: 'a', expiresAt: t0 + 40_000 });
    expect(tryAcquire('b', t0 + 39_000, 30_000)).toBe(false);
    // Leader went silent: b takes over once the TTL has lapsed.
    expect(tryAcquire('b', t0 + 41_000, 30_000)).toBe(true);
    expect(currentHolder()?.holder).toBe('b');
    // The old leader coming back does not get it back.
    expect(tryAcquire('a', t0 + 42_000, 30_000)).toBe(false);
    // A graceful release hands it over immediately.
    release('b');
    expect(tryAcquire('a', t0 + 43_000, 30_000)).toBe(true);
    // Releasing a lease you do not hold is a no-op.
    release('b');
    expect(currentHolder()?.holder).toBe('a');
    expect(tryAcquire('b', t0 + 44_000, 30_000)).toBe(false);
  });

  it('elects exactly one leader and hands over on stop', async () => {
    const { startLeaderLoop, release, currentHolder, INSTANCE_ID } = await import('../cluster/lease.js');
    release(currentHolder()?.holder ?? '');
    let elected = 0;
    let lost = 0;
    const stop = startLeaderLoop({ onElected: () => elected++, onLost: () => lost++ });
    expect(elected).toBe(1);
    expect(currentHolder()?.holder).toBe(INSTANCE_ID);
    stop();
    expect(lost).toBe(1);
    expect(currentHolder()?.expiresAt).toBe(0);
  });
});

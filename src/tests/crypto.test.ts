import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.DATA_DIR = './data-test/crypto';
  process.env.BASE_URL = 'http://localhost:3000'; // vite injects BASE_URL='/'
});

describe('secrets', () => {
  it('round-trips encryption', async () => {
    const { encryptSecret, decryptSecret } = await import('../crypto/secrets.js');
    const value = 'ya29.a0AfH6SMB-token-with-:colons: and unicode ✓';
    const stored = encryptSecret(value);
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain(value);
    expect(decryptSecret(stored)).toBe(value);
  });

  it('produces distinct ciphertexts for the same plaintext', async () => {
    const { encryptSecret } = await import('../crypto/secrets.js');
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('rejects tampered ciphertext', async () => {
    const { encryptSecret, decryptSecret } = await import('../crypto/secrets.js');
    const stored = encryptSecret('secret');
    const parts = stored.split(':');
    const data = Buffer.from(parts[3]!, 'base64');
    data[0] = data[0]! ^ 0xff;
    parts[3] = data.toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });
});

describe('credentials', () => {
  it('generates and verifies API keys', async () => {
    const { generateApiKey, hashApiKey } = await import('../crypto/credentials.js');
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^oem_live_[A-Za-z0-9]{32}$/);
    expect(prefix).toBe(key.slice(0, 12));
    expect(hashApiKey(key)).toBe(hash);
    expect(hashApiKey(key + 'x')).not.toBe(hash);
  });

  it('generates and verifies SMTP passwords', async () => {
    const { generateSmtpPassword, verifySmtpPassword } = await import(
      '../crypto/credentials.js'
    );
    const password = generateSmtpPassword();
    expect(password).toHaveLength(24);
    expect(verifySmtpPassword(password, password)).toBe(true);
    expect(verifySmtpPassword('wrong', password)).toBe(false);
  });
});

describe('backoff', () => {
  it('grows exponentially and caps at one hour', async () => {
    const { backoffMs } = await import('../queue/sendQueue.js');
    expect(backoffMs(1)).toBeGreaterThanOrEqual(2000);
    expect(backoffMs(1)).toBeLessThan(2000 + 30_000);
    expect(backoffMs(20)).toBeLessThanOrEqual(3600_000 + 30_000);
  });
});

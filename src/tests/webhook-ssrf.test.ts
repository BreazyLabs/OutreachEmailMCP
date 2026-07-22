import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.DATA_DIR = './data-test/webhook';
  process.env.BASE_URL = 'http://localhost:3000'; // vite injects BASE_URL='/'
});

describe('isPrivateWebhookTarget', () => {
  it('flags loopback and private ranges', async () => {
    const { isPrivateWebhookTarget } = await import('../inbound/webhooks.js');
    for (const url of [
      'http://127.0.0.1/hook',
      'http://10.0.0.5/hook',
      'http://192.168.1.10:8080/hook',
      'http://172.16.0.1/hook',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/hook',
      'not-a-url',
    ]) {
      expect(await isPrivateWebhookTarget(url), url).toBe(true);
    }
  });

  it('allows public addresses', async () => {
    const { isPrivateWebhookTarget } = await import('../inbound/webhooks.js');
    expect(await isPrivateWebhookTarget('http://8.8.8.8/hook')).toBe(false);
  });
});

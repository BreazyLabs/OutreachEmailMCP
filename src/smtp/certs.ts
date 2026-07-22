import fs from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { config } from '../config.js';
import { logger } from '../logger.js';

export function loadTlsMaterial(): { key: string; cert: string } {
  if (config.SMTP_TLS_CERT && config.SMTP_TLS_KEY) {
    return {
      cert: fs.readFileSync(config.SMTP_TLS_CERT, 'utf8'),
      key: fs.readFileSync(config.SMTP_TLS_KEY, 'utf8'),
    };
  }
  const certPath = path.join(config.certsDir, 'smtp.crt');
  const keyPath = path.join(config.certsDir, 'smtp.key');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') };
  }
  logger.info({ certPath }, 'generating self-signed certificate for SMTP STARTTLS');
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: new URL(config.BASE_URL).hostname }],
    { days: 3650, keySize: 2048 },
  );
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  return { cert: pems.cert, key: pems.private };
}

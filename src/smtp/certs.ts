import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { smtpAdvertisedHost } from './credentials.js';

// Every name a client might verify the STARTTLS certificate against: the host
// the CSV export tells sequencers to connect to comes first, since that is the
// one that actually gets checked.
function certHostnames(): string[] {
  const names = [smtpAdvertisedHost(), new URL(config.BASE_URL).hostname];
  return [...new Set(names.filter(Boolean))];
}

function covers(pem: string, hostnames: string[]): boolean {
  try {
    const cert = new crypto.X509Certificate(pem);
    return hostnames.every((h) => cert.checkHost(h) !== undefined);
  } catch {
    return false;
  }
}

export function loadTlsMaterial(): { key: string; cert: string } {
  if (config.SMTP_TLS_CERT && config.SMTP_TLS_KEY) {
    return {
      cert: fs.readFileSync(config.SMTP_TLS_CERT, 'utf8'),
      key: fs.readFileSync(config.SMTP_TLS_KEY, 'utf8'),
    };
  }
  const certPath = path.join(config.certsDir, 'smtp.crt');
  const keyPath = path.join(config.certsDir, 'smtp.key');
  const hostnames = certHostnames();
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const cert = fs.readFileSync(certPath, 'utf8');
    // A cert generated before MAIL_HOST was set names the wrong host, and
    // every client that checks hostnames rejects it. Regenerate rather than
    // leaving a mismatch on disk forever.
    if (covers(cert, hostnames)) {
      return { cert, key: fs.readFileSync(keyPath, 'utf8') };
    }
    logger.warn(
      { hostnames },
      'existing STARTTLS certificate does not cover the advertised mail host; regenerating',
    );
  }
  logger.info({ certPath, hostnames }, 'generating self-signed certificate for STARTTLS');
  const pems = selfsigned.generate([{ name: 'commonName', value: hostnames[0]! }], {
    days: 3650,
    keySize: 2048,
    extensions: [
      {
        name: 'subjectAltName',
        altNames: hostnames.map((value) => ({ type: 2, value })), // type 2 = DNS
      },
    ],
  });
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  return { cert: pems.cert, key: pems.private };
}

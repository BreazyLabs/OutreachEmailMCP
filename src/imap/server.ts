import net from 'node:net';
import tls from 'node:tls';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { loadTlsMaterial } from '../smtp/certs.js';
import { ImapSession } from './session.js';

// Two listeners, because sequencers disagree about which convention an IMAP
// port follows: STARTTLS on a plaintext port (143-style) and implicit TLS on
// connect (993-style). A client that assumes implicit TLS against a STARTTLS
// port fails with "wrong version number" as it reads the plaintext greeting as
// a TLS record, so offering only one of them locks out half the tools.
export function startImapServer(): net.Server[] {
  const tlsMaterial = loadTlsMaterial();
  const servers: net.Server[] = [];

  const starttls = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    new ImapSession(socket, tlsMaterial);
  });
  starttls.on('error', (err) => logger.warn({ err: String(err) }, 'imap server error'));
  starttls.listen(config.IMAP_PORT, config.IMAP_BIND, () => {
    logger.info(
      { port: config.IMAP_PORT, bind: config.IMAP_BIND, tls: 'starttls' },
      'imap server listening',
    );
  });
  servers.push(starttls);

  if (config.IMAPS_PORT > 0) {
    const implicit = tls.createServer(
      { key: tlsMaterial.key, cert: tlsMaterial.cert },
      (socket) => {
        socket.on('error', () => socket.destroy());
        new ImapSession(socket, tlsMaterial, true);
      },
    );
    implicit.on('error', (err) => logger.warn({ err: String(err) }, 'imaps server error'));
    implicit.on('tlsClientError', (err) =>
      logger.debug({ err: String(err) }, 'imaps handshake failed'),
    );
    implicit.listen(config.IMAPS_PORT, config.IMAP_BIND, () => {
      logger.info(
        { port: config.IMAPS_PORT, bind: config.IMAP_BIND, tls: 'implicit' },
        'imaps server listening',
      );
    });
    servers.push(implicit);
  }

  return servers;
}

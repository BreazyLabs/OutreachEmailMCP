import net from 'node:net';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { loadTlsMaterial } from '../smtp/certs.js';
import { ImapSession } from './session.js';

export function startImapServer(): net.Server {
  const tlsMaterial = loadTlsMaterial();
  const server = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    new ImapSession(socket, tlsMaterial);
  });
  server.on('error', (err) => logger.warn({ err: String(err) }, 'imap server error'));
  server.listen(config.IMAP_PORT, config.IMAP_BIND, () => {
    logger.info({ port: config.IMAP_PORT, bind: config.IMAP_BIND }, 'imap server listening');
  });
  return server;
}

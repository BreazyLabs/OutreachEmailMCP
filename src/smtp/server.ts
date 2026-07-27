import { SMTPServer, type SMTPServerSession } from 'smtp-server';
import { smtpAdvertisedHost, verifyProxyCredential } from './credentials.js';
import { providerFor } from '../providers/index.js';
import { QuotaError } from '../tenancy/orgs.js';
import { enqueueSend } from '../queue/sendQueue.js';
import { logActivity } from '../observability/activity.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { loadTlsMaterial } from './certs.js';
import { extractHeader } from '../utils/mime-headers.js';

interface SessionUser {
  accountId: string;
  email: string;
  provider: string;
}

function smtpError(message: string, code: number): Error & { responseCode: number } {
  const err = new Error(message) as Error & { responseCode: number };
  err.responseCode = code;
  return err;
}

// Started twice: STARTTLS on SMTP_PORT (587-style) and implicit TLS on
// SMTPS_PORT (465-style). Sequencers split roughly evenly between the two
// conventions, and guessing wrong shows up as an opaque TLS handshake error.
export function startSmtpServer(): SMTPServer[] {
  const servers = [buildSmtpServer(false)];
  if (config.SMTPS_PORT > 0) servers.push(buildSmtpServer(true));
  return servers;
}

function buildSmtpServer(implicitTls: boolean): SMTPServer {
  const tls = loadTlsMaterial();
  const port = implicitTls ? config.SMTPS_PORT : config.SMTP_PORT;
  const server = new SMTPServer({
    name: smtpAdvertisedHost(),
    banner: 'OutreachEmailMCP',
    secure: implicitTls,
    key: tls.key,
    cert: tls.cert,
    size: config.SMTP_MAX_SIZE,
    authMethods: ['PLAIN', 'LOGIN'],
    allowInsecureAuth: config.SMTP_ALLOW_INSECURE_AUTH,

    onAuth(auth, _session, callback) {
      const account = auth.password
        ? verifyProxyCredential(auth.username ?? '', auth.password)
        : null;
      if (!account) {
        logActivity({
          category: 'smtp',
          action: 'auth',
          status: 'failed',
          detail: `username=${(auth.username ?? '').slice(0, 60)}`,
          error: 'Invalid credentials',
        });
        return callback(smtpError('Invalid username or password', 535));
      }
      logActivity({
        category: 'smtp',
        action: 'auth',
        status: 'ok',
        accountId: account.id,
        detail: `username=${auth.username}`,
      });
      const user: SessionUser = {
        accountId: account.id,
        email: account.email,
        provider: account.provider,
      };
      callback(null, { user });
    },

    onMailFrom(address, session, callback) {
      const user = session.user as unknown as SessionUser | undefined;
      if (!user) return callback(smtpError('Authentication required', 530));
      if (address.address.toLowerCase() !== user.email) {
        return callback(
          smtpError(`MAIL FROM must be the connected account address (${user.email})`, 553),
        );
      }
      callback();
    },

    onData(stream, session: SMTPServerSession, callback) {
      const user = session.user as unknown as SessionUser | undefined;
      if (!user) return callback(smtpError('Authentication required', 530));
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        if (stream.sizeExceeded) {
          return callback(smtpError(`Message exceeds size limit of ${config.SMTP_MAX_SIZE} bytes`, 552));
        }
        const raw = Buffer.concat(chunks);
        // Fail fast instead of queueing something the provider will reject
        const providerLimit = providerFor(user.provider).maxRawSize;
        if (raw.length > providerLimit) {
          return callback(
            smtpError(
              `Message exceeds the ${user.provider} delivery limit of ${providerLimit} bytes`,
              552,
            ),
          );
        }
        try {
          const job = enqueueSend({
            accountId: user.accountId,
            source: 'smtp',
            raw,
            envelope: {
              from: session.envelope.mailFrom ? session.envelope.mailFrom.address : user.email,
              to: session.envelope.rcptTo.map((r) => r.address),
            },
            subject: extractHeader(raw, 'Subject'),
          });
          logger.info(
            { jobId: job.id, account: user.email, bytes: raw.length },
            'smtp message queued',
          );
          logActivity({
            category: 'smtp',
            action: 'submit',
            status: 'ok',
            accountId: user.accountId,
            detail: `job=${job.id} to=${session.envelope.rcptTo.map((r) => r.address).join(',')} subject=${job.subject ?? ''}`.slice(0, 400),
          });
          callback(null, `Queued as ${job.id}`);
        } catch (err) {
          logActivity({
            category: 'smtp',
            action: 'submit',
            status: 'failed',
            accountId: user.accountId,
            detail: `to=${session.envelope.rcptTo.map((r) => r.address).join(',')}`,
            error: String(err),
          });
          if (err instanceof QuotaError) {
            return callback(smtpError(err.message, 452));
          }
          logger.error({ err: String(err) }, 'failed to queue smtp message');
          callback(smtpError('Failed to queue message', 451));
        }
      });
    },
  });

  server.on('error', (err) => logger.warn({ err: String(err) }, 'smtp server error'));
  server.listen(port, config.SMTP_BIND, () => {
    logger.info(
      { port, bind: config.SMTP_BIND, tls: implicitTls ? 'implicit' : 'starttls' },
      'smtp server listening',
    );
  });
  return server;
}

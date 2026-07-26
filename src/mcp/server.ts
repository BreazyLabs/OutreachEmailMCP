import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, desc, and } from 'drizzle-orm';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { db, schema } from '../db/index.js';
import { hashApiKey } from '../crypto/credentials.js';
import { providerFor } from '../providers/index.js';
import { enqueueSend } from '../queue/sendQueue.js';
import { buildMime } from '../api/messages-send.js';
import { publicJob } from '../api/send-log.js';
import {
  createConnectHubLink,
  createConnectLink,
  revokeConnectLinks,
} from '../auth/connect-links.js';
import { buildAccountsCsv, SEQUENCER_FORMATS } from '../export/accounts-csv.js';
import { hasScope, type ApiScope } from '../api/plugin.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { logActivity } from '../observability/activity.js';
import { simpleParser } from 'mailparser';

// MCP endpoint: POST /mcp with Authorization: Bearer <api key>. Stateless
// Streamable HTTP — a fresh server+transport per request, tools filtered by
// the key's permissions, everything scoped to the key's org.

interface McpAuth {
  orgId: string;
  scopes: string[];
}

function authenticate(req: FastifyRequest): McpAuth | null {
  const header = req.headers.authorization;
  const key = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!key) return null;
  const row = db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.keyHash, hashApiKey(key)))
    .get();
  if (!row || row.revokedAt) return null;
  db.update(schema.apiKeys)
    .set({ lastUsedAt: Date.now() })
    .where(eq(schema.apiKeys.id, row.id))
    .run();
  return { orgId: row.orgId, scopes: JSON.parse(row.scopes) as string[] };
}

function text(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function accountFor(orgId: string, accountId: string) {
  const account = db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.orgId, orgId)))
    .get();
  if (!account) throw new Error(`Unknown account: ${accountId}`);
  return account;
}

const toArray = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

export function buildMcpServer(auth: McpAuth): McpServer {
  const server = new McpServer({ name: 'OutreachEmailMCP', version: '1.0.0' });
  const can = (scope: ApiScope) => hasScope(auth.scopes, scope);

  if (can('read')) {
    server.tool(
      'list_accounts',
      'List all connected email accounts (Gmail / Microsoft 365) in this workspace with their status.',
      {},
      async () => {
        const rows = db
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.orgId, auth.orgId))
          .orderBy(desc(schema.accounts.createdAt))
          .all();
        return text(
          rows.map((a) => ({
            id: a.id,
            provider: a.provider,
            email: a.email,
            displayName: a.displayName,
            status: a.status,
          })),
        );
      },
    );

    server.tool(
      'list_folders',
      'List the mail folders/labels of a connected account.',
      { accountId: z.string() },
      async ({ accountId }) => {
        const account = accountFor(auth.orgId, accountId);
        return text(await providerFor(account.provider).listFolders(account.id));
      },
    );

    server.tool(
      'list_messages',
      'List messages in a folder of a connected account. Returns summaries (from, subject, date, snippet) plus a nextPageToken for pagination.',
      {
        accountId: z.string(),
        folder: z.string().optional().describe('Folder/label id; defaults to INBOX'),
        query: z.string().optional().describe('Provider search query (e.g. "from:alice")'),
        limit: z.number().int().min(1).max(100).optional(),
        pageToken: z.string().optional(),
      },
      async ({ accountId, folder, query, limit, pageToken }) => {
        const account = accountFor(auth.orgId, accountId);
        return text(
          await providerFor(account.provider).listMessages(account.id, {
            folder,
            query,
            limit,
            pageToken,
          }),
        );
      },
    );

    server.tool(
      'get_message',
      'Fetch a full message (headers, text and html body, attachment list) by id.',
      { accountId: z.string(), messageId: z.string() },
      async ({ accountId, messageId }) => {
        const account = accountFor(auth.orgId, accountId);
        const raw = await providerFor(account.provider).getMessageRaw(account.id, messageId);
        const parsed = await simpleParser(raw);
        return text({
          id: messageId,
          from: parsed.from?.text ?? null,
          to: Array.isArray(parsed.to)
            ? parsed.to.map((t) => t.text).join(', ')
            : parsed.to?.text ?? null,
          subject: parsed.subject ?? null,
          date: parsed.date?.toISOString() ?? null,
          messageId: parsed.messageId ?? null,
          inReplyTo: parsed.inReplyTo ?? null,
          text: parsed.text ?? null,
          html: parsed.html || null,
          attachments: parsed.attachments.map((a, i) => ({
            id: String(i),
            filename: a.filename ?? `attachment-${i}`,
            contentType: a.contentType,
            size: a.size,
          })),
        });
      },
    );

    server.tool(
      'list_send_jobs',
      'List recent send jobs (the send log) for an account, including status and errors.',
      {
        accountId: z.string(),
        status: z.enum(['queued', 'sending', 'sent', 'failed', 'cancelled']).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      async ({ accountId, status, limit }) => {
        const account = accountFor(auth.orgId, accountId);
        const where = status
          ? and(eq(schema.sendJobs.accountId, account.id), eq(schema.sendJobs.status, status))
          : eq(schema.sendJobs.accountId, account.id);
        const rows = db
          .select()
          .from(schema.sendJobs)
          .where(where)
          .orderBy(desc(schema.sendJobs.createdAt))
          .limit(limit ?? 25)
          .all();
        return text(rows.map(publicJob));
      },
    );

    server.tool(
      'get_send_status',
      'Get the delivery status of a previously queued send job.',
      { accountId: z.string(), jobId: z.string() },
      async ({ accountId, jobId }) => {
        const account = accountFor(auth.orgId, accountId);
        const job = db
          .select()
          .from(schema.sendJobs)
          .where(
            and(eq(schema.sendJobs.id, jobId), eq(schema.sendJobs.accountId, account.id)),
          )
          .get();
        if (!job) throw new Error(`Unknown job: ${jobId}`);
        return text(publicJob(job));
      },
    );
  }

  if (can('send')) {
    server.tool(
      'send_email',
      'Send an email through a connected account. The message is queued and delivered via the provider API with automatic retries; returns a job id to check status with get_send_status.',
      {
        accountId: z.string(),
        to: z.array(z.string()).min(1),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        replyTo: z.string().optional(),
        subject: z.string(),
        text: z.string().optional().describe('Plain-text body'),
        html: z.string().optional().describe('HTML body'),
        inReplyTo: z
          .string()
          .optional()
          .describe('Message-ID being replied to (sets In-Reply-To/References headers)'),
      },
      async (input) => {
        if (input.text === undefined && input.html === undefined) {
          throw new Error('Provide at least one of "text" or "html"');
        }
        const account = accountFor(auth.orgId, input.accountId);
        if (account.status === 'disabled') throw new Error('Account is disabled');
        const from = account.displayName
          ? `"${account.displayName.replaceAll('"', '')}" <${account.email}>`
          : account.email;
        const raw = await buildMime({
          from,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          replyTo: input.replyTo,
          subject: input.subject,
          text: input.text,
          html: input.html,
          inReplyTo: input.inReplyTo,
          references: input.inReplyTo,
        });
        const providerLimit = providerFor(account.provider).maxRawSize;
        if (raw.length > providerLimit) {
          throw new Error(
            `Message is ${raw.length} bytes; the ${account.provider} limit is ${providerLimit}`,
          );
        }
        const job = enqueueSend({
          accountId: account.id,
          source: 'api',
          raw,
          envelope: {
            from: account.email,
            to: [...toArray(input.to), ...toArray(input.cc), ...toArray(input.bcc)],
          },
          subject: input.subject || null,
        });
        logActivity({
          category: 'mcp',
          action: 'send',
          status: 'ok',
          accountId: account.id,
          detail: `job=${job.id} to=${input.to.join(',')} subject=${input.subject}`.slice(0, 400),
        });
        return text({ jobId: job.id, status: job.status });
      },
    );
  }

  if (can('accounts')) {
    server.tool(
      'create_connect_link',
      'Create a signed OAuth link that lets someone connect Gmail or Microsoft mailboxes to this workspace without logging in. The link is REUSABLE: hand it over once and open it again for every further mailbox — it is not consumed. Omit provider for a link that offers both providers, lists what is already connected, and never expires (revoke it with revoke_connect_links).',
      {
        provider: z.enum(['google', 'microsoft']).optional(),
        expiresInHours: z.number().int().min(0).max(8760).optional(),
      },
      async ({ provider, expiresInHours }) => {
        if (provider) {
          const enabled = provider === 'google' ? config.googleEnabled : config.microsoftEnabled;
          if (!enabled) throw new Error(`${provider} OAuth is not configured on this instance`);
          return text({
            url: createConnectLink(
              provider,
              auth.orgId,
              expiresInHours ?? config.CONNECT_LINK_TTL_HOURS,
            ),
            reusable: true,
          });
        }
        return text({
          url: createConnectHubLink(auth.orgId, expiresInHours ?? 0),
          reusable: true,
        });
      },
    );
    server.tool(
      'revoke_connect_links',
      'Invalidate every connect link ever issued for this workspace and return a fresh one. Use if a link leaked.',
      {},
      async () => {
        revokeConnectLinks(auth.orgId);
        return text({ revoked: true, url: createConnectHubLink(auth.orgId) });
      },
    );
  }

  if (can('export')) {
    server.tool(
      'export_sequencer_csv',
      `Export all connected accounts as a CSV with proxy SMTP+IMAP credentials, formatted for a sequencer's bulk-import. Formats: ${SEQUENCER_FORMATS.join(', ')}.`,
      { format: z.enum(SEQUENCER_FORMATS as [string, ...string[]]).optional() },
      async ({ format }) => text(buildAccountsCsv(auth.orgId, format ?? 'generic')),
    );
  }

  return server;
}

export function registerMcpRoutes(app: FastifyInstance): void {
  app.post('/mcp', async (req, reply) => {
    const auth = authenticate(req);
    if (!auth) {
      return reply
        .code(401)
        .send({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized: pass an API key as Bearer token' },
          id: null,
        });
    }
    const server = buildMcpServer(auth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
    } catch (err) {
      logger.warn({ err: String(err) }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null,
          }),
        );
      }
    }
  });

  // Stateless server: session-oriented GET/DELETE are not applicable
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      handler: async (_req, reply) =>
        reply.code(405).send({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Stateless server: use POST' },
          id: null,
        }),
    });
  }
}

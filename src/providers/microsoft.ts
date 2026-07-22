import { getAccessToken } from '../auth/tokens.js';
import { throwForResponse, PermanentError } from './errors.js';
import type {
  Provider,
  Folder,
  MessageSummary,
  ListMessagesOptions,
  ListMessagesResult,
  PollResult,
} from './types.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

// Graph pagination/delta hands back absolute URLs which we treat as opaque
// tokens; only ever fetch them if they still point at Graph (SSRF guard).
function assertGraphUrl(url: string): string {
  if (!url.startsWith('https://graph.microsoft.com/')) {
    throw new PermanentError('Invalid Graph continuation URL');
  }
  return url;
}

async function graphFetch(
  accountId: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAccessToken(accountId);
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) await throwForResponse(res, `Graph ${init.method ?? 'GET'} ${url.slice(0, 120)}`);
  return res;
}

interface GraphMessage {
  id: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  subject?: string;
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  '@removed'?: unknown;
}

function formatAddress(a?: { emailAddress?: { name?: string; address?: string } }): string | null {
  const addr = a?.emailAddress?.address;
  if (!addr) return null;
  return a.emailAddress?.name ? `${a.emailAddress.name} <${addr}>` : addr;
}

function toSummary(m: GraphMessage): MessageSummary {
  return {
    id: m.id,
    from: formatAddress(m.from),
    to: (m.toRecipients ?? []).map(formatAddress).filter(Boolean).join(', ') || null,
    subject: m.subject ?? null,
    date: m.receivedDateTime ?? null,
    snippet: m.bodyPreview ?? null,
    unread: m.isRead === false,
    hasAttachments: m.hasAttachments ?? false,
  };
}

const SELECT_FIELDS =
  'id,from,toRecipients,subject,receivedDateTime,bodyPreview,isRead,hasAttachments';

export const microsoftProvider: Provider = {
  // Graph's REST request cap is 4 MB and sendMail takes base64 MIME (4/3
  // inflation), so ~2.9 MB raw is the practical ceiling. Larger mail needs the
  // draft + attachment-upload-session flow, which is not implemented yet.
  maxRawSize: 2_900_000,

  async sendRaw(accountId, raw) {
    await graphFetch(accountId, `${GRAPH}/me/sendMail`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: raw.toString('base64'),
    });
    // Graph sendMail returns 202 Accepted with no message id
    return null;
  },

  async listFolders(accountId): Promise<Folder[]> {
    const res = await graphFetch(accountId, `${GRAPH}/me/mailFolders?$top=100`);
    const body = (await res.json()) as {
      value?: { id: string; displayName: string; unreadItemCount?: number }[];
    };
    return (body.value ?? []).map((f) => ({
      id: f.id,
      name: f.displayName,
      unreadCount: f.unreadItemCount,
    }));
  },

  async listMessages(accountId, opts: ListMessagesOptions): Promise<ListMessagesResult> {
    let url: string;
    if (opts.pageToken) {
      url = assertGraphUrl(opts.pageToken);
    } else {
      const folder = encodeURIComponent(opts.folder ?? 'inbox');
      const params = new URLSearchParams({
        $top: String(Math.min(opts.limit ?? 25, 100)),
        $select: SELECT_FIELDS,
      });
      if (opts.query) {
        params.set('$search', `"${opts.query.replaceAll('"', '')}"`);
      } else {
        params.set('$orderby', 'receivedDateTime desc');
      }
      url = `${GRAPH}/me/mailFolders/${folder}/messages?${params}`;
    }
    const res = await graphFetch(accountId, url);
    const body = (await res.json()) as {
      value?: GraphMessage[];
      '@odata.nextLink'?: string;
    };
    return {
      messages: (body.value ?? []).map(toSummary),
      nextPageToken: body['@odata.nextLink'] ?? null,
    };
  },

  async getMessageRaw(accountId, messageId): Promise<Buffer> {
    const res = await graphFetch(
      accountId,
      `${GRAPH}/me/messages/${encodeURIComponent(messageId)}/$value`,
    );
    return Buffer.from(await res.arrayBuffer());
  },

  async initCursor(accountId): Promise<string> {
    // $deltatoken=latest anchors at "now" without enumerating the mailbox
    let url = `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=latest`;
    for (;;) {
      const res = await graphFetch(accountId, url);
      const body = (await res.json()) as {
        '@odata.nextLink'?: string;
        '@odata.deltaLink'?: string;
      };
      if (body['@odata.deltaLink']) return body['@odata.deltaLink'];
      if (!body['@odata.nextLink']) {
        throw new PermanentError('Graph delta returned neither nextLink nor deltaLink');
      }
      url = assertGraphUrl(body['@odata.nextLink']);
    }
  },

  async pollChanges(accountId, cursor): Promise<PollResult> {
    const ids: string[] = [];
    let url = assertGraphUrl(cursor);
    for (;;) {
      let res: Response;
      try {
        res = await graphFetch(accountId, url);
      } catch (err) {
        // 410 Gone = delta token expired; re-anchor and skip the gap
        if (err instanceof PermanentError && err.message.includes('410')) {
          return { newMessageIds: [], nextCursor: await this.initCursor(accountId) };
        }
        throw err;
      }
      const body = (await res.json()) as {
        value?: GraphMessage[];
        '@odata.nextLink'?: string;
        '@odata.deltaLink'?: string;
      };
      for (const m of body.value ?? []) {
        if (!m['@removed'] && m.id) ids.push(m.id);
      }
      if (body['@odata.deltaLink']) {
        return { newMessageIds: ids, nextCursor: body['@odata.deltaLink'] };
      }
      if (!body['@odata.nextLink']) {
        return { newMessageIds: ids, nextCursor: cursor };
      }
      url = assertGraphUrl(body['@odata.nextLink']);
    }
  },
};

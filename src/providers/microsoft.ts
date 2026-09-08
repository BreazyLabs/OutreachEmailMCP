import { getAccessToken } from '../auth/tokens.js';
import { throwForResponse, PermanentError } from './errors.js';
import type {
  Provider,
  Folder,
  MessageSummary,
  ListMessagesOptions,
  ListMessagesResult,
  PollResult,
  CanonicalFolder,
} from './types.js';

// Graph well-known folder names
const FOLDER_IDS: Record<CanonicalFolder, string> = {
  INBOX: 'inbox',
  Spam: 'junkemail',
  Sent: 'sentitems',
};

const GRAPH = 'https://graph.microsoft.com/v1.0';

// Graph pagination/delta hands back absolute URLs which we treat as opaque
// tokens; only ever fetch them if they still point at Graph (SSRF guard).
function assertGraphUrl(url: string): string {
  if (!url.startsWith('https://graph.microsoft.com/')) {
    throw new PermanentError('Invalid Graph continuation URL');
  }
  return url;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function graphFetch(
  accountId: string,
  url: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<Response> {
  const token = await getAccessToken(accountId);
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    // GET/PATCH/move are idempotent; absorb transient throttling with backoff
    // (Graph sends Retry-After on 429/503)
    const method = (init.method ?? 'GET').toUpperCase();
    const idempotent = method === 'GET' || method === 'PATCH' || url.endsWith('/move');
    if (idempotent && RETRYABLE_STATUS.has(res.status) && attempt < 3) {
      const retryAfterMs = Number(res.headers.get('retry-after')) * 1000 || 0;
      const delay = Math.max(retryAfterMs, 500 * 3 ** attempt) + Math.random() * 250;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return graphFetch(accountId, url, init, attempt + 1);
    }
    await throwForResponse(res, `Graph ${method} ${url.slice(0, 120)}`);
  }
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
  internetMessageId?: string;
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
    messageId: m.internetMessageId ?? null,
  };
}

const SELECT_FIELDS =
  'id,from,toRecipients,subject,receivedDateTime,bodyPreview,isRead,hasAttachments,internetMessageId';

// Well-known folder ids resolve to real ids per mailbox; cached so placement
// checks and cleanup moves do not re-resolve them on every message.
const folderIdCache = new Map<string, Map<string, string>>();

async function resolveFolderId(accountId: string, wellKnownOrName: string, createIfMissing = false): Promise<string> {
  const cached = folderIdCache.get(accountId)?.get(wellKnownOrName);
  if (cached) return cached;
  let id: string | undefined;
  if (['inbox', 'junkemail', 'sentitems', 'archive', 'deleteditems'].includes(wellKnownOrName)) {
    const res = await graphFetch(accountId, `${GRAPH}/me/mailFolders/${wellKnownOrName}?$select=id`);
    id = ((await res.json()) as { id?: string }).id;
  } else {
    const params = new URLSearchParams({
      $filter: `displayName eq '${wellKnownOrName.replaceAll("'", "''")}'`,
      $select: 'id',
    });
    const res = await graphFetch(accountId, `${GRAPH}/me/mailFolders?${params}`);
    id = ((await res.json()) as { value?: { id: string }[] }).value?.[0]?.id;
    if (!id && createIfMissing) {
      const created = await graphFetch(accountId, `${GRAPH}/me/mailFolders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: wellKnownOrName }),
      });
      id = ((await created.json()) as { id?: string }).id;
    }
  }
  if (!id) throw new PermanentError(`Graph folder "${wellKnownOrName}" not found`);
  if (!folderIdCache.has(accountId)) folderIdCache.set(accountId, new Map());
  folderIdCache.get(accountId)!.set(wellKnownOrName, id);
  return id;
}

async function moveTo(accountId: string, messageId: string, destinationId: string): Promise<string | null> {
  const res = await graphFetch(accountId, `${GRAPH}/me/messages/${encodeURIComponent(messageId)}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destinationId }),
  });
  const body = (await res.json()) as { id?: string };
  return body.id ?? null;
}

export const microsoftProvider: Provider = {
  // Graph's REST request cap is 4 MB and sendMail takes base64 MIME (4/3
  // inflation), so ~2.9 MB raw is the practical ceiling. Larger mail needs the
  // draft + attachment-upload-session flow, which is not implemented yet.
  maxRawSize: 2_900_000,

  supportsWrite(grantedScopes) {
    return grantedScopes.includes('Mail.ReadWrite');
  },

  async listMessageIds(accountId, folder, limit) {
    const params = new URLSearchParams({
      $top: String(limit),
      $select: 'id',
      $orderby: 'receivedDateTime desc',
    });
    const res = await graphFetch(
      accountId,
      `${GRAPH}/me/mailFolders/${FOLDER_IDS[folder]}/messages?${params}`,
    );
    const body = (await res.json()) as { value?: { id: string }[] };
    return (body.value ?? []).map((m) => m.id);
  },

  async moveMessage(accountId, messageId, _from, to) {
    const res = await graphFetch(
      accountId,
      `${GRAPH}/me/messages/${encodeURIComponent(messageId)}/move`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinationId: FOLDER_IDS[to] }),
      },
    );
    // Graph assigns a NEW id to the moved message
    const body = (await res.json()) as { id?: string };
    return body.id ?? null;
  },

  async setMessageFlags(accountId, messageId, flags) {
    const patch: Record<string, unknown> = {};
    if (flags.seen !== undefined) patch.isRead = flags.seen;
    if (flags.flagged !== undefined) {
      patch.flag = { flagStatus: flags.flagged ? 'flagged' : 'notFlagged' };
    }
    if (Object.keys(patch).length === 0) return;
    await graphFetch(accountId, `${GRAPH}/me/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  async getMessagePlacement(accountId, messageId) {
    const res = await graphFetch(
      accountId,
      `${GRAPH}/me/messages/${encodeURIComponent(messageId)}?$select=inferenceClassification,importance,parentFolderId`,
    );
    const body = (await res.json()) as {
      inferenceClassification?: string;
      importance?: string;
      parentFolderId?: string;
    };
    let inSpam = false;
    try {
      inSpam = body.parentFolderId === (await resolveFolderId(accountId, 'junkemail'));
    } catch {
      // placement without the spam bit is still useful
    }
    return {
      category: body.inferenceClassification === 'other' ? 'other' : 'primary',
      important: body.importance === 'high',
      inSpam,
    };
  },

  async setImportant(accountId, messageId, important) {
    await graphFetch(accountId, `${GRAPH}/me/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ importance: important ? 'high' : 'normal' }),
    });
  },

  async fixCategory(accountId, messageId) {
    await graphFetch(accountId, `${GRAPH}/me/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inferenceClassification: 'focused' }),
    });
  },

  async archiveMessage(accountId, messageId) {
    return moveTo(accountId, messageId, 'archive');
  },

  async moveToNamedFolder(accountId, messageId, name) {
    const folderId = await resolveFolderId(accountId, name, true);
    return moveTo(accountId, messageId, folderId);
  },

  async trashMessage(accountId, messageId) {
    return moveTo(accountId, messageId, 'deleteditems');
  },

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

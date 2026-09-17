import { getAccessToken } from '../auth/tokens.js';
import { upstreamSignal } from './http.js';
import { throwForResponse, PermanentError, RetryableError } from './errors.js';
import type {
  Provider,
  Folder,
  MessageSummary,
  ListMessagesOptions,
  ListMessagesResult,
  PollResult,
  CanonicalFolder,
} from './types.js';

const FOLDER_LABELS: Record<CanonicalFolder, string> = {
  INBOX: 'INBOX',
  Spam: 'SPAM',
  Sent: 'SENT',
};

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD_API = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function gmailFetch(
  accountId: string,
  url: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<Response> {
  const token = await getAccessToken(accountId);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: init.signal ?? upstreamSignal(),
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  } catch (err) {
    // A network error or the upstream timeout is transient: make it retryable
    // (like a 5xx) rather than a permanent send failure.
    throw new RetryableError(`Gmail request failed: ${String(err)}`);
  }
  if (!res.ok) {
    // Reads and label-modifies are idempotent: absorb transient 429/5xx with
    // backoff (honoring Retry-After) instead of surfacing them
    const method = (init.method ?? 'GET').toUpperCase();
    const idempotent = method === 'GET' || url.includes('/modify');
    if (idempotent && RETRYABLE_STATUS.has(res.status) && attempt < 3) {
      const retryAfterMs = Number(res.headers.get('retry-after')) * 1000 || 0;
      const delay = Math.max(retryAfterMs, 500 * 3 ** attempt) + Math.random() * 250;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return gmailFetch(accountId, url, init, attempt + 1);
    }
    await throwForResponse(res, `Gmail ${method} ${url.slice(0, 120)}`);
  }
  return res;
}

interface GmailMessageMeta {
  id: string;
  snippet?: string;
  labelIds?: string[];
  payload?: { headers?: { name: string; value: string }[] };
  internalDate?: string;
}

function header(msg: GmailMessageMeta, name: string): string | null {
  return (
    msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null
  );
}

function toSummary(msg: GmailMessageMeta): MessageSummary {
  return {
    id: msg.id,
    from: header(msg, 'From'),
    to: header(msg, 'To'),
    subject: header(msg, 'Subject'),
    date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
    snippet: msg.snippet ?? null,
    unread: msg.labelIds?.includes('UNREAD') ?? false,
    // format=metadata does not expose MIME parts; detail view reports attachments
    hasAttachments: false,
    messageId: header(msg, 'Message-ID'),
  };
}

const CATEGORY_LABELS: Record<string, 'promotions' | 'social' | 'updates' | 'forums'> = {
  CATEGORY_PROMOTIONS: 'promotions',
  CATEGORY_SOCIAL: 'social',
  CATEGORY_UPDATES: 'updates',
  CATEGORY_FORUMS: 'forums',
};

// Label ids of user-created labels, per account, so a warmup cleanup that
// files mail under "Warmup" does not list labels on every message.
const labelIdCache = new Map<string, Map<string, string>>();

async function ensureLabel(accountId: string, name: string): Promise<string> {
  const cached = labelIdCache.get(accountId)?.get(name);
  if (cached) return cached;
  const res = await gmailFetch(accountId, `${API}/labels`);
  const body = (await res.json()) as { labels?: { id: string; name: string }[] };
  let id = body.labels?.find((l) => l.name.toLowerCase() === name.toLowerCase())?.id;
  if (!id) {
    const created = await gmailFetch(accountId, `${API}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      }),
    });
    id = ((await created.json()) as { id: string }).id;
  }
  if (!labelIdCache.has(accountId)) labelIdCache.set(accountId, new Map());
  labelIdCache.get(accountId)!.set(name, id);
  return id;
}

async function modifyLabels(
  accountId: string,
  messageId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<void> {
  await gmailFetch(accountId, `${API}/messages/${messageId}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
}

function splitName(name: string | null): { firstName: string | null; lastName: string | null } {
  if (!name) return { firstName: null, lastName: null };
  const parts = name.split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? null, lastName: parts.length > 1 ? parts.slice(1).join(' ') : null };
}

export const googleProvider: Provider = {
  // Gmail API media upload accepts up to 25 MB
  maxRawSize: 25 * 1024 * 1024,

  supportsWrite(grantedScopes) {
    return grantedScopes.includes('gmail.modify');
  },

  async findSentMessageId(accountId, messageId) {
    const bare = messageId.replace(/^<|>$/g, '').trim();
    if (!bare) return null;
    const res = await gmailFetch(accountId, `${API}/messages?q=${encodeURIComponent('rfc822msgid:' + bare)}&maxResults=1`);
    const body = (await res.json()) as { messages?: { id: string }[] };
    return body.messages?.[0]?.id ?? null;
  },

  async fetchProfile(accountId) {
    // The send-as name is what recipients see and what the admin set; the
    // OpenID name would need the profile scope, which the connect flow does
    // not ask for.
    const res = await gmailFetch(accountId, `${API}/settings/sendAs`);
    const body = (await res.json()) as { sendAs?: { sendAsEmail?: string; displayName?: string; isPrimary?: boolean }[] };
    const primary = (body.sendAs ?? []).find((s) => s.isPrimary) ?? body.sendAs?.[0];
    const displayName = primary?.displayName?.trim() || null;
    return { displayName, ...splitName(displayName) };
  },

  async listMessageIds(accountId, folder, limit) {
    const params = new URLSearchParams({
      labelIds: FOLDER_LABELS[folder],
      maxResults: String(limit),
    });
    const res = await gmailFetch(accountId, `${API}/messages?${params}`);
    const body = (await res.json()) as { messages?: { id: string }[] };
    return (body.messages ?? []).map((m) => m.id);
  },

  async moveMessage(accountId, messageId, from, to) {
    await gmailFetch(accountId, `${API}/messages/${messageId}/modify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        addLabelIds: [FOLDER_LABELS[to]],
        removeLabelIds: [FOLDER_LABELS[from]],
      }),
    });
    return null; // Gmail keeps the same id
  },

  async setMessageFlags(accountId, messageId, flags) {
    const addLabelIds: string[] = [];
    const removeLabelIds: string[] = [];
    if (flags.seen !== undefined) (flags.seen ? removeLabelIds : addLabelIds).push('UNREAD');
    if (flags.flagged !== undefined) (flags.flagged ? addLabelIds : removeLabelIds).push('STARRED');
    if (addLabelIds.length === 0 && removeLabelIds.length === 0) return;
    await gmailFetch(accountId, `${API}/messages/${messageId}/modify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    });
  },

  async getMessagePlacement(accountId, messageId) {
    const res = await gmailFetch(accountId, `${API}/messages/${messageId}?format=minimal`);
    const body = (await res.json()) as { labelIds?: string[] };
    const labels = body.labelIds ?? [];
    let category: 'primary' | 'promotions' | 'social' | 'updates' | 'forums' | null = null;
    for (const l of labels) {
      if (CATEGORY_LABELS[l]) category = CATEGORY_LABELS[l]!;
    }
    if (!category && labels.includes('CATEGORY_PERSONAL')) category = 'primary';
    if (!category && labels.includes('INBOX')) category = 'primary';
    return { category, important: labels.includes('IMPORTANT'), inSpam: labels.includes('SPAM') };
  },

  async setImportant(accountId, messageId, important) {
    await modifyLabels(accountId, messageId, important ? ['IMPORTANT'] : [], important ? [] : ['IMPORTANT']);
  },

  async fixCategory(accountId, messageId) {
    await modifyLabels(accountId, messageId, ['CATEGORY_PERSONAL'], Object.keys(CATEGORY_LABELS));
  },

  async archiveMessage(accountId, messageId) {
    await modifyLabels(accountId, messageId, [], ['INBOX']);
    return null;
  },

  async moveToNamedFolder(accountId, messageId, name) {
    const labelId = await ensureLabel(accountId, name);
    await modifyLabels(accountId, messageId, [labelId], ['INBOX']);
    return null;
  },

  async trashMessage(accountId, messageId) {
    await gmailFetch(accountId, `${API}/messages/${messageId}/trash`, { method: 'POST' });
    return null;
  },

  async sendRaw(accountId, raw) {
    const res = await gmailFetch(accountId, `${UPLOAD_API}/messages/send?uploadType=media`, {
      method: 'POST',
      headers: { 'Content-Type': 'message/rfc822' },
      body: new Uint8Array(raw),
    });
    const body = (await res.json()) as { id?: string };
    return body.id ?? null;
  },

  async listFolders(accountId): Promise<Folder[]> {
    const res = await gmailFetch(accountId, `${API}/labels`);
    const body = (await res.json()) as { labels?: { id: string; name: string }[] };
    return (body.labels ?? []).map((l) => ({ id: l.id, name: l.name }));
  },

  async listMessages(accountId, opts: ListMessagesOptions): Promise<ListMessagesResult> {
    const params = new URLSearchParams({
      maxResults: String(Math.min(opts.limit ?? 25, 100)),
      labelIds: opts.folder ?? 'INBOX',
    });
    if (opts.pageToken) params.set('pageToken', opts.pageToken);
    if (opts.query) params.set('q', opts.query);
    const res = await gmailFetch(accountId, `${API}/messages?${params}`);
    const body = (await res.json()) as {
      messages?: { id: string }[];
      nextPageToken?: string;
    };
    const ids = (body.messages ?? []).map((m) => m.id);
    // Bounded concurrency: Gmail caps concurrent requests per user, and an
    // unbounded Promise.all over a 50-message page trips 429s
    const CONCURRENCY = 5;
    const metas: GmailMessageMeta[] = [];
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const chunk = await Promise.all(
        ids.slice(i, i + CONCURRENCY).map(async (id) => {
          const r = await gmailFetch(
            accountId,
            `${API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`,
          );
          return (await r.json()) as GmailMessageMeta;
        }),
      );
      metas.push(...chunk);
    }
    return {
      messages: metas.map(toSummary),
      nextPageToken: body.nextPageToken ?? null,
    };
  },

  async getMessageRaw(accountId, messageId): Promise<Buffer> {
    const res = await gmailFetch(accountId, `${API}/messages/${messageId}?format=raw`);
    const body = (await res.json()) as { raw?: string };
    if (!body.raw) throw new PermanentError(`Gmail message ${messageId} has no raw payload`);
    return Buffer.from(body.raw, 'base64url');
  },

  async initCursor(accountId): Promise<string> {
    const res = await gmailFetch(accountId, `${API}/profile`);
    const body = (await res.json()) as { historyId?: string };
    if (!body.historyId) throw new PermanentError('Gmail profile returned no historyId');
    return body.historyId;
  },

  async pollChanges(accountId, cursor): Promise<PollResult> {
    const ids = new Set<string>();
    let nextCursor = cursor;
    let pageToken: string | undefined;
    try {
      do {
        const params = new URLSearchParams({
          startHistoryId: cursor,
          historyTypes: 'messageAdded',
          labelId: 'INBOX',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const res = await gmailFetch(accountId, `${API}/history?${params}`);
        const body = (await res.json()) as {
          history?: { messagesAdded?: { message?: { id?: string } }[] }[];
          historyId?: string;
          nextPageToken?: string;
        };
        for (const h of body.history ?? []) {
          for (const added of h.messagesAdded ?? []) {
            if (added.message?.id) ids.add(added.message.id);
          }
        }
        if (body.historyId) nextCursor = body.historyId;
        pageToken = body.nextPageToken;
      } while (pageToken);
    } catch (err) {
      // A 404 means the cursor expired (Gmail keeps ~a week of history):
      // re-anchor at "now" and skip the gap.
      if (err instanceof PermanentError && err.message.includes('404')) {
        return { newMessageIds: [], nextCursor: await this.initCursor(accountId) };
      }
      throw err;
    }
    return { newMessageIds: [...ids], nextCursor };
  },
};

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

const FOLDER_LABELS: Record<CanonicalFolder, string> = {
  INBOX: 'INBOX',
  Spam: 'SPAM',
  Sent: 'SENT',
};

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD_API = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';

async function gmailFetch(
  accountId: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAccessToken(accountId);
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) await throwForResponse(res, `Gmail ${init.method ?? 'GET'} ${url.slice(0, 120)}`);
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
  };
}

export const googleProvider: Provider = {
  // Gmail API media upload accepts up to 25 MB
  maxRawSize: 25 * 1024 * 1024,

  supportsWrite(grantedScopes) {
    return grantedScopes.includes('gmail.modify');
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
    const metas = await Promise.all(
      ids.map(async (id) => {
        const r = await gmailFetch(
          accountId,
          `${API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        );
        return (await r.json()) as GmailMessageMeta;
      }),
    );
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

export interface Folder {
  id: string;
  name: string;
  unreadCount?: number;
}

export interface MessageSummary {
  id: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  date: string | null; // ISO 8601
  snippet: string | null;
  unread: boolean;
  hasAttachments: boolean;
}

export interface ListMessagesOptions {
  folder?: string;
  pageToken?: string;
  query?: string;
  limit?: number;
}

export interface ListMessagesResult {
  messages: MessageSummary[];
  nextPageToken: string | null;
}

export interface PollResult {
  newMessageIds: string[];
  nextCursor: string;
}

// Both providers speak raw RFC822 MIME on the send path; reads are normalized
// into the shapes above. All methods take an accountId and resolve tokens via
// the shared token store.
export interface Provider {
  /** Largest raw MIME message the provider's send path accepts, in bytes. */
  readonly maxRawSize: number;
  /** Send a raw MIME message; returns the provider's message id if it reports one. */
  sendRaw(accountId: string, raw: Buffer): Promise<string | null>;
  listFolders(accountId: string): Promise<Folder[]>;
  listMessages(accountId: string, opts: ListMessagesOptions): Promise<ListMessagesResult>;
  /** Fetch the full raw RFC822 source of a message. */
  getMessageRaw(accountId: string, messageId: string): Promise<Buffer>;
  /** Anchor a cursor at "now" for incremental polling. */
  initCursor(accountId: string): Promise<string>;
  /** Return inbox messages that arrived since the cursor, plus the advanced cursor. */
  pollChanges(accountId: string, cursor: string): Promise<PollResult>;
}

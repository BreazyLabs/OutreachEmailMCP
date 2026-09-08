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
  /** RFC822 Message-ID header, when the listing exposes it (used to filter
   *  warmup traffic out of listings). */
  messageId: string | null;
}

/** Where a message sits inside the recipient's mailbox beyond the folder:
 *  Gmail's inbox categories, Outlook's Focused/Other split, importance. */
export interface MessagePlacement {
  category: 'primary' | 'promotions' | 'social' | 'updates' | 'forums' | 'other' | null;
  important: boolean;
  inSpam: boolean;
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

// Folders the IMAP facade exposes as provider-backed (warmup needs Spam).
export type CanonicalFolder = 'INBOX' | 'Spam' | 'Sent';
export const PROVIDER_FOLDERS: CanonicalFolder[] = ['INBOX', 'Spam', 'Sent'];

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
  /** Whether the granted OAuth scopes permit upstream writes (move/flags). */
  supportsWrite(grantedScopes: string): boolean;
  /** Newest message ids in a canonical folder (up to limit). */
  listMessageIds(accountId: string, folder: CanonicalFolder, limit: number): Promise<string[]>;
  /**
   * Move a message between canonical folders upstream. Returns the message's
   * new provider id when the provider reassigns ids on move (Graph does),
   * otherwise null.
   */
  moveMessage(
    accountId: string,
    messageId: string,
    from: CanonicalFolder,
    to: CanonicalFolder,
  ): Promise<string | null>;
  /** Set read/starred state upstream. */
  setMessageFlags(
    accountId: string,
    messageId: string,
    flags: { seen?: boolean; flagged?: boolean },
  ): Promise<void>;

  // --- warmup engagement: the things a person's mail client does ---

  /** Category / importance / spam status of a message. */
  getMessagePlacement(accountId: string, messageId: string): Promise<MessagePlacement>;
  /** Gmail: IMPORTANT label. Graph: importance = high. */
  setImportant(accountId: string, messageId: string, important: boolean): Promise<void>;
  /** Gmail: Promotions/Social/Updates → Primary. Graph: Other → Focused. */
  fixCategory(accountId: string, messageId: string): Promise<void>;
  /** Remove from the inbox without deleting. Returns the new id when the
   *  provider reassigns ids on move (Graph), else null. */
  archiveMessage(accountId: string, messageId: string): Promise<string | null>;
  /** Move into a user-visible label/folder by name, creating it if needed.
   *  Returns the new id when reassigned. */
  moveToNamedFolder(accountId: string, messageId: string, name: string): Promise<string | null>;
  /** Trash (recoverable delete). Returns the new id when reassigned. */
  trashMessage(accountId: string, messageId: string): Promise<string | null>;
}

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { simpleParser } from 'mailparser';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { db, schema } from '../db/index.js';
import { providerFor } from '../providers/index.js';
import { verifyProxyCredential } from '../smtp/credentials.js';
import { refreshAccountMailbox } from '../inbound/poller.js';
import {
  backfillAccount,
  messagesFor,
  flagsOf,
  applyFlags,
  expunge,
  uidValidity,
  indexMessage,
  distinctFolders,
  syncProviderFolder,
  recordMove,
  accountGrantedScopes,
  imapIndexEvents,
  type FlagName,
  type CachedEnvelope,
} from './index-store.js';
import { logActivity } from '../observability/activity.js';
import { PROVIDER_FOLDERS, type CanonicalFolder } from '../providers/types.js';
import {
  parseMimeStructure,
  serializeBodyStructure,
  serializeEnvelope,
  findPart,
  imapDate,
  parseImapDate,
  quoted,
  type MimeNode,
} from './mime-structure.js';
import {
  tokenize,
  atom,
  parseSequenceSet,
  parseUidSet,
  type Token,
  type CommandSegments,
} from './protocol.js';
import type { Account, ImapMessage } from '../db/schema.js';

const CRLF = '\r\n';
const MAX_LITERAL = 64 * 1024;
const MAX_LINE = 64 * 1024;

interface TlsMaterial {
  key: string;
  cert: string;
}

export class ImapSession {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = Buffer.alloc(0);
  private secure: boolean;
  private closed = false;
  private state: 'notauth' | 'auth' | 'selected' = 'notauth';
  private account: Account | null = null;
  private canWrite = false;
  private folder = 'INBOX';
  private messages: ImapMessage[] = [];
  private readonly rawCache = new Map<string, Buffer>();
  private segments: CommandSegments = { parts: [] };
  private pendingText = '';
  private literalRemaining = 0;
  private literalChunks: Buffer[] = [];
  private idleTag: string | null = null;
  private authContinuation: ((line: string) => Promise<void>) | null = null;
  private processing = false;
  private readonly onIndexed = (accountId: string) => {
    if (this.account?.id === accountId && this.state === 'selected') {
      void this.notifyNewMail();
    }
  };

  // Pre-auth literals stay tiny (DoS guard); after login allow APPEND-sized ones.
  private maxLiteral(): number {
    return this.state === 'notauth' ? MAX_LITERAL : config.SMTP_MAX_SIZE;
  }

  constructor(
    socket: net.Socket,
    private readonly tlsMaterial: TlsMaterial,
    // True on the implicit-TLS listener, where the socket is already
    // encrypted and STARTTLS must not be offered.
    alreadySecure = false,
  ) {
    this.socket = socket;
    this.secure = alreadySecure;
    this.attach(socket);
    imapIndexEvents.on('indexed', this.onIndexed);
    this.write(`* OK [CAPABILITY ${this.capabilities()}] OutreachEmailMCP IMAP ready${CRLF}`);
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.destroy());
    socket.setTimeout(30 * 60_000, () => this.destroy());
  }

  private destroy(): void {
    if (this.closed) return;
    this.closed = true;
    imapIndexEvents.off('indexed', this.onIndexed);
    this.socket.destroy();
  }

  private write(data: string | Buffer): void {
    if (!this.closed) this.socket.write(data);
  }

  private capabilities(): string {
    const caps = ['IMAP4rev1', 'IDLE', 'LITERAL+', 'MOVE'];
    if (!this.secure) caps.push('STARTTLS');
    if (this.secure || config.IMAP_ALLOW_INSECURE_AUTH) caps.push('AUTH=PLAIN');
    else caps.push('LOGINDISABLED');
    return caps.join(' ');
  }

  private authAllowed(): boolean {
    return this.secure || config.IMAP_ALLOW_INSECURE_AUTH;
  }

  // --- input plumbing: lines + literals ---

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_LINE + this.maxLiteral()) {
      this.write(`* BAD Input too long${CRLF}`);
      return this.destroy();
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      for (;;) {
        if (this.closed) return;
        if (this.literalRemaining > 0) {
          if (this.buffer.length === 0) return;
          const take = Math.min(this.literalRemaining, this.buffer.length);
          this.literalChunks.push(this.buffer.subarray(0, take));
          this.buffer = this.buffer.subarray(take);
          this.literalRemaining -= take;
          if (this.literalRemaining > 0) return;
          this.segments.parts.push(Buffer.concat(this.literalChunks));
          this.literalChunks = [];
          continue;
        }
        const idx = this.buffer.indexOf('\n');
        if (idx === -1) return;
        let line = this.buffer.subarray(0, idx).toString('utf8');
        this.buffer = this.buffer.subarray(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        await this.onLine(line);
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'imap session error');
      this.write(`* BAD Internal error${CRLF}`);
      this.destroy();
    } finally {
      this.processing = false;
    }
  }

  private async onLine(line: string): Promise<void> {
    if (this.authContinuation) {
      const handler = this.authContinuation;
      this.authContinuation = null;
      return handler(line);
    }
    if (this.idleTag) {
      if (line.trim().toUpperCase() === 'DONE') {
        this.write(`${this.idleTag} OK IDLE terminated${CRLF}`);
        this.idleTag = null;
      }
      return;
    }
    const literalMatch = line.match(/\{(\d+)(\+)?\}$/);
    if (literalMatch) {
      const size = Number(literalMatch[1]);
      if (size > this.maxLiteral()) {
        this.write(`* BAD Literal too large${CRLF}`);
        return this.destroy();
      }
      this.segments.parts.push(line.slice(0, literalMatch.index));
      this.literalRemaining = size;
      if (!literalMatch[2]) this.write(`+ Ready${CRLF}`);
      return;
    }
    this.segments.parts.push(line);
    const segments = this.segments;
    this.segments = { parts: [] };
    await this.dispatch(segments);
  }

  // --- command dispatch ---

  private async dispatch(segments: CommandSegments): Promise<void> {
    const tokens = tokenize(segments);
    const tag = atom(tokens.shift());
    if (!tag) return;
    const command = atom(tokens.shift()).toUpperCase();
    const uidMode = command === 'UID';
    const effective = uidMode ? atom(tokens.shift()).toUpperCase() : command;

    try {
      switch (effective) {
        case 'CAPABILITY':
          this.write(`* CAPABILITY ${this.capabilities()}${CRLF}`);
          return this.ok(tag, 'CAPABILITY completed');
        case 'NOOP':
          if (this.state === 'selected') await this.refreshAndNotify();
          return this.ok(tag, 'NOOP completed');
        case 'LOGOUT':
          this.write(`* BYE Logging out${CRLF}`);
          this.ok(tag, 'LOGOUT completed');
          return this.destroy();
        case 'STARTTLS':
          return this.startTls(tag);
        case 'LOGIN':
          return this.login(tag, atom(tokens[0]), atom(tokens[1]));
        case 'AUTHENTICATE':
          return this.authenticate(tag, atom(tokens[0]).toUpperCase(), atom(tokens[1]));
        case 'LIST':
        case 'LSUB':
          return this.list(tag, effective, atom(tokens[1]));
        case 'SUBSCRIBE':
        case 'UNSUBSCRIBE':
        case 'CHECK':
          return this.ok(tag, `${effective} completed`);
        case 'STATUS':
          return this.status(tag, atom(tokens[0]), tokens[1]);
        case 'SELECT':
        case 'EXAMINE':
          return this.select(tag, atom(tokens[0]), effective === 'EXAMINE');
        case 'CLOSE':
          if (this.state !== 'selected') return this.bad(tag, 'Not selected');
          if (this.account) expunge(this.account.id, this.folder);
          this.state = 'auth';
          this.messages = [];
          return this.ok(tag, 'CLOSE completed');
        case 'APPEND':
          return this.append(tag, tokens, segments);
        case 'EXPUNGE':
          return this.doExpunge(tag);
        case 'SEARCH':
          return this.search(tag, tokens, uidMode);
        case 'FETCH':
          return this.fetch(tag, atom(tokens[0]), tokens[1] ?? tokens.slice(1), uidMode);
        case 'STORE':
          return this.store(tag, atom(tokens[0]), atom(tokens[1]), tokens[2], uidMode);
        case 'MOVE':
          return this.move(tag, atom(tokens[0]), atom(tokens[1]), uidMode);
        case 'IDLE':
          if (this.state === 'notauth') return this.no(tag, 'Authenticate first');
          this.idleTag = tag;
          this.write(`+ idling${CRLF}`);
          return;
        default:
          return this.bad(tag, `Unknown command ${effective}`);
      }
    } catch (err) {
      logger.warn({ err: String(err), command: effective }, 'imap command failed');
      return this.no(tag, 'Command failed');
    }
  }

  private ok(tag: string, message: string): void {
    this.write(`${tag} OK ${message}${CRLF}`);
  }
  private no(tag: string, message: string): void {
    this.write(`${tag} NO ${message}${CRLF}`);
  }
  private bad(tag: string, message: string): void {
    this.write(`${tag} BAD ${message}${CRLF}`);
  }

  // --- TLS / auth ---

  private startTls(tag: string): void {
    if (this.secure) return this.bad(tag, 'Already using TLS');
    this.ok(tag, 'Begin TLS negotiation now');
    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    plain.setTimeout(0);
    const secureSocket = new tls.TLSSocket(plain, {
      isServer: true,
      secureContext: tls.createSecureContext(this.tlsMaterial),
    });
    this.socket = secureSocket;
    this.secure = true;
    this.buffer = Buffer.alloc(0);
    this.attach(secureSocket);
  }

  private finishLogin(tag: string, username: string, password: string): void {
    const account = verifyProxyCredential(username, password);
    if (!account) {
      logActivity({
        category: 'imap',
        action: 'auth',
        status: 'failed',
        detail: `username=${username.slice(0, 60)}`,
        error: 'Invalid credentials',
      });
      return this.no(tag, '[AUTHENTICATIONFAILED] Invalid credentials');
    }
    this.account = account;
    this.canWrite = providerFor(account.provider).supportsWrite(
      accountGrantedScopes(account.id),
    );
    this.state = 'auth';
    logActivity({
      category: 'imap',
      action: 'auth',
      status: 'ok',
      accountId: account.id,
      detail: `username=${username}, upstreamWrite=${this.canWrite}`,
    });
    this.write(`* CAPABILITY ${this.capabilities()}${CRLF}`);
    this.ok(tag, `${username} authenticated`);
  }

  private login(tag: string, username: string, password: string): void {
    if (!this.authAllowed()) return this.no(tag, '[PRIVACYREQUIRED] Use STARTTLS first');
    if (!username || !password) return this.bad(tag, 'LOGIN expects username and password');
    this.finishLogin(tag, username, password);
  }

  private authenticate(tag: string, mechanism: string, initial: string): void {
    if (!this.authAllowed()) return this.no(tag, '[PRIVACYREQUIRED] Use STARTTLS first');
    if (mechanism !== 'PLAIN') return this.no(tag, 'Only AUTH=PLAIN is supported');
    const handle = (b64: string) => {
      const parts = Buffer.from(b64, 'base64').toString('utf8').split('\0');
      const username = parts[1] ?? '';
      const password = parts[2] ?? '';
      this.finishLogin(tag, username, password);
    };
    if (initial) return handle(initial);
    this.write(`+ ${CRLF}`);
    this.authContinuation = async (line) => handle(line.trim());
  }

  // --- mailbox commands ---

  // INBOX, Spam and Sent are provider-backed; other names exist only in the
  // local index (fed by APPEND).
  private normalizeMailbox(name: string): string {
    const upper = name.toUpperCase();
    if (upper === 'INBOX') return 'INBOX';
    if (
      upper === 'SPAM' || upper === 'JUNK' || upper === 'JUNK EMAIL' ||
      upper === '[GMAIL]/SPAM' || upper === 'JUNK E-MAIL'
    ) {
      return 'Spam';
    }
    if (upper === 'SENT' || upper === 'SENT ITEMS' || upper === 'SENT MAIL' || upper === '[GMAIL]/SENT MAIL') {
      return 'Sent';
    }
    return name;
  }

  private isProviderFolder(folder: string): folder is CanonicalFolder {
    return (PROVIDER_FOLDERS as string[]).includes(folder);
  }

  // Refresh a provider-backed folder's index from upstream, logging failures
  // to the activity log but serving the (stale) local index on error.
  private async syncFolder(folder: string): Promise<void> {
    if (!this.account || !this.isProviderFolder(folder)) return;
    try {
      const { added, removed } = await syncProviderFolder(
        this.account,
        folder,
        config.IMAP_BACKFILL_COUNT,
      );
      if (added > 0 || removed > 0) {
        logActivity({
          category: 'imap',
          action: 'folder-sync',
          status: 'ok',
          accountId: this.account.id,
          detail: `${folder}: +${added} -${removed}`,
        });
      }
    } catch (err) {
      logActivity({
        category: 'imap',
        action: 'folder-sync',
        status: 'failed',
        accountId: this.account.id,
        detail: folder,
        error: String(err),
      });
    }
  }

  private list(tag: string, command: string, pattern: string): void {
    if (this.state === 'notauth' || !this.account) return this.no(tag, 'Authenticate first');
    const p = pattern.toUpperCase();
    if (p === '') {
      this.write(`* ${command} (\\Noselect) "/" ""${CRLF}`);
    } else {
      for (const folder of distinctFolders(this.account.id)) {
        const attrs =
          folder === 'Sent'
            ? '\\HasNoChildren \\Sent'
            : folder === 'Spam'
              ? '\\HasNoChildren \\Junk'
              : '\\HasNoChildren';
        if (p === '*' || p === '%' || this.normalizeMailbox(pattern) === folder) {
          this.write(`* ${command} (${attrs}) "/" ${quoted(folder)}${CRLF}`);
        }
      }
    }
    this.ok(tag, `${command} completed`);
  }

  private async status(tag: string, mailbox: string, itemsToken: Token | undefined): Promise<void> {
    if (!this.account) return this.no(tag, 'Authenticate first');
    const folder = this.normalizeMailbox(mailbox);
    if (folder === 'INBOX') await backfillAccount(this.account);
    const rows = messagesFor(this.account.id, folder);
    const unseen = rows.filter((m) => !m.seen).length;
    const uidNext = (rows[rows.length - 1]?.uid ?? 0) + 1;
    const wanted = (Array.isArray(itemsToken) ? itemsToken : ['MESSAGES']).map((t) =>
      atom(t).toUpperCase(),
    );
    const values: Record<string, number> = {
      MESSAGES: rows.length,
      RECENT: 0,
      UNSEEN: unseen,
      UIDNEXT: uidNext,
      UIDVALIDITY: uidValidity(this.account),
    };
    const parts = wanted
      .filter((w) => w in values)
      .map((w) => `${w} ${values[w]}`)
      .join(' ');
    this.write(`* STATUS ${quoted(folder)} (${parts})${CRLF}`);
    this.ok(tag, 'STATUS completed');
  }

  private async select(tag: string, mailbox: string, readOnly: boolean): Promise<void> {
    if (!this.account) return this.no(tag, 'Authenticate first');
    this.folder = this.normalizeMailbox(mailbox);
    if (this.folder === 'INBOX') {
      await backfillAccount(this.account);
      try {
        await refreshAccountMailbox(this.account);
      } catch (err) {
        logger.debug({ err: String(err) }, 'imap select refresh failed');
      }
    } else if (this.isProviderFolder(this.folder)) {
      await this.syncFolder(this.folder);
    }
    this.messages = messagesFor(this.account.id, this.folder);
    this.state = 'selected';
    const unseenIdx = this.messages.findIndex((m) => !m.seen);
    const uidNext = (this.messages[this.messages.length - 1]?.uid ?? 0) + 1;
    this.write(`* FLAGS (\\Seen \\Answered \\Flagged \\Deleted)${CRLF}`);
    this.write(`* ${this.messages.length} EXISTS${CRLF}`);
    this.write(`* 0 RECENT${CRLF}`);
    if (unseenIdx !== -1) this.write(`* OK [UNSEEN ${unseenIdx + 1}] First unseen${CRLF}`);
    this.write(`* OK [UIDVALIDITY ${uidValidity(this.account)}] UIDs valid${CRLF}`);
    this.write(`* OK [UIDNEXT ${uidNext}] Predicted next UID${CRLF}`);
    this.write(`* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted)] Flags stored locally${CRLF}`);
    this.ok(tag, `[${readOnly ? 'READ-ONLY' : 'READ-WRITE'}] ${readOnly ? 'EXAMINE' : 'SELECT'} completed`);
  }

  private doExpunge(tag: string): void {
    if (this.state !== 'selected' || !this.account) return this.bad(tag, 'Not selected');
    const uids = new Set(expunge(this.account.id, this.folder));
    // report seq numbers highest-first so earlier numbers stay valid
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (uids.has(this.messages[i]!.uid)) this.write(`* ${i + 1} EXPUNGE${CRLF}`);
    }
    this.messages = this.messages.filter((m) => !uids.has(m.uid));
    this.ok(tag, 'EXPUNGE completed');
  }

  private async refreshAndNotify(): Promise<void> {
    if (!this.account) return;
    try {
      await refreshAccountMailbox(this.account);
    } catch {
      // provider hiccup — stale view is acceptable
    }
    await this.notifyNewMail();
  }

  private async notifyNewMail(): Promise<void> {
    if (!this.account || this.state !== 'selected') return;
    const fresh = messagesFor(this.account.id, this.folder);
    if (fresh.length > this.messages.length) {
      this.messages = fresh;
      this.write(`* ${fresh.length} EXISTS${CRLF}`);
    }
  }

  // --- APPEND ---

  private async append(tag: string, tokens: Token[], segments: CommandSegments): Promise<void> {
    if (this.state === 'notauth' || !this.account) return this.no(tag, 'Authenticate first');
    const mailbox = atom(tokens[0]);
    if (!mailbox) return this.bad(tag, 'APPEND expects a mailbox');
    const folder = this.normalizeMailbox(mailbox);
    // The message is the literal — take its raw bytes, not the tokenized
    // string (binary safety for attachments).
    const literal = [...segments.parts].reverse().find((p): p is Buffer => Buffer.isBuffer(p));
    if (!literal || literal.length === 0) return this.bad(tag, 'APPEND expects a message literal');
    const flagList = tokens.find((t): t is Token[] => Array.isArray(t)) ?? [];
    const flagNames: FlagName[] = [];
    for (const f of flagList) {
      const name = (['Seen', 'Answered', 'Flagged', 'Deleted'] as FlagName[]).find(
        (k) => k.toLowerCase() === atom(f).replace(/^\\/, '').toLowerCase(),
      );
      if (name) flagNames.push(name);
    }
    const localPath = path.join(config.messagesDir, `imap-${nanoid()}.eml`);
    fs.writeFileSync(localPath, literal);
    const parsed = await simpleParser(literal);
    const rowId = indexMessage(
      this.account.id,
      `local:${nanoid()}`,
      literal,
      parsed,
      folder,
      localPath,
    );
    if (rowId && flagNames.length > 0) applyFlags(rowId, flagNames, 'add');
    if (this.state === 'selected' && this.folder === folder) {
      this.messages = messagesFor(this.account.id, this.folder);
      this.write(`* ${this.messages.length} EXISTS${CRLF}`);
    }
    this.ok(tag, 'APPEND completed');
  }

  // --- message set resolution ---

  private resolveSet(spec: string, uidMode: boolean): ImapMessage[] {
    if (uidMode) {
      const uids = parseUidSet(spec, this.messages.map((m) => m.uid));
      return this.messages.filter((m) => uids.has(m.uid));
    }
    const seqs = parseSequenceSet(spec, this.messages.length);
    return seqs.map((n) => this.messages[n - 1]!).filter(Boolean);
  }

  private seqOf(msg: ImapMessage): number {
    return this.messages.findIndex((m) => m.id === msg.id) + 1;
  }

  private async getRaw(msg: ImapMessage): Promise<Buffer> {
    if (msg.localPath) return fs.readFileSync(msg.localPath);
    const cached = this.rawCache.get(msg.providerMessageId);
    if (cached) return cached;
    if (!this.account) throw new Error('no account');
    const raw = await providerFor(this.account.provider).getMessageRaw(
      this.account.id,
      msg.providerMessageId,
    );
    this.rawCache.set(msg.providerMessageId, raw);
    if (this.rawCache.size > 8) {
      const oldest = this.rawCache.keys().next().value as string;
      this.rawCache.delete(oldest);
    }
    return raw;
  }

  // --- SEARCH ---

  private async search(tag: string, tokens: Token[], uidMode: boolean): Promise<void> {
    if (this.state !== 'selected') return this.bad(tag, 'Not selected');
    let idx = 0;
    if (atom(tokens[0]).toUpperCase() === 'CHARSET') idx = 2; // accept and ignore
    let candidates = [...this.messages];
    while (idx < tokens.length) {
      const criterion = atom(tokens[idx]).toUpperCase();
      idx++;
      const env = (m: ImapMessage) => JSON.parse(m.envelopeJson) as CachedEnvelope;
      switch (criterion) {
        case 'ALL':
          break;
        case 'SEEN':
          candidates = candidates.filter((m) => m.seen);
          break;
        case 'UNSEEN':
        case 'NEW':
          candidates = candidates.filter((m) => !m.seen);
          break;
        case 'ANSWERED':
          candidates = candidates.filter((m) => m.answered);
          break;
        case 'UNANSWERED':
          candidates = candidates.filter((m) => !m.answered);
          break;
        case 'DELETED':
          candidates = candidates.filter((m) => m.deleted);
          break;
        case 'UNDELETED':
          candidates = candidates.filter((m) => !m.deleted);
          break;
        case 'FLAGGED':
          candidates = candidates.filter((m) => m.flagged);
          break;
        case 'SINCE': {
          const ts = parseImapDate(atom(tokens[idx]));
          idx++;
          if (ts === null) return this.bad(tag, 'Bad SINCE date');
          candidates = candidates.filter((m) => m.internalDate >= ts);
          break;
        }
        case 'BEFORE': {
          const ts = parseImapDate(atom(tokens[idx]));
          idx++;
          if (ts === null) return this.bad(tag, 'Bad BEFORE date');
          candidates = candidates.filter((m) => m.internalDate < ts);
          break;
        }
        case 'UID': {
          const uidSet = parseUidSet(atom(tokens[idx]), this.messages.map((m) => m.uid));
          idx++;
          candidates = candidates.filter((m) => uidSet.has(m.uid));
          break;
        }
        case 'FROM': {
          const value = atom(tokens[idx]).toLowerCase();
          idx++;
          candidates = candidates.filter((m) =>
            env(m).from.some((a) => `${a.name ?? ''} ${a.address ?? ''}`.toLowerCase().includes(value)),
          );
          break;
        }
        case 'TO': {
          const value = atom(tokens[idx]).toLowerCase();
          idx++;
          candidates = candidates.filter((m) =>
            env(m).to.some((a) => `${a.name ?? ''} ${a.address ?? ''}`.toLowerCase().includes(value)),
          );
          break;
        }
        case 'SUBJECT': {
          const value = atom(tokens[idx]).toLowerCase();
          idx++;
          candidates = candidates.filter((m) =>
            (env(m).subject ?? '').toLowerCase().includes(value),
          );
          break;
        }
        case 'HEADER': {
          const field = atom(tokens[idx]).toLowerCase();
          const value = atom(tokens[idx + 1]).toLowerCase();
          idx += 2;
          if (field === 'message-id') {
            candidates = candidates.filter((m) =>
              (env(m).messageId ?? '').toLowerCase().includes(value),
            );
          } else if (field === 'in-reply-to') {
            candidates = candidates.filter((m) =>
              (env(m).inReplyTo ?? '').toLowerCase().includes(value),
            );
          } else {
            // fall back to fetching headers (mailbox index is small)
            const matched: ImapMessage[] = [];
            for (const m of candidates) {
              try {
                const raw = await this.getRaw(m);
                const structure = parseMimeStructure(raw);
                const head = raw.subarray(0, structure.bodyStart).toString('utf8').toLowerCase();
                const re = new RegExp(`^${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:.*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'im');
                if (re.test(head.replace(/\r?\n[ \t]+/g, ' '))) matched.push(m);
              } catch {
                // unfetchable message can't match
              }
            }
            candidates = matched;
          }
          break;
        }
        default: {
          // bare sequence set as a criterion
          if (/^[\d,:*]+$/.test(criterion)) {
            const wanted = new Set(this.resolveSet(criterion, uidMode).map((m) => m.id));
            candidates = candidates.filter((m) => wanted.has(m.id));
            break;
          }
          return this.bad(tag, `Unsupported SEARCH criterion ${criterion}`);
        }
      }
    }
    const results = candidates.map((m) => (uidMode ? m.uid : this.seqOf(m)));
    this.write(`* SEARCH${results.length ? ' ' + results.join(' ') : ''}${CRLF}`);
    this.ok(tag, 'SEARCH completed');
  }

  // --- FETCH ---

  private async fetch(
    tag: string,
    setSpec: string,
    itemsToken: Token | Token[],
    uidMode: boolean,
  ): Promise<void> {
    if (this.state !== 'selected') return this.bad(tag, 'Not selected');
    if (!setSpec) return this.bad(tag, 'FETCH expects a sequence set');
    let items = (Array.isArray(itemsToken) ? itemsToken : [itemsToken]).map((t) => atom(t));
    // macros
    const macro = items.length === 1 ? items[0]!.toUpperCase() : '';
    if (macro === 'ALL') items = ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'];
    else if (macro === 'FAST') items = ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'];
    else if (macro === 'FULL')
      items = ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY'];
    if (uidMode && !items.some((i) => i.toUpperCase() === 'UID')) items.unshift('UID');

    const targets = this.resolveSet(setSpec, uidMode);
    let hadErrors = false;
    for (const msg of targets) {
      try {
        const parts: (string | Buffer)[] = [];
        let markSeen = false;
        for (const item of items) {
          const rendered = await this.fetchItem(msg, item);
          if (rendered === null) continue;
          parts.push(...rendered.chunks);
          if (rendered.markSeen) markSeen = true;
        }
        if (markSeen && !msg.seen) {
          applyFlags(msg.id, ['Seen'], 'add');
          msg.seen = 1;
          if (!items.some((i) => i.toUpperCase() === 'FLAGS')) {
            parts.push(`FLAGS (${flagsOf(msg).join(' ')})`);
          }
        }
        const head = `* ${this.seqOf(msg)} FETCH (`;
        this.write(head);
        parts.forEach((p, i) => {
          if (i > 0 && typeof p === 'string' && !p.startsWith(' ')) this.write(' ');
          this.write(p);
        });
        this.write(`)${CRLF}`);
      } catch (err) {
        hadErrors = true;
        logger.warn(
          { uid: msg.uid, err: String(err) },
          'imap fetch: failed to serve message',
        );
      }
    }
    if (hadErrors) return this.no(tag, 'FETCH completed with errors');
    this.ok(tag, 'FETCH completed');
  }

  private literal(prefix: string, data: Buffer): (string | Buffer)[] {
    return [`${prefix} {${data.length}}${CRLF}`, data];
  }

  private async fetchItem(
    msg: ImapMessage,
    rawItem: string,
  ): Promise<{ chunks: (string | Buffer)[]; markSeen: boolean } | null> {
    const item = rawItem.toUpperCase();
    if (item === 'UID') return { chunks: [`UID ${msg.uid}`], markSeen: false };
    if (item === 'FLAGS') return { chunks: [`FLAGS (${flagsOf(msg).join(' ')})`], markSeen: false };
    if (item === 'INTERNALDATE')
      return { chunks: [`INTERNALDATE ${quoted(imapDate(msg.internalDate))}`], markSeen: false };
    if (item === 'RFC822.SIZE') return { chunks: [`RFC822.SIZE ${msg.size}`], markSeen: false };
    if (item === 'ENVELOPE') {
      const env = JSON.parse(msg.envelopeJson) as CachedEnvelope;
      return { chunks: [`ENVELOPE ${serializeEnvelope(env)}`], markSeen: false };
    }
    if (item === 'BODYSTRUCTURE' || item === 'BODY') {
      const raw = await this.getRaw(msg);
      const structure = parseMimeStructure(raw);
      return {
        chunks: [`${item} ${serializeBodyStructure(structure)}`],
        markSeen: false,
      };
    }
    if (item === 'RFC822') {
      const raw = await this.getRaw(msg);
      return { chunks: this.literal('RFC822', raw), markSeen: true };
    }
    if (item === 'RFC822.HEADER') {
      const raw = await this.getRaw(msg);
      const structure = parseMimeStructure(raw);
      return {
        chunks: this.literal('RFC822.HEADER', raw.subarray(0, structure.bodyStart)),
        markSeen: false,
      };
    }
    if (item === 'RFC822.TEXT') {
      const raw = await this.getRaw(msg);
      const structure = parseMimeStructure(raw);
      return { chunks: this.literal('RFC822.TEXT', raw.subarray(structure.bodyStart)), markSeen: true };
    }

    const sectionMatch = rawItem.match(/^(BODY|BODY\.PEEK)\[([^\]]*)\](?:<(\d+)\.(\d+)>)?$/i);
    if (!sectionMatch) return null; // unknown item — skip gracefully
    const peek = sectionMatch[1]!.toUpperCase() === 'BODY.PEEK';
    const section = sectionMatch[2]!;
    const raw = await this.getRaw(msg);
    const structure = parseMimeStructure(raw);
    let data = this.sliceSection(raw, structure, section);
    if (data === null) return null;
    let suffix = '';
    if (sectionMatch[3] !== undefined) {
      const offset = Number(sectionMatch[3]);
      const length = Number(sectionMatch[4]);
      data = data.subarray(offset, offset + length);
      suffix = `<${offset}>`;
    }
    // echo the section back without the .PEEK
    const label = `BODY[${section}]${suffix}`;
    return { chunks: this.literal(label, data), markSeen: !peek };
  }

  private sliceSection(raw: Buffer, structure: MimeNode, section: string): Buffer | null {
    if (section === '') return raw;
    const upper = section.toUpperCase();
    if (upper === 'HEADER') return raw.subarray(0, structure.bodyStart);
    if (upper === 'TEXT') return raw.subarray(structure.bodyStart);
    const fieldsMatch = upper.match(/^HEADER\.FIELDS(\.NOT)? \((.*)\)$/);
    if (fieldsMatch) {
      const negate = Boolean(fieldsMatch[1]);
      const wanted = fieldsMatch[2]!.split(/\s+/).filter(Boolean).map((f) => f.toLowerCase());
      const head = raw.subarray(0, structure.bodyStart).toString('latin1');
      const lines = head.split(/\r?\n/);
      const out: string[] = [];
      let including = false;
      for (const line of lines) {
        if (/^[ \t]/.test(line)) {
          if (including) out.push(line);
          continue;
        }
        const name = line.slice(0, line.indexOf(':')).trim().toLowerCase();
        const inList = wanted.includes(name);
        including = line.includes(':') && (negate ? !inList : inList);
        if (including) out.push(line);
      }
      return Buffer.from(out.join('\r\n') + '\r\n\r\n', 'latin1');
    }
    // part path, optionally with .MIME / .HEADER / .TEXT suffix
    const partMatch = upper.match(/^([\d.]+?)(?:\.(MIME|HEADER|TEXT))?$/);
    if (!partMatch) return null;
    const node = findPart(structure, partMatch[1]!);
    if (!node) return null;
    if (partMatch[2] === 'MIME' || partMatch[2] === 'HEADER') {
      return raw.subarray(node.headerStart, node.bodyStart);
    }
    if (partMatch[2] === 'TEXT') return raw.subarray(node.bodyStart, node.bodyEnd);
    return raw.subarray(node.bodyStart, node.bodyEnd);
  }

  // --- MOVE (warmup: pull messages out of Spam upstream) ---

  private async move(
    tag: string,
    setSpec: string,
    mailbox: string,
    uidMode: boolean,
  ): Promise<void> {
    if (this.state !== 'selected' || !this.account) return this.bad(tag, 'Not selected');
    const target = this.normalizeMailbox(mailbox);
    const source = this.folder;
    if (!this.isProviderFolder(source) || !this.isProviderFolder(target) || target === 'Sent') {
      return this.no(tag, `MOVE is supported between INBOX and Spam`);
    }
    if (source === target) return this.ok(tag, 'MOVE completed');
    if (!this.canWrite) {
      return this.no(
        tag,
        'Upstream changes not permitted — reconnect this account to grant mailbox-write access',
      );
    }
    const targets = this.resolveSet(setSpec, uidMode);
    if (targets.length === 0) return this.ok(tag, 'MOVE completed');
    const provider = providerFor(this.account.provider);
    const moved: ImapMessage[] = [];
    for (const msg of targets) {
      if (msg.localPath) continue; // local-only rows have no upstream copy
      try {
        const newId = await provider.moveMessage(
          this.account.id,
          msg.providerMessageId,
          source,
          target,
        );
        recordMove(msg, target, newId);
        moved.push(msg);
        logActivity({
          category: 'imap',
          action: 'move',
          status: 'ok',
          accountId: this.account.id,
          detail: `${source}→${target} uid=${msg.uid} subject=${(JSON.parse(msg.envelopeJson) as CachedEnvelope).subject ?? ''}`.slice(0, 300),
        });
      } catch (err) {
        logActivity({
          category: 'imap',
          action: 'move',
          status: 'failed',
          accountId: this.account.id,
          detail: `${source}→${target} uid=${msg.uid}`,
          error: String(err),
        });
      }
    }
    // Report moved messages as expunged from the source, highest seq first
    const movedIds = new Set(moved.map((m) => m.id));
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (movedIds.has(this.messages[i]!.id)) this.write(`* ${i + 1} EXPUNGE${CRLF}`);
    }
    this.messages = this.messages.filter((m) => !movedIds.has(m.id));
    if (moved.length < targets.filter((t) => !t.localPath).length) {
      return this.no(tag, 'MOVE completed with errors (see activity log)');
    }
    return this.ok(tag, 'MOVE completed');
  }

  // --- STORE ---

  private async store(
    tag: string,
    setSpec: string,
    operation: string,
    flagsToken: Token | undefined,
    uidMode: boolean,
  ): Promise<void> {
    if (this.state !== 'selected') return this.bad(tag, 'Not selected');
    const op = operation.toUpperCase();
    const match = op.match(/^([+-]?)FLAGS(\.SILENT)?$/);
    if (!match) return this.bad(tag, 'STORE expects FLAGS');
    const mode = match[1] === '+' ? 'add' : match[1] === '-' ? 'remove' : 'set';
    const silent = Boolean(match[2]);
    const flagAtoms = (Array.isArray(flagsToken) ? flagsToken : flagsToken ? [flagsToken] : [])
      .map((t) => atom(t).replace(/^\\/, ''))
      .filter(Boolean);
    const known: FlagName[] = [];
    for (const f of flagAtoms) {
      const name = (['Seen', 'Answered', 'Flagged', 'Deleted'] as FlagName[]).find(
        (k) => k.toLowerCase() === f.toLowerCase(),
      );
      if (name) known.push(name);
    }
    // Upstream sync of \Seen and \Flagged (warmup marks messages read/starred)
    // for provider-backed folders when the account grants write access.
    const syncUpstream =
      this.canWrite &&
      this.isProviderFolder(this.folder) &&
      known.some((k) => k === 'Seen' || k === 'Flagged');
    for (const msg of this.resolveSet(setSpec, uidMode)) {
      applyFlags(msg.id, known, mode);
      const updated = db
        .select()
        .from(schema.imapMessages)
        .where(eq(schema.imapMessages.id, msg.id))
        .get();
      if (updated) {
        Object.assign(msg, updated);
        if (!silent) {
          const uidPart = uidMode ? `UID ${msg.uid} ` : '';
          this.write(`* ${this.seqOf(msg)} FETCH (${uidPart}FLAGS (${flagsOf(msg).join(' ')}))${CRLF}`);
        }
        if (syncUpstream && !msg.localPath && this.account) {
          const wants: { seen?: boolean; flagged?: boolean } = {};
          if (known.includes('Seen')) wants.seen = mode !== 'remove';
          if (known.includes('Flagged')) wants.flagged = mode !== 'remove';
          if (mode === 'set') {
            wants.seen = known.includes('Seen');
            wants.flagged = known.includes('Flagged');
          }
          try {
            await providerFor(this.account.provider).setMessageFlags(
              this.account.id,
              msg.providerMessageId,
              wants,
            );
          } catch (err) {
            logActivity({
              category: 'imap',
              action: 'flags',
              status: 'failed',
              accountId: this.account.id,
              detail: `uid=${msg.uid} ${JSON.stringify(wants)}`,
              error: String(err),
            });
          }
        }
      }
    }
    this.ok(tag, 'STORE completed');
  }
}

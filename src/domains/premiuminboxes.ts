/**
 * Premium Inboxes client API: workspaces, purchase orders, order status with
 * the delivered mailboxes, and cancellations. JSON with an agency token in
 * the x-api-token header; 100 requests a minute.
 */

export interface PiWorkspace {
  id: string;
  name: string;
  status: string;
  hasActiveSubscriptions: boolean;
}

export interface PiHosting {
  platform: 'Namecheap' | 'Cloudflare' | 'GoDaddy' | 'Porkbun' | string;
  username?: string;
  password?: string;
  namecheapAccessTutorial?: string;
  namecheapBackupCodes?: string;
  goDaddyAccessTutorial?: string;
  goDaddyAccountName?: string;
  porkbunAccessTutorial?: string;
}

/** The provisioner's sequencer enum; "Other" hands the details over in additionalInfo. */
export const PI_SEQUENCER_OTHER = 'Other - Indicated @ "Additional Information" Field Below';

export interface PiSequencer {
  platform: string;
  username: string;
  password: string;
  workspaceName?: string;
  enableWarmup?: boolean;
}

export interface PiPurchase {
  emailProvider: 'Google' | 'Microsoft';
  hosting: PiHosting;
  /** Optional to their validator, but their handler crashes without it; always sent. */
  sequencer: PiSequencer;
  domains: string;
  forwardedDomain?: string;
  numberOfInboxes: number;
  inboxesPerDomain: number;
  prefixVariants: string[];
  emailFirstName: string;
  emailLastName: string;
  password?: string;
  profilePictureLink?: string;
  masterInboxEmail?: string;
  additionalInfo?: string;
  coupon?: string;
  manualPersonas?: { firstName: string; lastName: string; domains: string[]; prefixVariants: string[] }[];
  insured?: boolean;
  flowStartedAt?: number;
}

export interface PiDeliveredEmail {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  status: string;
}

export interface PiOrder {
  _id: string;
  status: string;
  emailProvider: string;
  domains: string[];
  prefixVariants: string[];
  issues: { reason: string }[];
  inboxes: { total: number; perDomain: number };
  emails: PiDeliveredEmail[];
  fullName?: string;
  workspaceId?: string;
  workspaceName?: string;
  subscriptionId?: string;
  subscriptionStatus?: string;
  subscriptionPrice?: number;
  tags?: { name: string }[];
  additionalInfo?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PiSubscription {
  _id: string;
  status: string;
  price: number;
  discount: number;
  items: { id: string; type: string; quantity: number; unitPrice: number; price: number }[];
  /** Order ids, or whole orders in the list endpoint. */
  orders?: (string | { _id?: string })[];
  nextBillingDate?: unknown;
  cancelled?: { date?: unknown; reason?: string };
}

export interface PiEmailAccount {
  orderId: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  domain: string;
  status: string;
  createdAt: string;
}

export class PremiumInboxesError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'PremiumInboxesError';
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const BASE = 'https://api.premiuminboxes.com/api';

async function request<T>(fetchImpl: FetchLike, url: string, method: string, path: string, headers: Record<string, string>, body?: unknown, timeoutMs = 30_000): Promise<T> {
  const res = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: string; name?: string; errors?: { property?: string; constraints?: Record<string, string> }[] };
      msg = j.message ?? j.name ?? msg;
      const details = (j.errors ?? []).flatMap((e) => Object.values(e.constraints ?? {}).map((c) => c || e.property || '')).filter(Boolean);
      if (details.length) msg = `${msg} ${details.join('; ')}`;
    } catch {
      // plain text error
    }
    if (res.status === 429) msg = `Rate limited by Premium Inboxes; retry after ${res.headers.get('retry-after') ?? '60'}s`;
    throw new PremiumInboxesError(`Premium Inboxes ${method} ${path}: HTTP ${res.status} ${msg}`, res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export class PremiumInboxesClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly base = BASE,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, opts: { workspaceId?: string | null; timeoutMs?: number } = {}): Promise<T> {
    const headers: Record<string, string> = { 'x-api-token': this.token, 'Content-Type': 'application/json' };
    if (opts.workspaceId) headers['x-workspace-id'] = opts.workspaceId;
    return request<T>(this.fetchImpl, `${this.base}${path}`, method, path, headers, body, opts.timeoutMs);
  }

  async workspaces(): Promise<PiWorkspace[]> {
    const r = await this.call<{ workspaces: PiWorkspace[] }>('GET', '/client/workspaces');
    return r.workspaces ?? [];
  }

  async createWorkspace(name: string): Promise<PiWorkspace> {
    const r = await this.call<{ workspace: PiWorkspace }>('POST', '/client/workspaces', {
      name,
      copyPaymentMethod: true,
      copyBillingDetails: true,
      copyPlatformSettings: true,
    });
    return r.workspace;
  }

  /** Takes 30-45 s at their end; returns the order id. */
  async purchase(body: PiPurchase, workspaceId?: string | null): Promise<string> {
    const r = await this.call<string | { orderId?: string; id?: string; _id?: string }>('POST', '/client/purchase', body, { workspaceId, timeoutMs: 120_000 });
    if (typeof r === 'string') return r.replace(/^"|"$/g, '');
    return String(r.orderId ?? r.id ?? r._id ?? '');
  }

  /** Subscriptions with their plan lines; the unit price is what an inbox costs per 4 weeks, in cents. */
  async subscriptions(workspaceId?: string | null): Promise<PiSubscription[]> {
    const r = await this.call<{ data: PiSubscription[] }>('GET', '/client/subscription', undefined, { workspaceId });
    return r.data ?? [];
  }

  async orders(workspaceId?: string | null): Promise<PiOrder[]> {
    const r = await this.call<{ data: PiOrder[] }>('GET', '/client/order', undefined, { workspaceId });
    return r.data ?? [];
  }

  async order(orderId: string): Promise<PiOrder> {
    return this.call<PiOrder>('GET', `/client/order/${encodeURIComponent(orderId)}`);
  }

  async emailAccounts(workspaceId?: string | null): Promise<PiEmailAccount[]> {
    const r = await this.call<{ emailAccounts: PiEmailAccount[] }>('GET', '/client/email-account', undefined, { workspaceId });
    return r.emailAccounts ?? [];
  }

  /** Stop billing an order's subscription. Without removeImmediately the
   *  mailboxes stay until the paid period ends; with it they are removed now. */
  async cancelSubscription(subscriptionId: string, opts: { reason: string; removeImmediately: boolean }): Promise<void> {
    await this.call('PUT', `/client/subscription/cancel/${encodeURIComponent(subscriptionId)}`, { reason: opts.reason, removeImmediately: opts.removeImmediately });
  }

  async reactivateSubscription(subscriptionId: string): Promise<void> {
    await this.call('PUT', `/client/subscription/reactivate/${encodeURIComponent(subscriptionId)}`);
  }

  async cancelEmails(emails: { orderId: string; email: string; domain: string }[], workspaceId?: string | null): Promise<{ cancelledCount: number; cancelledEmails: string[] }> {
    return this.call('POST', '/client/email-account/cancel', { emails }, { workspaceId });
  }
}

/** The portal's ticket type for mailboxes that stopped working. */
export const PI_TICKET_DISCONNECTED = 'Disconnected Email Accounts';

export interface PiTicketInput {
  type: string;
  /** The order's id at Premium Inboxes. */
  order?: string | null;
  subscription?: string | null;
  emailAccounts: string[];
  notes: string;
}

/**
 * The portal's own API, signed in with the portal email and password. The
 * agency API token cannot open tickets; only a portal session can, so this
 * is the one place that logs in as the person.
 */
export class PremiumInboxesPortal {
  private session: string | null = null;

  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly base = BASE,
  ) {}

  async login(): Promise<void> {
    const r = await request<{ token?: string }>(this.fetchImpl, `${this.base}/web/auth/login`, 'POST', '/web/auth/login', { 'Content-Type': 'application/json' }, { email: this.email, password: this.password });
    if (!r?.token) throw new PremiumInboxesError('Premium Inboxes portal login returned no session');
    this.session = r.token;
  }

  /** Signs in on first use, and once more when the session has expired. */
  private async call<T>(method: string, path: string, body?: unknown, workspaceId?: string | null): Promise<T> {
    if (!this.session) await this.login();
    const send = () => {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.session}`, 'Content-Type': 'application/json' };
      if (workspaceId) headers['X-Workspace-Id'] = workspaceId;
      return request<T>(this.fetchImpl, `${this.base}${path}`, method, path, headers, body);
    };
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof PremiumInboxesError) || err.status !== 401) throw err;
      await this.login();
      return send();
    }
  }

  /** The agency's own workspace, for orders that do not name one. */
  async selfWorkspaceId(): Promise<string | null> {
    const r = await this.call<{ clients?: { _id: string; isSelfClient?: boolean }[] }>('GET', '/web/clients');
    return r.clients?.find((c) => c.isSelfClient)?._id ?? null;
  }

  /** Opens a ticket in the workspace the order lives in; returns its id when the portal says. */
  async createTicket(input: PiTicketInput, workspaceId: string | null): Promise<string | null> {
    const r = await this.call<{ _id?: string; id?: string } | string>('POST', '/web/ticket', input, workspaceId);
    if (r && typeof r === 'object') return r._id ?? r.id ?? null;
    return null;
  }
}

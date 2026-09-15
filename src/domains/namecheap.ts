/**
 * Namecheap registrar API: availability, prices, registration, the account's
 * domain list. XML over GET, one command per call; the account must have API
 * access enabled and the caller's IP whitelisted.
 */

import { XMLParser } from 'fast-xml-parser';

export interface RegistrantContact {
  firstName: string;
  lastName: string;
  organization?: string;
  address1: string;
  city: string;
  stateProvince: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2, e.g. NL. */
  country: string;
  /** Namecheap format: +CC.number, e.g. +31.612345678 */
  phone: string;
  email: string;
}

export interface NamecheapConfig {
  apiUser: string;
  apiKey: string;
  /** Usually the same as apiUser. */
  username: string;
  /** The whitelisted caller IP. */
  clientIp: string;
  sandbox?: boolean;
  contact: RegistrantContact;
}

export interface Availability {
  domain: string;
  available: boolean;
  premium: boolean;
  premiumPrice: number | null;
}

export interface TldPrice {
  tld: string;
  price: number;
  currency: string;
}

export interface Registration {
  domain: string;
  registered: boolean;
  chargedAmount: number;
  domainId: string;
  orderId: string;
  transactionId: string;
  whoisGuard: boolean;
}

export interface RegistrarDomain {
  domain: string;
  expiresAt: number | null;
  expired: boolean;
  autoRenew: boolean;
}

export class NamecheapError extends Error {
  constructor(message: string, readonly code: string | null = null) {
    super(message);
    this.name = 'NamecheapError';
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// Everything stays a string: a phone like +31.612345678 must not become a number.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', textNodeName: 'text', parseTagValue: false, parseAttributeValue: false });
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export class NamecheapClient {
  constructor(private readonly cfg: NamecheapConfig, private readonly fetchImpl: FetchLike = fetch) {}

  get endpoint(): string {
    return this.cfg.sandbox ? 'https://api.sandbox.namecheap.com/xml.response' : 'https://api.namecheap.com/xml.response';
  }

  private async call(command: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const q = new URLSearchParams({
      ApiUser: this.cfg.apiUser,
      ApiKey: this.cfg.apiKey,
      UserName: this.cfg.username,
      ClientIp: this.cfg.clientIp,
      Command: command,
      ...params,
    });
    const res = await this.fetchImpl(`${this.endpoint}?${q}`, { signal: AbortSignal.timeout(60_000) });
    const xml = await res.text();
    if (!res.ok) throw new NamecheapError(`Namecheap HTTP ${res.status}: ${xml.slice(0, 200)}`);
    const doc = parser.parse(xml) as { ApiResponse?: Record<string, unknown> };
    const api = doc.ApiResponse;
    if (!api) throw new NamecheapError(`Unexpected response from Namecheap: ${xml.slice(0, 200)}`);
    if (api.Status !== 'OK') {
      const errors = asArray((api.Errors as { Error?: unknown })?.Error).map((e) =>
        typeof e === 'string' ? { text: e, Number: null } : (e as { text?: string; Number?: string }),
      );
      const first = errors[0];
      throw new NamecheapError(first?.text ?? 'Namecheap returned an error', first?.Number ?? null);
    }
    return (api.CommandResponse ?? {}) as Record<string, unknown>;
  }

  /** Up to 50 domains per call. */
  async check(domains: string[]): Promise<Availability[]> {
    const out: Availability[] = [];
    for (let i = 0; i < domains.length; i += 50) {
      const batch = domains.slice(i, i + 50);
      const r = await this.call('namecheap.domains.check', { DomainList: batch.join(',') });
      for (const d of asArray(r.DomainCheckResult as Record<string, string> | Record<string, string>[])) {
        out.push({
          domain: d.Domain!.toLowerCase(),
          available: d.Available === 'true',
          premium: d.IsPremiumName === 'true',
          premiumPrice: d.PremiumRegistrationPrice ? Number(d.PremiumRegistrationPrice) : null,
        });
      }
    }
    return out;
  }

  /** First-year registration price per TLD, in the account currency. */
  async pricing(tlds: string[]): Promise<TldPrice[]> {
    const out: TldPrice[] = [];
    for (const tld of tlds) {
      const r = await this.call('namecheap.users.getPricing', {
        ProductType: 'DOMAIN',
        ProductCategory: 'DOMAINS',
        ActionName: 'REGISTER',
        ProductName: tld.toUpperCase(),
      });
      const type = asArray((r.UserGetPricingResult as { ProductType?: unknown })?.ProductType)[0] as Record<string, unknown> | undefined;
      const cat = asArray(type?.ProductCategory)[0] as Record<string, unknown> | undefined;
      const product = asArray(cat?.Product).find((p) => String((p as { Name?: string }).Name).toLowerCase() === tld.toLowerCase()) as Record<string, unknown> | undefined;
      const price = asArray(product?.Price as Record<string, string> | Record<string, string>[]).find((p) => p.Duration === '1') ?? asArray(product?.Price as Record<string, string>[])[0];
      if (!price) continue;
      out.push({ tld: tld.toLowerCase(), price: Number(price.YourPrice ?? price.Price), currency: price.Currency ?? 'USD' });
    }
    return out;
  }

  /** Register for one year with free WhoisGuard; the same contact for every role. */
  async register(domain: string, years = 1): Promise<Registration> {
    const c = this.cfg.contact;
    const contact: Record<string, string> = {};
    for (const role of ['Registrant', 'Tech', 'Admin', 'AuxBilling']) {
      contact[`${role}FirstName`] = c.firstName;
      contact[`${role}LastName`] = c.lastName;
      if (c.organization) contact[`${role}OrganizationName`] = c.organization;
      contact[`${role}Address1`] = c.address1;
      contact[`${role}City`] = c.city;
      contact[`${role}StateProvince`] = c.stateProvince;
      contact[`${role}PostalCode`] = c.postalCode;
      contact[`${role}Country`] = c.country;
      contact[`${role}Phone`] = c.phone;
      contact[`${role}EmailAddress`] = c.email;
    }
    const create = (whoisGuard: boolean) =>
      this.call('namecheap.domains.create', {
        DomainName: domain,
        Years: String(years),
        AddFreeWhoisguard: whoisGuard ? 'yes' : 'no',
        WGEnabled: whoisGuard ? 'yes' : 'no',
        ...contact,
      });
    let r: Record<string, unknown>;
    try {
      r = await create(true);
    } catch (err) {
      // Country TLDs such as .nl and .de publish their own registrant rules
      // and refuse WhoisGuard; register those without it.
      if (err instanceof NamecheapError && /whoisguard/i.test(err.message)) r = await create(false);
      else throw err;
    }
    const d = asArray(r.DomainCreateResult as Record<string, string> | Record<string, string>[])[0];
    if (!d) throw new NamecheapError('Namecheap returned no registration result');
    return {
      domain: d.Domain!.toLowerCase(),
      registered: d.Registered === 'true',
      chargedAmount: Number(d.ChargedAmount ?? 0),
      domainId: String(d.DomainID ?? ''),
      orderId: String(d.OrderID ?? ''),
      transactionId: String(d.TransactionID ?? ''),
      whoisGuard: d.WhoisguardEnable === 'true',
    };
  }

  /** Account funds. API purchases are paid from this balance only; Namecheap never charges a card through the API. */
  async balances(): Promise<{ available: number; total: number; currency: string }> {
    const r = await this.call('namecheap.users.getBalances', {});
    const b = asArray(r.UserGetBalancesResult as Record<string, string> | Record<string, string>[])[0] ?? {};
    return { available: Number(b.AvailableBalance ?? 0), total: Number(b.AccountBalance ?? 0), currency: String(b.Currency ?? 'USD') };
  }

  /** The account's address book; the default entry is the registrant Namecheap itself would use. */
  async addresses(): Promise<{ id: string; name: string; isDefault: boolean }[]> {
    const r = await this.call('namecheap.users.address.getList', {});
    const rows = asArray((r.AddressGetListResult as { List?: unknown })?.List) as Record<string, string>[];
    return rows.map((a) => ({ id: String(a.AddressId), name: String(a.AddressName ?? ''), isDefault: a.IsDefault === 'true' }));
  }

  async addressInfo(addressId: string): Promise<RegistrantContact> {
    const r = await this.call('namecheap.users.address.getInfo', { AddressId: addressId });
    const info = (r.GetAddressInfoResult ?? {}) as Record<string, unknown>;
    const text = (k: string): string => {
      const v = info[k];
      if (v === undefined || v === null) return '';
      if (typeof v === 'object') return String((v as { text?: string }).text ?? '');
      return String(v);
    };
    return {
      firstName: text('FirstName'),
      lastName: text('LastName'),
      organization: text('Organization') || undefined,
      address1: text('Address1'),
      city: text('City'),
      stateProvince: text('StateProvince') || text('StateProvinceChoice'),
      postalCode: text('Zip'),
      country: text('Country'),
      phone: text('Phone'),
      email: text('EmailAddress'),
    };
  }

  /** The default address book entry as a registrant contact, or null when the book is empty. */
  async defaultContact(): Promise<RegistrantContact | null> {
    const all = await this.addresses();
    const pick = all.find((a) => a.isDefault) ?? all[0];
    return pick ? this.addressInfo(pick.id) : null;
  }

  async list(): Promise<RegistrarDomain[]> {
    const out: RegistrarDomain[] = [];
    for (let page = 1; page < 50; page++) {
      const r = await this.call('namecheap.domains.getList', { PageSize: '100', Page: String(page) });
      const rows = asArray((r.DomainGetListResult as { Domain?: unknown })?.Domain) as Record<string, string>[];
      for (const d of rows) {
        out.push({
          domain: d.Name!.toLowerCase(),
          expiresAt: parseNamecheapDate(d.Expires),
          expired: d.IsExpired === 'true',
          autoRenew: d.AutoRenew === 'true',
        });
      }
      const paging = r.Paging as { TotalItems?: string } | undefined;
      if (rows.length < 100 || (paging?.TotalItems && out.length >= Number(paging.TotalItems))) break;
    }
    return out;
  }
}

/** Namecheap dates are MM/DD/YYYY. */
export function parseNamecheapDate(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
}

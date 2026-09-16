# OutreachEmailMCP

**Free, open-source (AGPL) email gateway.** Connect OAuth-based mail providers (**Gmail**, **Microsoft 365 / Outlook**) once, then use those mailboxes from anywhere: email sequencers over **SMTP + IMAP**, AI agents over **MCP**, your own code over **REST + webhooks** — no OAuth plumbing, no app passwords.

```
 Instantly / Smartlead / … ──SMTP+IMAP──▶ ┌──────────────────┐ ──Gmail API──▶ Google
 AI agents (Claude, MCP) ─────MCP───────▶ │ OutreachEmailMCP │ ──MS Graph──▶ Microsoft
 your scripts & apps ────REST+webhooks──▶ └──────────────────┘ ◀──polling──
```

The public landing page at `/` explains the product; the dashboard lives at `/ui`: one **Mailboxes** page with every connected mailbox, its warmup health, placement chart and DNS posture, where you select mailboxes to chart, tag and change them together.

- **Outbound**: SMTP submission (STARTTLS, per-account credentials) and `POST /api/v1/accounts/:id/messages`. Everything goes through a crash-safe SQLite-backed queue with exponential-backoff retries, then out via the provider's HTTP API (Gmail API / Microsoft Graph — works even where SMTP AUTH is disabled).
- **Inbound**: read folders/messages/attachments over the API; a poller (Gmail `history.list` / Graph delta) fires **HMAC-signed webhooks** for new mail; and an **IMAP server** exposes the INBOX to any IMAP client (reply detection in tools like Instantly) using the same credentials as SMTP.
- **Reliability**: jobs survive restarts; auth failures pause the account (mail stays queued) until you reconnect; the send log shows every message's status.
- **Zero infra**: one Node process, SQLite, no Redis/queue service.

## Quick start

```bash
npm install
cp .env.example .env
# in .env, set at minimum:
#   MASTER_KEY=$(openssl rand -base64 32)
#   ADMIN_PASSWORD=something-secret
#   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (and/or MICROSOFT_*)
npm start
```

Open http://localhost:3000/ui, log in with `ADMIN_PASSWORD`, and click **Connect Gmail** / **Connect Microsoft**.

Or with Docker: `MASTER_KEY=... ADMIN_PASSWORD=... docker compose up -d`.

## Provider app registration

### Google (Gmail)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Gmail API**.
2. Configure the OAuth consent screen (External is fine; in *Testing* mode add your own address as a test user).
3. Create an **OAuth client ID** of type **Web application** with redirect URI: `{BASE_URL}/auth/google/callback` (e.g. `http://localhost:3000/auth/google/callback`).
4. Put the client ID/secret in `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

Scopes used: `gmail.send`, `gmail.modify`, `openid email` (`gmail.modify` enables warmup: moving mail out of Spam and syncing read/star state upstream).

### Microsoft (Outlook / Microsoft 365)

1. In [Azure Portal → App registrations](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade), create a registration. Supported account types: *Accounts in any organizational directory and personal Microsoft accounts*.
2. Add a **Web** platform with redirect URI: `{BASE_URL}/auth/microsoft/callback`.
3. Create a **client secret** (Certificates & secrets).
4. Put them in `.env` as `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`. Keep `MICROSOFT_TENANT=common` unless you want to lock it to one tenant.

Scopes used: `Mail.Send`, `Mail.ReadWrite`, `User.Read`, `offline_access` (`Mail.ReadWrite` enables warmup folder moves and flag sync).

> **Upgrading from a read-only install?** Accounts connected before the write scopes were added keep working for send/read, but warmup operations return an IMAP `NO` until the account is **reconnected** (account page shows a banner). Reconnecting re-runs consent with the new scope; credentials and history are kept.

## Connect links (automation-friendly onboarding)

The dashboard shows an **onboarding link** — one signed URL that opens a connect page *without* requiring the admin login. Hand it to whoever adds mailboxes (a teammate, a VA, an automation) and they open it once per mailbox.

**One link, many mailboxes.** Nothing about the link is consumed by use, and it does not expire by default. Each visit shows the workspace, how many mailboxes are connected against the plan limit, which ones are already in (so nobody adds a duplicate), and buttons for every configured provider. After each consent round-trip the browser comes back to the same page with the result, ready for the next mailbox. Concurrent flows are supported — the same link can be open in several tabs at once.

**Failures are explained where they happen.** Consent cancelled, permission checkboxes left unticked, mailbox already in another workspace, plan limit reached, link expired or revoked, provider outage — each renders a plain-language page saying what happened and what to do next, and is recorded in the Activity log for the admin. Nothing is written when a connect fails, so retrying is always safe.

Mint links programmatically:

```bash
# Reusable hub link, no expiry (recommended for onboarding)
curl -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{}' localhost:3000/api/v1/connect-links
# → {"provider":"any","url":"https://…/connect?token=…","reusable":true,"expiresAt":null}

# Provider-specific link that skips the chooser page (expires by default)
curl -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"google","expiresInHours":168}' localhost:3000/api/v1/connect-links

# Revoke every link issued for this workspace and get a fresh one
curl -X DELETE -H "Authorization: Bearer $KEY" localhost:3000/api/v1/connect-links
```

Tokens are HMAC-signed with `MASTER_KEY` and stateless — no rows, no shared secrets to leak. Provider-specific links expire (`CONNECT_LINK_TTL_HOURS`, default 7 days); the hub link is non-expiring and revoked instead, via the dashboard's **Revoke & regenerate** button, `DELETE /api/v1/connect-links`, or the `revoke_connect_links` MCP tool — which invalidates every link handed out so far in one go.

**Guards on what gets stored.** A grant missing `gmail.send`/`gmail.modify` (or `Mail.Send`/`Mail.ReadWrite`) is rejected rather than saved as a mailbox that can never send; so is a grant that comes back without a long-lived refresh token. The plan limit is re-checked at the moment of insert, so parallel connects cannot overshoot it. Re-connecting a mailbox that is already in the workspace refreshes its access instead of creating a duplicate.

## Connect to your sequencer (CSV export)

The Mailboxes page downloads a bulk-import CSV with each account's proxy SMTP + IMAP credentials, pre-formatted for the target tool: **Instantly, Smartlead, Lemlist, Reply.io, Woodpecker**, or a generic layout — for the whole workspace from the onboarding section, or for any selection of mailboxes from the selection panel's Export tab. Rows carry the owner's **first and last name** (Instantly refuses rows without both): the proxy stores them from the provider when a mailbox connects (the Gmail send-as name, or the Microsoft 365 directory entry), you can fetch them again for any selection or set them by hand on the account page, and a mailbox with nothing on file gets a guess from its address. Same thing over the API (`?tag=` or `?accountIds=a,b` limit the export; `POST /api/v1/accounts/refresh-profile` re-fetches names):

```bash
curl -H "Authorization: Bearer $KEY" "localhost:3000/api/v1/accounts/export.csv?format=instantly"
```

Accounts without an SMTP credential get one auto-generated during export, so the file is always complete. Typical flow: mint connect links → users OAuth their mailboxes → export the CSV for your sequencer → bulk-import → the tool sends via proxy SMTP and detects replies via proxy IMAP.

Note: to make this possible, SMTP passwords are stored encrypted with `MASTER_KEY` (not hashed) — they are machine-generated, proxy-local credentials, re-viewable on the account page and in exports.

## Sending via SMTP

Generate a credential on the account page in the UI (or `npm run create-smtp-credential -- you@gmail.com`). Then point any SMTP client at the proxy:

```bash
swaks --server localhost:2525 --tls \
  --auth-user you.google.abc123 --auth-password <password> \
  --from you@gmail.com --to friend@example.com \
  --header "Subject: hello" --body "sent through OutreachEmailMCP"
```

Notes:

- STARTTLS is always offered (self-signed cert generated into `data/certs/` unless you provide `SMTP_TLS_CERT`/`SMTP_TLS_KEY`). Plaintext AUTH is refused unless `SMTP_ALLOW_INSECURE_AUTH=true`.
- `MAIL FROM` must match the connected account's address — the proxy refuses cross-account spoofing.
- The SMTP `250` response contains the queue job id; delivery itself happens asynchronously via the provider API.
- **BCC works correctly**: envelope-only recipients (standard SMTP BCC) are preserved — the proxy injects them as a `Bcc` header before provider delivery, since Gmail/Graph deliver to header recipients only.
- **Size limits are per provider** and enforced at submission time (SMTP `552` / API `413`): 25 MB for Gmail, **~2.9 MB for Microsoft** (Graph's 4 MB request cap on base64 MIME; the large-attachment upload-session flow is not implemented yet).

## Reading via IMAP

The proxy runs an IMAP4rev1 server (default port **1143**, STARTTLS) so reply-detection tools can watch the mailbox without provider OAuth. It authenticates with the **same username/password as SMTP** — the CSV export includes matching `imap_*` columns.

Supported: `LOGIN` / `AUTHENTICATE PLAIN`, `LIST`, `STATUS`, `SELECT`/`EXAMINE`, `APPEND` (e.g. saving sent copies — stored locally), `UID SEARCH` (ALL, SEEN/UNSEEN, ANSWERED, DELETED, FLAGGED, SINCE/BEFORE, UID, FROM/TO/SUBJECT, HEADER — including `HEADER In-Reply-To`), `FETCH`/`UID FETCH` (FLAGS, UID, RFC822.SIZE, INTERNALDATE, ENVELOPE, BODYSTRUCTURE, `BODY[]`/sections/parts/partials), `STORE` flags (synced upstream), **`MOVE`/`UID MOVE`** (synced upstream), `EXPUNGE`, `IDLE`.

How it works and its limits:

- **INBOX, Spam and Sent are provider-backed.** INBOX is fed by the same poller that drives webhooks; Spam and Sent sync from the provider on every `SELECT`. This is what makes **sequencer warmup work**: warmup tools open Spam, find their messages, `MOVE` them to INBOX — and the proxy performs the move in the real mailbox (Gmail label change / Graph folder move). `STORE \Seen`/`\Flagged` likewise sync to real read/star state. Other mailbox names a client APPENDs to exist in the proxy's local index only.
- Message **bodies are never stored** — they're fetched live from Gmail/Graph when a client asks, with UIDs and envelope metadata kept in a local index.
- Upstream writes need the write scopes (`gmail.modify` / `Mail.ReadWrite`); accounts connected with older read-only grants get a clear `NO … reconnect` response and a UI banner. `EXPUNGE` stays proxy-local (nothing is ever deleted upstream).

## MCP (AI agents)

The gateway is an **MCP server** (Streamable HTTP) at `POST /mcp`, authenticated with the same API keys (`Authorization: Bearer oem_live_…`). Tools exposed — automatically limited to the key's permissions:

| Tool | Needs | Does |
|---|---|---|
| `list_accounts` | read | Connected accounts + status |
| `list_folders` / `list_messages` / `get_message` | read | Browse and read mail |
| `list_send_jobs` / `get_send_status` | read | Delivery log / job status |
| `send_email` | send | Queue an email (to/cc/bcc, text/html, reply threading via `inReplyTo`) |
| `create_connect_link` | accounts | Mint a no-login OAuth onboarding link |
| `export_sequencer_csv` | export | CSV for Instantly/Smartlead/Lemlist/Reply.io/Woodpecker |

Example client config (Claude Code / any MCP client):

```json
{ "type": "http", "url": "https://your-instance/mcp",
  "headers": { "Authorization": "Bearer oem_live_…" } }
```

A send-only agent gets a key with just the `send` permission and literally cannot read mail — the read tools don't even appear in its tool list.

## REST API

Create a key in the UI (**API keys** — pick per-key permissions: `send`, `read`, `accounts`, `webhooks`, `export`) or with `npm run create-api-key -- my-key`. Authenticate every call with `Authorization: Bearer oem_live_…`. Calls outside the key's permissions return `403`.

```bash
# list connected accounts
curl -H "Authorization: Bearer $KEY" localhost:3000/api/v1/accounts

# send (returns 202 + job id)
curl -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"to":["friend@example.com"],"subject":"hi","html":"<b>hello</b>",
       "attachments":[{"filename":"a.txt","contentBase64":"aGVsbG8="}]}' \
  localhost:3000/api/v1/accounts/$ACCOUNT_ID/messages

# check delivery status / browse the send log
curl -H "Authorization: Bearer $KEY" localhost:3000/api/v1/accounts/$ACCOUNT_ID/send-jobs

# read mail
curl -H "Authorization: Bearer $KEY" "localhost:3000/api/v1/accounts/$ACCOUNT_ID/folders"
curl -H "Authorization: Bearer $KEY" "localhost:3000/api/v1/accounts/$ACCOUNT_ID/messages?folder=INBOX&limit=10"
curl -H "Authorization: Bearer $KEY" "localhost:3000/api/v1/accounts/$ACCOUNT_ID/messages/$MSG_ID"          # parsed
curl -H "Authorization: Bearer $KEY" "localhost:3000/api/v1/accounts/$ACCOUNT_ID/messages/$MSG_ID?format=raw" # rfc822
curl -H "Authorization: Bearer $KEY" -O "localhost:3000/api/v1/accounts/$ACCOUNT_ID/messages/$MSG_ID/attachments/0"
```

### Delivery statistics

Every send job carries its own outcome, so "how is this mailbox doing" is a
read, not a reconstruction. Bounces are detected by parsing the DSNs that come
back into the sending mailbox (RFC 3464 report parts, `X-Failed-Recipients`, or
a daemon sender with a failure subject) and correlating them to the original
send by RFC822 Message-ID; replies are correlated the same way via
`In-Reply-To`/`References`. A duplicate DSN never double-counts.

```bash
# workspace rollup + per-mailbox breakdown
curl -H "Authorization: Bearer $KEY" "localhost:3000/api/v1/stats?days=30"
# → {"total":{"sent":812,"failed":3,"queued":0,"bounced":11,"hardBounced":9,
#              "softBounced":2,"replied":47,"bounceRate":1.35,"replyRate":5.79},
#    "accounts":[{"accountId":"…","email":"you@gmail.com","sent":…}]}

# one mailbox, with a daily series for charting
curl -H "Authorization: Bearer $KEY" "localhost:3000/api/v1/accounts/$ACCOUNT_ID/stats?days=30"

# the bounces themselves — the addresses to suppress
curl -H "Authorization: Bearer $KEY" "localhost:3000/api/v1/bounces?days=30"
# → {"bounces":[{"recipient":"nobody@nowhere.test","type":"hard","code":"5.1.1",
#                "diagnostic":"smtp; 550 5.1.1 …","account":"you@gmail.com",…}]}
```

`bounced` is deliberately not a subset of `failed`: `failed` means the provider
refused the submission, `bounced` means it was accepted and the receiving system
rejected it afterwards.

### Provisioning API (embedding this gateway in another product)

Set `ADMIN_API_KEY` to enable a small cross-tenant surface for a product that
puts this gateway underneath its own UI and needs a workspace per customer
without a human at the signup form. Unset, the routes 404 and the surface does
not exist.

```bash
# create a workspace and get an unrestricted key for it (idempotent on email)
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Acme Corp","email":"acme@yourapp.internal","plan":"pro"}' \
  localhost:3000/api/v1/admin/orgs
# → {"created":true,"org":{"id":"…","plan":"pro","limits":{…},"accounts":[]},"apiKey":"oem_live_…"}

curl -H "Authorization: Bearer $ADMIN_API_KEY" localhost:3000/api/v1/admin/orgs          # list
curl -H "Authorization: Bearer $ADMIN_API_KEY" localhost:3000/api/v1/admin/orgs/$ORG_ID  # detail
curl -X POST -H "Authorization: Bearer $ADMIN_API_KEY" localhost:3000/api/v1/admin/orgs/$ORG_ID/api-keys  # rotate
```

The embedding product then uses the returned workspace key for everything else:
mint a connect link for the end user, list mailboxes, send, and pull stats.

### Partner SSO (superadmin handoff)

With `ADMIN_API_KEY` set, the embedding platform can sign its own operators
straight into this UI as **superadmins** — able to see, enter, create and
manage every workspace on the instance — without a second password.

The platform mints a short-lived token and links to it:

```
GET {BASE_URL}/auth/sso/partner?token=<payload>.<sig>&next=/ui
```

`payload` is base64url `{"email","name","exp","nonce"}`; `sig` is
HMAC-SHA256 of the payload keyed with `HMAC(ADMIN_API_KEY, "sso-v1")` — a
DERIVED key, so a leaked signature can never be replayed as an API key.
Tokens expire (minutes, set by the issuer) and superadmin is granted **only**
here: signup cannot produce one.

Superadmins get a workspace switcher in the nav and a **+ Workspace** button;
the workspace they are acting in is stored per session, so two tabs can look
at two different customers at once.

### Internal sign-in (Pocket ID, staff only)

Breazy staff sign in with a passkey through Pocket ID at `id.internal` and land
as superadmins — the same grant as the partner handoff above.

The offer is **conditional on where the request came from**. `id.internal`
resolves only on the Breazy tailnet, so the button appears — and the routes
respond — only for traffic that arrived through the internal nginx gateway.
On the public hostname the login page is unchanged and both routes 404, so a
public visitor never learns internal sign-in exists. Conversely, on the
internal hostname the password form is *not* offered: staff use passkeys, and
the public hostname remains the escape hatch if the IdP is down.

"Came from the gateway" is two signals, ANDed (`src/auth/internal-network.ts`):

| Signal | Why it holds |
|---|---|
| `Host: emailproxy.internal` | Traefik has no router for that name, so a public request carrying it 404s at the edge |
| `X-Internal-Gateway: <secret>` | any container on the host can dial the gateway's IP, but won't know the secret; nginx overwrites the header, so a client cannot supply its own |

Missing secret ⇒ the check returns false for everything. It fails closed.

> **The public edge must strip the header.** Traefik forwards arbitrary client
> headers, so without a `strip-internal-trust` middleware on every public
> domain, anyone can send `X-Internal-Gateway: …` to the public hostname. Attach
> it via Dokploy (`domain.update`) so it survives redeploys, and re-verify after
> every deploy — a missing attachment fails silently.

Setup:

```bash
# 1. register the client (needs POCKETID_API_KEY)
oidc-app emailproxy https://emailproxy.internal/auth/callback

# 2. set on the deployment
INTERNAL_HOSTNAME=emailproxy.internal
INTERNAL_GATEWAY_SECRET=<same value as the gateway vhost's proxy_set_header>
OIDC_CLIENT_ID=…
OIDC_CLIENT_SECRET=…
```

The container must trust the private CA that issues `*.internal` certificates.
The Dockerfile bakes it in (`certs/breazy-root.crt` + `NODE_EXTRA_CA_CERTS`);
Node reads that variable at process start, so putting it in a `.env` is too
late to have any effect. When it is missing, the browser redirect succeeds and
the token exchange fails — `/auth/oidc/start` reports the certificate error
explicitly rather than a bare "fetch failed".

### Webhooks (new-mail notifications and delivery outcomes)

Register a URL (UI or `POST /api/v1/webhooks {"url": "...", "accountId": "..."}`). Each new inbound message triggers:

```
POST <your url>
X-OutreachEmailMCP-Event: message.received
X-OutreachEmailMCP-Delivery: <delivery id>
X-OutreachEmailMCP-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the webhook secret>

{"event":"message.received",
 "account":{"id":"…","email":"you@gmail.com","provider":"google"},
 "message":{"id":"…","from":"Alice <alice@example.com>","to":"you@gmail.com",
            "subject":"Hi","date":"2026-07-20T12:00:00Z","snippet":"…","hasAttachments":false}}
```

Subscribe with `{"events": [...]}` — `message.received` (default) plus the
outcome events for mail you sent: `message.sent`, `message.failed`,
`message.bounced`, `message.replied`. Outcome payloads carry a `send` object
(`jobId`, `messageId`, `subject`, `to`, plus `bounce` or `reply` detail) instead
of `message`, so one endpoint can drive a delivery dashboard without polling.

Verify the signature, then fetch the full body via the read API using `message.id`. Non-2xx responses are retried up to 6 times with exponential backoff; see delivery history in the UI or `GET /api/v1/webhooks/:id/deliveries`. New mail is detected by polling (default every 60s, `POLL_INTERVAL`); no public inbound URL is required. Webhook targets that resolve to private/loopback addresses are rejected unless `WEBHOOKS_ALLOW_PRIVATE=true`.

### Ports clients are told to use

Exports, the account page and the credential page advertise the implicit-TLS ports (465/993) whenever the app serves them, because every sequencer assumes SSL-on-connect. When TLS is terminated in front of the app (a proxy owns 465/993 and forwards to the STARTTLS ports, so `SMTPS_PORT=0`/`IMAPS_PORT=0`), set `SMTP_ADVERTISED_PORT=465` and `IMAP_ADVERTISED_PORT=993`; without them the STARTTLS ports are advertised and a sequencer configured with SSL fails with "wrong version number".

## Domains and mailbox provisioning

The **Domains** page takes a batch from a brand word to connected mailboxes. Connect two integrations per workspace (credentials are stored encrypted with `MASTER_KEY`):

- **Namecheap** (API user, key, whitelisted IP, registrant contact): *Find & buy* suggests names in the shape real companies use (`getbreazy.nl`, `breazygrowth.com`), checks availability and first-year prices, and registers what you tick with WhoisGuard on. *Import domains* pulls in the account's existing domains and adopts the domains of mailboxes already connected.
- **Premium Inboxes** (agency API token, workspace, the registrar or DNS-host login their team uses to set DNS, and order defaults): *Order mailboxes* places a purchase order for the ticked domains — provider, inboxes per domain, address patterns, a persona per domain, password — and asks them, in the order notes, to connect the mailboxes to this gateway through the onboarding link rather than to a sequencer. Orders are mirrored every 10 minutes: status, issues, and the delivered mailboxes with their passwords, each marked *connected* once it exists here. A domain moves purchased → ordered → provisioned → connected on its own.

What still needs a person: the OAuth consent for each delivered mailbox (open the onboarding link signed in as the mailbox, or hand the order's checklist to Premium Inboxes). Mailbox passwords alone do not open the Gmail or Graph API.

## Warmup (built-in inbox warmup pool)

Every connected mailbox can opt into a **warmup pool**: the mailboxes on the proxy write to each other in short, human-looking threads, and the engine watches where each message lands and does what a person's mail client would do with it. Nothing about it is visible to the tools that use the gateway — the REST/MCP listings, IMAP, webhooks, the send log and the stats all exclude warmup traffic — so a sequencer watching the mailbox never mistakes pool chatter for a reply.

What the pool does, per mailbox and per day:

- **Opens conversations** with other pool mailboxes, ramping from a few a day up to the daily limit, on a two-peak daytime schedule in the mailbox's own timezone (never on a round minute, never bursting after downtime).
- **Threads**: replies with proper `In-Reply-To`/`References` and Gmail- or Outlook-style quoting, thread lengths skewed short, a share of openers Cc a third mailbox (replies go to everyone), a share go to a **same-domain colleague** (internal threads), and received mail is sometimes **forwarded** on to a third mailbox.
- **Client actions**: marks read after a delay, stars some, marks some important (Gmail label / Outlook importance), honours **read-receipt requests** with a real MDN, and tidies mail out of the owner's real inbox after a few days (archive, a "Warmup" label/folder, or trash).
- **Placement**: every arrival is recorded as inbox / spam / Gmail category / Outlook "Other" / missing / bounced. Spam placements are **rescued** (moved to the inbox, which is the not-spam signal), Promotions → Primary and Other → Focused are fixed, and a 7-day spam+missing rate per sender drives the **reputation controller**: hold the ramp and halve volume, or auto-pause for a cooldown. The controller waits out a **protection delay** (14 days by default) after a mailbox starts: a fresh pool lands badly at first and the rescues are exactly what earns placement, so early spam is training, not a fault.
- **Content** comes from multi-turn scripts written in batches by any OpenAI-compatible model (`WARMUP_LLM_BASE_URL`, `WARMUP_LLM_API_KEY`, `WARMUP_LLM_MODEL`), validated (no links, numbers, placeholders or sales language) and kept in a pool. Scripts carry spintax (`{quick|short|brief}`) so about two thirds of conversations reuse an existing script with its wording re-rolled, the way real mailboxes repeat themselves, while the rest are fresh; a bundled template corpus (English and Dutch) covers gaps, so a dead API never blocks a send.

Enable it per mailbox on the account page or in bulk on the **Mailboxes** page: select any set of mailboxes (search, or filter by state, health, provider, domain or tag) to see their combined placement chart and numbers, enable, pause or resume them, apply settings to all of them at once, or tag them. **Tags** are free-form labels (`campaign-a`, `client-x`) that bundle mailboxes so a whole campaign can be filtered and edited as one; they are on `GET /api/v1/accounts` (filter with `?tag=`), set with `PATCH /api/v1/accounts/:id {"tags":[...]}`, and edited in bulk with `POST /api/v1/warmup/bulk {"accountIds":[...],"action":"tags","tags":{"add":[...],"remove":[...]}}`. The page also holds the workspace defaults. Settings are layered — instance env caps → workspace defaults → per-mailbox overrides — and the per-mailbox form shows where each value comes from. The knobs mirror what Instantly and Smartlead expose: start volume, increase per day, daily limit, slow start, randomize %, weekdays only + weekend factor, timezone and send window, min gap, reply rate, max thread turns, reply/read delays, internal-thread share, Cc rate, forward rate, read/star/important rates, read-receipt request/send rates, spam rescue rate and delay, category fix, receive limit, languages, register, cleanup mode, pairing rules (same domain / same workspace / prefer cross-provider), auto-throttle thresholds and cooldown, and an optional combined cap on warmup + real sends.

Warmup mail carries **no marker of its own**: the engine recognises it by the `Message-ID` it generated (in the provider's own house style), with a fallback match on sender, recipient and subject for providers that rewrite ids, so a receiver has nothing to pattern-match across senders. A workspace can optionally switch on a visible **filter tag** (an Instantly-style code as the last line of the body) for tools that read the mailboxes without going through the proxy. Pass `?includeWarmup=true` to the message listing or send-log endpoints to see warmup mail deliberately.

Every sending domain's **SPF, DKIM, DMARC and MX** are checked every six hours (`GET /api/v1/warmup/dns`, a re-check button on the Mailboxes page); a domain that fails authentication is flagged in the table, lowers the mailbox health score, and is reported in the daily health mail, because warmup cannot fix a domain that does not authenticate.

```bash
# pool overview + per-mailbox placement, and one mailbox in detail
curl -H "Authorization: Bearer $KEY" localhost:3000/api/v1/warmup
curl -H "Authorization: Bearer $KEY" localhost:3000/api/v1/accounts/$ACCOUNT_ID/warmup

# enable + override a few settings on one mailbox (null clears an override)
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"enabled":true,"settings":{"dailyLimit":40,"replyRate":30,"timezone":"Europe/Amsterdam"},"persona":{"firstName":"Alice"}}' \
  localhost:3000/api/v1/accounts/$ACCOUNT_ID/warmup
curl -X POST -H "Authorization: Bearer $KEY" localhost:3000/api/v1/accounts/$ACCOUNT_ID/warmup/pause   # start|pause|resume|stop

# bulk: one action and/or a settings patch across many mailboxes
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"accountIds":["…","…"],"action":"enable","settings":{"weekdaysOnly":true}}' localhost:3000/api/v1/warmup/bulk

# workspace defaults, pool scope (instance | org), filter tag, visibility
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"defaults":{"dailyLimit":30},"poolScope":"instance","emitWebhooks":false}' localhost:3000/api/v1/warmup/defaults
```

MCP exposes the same as `get_warmup_status`, `list_warmup_messages`, `set_warmup` and `bulk_warmup`; webhooks can opt into `warmup.*` events (spam detected, rescued, throttled, paused, resumed).

Engine settings (env): `WARMUP_ENABLED` (kill switch, default on), `WARMUP_MAX_DAILY_PER_ACCOUNT` (50), `WARMUP_MIN_POOL_SIZE` (2), `WARMUP_LLM_*`, `WARMUP_LLM_DAILY_CALL_BUDGET` (200), `WARMUP_SCRIPT_POOL_MIN` (60/language), `WARMUP_SCRIPT_REUSE_PERCENT` (66: share of conversations that reuse an existing script with its rotating words re-rolled, rather than a fresh one) and `WARMUP_SCRIPT_MAX_USES` (40), `WARMUP_SPAM_SWEEP_SECONDS` (600), `WARMUP_ARRIVAL_TIMEOUT_HOURS` (6), `WARMUP_TASK_GRACE_MINUTES` (45), and in SaaS mode `PLAN_FREE_WARMUP_DAILY` / `PLAN_PRO_WARMUP_DAILY` (warmup does not consume the plan's real send quota).

Notes: the pool is **instance-wide by default** — in SaaS mode that means mailboxes from different workspaces exchange mail (the proxy hides it, the human owner sees it in Gmail/Outlook until cleanup runs); a workspace can restrict itself to its own mailboxes with `poolScope: "org"`, which is symmetric. A mailbox connected without mailbox-write access still sends and replies but cannot mark read, star or rescue; reconnect it to grant the scope. A real person replying on a warmup thread closes the thread and their message stays visible. The daily health mail reports auto-pauses, throttling, a too-small pool, stalled mailboxes, missing mail and content-API failures.

## Running more than one instance (zero-downtime deploys)

On the Breazy instance a push to `main` deploys: a GitHub webhook calls the Dokploy application's deploy URL, which builds the image and rolls the two replicas one at a time.

Several instances can share one data volume. Every instance serves SMTP, IMAP and HTTP; only the holder of a heartbeat lease (one SQLite row, 30 s TTL) runs the pollers, the send and webhook workers and the warmup engine, and a peer takes the lease over when the holder shuts down or dies. On shutdown an instance drains: it stops accepting, lets in-flight sessions finish for up to 8 s, releases the lease, and answers `503` on `/healthz` meanwhile so a router stops sending it work.

To deploy without downtime, put the mail ports behind a TCP proxy that stays up (Traefik TCP entrypoints with TLS terminated there and a real certificate; set `SMTP_ALLOW_INSECURE_AUTH=true`, `IMAP_ALLOW_INSECURE_AUTH=true`, `SMTPS_PORT=0`, `IMAPS_PORT=0` on the app, which is then only reachable on the container network), run two replicas with start-first rolling updates and a health check, and keep migrations additive so both versions can run side by side for a minute. The bundled `docker-compose.yml` is the single-instance, self-hosted layout with the ports published directly.

## Operational notes

- **Secrets**: OAuth tokens and SMTP passwords are AES-256-GCM-encrypted with `MASTER_KEY` (SMTP passwords stay readable for export/re-display); API keys are stored hashed and shown exactly once. Losing `MASTER_KEY` means reconnecting accounts and regenerating SMTP credentials.
- **Exposure**: everything binds to `127.0.0.1` by default. To expose, set `HTTP_BIND`/`SMTP_BIND` to `0.0.0.0` and put the HTTP side behind a TLS reverse proxy (Caddy/nginx); set `BASE_URL` to the public https URL (it is also the OAuth redirect base).
- **Account health**: if a refresh token is revoked, the account flips to `auth_error`, queued mail is held (not failed), and the UI shows a reconnect link. Sending resumes automatically after reconnecting.
- **Transaction log**: every operation — SMTP/IMAP logins, submissions, each delivery attempt, warmup moves, flag syncs, poll runs, webhook deliveries, token refreshes — is recorded with pass/fail in the **Activity** page (`/ui/activity`, filterable by status/category, with a failures-last-24h counter) and via `GET /api/v1/activity?status=failed…`. Failures also go to the structured process log. Retention: `ACTIVITY_RETENTION_DAYS` (default 30).
- **Daily health check**: once a day (`HEALTH_REPORT_HOUR`, default 07:00 UTC) the instance sweeps everything that can fail silently and emails what it finds. Each connected mailbox gets a live probe — token refresh plus a real API call proving the mailbox still exists and is licensed — and the check also covers failed and stuck send jobs, inbound polling that has stalled or errored, failed webhook deliveries, plan quotas, TLS certificate expiry, and free space on the data volume. The report is sent through the proxy from the workspace's own healthiest mailbox to `HEALTH_REPORT_TO` (or the workspace owners), **only when something is wrong** unless `HEALTH_REPORT_ALWAYS=true`. Every run is recorded in the Activity page whether or not mail goes out, so a quiet day is verifiable rather than assumed. Run it on demand with `npm run health-check` (add `--send` to actually mail it); it exits non-zero when anything critical is found, so it doubles as a monitoring probe.
- **Data**: everything lives in `DATA_DIR` (default `./data`) — SQLite DB, raw `.eml` spool, TLS certs. Back that directory up.
- **Spool retention**: the raw `.eml` of a message is only stored while it matters — as the queue payload before delivery, then for `SENT_RAW_RETENTION_HOURS` (default 24) after a successful send, after which it is deleted. The canonical sent copy lives in the provider's Sent folder (re-findable via `providerMessageId` for Gmail or the `messageId` header for Microsoft, both exposed in the send log). Failed/queued mail is never cleaned up — it's the only copy.

## Deploying (Dokploy or any Docker host)

The whole platform is **one container + one volume**. Storage is embedded SQLite (better-sqlite3, WAL mode) at `/data/emailproxy.db` — there is **no external database to provision**. The `/data` volume also holds the outbound message spool and generated TLS certs; backing it up backs up everything. OAuth tokens and SMTP passwords in the DB are AES-256-GCM-encrypted with `MASTER_KEY`, so keep that env var safe — the volume alone is not enough to restore (and the key alone reveals nothing without the volume).

On **Dokploy**:

1. Create a **Compose** service from this repo (the `docker-compose.yml` at the root builds the image from the `Dockerfile`).
2. In the **Environment** tab set at minimum: `MASTER_KEY` (`openssl rand -base64 32`), `ADMIN_PASSWORD` (or `SAAS_MODE=true`), and `BASE_URL=https://your-domain` — BASE_URL drives OAuth redirects, connect links, and secure cookies, so it must be the real public URL.
3. Add a **Domain** pointed at the `outreachemailmcp` service, container port **3000**, HTTPS enabled (Dokploy's Traefik terminates TLS). The compose deliberately does **not** host-publish port 3000 — Traefik reaches the container over the docker network, and publishing it would collide with anything already on host port 3000 (`Bind for 0.0.0.0:3000 failed: port is already allocated`). For local no-proxy runs, copy `docker-compose.override.example.yml` to `docker-compose.override.yml`.
4. Keep the `2525` (SMTP) and `1143` (IMAP) port mappings — they're raw TCP that Traefik doesn't route — and open those ports in your provider's firewall/security group. **No special DNS is needed**: the same A record used for the domain serves them (DNS doesn't know about ports), and no MX/SPF/DKIM records are required — actual delivery happens through Google/Microsoft's own infrastructure. One exception: if the domain is behind a proxying CDN (Cloudflare orange-cloud), raw TCP won't pass — either set the record to DNS-only, or add an unproxied record (e.g. `smtp.yourdomain.com`) pointing at the server and set `MAIL_HOST=smtp.yourdomain.com` so exports advertise it.
5. Register the OAuth redirect URIs against the same domain: `https://your-domain/auth/google/callback`, `/auth/microsoft/callback`, and (SaaS+SSO) `/auth/sso/google/callback`; for Stripe, webhook `https://your-domain/billing/stripe/webhook`.
6. Optional: switch the volume to Dokploy's managed files directory (`../files/data:/data`) so it's included in Dokploy's backup tooling.

Notes: SMTP/IMAP STARTTLS uses an auto-generated self-signed cert by default; if a sequencer refuses self-signed certs, mount a real cert/key into the container and set `SMTP_TLS_CERT`/`SMTP_TLS_KEY` (used by both listeners). The image was validated end-to-end: `docker build` needs no toolchain (Debian-slim base with prebuilt SQLite bindings), and the compose healthcheck reports healthy once the HTTP listener is up.

## SaaS mode (multi-tenant)

Everything above describes the default **self-hosted** mode: one workspace, `ADMIN_PASSWORD` login, no limits. Setting `SAAS_MODE=true` turns the same instance into a multi-tenant service:

- **Workspaces**: public signup (`/ui/signup`, email + scrypt-hashed password) creates an isolated org. Accounts, API keys, webhooks, SMTP/IMAP credentials, send logs, and CSV exports are all scoped per org; cross-tenant ids read as 404.
- **Google SSO**: with `GOOGLE_CLIENT_ID/SECRET` set, login and signup pages show **Continue with Google** — register the extra redirect URI `{BASE_URL}/auth/sso/google/callback` in your Google OAuth client. New Google sign-ins get their own workspace automatically (identity scopes only; unrelated to mailbox connects).
- **Connect links** embed the workspace, so onboarding automation works per tenant.
- **Quotas**: plans (`free`/`pro`) limit connected accounts and sends per 24h (`PLAN_*` env vars). Hitting a limit returns API `429` / SMTP `452` (temporary, client retries later) / a UI notice — never lost mail. To move a workspace between plans without Stripe (e.g. granting yourself pro on your own instance): `npm run set-plan -- --list` to see every workspace, then `npm run set-plan -- --email owner@example.com --plan pro`. On a Docker host, `docker exec -it <container> npm run set-plan -- --list`.
- **Billing** (optional): set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_PRO` to enable Stripe Checkout upgrades and the customer portal. Point a Stripe webhook at `/billing/stripe/webhook` (events: `checkout.session.completed`, `customer.subscription.deleted`). No Stripe SDK — plain REST with signature verification. **Shared Stripe accounts are safe**: checkout sessions and subscriptions are stamped with `metadata.app=outreachemailmcp`, and the webhook acknowledges-but-ignores any event object without that marker, so other apps' events on the same account can never touch workspace plans.

Operational notes for running it as a service: put the HTTP side behind TLS (Caddy/nginx), provide real certs for SMTP/IMAP STARTTLS via `SMTP_TLS_CERT`/`SMTP_TLS_KEY`, and note that offering Gmail's `gmail.readonly` scope in a public OAuth app requires Google's app verification plus an annual CASA security assessment. Single-node SQLite comfortably serves hundreds of workspaces; beyond that, the growth path is Postgres + per-tenant sharding.

## Development

```bash
npm run dev        # watch mode
npm test           # vitest unit tests
npm run typecheck
npm run db:generate  # regenerate drizzle migrations after schema changes
```

Layout: `src/providers/` (Gmail/Graph adapters speaking raw MIME), `src/queue/` (SQLite-backed send queue + worker), `src/smtp/` (SMTP listener), `src/imap/` (IMAP facade: session state machine, MIME structure parser, UID index), `src/inbound/` (poller + webhook dispatch), `src/api/` (REST), `src/ui/` (server-rendered admin).

## License

[AGPL-3.0-only](LICENSE). Free to self-host, modify, and redistribute; if you offer a modified version as a network service, you must publish your changes.

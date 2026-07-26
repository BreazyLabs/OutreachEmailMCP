# OutreachEmailMCP

**Free, open-source (AGPL) email gateway.** Connect OAuth-based mail providers (**Gmail**, **Microsoft 365 / Outlook**) once, then use those mailboxes from anywhere: email sequencers over **SMTP + IMAP**, AI agents over **MCP**, your own code over **REST + webhooks** — no OAuth plumbing, no app passwords.

```
 Instantly / Smartlead / … ──SMTP+IMAP──▶ ┌──────────────────┐ ──Gmail API──▶ Google
 AI agents (Claude, MCP) ─────MCP───────▶ │ OutreachEmailMCP │ ──MS Graph──▶ Microsoft
 your scripts & apps ────REST+webhooks──▶ └──────────────────┘ ◀──polling──
```

The public landing page at `/` explains the product; the dashboard lives at `/ui`.

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

The dashboard's **Connect to your sequencer** section downloads a bulk-import CSV with each account's proxy SMTP + IMAP credentials, pre-formatted for the target tool: **Instantly, Smartlead, Lemlist, Reply.io, Woodpecker**, or a generic layout. Same thing over the API:

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

### Webhooks (new-mail notifications)

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

Verify the signature, then fetch the full body via the read API using `message.id`. Non-2xx responses are retried up to 6 times with exponential backoff; see delivery history in the UI or `GET /api/v1/webhooks/:id/deliveries`. New mail is detected by polling (default every 60s, `POLL_INTERVAL`); no public inbound URL is required. Webhook targets that resolve to private/loopback addresses are rejected unless `WEBHOOKS_ALLOW_PRIVATE=true`.

## Operational notes

- **Secrets**: OAuth tokens and SMTP passwords are AES-256-GCM-encrypted with `MASTER_KEY` (SMTP passwords stay readable for export/re-display); API keys are stored hashed and shown exactly once. Losing `MASTER_KEY` means reconnecting accounts and regenerating SMTP credentials.
- **Exposure**: everything binds to `127.0.0.1` by default. To expose, set `HTTP_BIND`/`SMTP_BIND` to `0.0.0.0` and put the HTTP side behind a TLS reverse proxy (Caddy/nginx); set `BASE_URL` to the public https URL (it is also the OAuth redirect base).
- **Account health**: if a refresh token is revoked, the account flips to `auth_error`, queued mail is held (not failed), and the UI shows a reconnect link. Sending resumes automatically after reconnecting.
- **Transaction log**: every operation — SMTP/IMAP logins, submissions, each delivery attempt, warmup moves, flag syncs, poll runs, webhook deliveries, token refreshes — is recorded with pass/fail in the **Activity** page (`/ui/activity`, filterable by status/category, with a failures-last-24h counter) and via `GET /api/v1/activity?status=failed…`. Failures also go to the structured process log. Retention: `ACTIVITY_RETENTION_DAYS` (default 30).
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

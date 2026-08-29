# TailSSH

A 100% browser-based SSH terminal to Tailscale machines using Tailscale's WASM, deployed with Cloudflare Workers.

> **Access controls recommended.**
> The app itself has no login wall and holds no Tailscale credentials: each
> visitor's browser WASM node joins **whatever tailnet the visitor logs in
> with** (as an ephemeral node), and they only see the devices their own
> identity permits. A stranger reaching the URL cannot touch your tailnet —
> but consider Cloudflare Access if you don't want the Worker acting as a
> public WASM host.

---

## Enable Tailscale SSH

TailSSH connects to machines using **Tailscale SSH** — certificate-based SSH
that requires no passwords and no key distribution. You must enable it on every
machine you want to reach.

Full documentation: <https://tailscale.com/docs/features/tailscale-ssh>

**Quick steps per target machine:**

```sh
# Linux / macOS — enable Tailscale SSH
sudo tailscale set --ssh

# Verify it is active
tailscale status
# Look for "offers SSH" next to the machine entry
```

On the Tailscale admin console you also need an ACL rule that grants your user
(or a tag) SSH access. The minimal addition to your `acls` block:

```json
{
  "action": "accept",
  "src":    ["autogroup:member"],
  "dst":    ["autogroup:self"],
  "users":  ["autogroup:nonroot", "root"]
}
```

Adjust `src`, `dst`, and `users` to match your security policy.

---

## Installation

```sh
git clone <your-repo-url>
cd tailssh
npm install
npm run build        # vendors pkg.js / main.wasm / pkg.css into public/
```

---

## Local development

1. Start the local dev server:

   ```sh
   npm run dev
   ```

   Wrangler serves the app at `http://localhost:8787`.

2. Open `http://localhost:8787` in your browser. The Tailscale WASM node will
   boot, open a Tailscale login tab, and authenticate as an ephemeral node
   under **your** Tailscale account. The device list is then populated from
   the netmap that node receives — no API token is needed anywhere.

---

## Port proxy (`/proxy/<device>/<port>/…`)

Besides SSH, the app can proxy **HTTP traffic to any TCP port on any tailnet
device** through generated URLs:

```
/proxy/<device>/<port>/<path>?<query>
```

Examples:

```
/proxy/aliyun-yl/3000/package.json     → http://<aliyun-yl's tailnet IP>:3000/package.json
/proxy/100.81.0.16/8080/admin          → http://100.81.0.16:8080/admin
/proxy/mbp/5900/                       → any HTTP service on mbp:5900
```

The device segment accepts a MagicDNS short name (`aliyun-yl`), a full FQDN
(`aliyun-yl.tailnet.ts.net.`), or a bare tailnet IP.

### Feature switch

The port proxy is **off by default**. Enable it at build/deploy time:

```sh
TAILSSH_PROXY=1 npm run deploy
```

The flag is baked into `public/config.js` by `build.js` (from the
`TAILSSH_PROXY` env var — `1`/`true`/`yes`/`on` enable it). When disabled:

- `proxy-sw.js` is **never registered**, so `/proxy/*` URLs are not
  intercepted (they fall through to the SPA fallback);
- the **"Proxy…" button is hidden** on device cards;
- any **previously-installed SW is unregistered** on next visit, so a
  redeploy with the flag off cleanly removes old interception.

> **Browser-only.** This path works only in a browser (Service Worker + the
> app tab's WASM node).

### How it works

Cloudflare Workers cannot open arbitrary outbound TCP connections, and the
browser WASM node cannot listen on ports — so neither side can serve the
proxy alone. The feature chains three pieces together:

```mermaid
sequenceDiagram
    autonumber
    participant T as Proxy tab<br/>(GET /proxy/dev/3000/x)
    participant SW as Service Worker<br/>(proxy-sw.js)
    participant H as App tab — proxy host<br/>(app.js + WASM node)
    participant D as Target device<br/>(dev:3000, via tailnet)

    T->>SW: fetch /proxy/dev/3000/x
    SW->>SW: parse device + port,<br/>strip hop-by-hop headers
    SW->>H: proxy-request {method, origin, path}<br/>via MessagePort
    H->>H: resolve device → tailnet IP<br/>(netmap cache)
    H->>D: ipn.fetch("http://<ip>:3000/x")<br/>(DERP-relayed)
    D-->>H: HTTP response
    H-->>SW: proxy-response {status, bodyBase64}
    SW-->>T: Response (sniffed content-type,<br/>x-proxied-by: tailssh-proxy)

    Note over SW,H: No host page open? SW waits 10 s,<br/>then 502 "no proxy host page is open"
```

1. **`public/proxy-sw.js`** — a Service Worker scoped to the whole app. It
   intercepts `fetch` for `/proxy/*` URLs, extracts `<device>` and `<port>`,
   strips hop-by-hop headers, and forwards the request to the app page over a
   `MessageChannel` port. If no host page is open it waits up to 10 s, then
   returns `502 "no proxy host page is open"`.
2. **`public/app.js` (proxy host)** — the main app tab registers itself as the
   host (`startProxyHost()` at module load). For each request it resolves the
   device name to a tailnet IP via the netmap cache (the WASM node has no DNS
   resolver), then calls `ipn.fetch("http://<ip>:<port><path>")`.
3. **The WASM node** dials the target through the tailnet (DERP-relayed for
   browser WASM — see the tailvnc notes for why direct UDP is impossible
   here) and returns `{status, statusText, text()}`.

Because `ipn.fetch()` in the current `@tailscale/connect` build is **GET-only
and returns no response headers**, the host layer:

- rejects non-GET/HEAD methods with an explicit error (no silent POST→GET
  downgrade),
- sniffs `content-type` from the body (HTML/JSON/plain) so proxied pages and
  APIs render correctly.

### Requirements & limitations

- **The main app tab must stay open** — it is the proxy engine. Closing it
  makes in-flight and new proxy requests fail with `502` after the host
  timeout. A proxy URL opened directly (e.g. from a bookmark) works only
  while another tab has the app open; the SW holds the request until a host
  registers or the 10 s timeout fires.
- **GET/HEAD only** — the pinned `@tailscale/connect` (1.39.98, and the
  latest 1.102.3 alike) exposes no raw-TCP `ipn.tcp()`; that method exists
  only in the tailscale repo's unmerged `origin/vnc` branch (which tailvnc's
  submodule uses). Upgrading the npm package does not add it.
- **Device must be in the netmap** — names are resolved from the ephemeral
  node's own netmap, so ACL visibility rules apply exactly as for SSH.
- **Auth is shared with the app** — the proxy reuses the logged-in WASM node;
  there is no separate credential surface.
- Response headers from the target are not preserved (single sniffed
  `content-type`); `content-encoding`/`transfer-encoding` are stripped so the
  browser can decode the plain body.

### Testing the proxy

1. Start the dev server and open the app:

   ```sh
   npm run dev
   # open http://localhost:8787 and complete Tailscale login
   ```

2. Start a test listener on any tailnet device (here: `mbp`, on its tailnet
   IP, so the WASM node can reach it):

   ```sh
   ssh mbp 'while true; do echo "HELLO-FROM-MBP-$(date +%s)" | nc -l 100.81.0.12 9999 >/dev/null; done'
   ```

3. In the app, click **Proxy…** on a device card and enter the port, or open
   the URL directly:

   ```
   http://localhost:8787/proxy/mbp/9999/
   ```

   Expected: the page renders `HELLO-FROM-MBP-<timestamp>` (one line per
   reload — the `nc` listener serves one connection then exits).

4. Test a real HTTP service (device running anything on :3000):

   ```
   http://localhost:8787/proxy/aliyun-yl/3000/package.json
   ```

   Expected: the target's `package.json` JSON, served with
   `application/json` and an `x-proxied-by: tailssh-proxy` header.

5. Error paths worth exercising:

   | URL | Expected |
   |---|---|
   | `/proxy/mbp/99999/` | `400` — `invalid port "99999"` |
   | `/proxy/bad_..name/80/` | `400` — `invalid device` |
   | `/proxy/mbp/9999/` (listener down) | `502` — dial/timeout error from `ipn.fetch` |
   | `/proxy/mbp/9999/` with app tab closed | `502` — `no proxy host page is open` (after 10 s) |

**Important:** the proxy only works in a browser — `curl` cannot exercise it
(Service Workers don't run outside browsers; curl just gets the SPA fallback
`index.html`). When testing locally, also bypass any system HTTP proxy for
localhost (`curl --noproxy '*'` / `NO_PROXY=127.0.0.1,localhost`), otherwise
a local proxy like `127.0.0.1:7890` intercepts the request.

**Service Worker caching gotcha:** after changing `proxy-sw.js` or the proxy
code in `app.js`, a normal reload may keep serving the **old** worker (SW
updates are asynchronous and only take over after all tabs close, unless
`skipWaiting` fires). If you see stale behavior such as
`{"error":"bad path /…"}`, unregister first: DevTools → Application →
Service Workers → **Unregister** (or Application → Storage → Clear site
data), then hard-reload (Cmd+Shift+R).

---

## Persistent proxy via relay agent (`/p/<device>/<port>/…`)

The browser proxy above has two hard constraints: it only works in a browser,
and it dies when the app tab closes. The Worker-side `/p/*` route removes both
— `curl`, scripts, and any HTTP client can reach **any device, any port** on
the tailnet through the deployed Worker, with no app tab open and **no
Tailscale Funnel**.

### How it works

A Worker cannot `fetch()` a tailnet IP (`100.x` is CGNAT space — no route from
Cloudflare's edge), and running the Tailscale WASM node inside a Worker is not
possible (the ~32 MB `main.wasm` exceeds the 3/10 MB Worker size limit, and
the node's interactive login has no headless path). Instead, a tiny Node agent
(`agent/agent.mjs`, zero npm dependencies) runs on any always-on tailnet
device, connects **out** to the Worker's Durable Object over WebSocket, and
dials proxy targets using the tailscaled daemon **already on that machine**:

```mermaid
flowchart LR
    C[curl / scripts / any client] -->|"GET /p/aliyun-yl/3000/ + x-proxy-key"| W["Worker /p/*<br/>(PROXY_KEY check)"]
    W -->|stub.fetch| DO["ProxyRelay<br/>Durable Object"]
    A["agent (Node, on e.g. aliyun-yl)<br/>outbound WSS to /agent-ws"] -->|WebSocket| DO
    DO -->|req frames| A
    A -->|"http.request(aliyun-yl:3000)<br/>via existing tailscaled"| D[Target device:port]
    A -->|streamed response frames| DO
```

Key properties:

- **No Funnel / Serve** — nothing is exposed publicly; the agent only makes
  *outbound* WSS connections to Cloudflare.
- **One agent = whole tailnet** — the agent dials any device:port its
  tailscaled can reach (MagicDNS names or 100.x IPs), so a single deployment
  covers every machine. No per-device setup.
- **Full HTTP** — all methods, streaming request/response bodies, response
  headers preserved (hop-by-hop stripped), tagged `x-proxied-by: tailssh-relay`.
- **Resilient** — the DO uses WebSocket hibernation (free keep-alive), the
  agent reconnects with exponential backoff.

### One-time setup

1. **Worker side**:

   ```sh
   npx wrangler secret put PROXY_KEY    # client auth for /p/*
   npx wrangler secret put RELAY_KEY    # agent auth for /agent-ws
   npm run deploy
   ```

2. **Agent side** — on one always-on tailnet device (Node ≥ 22):

   ```sh
   RELAY_URL=wss://tailssh.<you>.workers.dev/agent-ws \
   RELAY_KEY=<RELAY_KEY> \
   node agent/agent.mjs
   ```

   Optional hardening: `ALLOW_DEVICES=aliyun-yl,mini` restricts which devices
   the agent will dial (comma-separated, empty = all). `PORT=0` disables the
   local health endpoint (default `127.0.0.1:8785`).

   For a persistent setup, run it under systemd/launchd/pm2 — e.g.:

   ```ini
   # /etc/systemd/system/tailssh-agent.service
   [Unit]
   Description=tailssh relay agent
   After=network-online.target

   [Service]
   Environment=RELAY_URL=wss://tailssh.<you>.workers.dev/agent-ws
   EnvironmentFile=/etc/default/tailssh-agent   # RELAY_KEY=… ALLOW_DEVICES=…
   ExecStart=/usr/bin/node /opt/tailssh/agent/agent.mjs
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```

### Usage

```sh
# Header auth (recommended)
curl -H "x-proxy-key: $PROXY_KEY" https://tailssh.<you>.workers.dev/p/aliyun-yl/3000/package.json

# Or query param
curl "https://tailssh.<you>.workers.dev/p/100.81.0.16/8080/admin?key=$PROXY_KEY"
```

The device segment accepts a MagicDNS short name (`aliyun-yl`), a full FQDN,
or a bare tailnet IP — resolved by the agent's machine via tailscaled.

### Error paths

| Case | Response |
|---|---|
| Missing/invalid `PROXY_KEY` | `401` — `missing or invalid proxy key` |
| Bad device name / port | `400` — `invalid device` / `invalid port` |
| Agent not running | `502` — `relay agent not connected` |
| Target unreachable / hung | `502` — dial error, or `relay timed out after 120s` |
| `PROXY_KEY`/`RELAY_KEY` secret not set | `503` — `… secret is not configured` |

### Security notes

- Both surfaces are authenticated: `/p/*` with `PROXY_KEY`, `/agent-ws` with
  `RELAY_KEY` (the agent is an outbound dialer — no inbound ports anywhere).
- The agent can reach **your whole tailnet**, so treat `RELAY_KEY` as highly
  sensitive and consider `ALLOW_DEVICES` to bound the blast radius.
- The Worker never forwards `x-proxy-key` or `cf-*` headers upstream.
- For stronger protection, front `/p/*` with Cloudflare Access.

### Why not run the Tailscale node inside the Worker?

Investigated and ruled out: `main.wasm` is ~32 MB (Worker limit: 3 MB free /
10 MB paid, compressed), the 1 s Worker startup budget can't absorb compiling
it, the pinned `@tailscale/connect` build exposes no auth-key login path for
headless use, and the binary is built for browsers (`wasm_exec` +
`sessionStorage`), not the Workers runtime. The browser SW proxy works because
the node runs **in the browser** — the SW is just a router. Tailscale
Funnel/Serve was also rejected: each device can bind its certificate domain
to only one service, so it cannot cover "any device, any port" — which the
single relay agent does.

---

## Deployment

### 1. First deploy

If this is your first deploy, Wrangler will create the project automatically.
The Worker code (`src/index.js`) only handles the `/f/*` funnel proxy route —
everything else is pure static assets served by Cloudflare's Workers
infrastructure. The name is set in `wrangler.jsonc` (`"name": "tailssh"`).
Change it there if you want a different subdomain.

Before deploying, set the two relay-proxy secrets (see
[Persistent proxy via relay agent](#persistent-proxy-via-relay-agent-pdeviceport)):

```sh
npx wrangler secret put PROXY_KEY
npx wrangler secret put RELAY_KEY
```

### 2. Deploy

```sh
npm run deploy
```

Wrangler will print the deployed URL, which will be:

```
https://tailssh.<your-cf-subdomain>.workers.dev
```

### 3. Custom domain (optional)

To use your own domain instead of the `*.workers.dev` URL:

1. In the Cloudflare dashboard, open **Workers & Pages → tailssh → Settings →
   Domains & Routes**.
2. Add a route or custom domain pointing to the Worker.
3. Ensure the domain is proxied through Cloudflare (orange-cloud in DNS).

**Reminder:** a custom domain makes the app easier to find. If your domain is
publicly resolvable, add an access control layer (Cloudflare Access is free for
up to 50 users) before sharing the URL with anyone.

---

## Security notes

- The **browser app** holds no Tailscale credentials: each session creates an
  **ephemeral** Tailscale node under the identity the visitor logs in with;
  the node disappears from that tailnet automatically when the tab is closed.
- The device list comes from the ephemeral node's own netmap, so it only ever
  contains peers the logged-in user's tailnet ACLs let them see. Users see
  their own tailnet — never the deployer's.
- SSH credentials are certificate-based via Tailscale SSH — no passwords are
  stored or transmitted by this app.
- Tailscale ACLs govern which users can SSH into which machines. TailSSH does
  not bypass them.
- The **`/p/*` relay proxy is the one server-side surface**: it reaches
  *the deployer's* tailnet (via the relay agent's tailscaled), so it requires
  the `PROXY_KEY` secret on every request (`401` otherwise). The agent
  endpoint `/agent-ws` separately requires `RELAY_KEY`. The agent only makes
  outbound connections — no inbound ports anywhere. Treat both keys as
  sensitive — set them with `wrangler secret put`, never in `wrangler.jsonc`
  or git.

---

## Content Security Policy (planned)

The site is pure static assets, so a policy can only ship as a `<meta>` tag
in `index.html` (or a `_headers` file — see rollout below). Nothing is
enforced yet; this is the target policy and the open questions to settle
before turning it on.

### Draft policy

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self';
  img-src 'self' data:;
  font-src 'self';
  connect-src 'self' https://*.tailscale.com wss://*.tailscale.com https://log.tailscale.io;
  base-uri 'self';
  form-action 'self';
  object-src 'none'">
```

Why each part:

| Directive | Rationale |
|---|---|
| `script-src 'self' 'wasm-unsafe-eval'` | `app.js` / `pkg.js` / the vendored Alpine (`public/alpine.esm.js`, pinned to 3.16.3 — no third-party script origin at all) are same-origin. The Go runtime needs `'wasm-unsafe-eval'` to compile `main.wasm`. |
| `connect-src 'self' https://*.tailscale.com wss://*.tailscale.com https://log.tailscale.io` | Verified against a captured session HAR (2026-08). The browser node talks to `controlplane.tailscale.com` (netmap + a persistent `wss://` watch connection), the DERP relays (https polling + `wss://` relays, hosts like `derp18d.tailscale.com` — still `*.tailscale.com`), and `log.tailscale.io` (runtime logs — note the **tailscale.io** domain, not tailscale.com). Tailnet traffic (SSH, peerapi latency probes) is *tunneled inside* the DERP connections — the HAR shows **zero** browser-level requests to `100.x` addresses, so no per-device exceptions are needed. The explicit `wss://` entries guard against browsers not honoring the CSP `https → wss` scheme upgrade. |
| `style-src 'self'` | Requires migrating the `<noscript>` fallback out of its inline `<style>` first (e.g. an `html.no-js` class toggle); otherwise `'unsafe-inline'` would be needed. |
| `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` | Cheap hardening — the page has no plugins, forms, or scriptable bases. |

### Open questions before enforcing

1. Do the explicit `wss://` entries hold everywhere, or can `https://`
   sources be relied on to cover `wss://` (CSP3 scheme upgrade)? The HAR
   confirms `wss://controlplane.tailscale.com` and `wss://derp*.tailscale.com`
   are both in use. Verify on Chrome / Firefox / Safari.
2. Custom DERP servers, if the tailnet ever configures any, must be added
   to `connect-src`.
3. ~~Confirm no other browser-level origins are contacted~~ — resolved by the
   session HAR: the complete origin inventory is `self` (workers.dev),
   `*.tailscale.com` (control / DERP) and `log.tailscale.io` (logs). Alpine
   has since been vendored (`public/alpine.esm.js`), removing the unpkg
   origin the HAR still shows. Re-verify after any dependency change.

### Recommended rollout

Meta tags cannot carry `frame-ancestors` / `X-Frame-Options`
(clickjacking protection needs real headers). Workers static assets
support a `_headers` file in the assets directory, which is the better
home for the final policy:

```
# public/_headers
/*
  Content-Security-Policy: <same policy, plus frame-ancestors 'none'>
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()
```

Suggested sequence: add `public/_headers` with
`Content-Security-Policy-Report-Only`, browse the whole app, fix any
reported violations, then switch the header to enforcing
`Content-Security-Policy`.

---

## Project structure

```
tailssh/
├── build.js            # Asset vendor script — see below
├── package.json
├── wrangler.jsonc      # Cloudflare config (assets-only, no server code)
└── public/
    ├── index.html
    ├── style.css
    ├── app.js          # Browser entry point (SSH sessions + proxy host)
    ├── proxy-sw.js     # Service Worker: /proxy/<device>/<port>/ interception
    ├── alpine.esm.js   # Vendored Alpine 3.16.3 (no third-party script origin)
    ├── pkg.js          # @tailscale/connect ESM bundle (build output)
    ├── config.js       # Generated bootstrap: hashed wasm path + feature flags
    ├── _headers        # Custom response headers (immutable wasm caching; CSP later)
    ├── assets/
    │   └── main.<hash>.wasm  # Tailscale WASM binary (build output, immutable cache)
    └── pkg.css         # xterm.js base styles (build output)
```

### build.js

There is no Webpack/Vite/esbuild in this project. `build.js` is a plain Node
ESM script that copies three files out of `node_modules/@tailscale/connect` into
`public/`:

| File | What it is |
|---|---|
| `pkg.js` | Self-contained ESM bundle — includes xterm.js, FitAddon, WebLinksAddon, the `wasm_exec` shim, and the `createIPN` / `runSSHSession` exports. |
| `assets/main.<hash>.wasm` | The Go WASM binary (~22 MB), copied under a content-hash name and served with `Cache-Control: immutable` (see `public/_headers`), so repeat visits never re-download it. Kept as a separate file so the browser can use `WebAssembly.instantiateStreaming()` — inlining it into JS would break streaming compilation and exceed size limits. `app.js` learns the path from `config.js` via `createIPN({ wasmURL })`. |
| `config.js` | Generated bootstrap script (loaded before `app.js`): exposes the hashed wasm path as `globalThis.WASM_URL` and build-time feature flags as `globalThis.TAILSSH_CONFIG` (e.g. `proxyEnabled` from `TAILSSH_PROXY`). |
| `pkg.css` | xterm.js base stylesheet shipped by `@tailscale/connect`. |

`pkg.js` is already a self-contained bundle; re-bundling it through a tool like
esbuild would break its internal relative path resolution for `main.wasm`. The
build step is intentionally just a file copy.

`npm run build` (and therefore `npm run dev` / `npm run deploy`) runs `build.js`
automatically. You only need to re-run it manually if you update the
`@tailscale/connect` package.

---

## Updating Tailscale

The Tailscale WASM bundle is pinned to a specific `@tailscale/connect` version
in `package.json`. To update:

```sh
npm install @tailscale/connect@latest
npm run build
```

Test locally before deploying — the `createIPN` / `runSSHSession` API surface
can change between releases.

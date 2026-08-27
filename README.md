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

## Deployment

### 1. First deploy

If this is your first deploy, Wrangler will create the project automatically.
There is no server-side code — the deployment is pure static assets served by
Cloudflare's Workers infrastructure. The name is set in `wrangler.jsonc`
(`"name": "tailssh"`). Change it there if you want a different subdomain.

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

- There is **no server-side code, no secrets and no Tailscale credentials** —
  the deployment is pure static assets.
- Each browser session creates an **ephemeral** Tailscale node under the
  identity the visitor logs in with; the node disappears from that tailnet
  automatically when the tab is closed.
- The device list comes from the ephemeral node's own netmap, so it only ever
  contains peers the logged-in user's tailnet ACLs let them see. Users see
  their own tailnet — never the deployer's.
- SSH credentials are certificate-based via Tailscale SSH — no passwords are
  stored or transmitted by this app.
- Tailscale ACLs govern which users can SSH into which machines. TailSSH does
  not bypass them.

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
    ├── app.js          # Browser entry point
    ├── pkg.js          # @tailscale/connect ESM bundle (build output)
    ├── main.wasm       # Tailscale WASM binary (build output)
    └── pkg.css         # xterm.js base styles (build output)
```

### build.js

There is no Webpack/Vite/esbuild in this project. `build.js` is a plain Node
ESM script that copies three files out of `node_modules/@tailscale/connect` into
`public/`:

| File | What it is |
|---|---|
| `pkg.js` | Self-contained ESM bundle — includes xterm.js, FitAddon, WebLinksAddon, the `wasm_exec` shim, and the `createIPN` / `runSSHSession` exports. |
| `main.wasm` | The Go WASM binary (~32 MB). Kept as a separate file so the browser can use `WebAssembly.instantiateStreaming()` — inlining it into JS would break streaming compilation and exceed size limits. |
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

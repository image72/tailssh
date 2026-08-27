/**
 * Cloudflare Worker entry point for TailSSH.
 *
 * Routes:
 *   GET /api/healthz   — liveness check
 *   *                  — static assets from /public
 *
 * The Worker holds no secrets. The browser WASM node logs in interactively as
 * an ephemeral node, and the device list is built from the netmap that node
 * receives — so every visitor only sees the peers their own Tailscale
 * identity is allowed to see.
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/healthz") {
      return json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  },
};

function json(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

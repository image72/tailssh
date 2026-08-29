/**
 * tailssh Worker entry — persistent port proxy via a tailnet relay agent.
 *
 * Route map
 * ────────
 *   /p/<device>/<port>/<path>?<query>  → proxy through the relay agent
 *   /agent-ws?key=…                    → agent WebSocket (upstream to DO)
 *   everything else                    → static assets (SPA fallback)
 *
 * Why an agent: tailnet IPs (100.x) are CGNAT space with no route from
 * Cloudflare's edge, so a Worker can never `fetch()` them directly. A tiny
 * Node agent (agent/agent.mjs) runs on any always-on tailnet device, dials
 * targets with the tailscaled daemon already present on that machine, and
 * streams responses back over a WebSocket to a Durable Object. No funnel,
 * no public exposure, every device/port reachable.
 *
 * Security: both surfaces are authenticated with secrets —
 *   • /p/*      requires PROXY_KEY  (header `x-proxy-key` or `?key=`)
 *   • /agent-ws requires RELAY_KEY  (query `?key=`)
 * Set both with `npx wrangler secret put …`.
 */

import { ProxyRelay } from "./relay.js";

// Hop-by-hop headers that never make sense across a proxy hop. Mirrors the
// browser-side proxy (public/proxy-sw.js).
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
]);

// Device: MagicDNS short name ("aliyun-yl"), FQDN ("aliyun-yl.tail.ts.net."),
// or bare tailnet IP — same shape as the browser proxy's device check.
const DEVICE_RE = /^(\d{1,3}(\.\d{1,3}){3}|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)*\.?)$/i;

export { ProxyRelay };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/agent-ws") {
      return handleAgentWebSocket(request, env);
    }

    if (url.pathname === "/p" || url.pathname.startsWith("/p/")) {
      return handleProxy(request, url, env);
    }

    return env.ASSETS.fetch(request);
  },
};

// ── Agent WebSocket ──────────────────────────────────────────────────────────

async function handleAgentWebSocket(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!env.RELAY_KEY) {
    return jsonError(503, "RELAY_KEY secret is not configured on this Worker");
  }
  if (!key || !(await timingSafeEqual(key, env.RELAY_KEY))) {
    return jsonError(401, "missing or invalid relay key (?key=)");
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return jsonError(426, "expected websocket upgrade");
  }

  // Single relay instance: one agent, one namespace of requests. The DO
  // serves the upgrade at /connect, so rewrite the path before forwarding.
  const stub = env.RELAY.get(env.RELAY.idFromName("singleton"));
  const relayUrl = new URL(request.url);
  relayUrl.pathname = "/connect";
  relayUrl.protocol = "https:";
  relayUrl.hostname = "relay.internal";
  return stub.fetch(new Request(relayUrl, request));
}

// ── Proxy route ──────────────────────────────────────────────────────────────

/**
 * Proxy /p/<device>/<port>/<path>?<query> through the relay agent.
 * @returns {Promise<Response>}
 */
async function handleProxy(request, url, env) {
  // ── Auth ────────────────────────────────────────────────────────────────
  const key = request.headers.get("x-proxy-key") ?? url.searchParams.get("key");
  if (!env.PROXY_KEY) {
    return jsonError(503, "PROXY_KEY secret is not configured on this Worker");
  }
  if (!key || !(await timingSafeEqual(key, env.PROXY_KEY))) {
    return jsonError(401, "missing or invalid proxy key (x-proxy-key header or ?key=)");
  }

  // ── Parse /p/<device>/<port>/<path>?<query> ─────────────────────────────
  const rest = url.pathname.slice("/p/".length);
  const segs = rest.split("/").filter(Boolean);
  if (segs.length < 2) {
    return jsonError(404, "proxy URL must be /p/<device>/<port>/<path>");
  }
  const [device, portStr, ...pathSegs] = segs;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return jsonError(400, `invalid port "${portStr}"`);
  }
  if (!DEVICE_RE.test(device)) {
    return jsonError(400, `invalid device "${device}"`);
  }

  const targetPath = "/" + pathSegs.join("/") + (url.search || "");
  const targetUrl = `http://${device}:${port}${targetPath}`;

  // ── Build the relay request ─────────────────────────────────────────────
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    if (lower === "x-proxy-key" || lower.startsWith("cf-")) return;
    headers.set(name, value);
  });
  headers.set("x-relay-method", request.method);
  headers.set("x-relay-url", targetUrl);

  const stub = env.RELAY.get(env.RELAY.idFromName("singleton"));
  try {
    return await stub.fetch("https://relay.internal/relay", {
      method: "POST",
      headers,
      body: request.body,
      ...(request.body ? { duplex: "half" } : {}),
    });
  } catch (err) {
    return jsonError(502, `relay error: ${err?.message ?? err}`);
  }
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Constant-time string comparison: hash both sides so length/byte leaks
 * don't reach an attacker.
 * @param {string} a
 * @param {string} b
 * @returns {Promise<boolean>}
 */
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

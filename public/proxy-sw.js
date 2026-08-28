/**
 * proxy-sw.js — Service Worker: serve /proxy/<device>/<port>/... through the
 * tailssh app's WASM tailscale node.
 *
 * Why: Cloudflare Workers cannot dial tailnet IPs (100.x). The only entity in
 * the browser that can is the app page's WASM IPN instance. So this SW
 * intercepts proxy URLs, forwards the request to the app page (which is
 * always open in some tab), and relays the response back.
 *
 * URL shape: /proxy/<device>/<port>/<path>?<query>
 *   device: MagicDNS short name or tailscale IP
 *   port:   TCP port on that device
 *   <path>?<query>: forwarded verbatim to the origin server
 *
 * Handshake: the app page registers a MessagePort with this SW via
 * postMessage({ type: "proxy-host-register" }). Requests travel to the page
 * as { type: "proxy-request", id, method, url, headers, body } and responses
 * come back as { type: "proxy-response", id, status, headers, body }.
 */

const HOST_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 120_000;

/** @type {MessagePort|null} the app page's proxy host port */
let hostPort = null;
/** @type {Map<string, {resolve: Function, reject: Function}>} */
const pending = new Map();
/** @type {Map<string, Function>} id → SW FetchEvent respondWith resolver */
const responders = new Map();

let seq = 0;
const nextId = () => `p${++seq}-${Date.now().toString(36)}`;

self.addEventListener("install", (event) => {
  // Activate immediately so /proxy/ works on the first load after deploy.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// ── App page registers itself as the proxy host ─────────────────────────────

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "proxy-host-register" && event.ports?.[0]) {
    // A fresh app page is taking over host duty (e.g. reload). Replace any
    // previous port; in-flight requests to the old port will time out.
    if (hostPort) {
      try { hostPort.close(); } catch {}
    }
    hostPort = event.ports[0];
    hostPort.onmessage = (e) => handleHostMessage(e.data);
    hostPort.start?.();
    // Wake any SW-side waiters that were holding requests for a host.
    for (const wake of hostWaiters.splice(0)) wake();
    return;
  }

  if (msg.type === "proxy-host-unregister" && hostPort === event.ports?.[0]) {
    hostPort = null;
  }
});

/** @type {Array<Function>} */
const hostWaiters = [];
function waitForHost(timeoutMs) {
  if (hostPort) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = hostWaiters.indexOf(wake);
      if (i >= 0) hostWaiters.splice(i, 1);
      reject(new Error("no proxy host page is open — open the tailssh app in a tab"));
    }, timeoutMs);
    const wake = () => {
      clearTimeout(timer);
      const i = hostWaiters.indexOf(wake);
      if (i >= 0) hostWaiters.splice(i, 1);
      hostPort ? resolve() : reject(new Error("proxy host vanished"));
    };
    hostWaiters.push(wake);
  });
}

// ── Host → SW responses ─────────────────────────────────────────────────────

function handleHostMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "proxy-response" && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
}

// ── SW → host requests ──────────────────────────────────────────────────────

/**
 * Send a proxied request to the host page and resolve with its response
 * message. The responder callback lets a pending fetch be settled even if
 * the host dies mid-flight (page closed, navigated away).
 */
function askHost(req, onPending) {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`proxy request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, {
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(msg);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    if (onPending) onPending(id);
    hostPort.postMessage({ type: "proxy-request", id, ...req });
  });
}

// ── Fetch interception ──────────────────────────────────────────────────────

const PROXY_PREFIX = "/proxy/";

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(PROXY_PREFIX)) return;

  // Only same-origin proxy URLs are ours; let everything else through.
  event.respondWith(handleProxy(event));
});

async function handleProxy(event) {
  const request = event.request;
  const url = new URL(request.url);

  // /proxy/<device>/<port>/<path...>
  const rest = url.pathname.slice(PROXY_PREFIX.length);
  const segs = rest.split("/").filter(Boolean);
  if (segs.length < 2) {
    return jsonError(404, "proxy URL must be /proxy/<device>/<port>/<path>");
  }
  const [device, portStr, ...pathSegs] = segs;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return jsonError(400, `invalid port "${portStr}"`);
  }
  // Device names are DNS-ish; reject anything that smells like traversal.
  if (!/^(\d{1,3}(\.\d{1,3}){3}|[A-Za-z0-9-]+)$/.test(device)) {
    return jsonError(400, `invalid device "${device}"`);
  }

  const targetPath = "/" + pathSegs.join("/") + (url.search || "");
  const origin = `http://${device}:${port}`;

  // Read the body once (fetch() bodies are single-use).
  let bodyBuf = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    bodyBuf = await request.arrayBuffer();
  }

  const headers = {};
  request.headers.forEach((v, k) => {
    // Hop-by-hop and SW-managed headers don't apply on the new origin.
    if (["host", "connection", "content-length", "accept-encoding"].includes(k)) return;
    headers[k] = v;
  });

  await waitForHost(HOST_TIMEOUT_MS);

  let respMsg;
  try {
    respMsg = await askHost(
      {
        method: request.method,
        origin,
        path: targetPath,
        headers,
        body: bodyBuf ? Array.from(new Uint8Array(bodyBuf)) : null,
      },
      (id) => responders.set(id, null),
    );
  } catch (err) {
    return jsonError(502, String(err?.message || err));
  } finally {
    // nothing to clean — responders map only tracked ids for symmetry
  }

  if (respMsg.error) {
    return jsonError(502, respMsg.error);
  }

  const respHeaders = new Headers();
  for (const [k, v] of Object.entries(respMsg.headers || {})) {
    // Re-adding these would break browser handling of the SW response.
    if (["content-encoding", "transfer-encoding", "content-length", "connection"].includes(k.toLowerCase())) continue;
    respHeaders.set(k, v);
  }
  // Proxied content is same-origin through the SW; avoid letting a target
  // server set cross-site framing/credentials policies that break rendering.
  respHeaders.set("x-proxied-by", "tailssh-proxy");

  const body = respMsg.bodyBase64 ? base64ToBytes(respMsg.bodyBase64) : respMsg.bodyText ?? "";
  return new Response(body, {
    status: respMsg.status || 502,
    statusText: respMsg.statusText || "",
    headers: respHeaders,
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

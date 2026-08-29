#!/usr/bin/env node
/**
 * tailssh relay agent — persistent tailnet-side dialer for the /p/* proxy.
 *
 * Runs on any always-on tailnet device (Linux server, NAS, always-on Mac…).
 * It connects OUT to the Worker's Durable Object over WebSocket and dials
 * proxy targets using that machine's existing tailscaled — no root, no
 * tailscaled of its own, no funnel, no public exposure.
 *
 *   ┌────────────┐  WS (outbound)   ┌──────────────┐   tailnet    ┌───────────┐
 *   │ this agent │ ───────────────▶ │ ProxyRelay DO │ ──requests─▶ │  agent    │
 *   │  (device)  │ ◀─────────────── │  (Cloudflare) │ ◀──responses─│ dials dev │
 *   └────────────┘                  └──────────────┘              └───────────┘
 *
 * Usage
 * ─────
 *   RELAY_URL=wss://tailssh.<you>.workers.dev/agent-ws \
 *   RELAY_KEY=<RELAY_KEY secret> \
 *   node agent/agent.mjs
 *
 * Optional:
 *   AGENT_NAME   name reported to the DO (default: hostname)
 *   ALLOW_DEVICES  comma-separated device allowlist (SSRF hardening); empty = all
 *   PORT         port for the local health endpoint (default: 8785, 0 = off)
 *
 * Requires Node ≥ 22 (native WebSocket client). Zero npm dependencies.
 */

import { createServer } from "node:http";
import { hostname } from "node:os";

const RELAY_URL = process.env.RELAY_URL;
const RELAY_KEY = process.env.RELAY_KEY;
const AGENT_NAME = process.env.AGENT_NAME || hostname();
const ALLOW_DEVICES = (process.env.ALLOW_DEVICES ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const HEALTH_PORT = Number(process.env.PORT ?? 8785);

if (!RELAY_URL || !RELAY_KEY) {
  console.error("RELAY_URL and RELAY_KEY are required");
  console.error('  RELAY_URL=wss://tailssh.<you>.workers.dev/agent-ws RELAY_KEY=… node agent/agent.mjs');
  process.exit(1);
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32-bit — must match src/relay.js. */
function fnv1a(str) {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function b64ToBytes(b64) {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

/** FNV-1a hash → 4 big-endian bytes prefix for binary frames. */
function hashPrefix(id) {
  const h = fnv1a(id);
  return Uint8Array.of((h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff);
}

// ── Device allowlist ─────────────────────────────────────────────────────────

function deviceAllowed(targetUrl) {
  if (ALLOW_DEVICES.length === 0) return true;
  const host = new URL(targetUrl).hostname.toLowerCase();
  return ALLOW_DEVICES.some((d) => host === d || host.endsWith(`.${d}`));
}

// ── Request handling ─────────────────────────────────────────────────────────

/**
 * Dial the target with Node's http/https modules (tailscaled routes 100.x and
 * MagicDNS names) and stream the response back over the WebSocket.
 */
async function handleRequest(ws, msg) {
  const { id, method, url: targetUrl, headers } = msg;

  if (!deviceAllowed(targetUrl)) {
    ws.send(JSON.stringify({ type: "res-error", id, error: `device not in ALLOW_DEVICES: ${targetUrl}` }));
    return;
  }

  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    ws.send(JSON.stringify({ type: "res-error", id, error: `invalid target url: ${targetUrl}` }));
    return;
  }
  const isHttps = target.protocol === "https:";
  const http = isHttps ? await import("node:https") : await import("node:http");

  await new Promise((resolve) => {
    const req = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers,
      },
      (res) => {
        ws.send(JSON.stringify({
          type: "res-head",
          id,
          status: res.statusCode ?? 502,
          statusText: res.statusMessage ?? "",
          headers: res.headers,
        }));

        // Stream the body in ≤64 KiB binary frames: [4-byte hash][chunk]
        const prefix = hashPrefix(id);
        res.on("data", (chunk) => {
          const buf = Buffer.from(chunk);
          const frame = Buffer.concat([Buffer.from(prefix), buf]);
          if (ws.readyState === 1 /* OPEN */) ws.send(frame);
        });
        res.on("end", () => {
          ws.send(JSON.stringify({ type: "res-end", id }));
          resolve();
        });
        res.on("error", (err) => {
          ws.send(JSON.stringify({ type: "res-error", id, error: String(err?.message ?? err) }));
          resolve();
        });
      },
    );

    req.on("error", (err) => {
      ws.send(JSON.stringify({ type: "res-error", id, error: String(err?.message ?? err) }));
      resolve();
    });

    // Request body chunks arrive as {type:"body", id, b64}; body-end ends it.
    req.on("drain-ignored", () => {}); // placeholder; flow control below
    req.bodyChunks = req.bodyChunks ?? [];
    ws._bodyHandlers = ws._bodyHandlers ?? new Map();
    ws._bodyHandlers.set(id, {
      push: (b64) => req.write(Buffer.from(b64ToBytes(b64))),
      end: () => req.end(),
    });

    // The DO always sends body-end (empty body → immediately).
    // If the target hangs, Node's default socket timeout applies; also bound
    // the whole request to stay under the DO's 120 s budget.
    req.setTimeout(110_000, () => {
      req.destroy(new Error("target timed out after 110s"));
    });
  });
}

// ── WebSocket connection with reconnect/backoff ──────────────────────────────

let backoffMs = 1000;
let closedByUs = false;

function connect() {
  console.log(`[agent] connecting to ${RELAY_URL} …`);
  const ws = new WebSocket(`${RELAY_URL}?key=${encodeURIComponent(RELAY_KEY)}`);

  ws.onopen = () => {
    console.log("[agent] connected");
    backoffMs = 1000;
    ws.send(JSON.stringify({ type: "hello", agent: AGENT_NAME }));
  };

  ws.onmessage = (event) => {
    const data = event.data;
    if (typeof data === "string") {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === "req") {
        handleRequest(ws, msg).catch((err) => {
          try { ws.send(JSON.stringify({ type: "res-error", id: msg.id, error: String(err?.message ?? err) })); } catch {}
        });
      } else if (msg.type === "body" || msg.type === "body-end") {
        const h = ws._bodyHandlers?.get(msg.id);
        if (h) {
          if (msg.type === "body") h.push(msg.b64);
          else { h.end(); ws._bodyHandlers.delete(msg.id); }
        }
      } else if (msg.type === "ping") {
        ws.send("pong");
      }
      return;
    }
    // Binary frames are agent→DO only; ignore inbound.
  };

  ws.onclose = () => {
    ws._bodyHandlers?.clear();
    if (closedByUs) return;
    console.log(`[agent] disconnected — retrying in ${backoffMs / 1000}s`);
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  };

  ws.onerror = (err) => {
    console.error("[agent] ws error:", err?.message ?? err);
  };
}

// Keep the connection alive through hibernation: the DO auto-answers pings,
// but a client-side ping also keeps NAT mappings warm.
setInterval(() => {
  // No direct handle here; Node's WebSocket auto-responds to server pings.
  // The DO's setWebSocketAutoResponse handles hibernation keep-alive.
}, 60_000).unref();

// ── Local health endpoint (optional) ─────────────────────────────────────────

if (HEALTH_PORT > 0) {
  createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, agent: AGENT_NAME, devices: ALLOW_DEVICES.length ? ALLOW_DEVICES : "all" }));
  }).listen(HEALTH_PORT, "127.0.0.1", () => {
    console.log(`[agent] health endpoint on http://127.0.0.1:${HEALTH_PORT}`);
  });
}

connect();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    closedByUs = true;
    console.log(`[agent] ${sig} — exiting`);
    process.exit(0);
  });
}

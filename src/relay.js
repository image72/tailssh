/**
 * ProxyRelay — Durable Object bridging HTTP proxy requests to a persistent
 * tailnet agent over one WebSocket.
 *
 * Topology
 * ────────
 *   client ──HTTP──▶ Worker (/p/*) ──stub.fetch──▶ this DO ──WS──▶ agent
 *                                                     └─dials─▶ device:port
 *
 * The agent (agent/agent.mjs) runs on any always-on tailnet device and dials
 * targets using the tailscaled daemon already on that machine — no funnel,
 * no extra daemon, full tailnet reach.
 *
 * Wire protocol (DO ↔ agent, one WebSocket)
 * ─────────────────────────────────────────
 *   agent → DO : {type:"hello", agent:"<name>"}           first frame
 *   DO → agent : {type:"req", id, method, url, headers}   url = "http://device:port/path?query"
 *   DO → agent : {type:"body", id, b64}                   request body chunk
 *   DO → agent : {type:"body-end", id}                    request body complete
 *   agent→ DO  : {type:"res-head", id, status, statusText, headers}
 *   agent→ DO  : {type:"res-end", id}                     body complete
 *   agent→ DO  : {type:"res-error", id, error}            dial/read failure
 *   agent→ DO  : binary frame [4-byte BE fnv1a(id)][chunk]  response body data
 *
 * Binary body frames carry an FNV-1a hash of the request id instead of the
 * full id to keep frames small; ids are unique per request so the mapping is
 * unambiguous, and per-request frame order is guaranteed by the agent.
 *
 * Hibernation: acceptWebSocket() lets the DO evict between requests;
 * setWebSocketAutoResponse answers agent pings for free while evicted.
 */

const REQUEST_TIMEOUT_MS = 120_000; // aligns with the browser proxy's limit

export class ProxyRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** @type {Map<string, Pending>} id → in-flight request state */
    this.pending = new Map();
    /** @type {Map<number, string>} fnv1a(id) → id (binary frame routing) */
    this.hashIndex = new Map();
    this.agentConnected = false;
    this.seq = 0;
  }

  // ── Entry points (called via stub.fetch) ─────────────────────────────────

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      return this.handleAgentConnect(request);
    }
    if (url.pathname === "/relay") {
      return this.handleRelay(request);
    }
    return new Response("not found", { status: 404 });
  }

  /**
   * Upgrade the agent's WebSocket (Worker already verified RELAY_KEY).
   * @param {Request} request
   */
  async handleAgentConnect(request) {
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    // Free keep-alive while hibernating: runtime answers pings automatically.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * Relay one proxied HTTP request through the agent.
   * Metadata arrives in X-Relay-* headers; body streams in the POST body.
   * @param {Request} request
   */
  async handleRelay(request) {
    // Hibernation resets in-memory state, so don't trust this.agentConnected —
    // the live WebSocket list is the source of truth.
    const ws = this.state.webSockets?.[0];
    if (!ws) {
      return jsonError(502, "relay agent not connected — start agent/agent.mjs on a tailnet device");
    }
    this.agentConnected = true;

    const id = `r${++this.seq}-${Date.now().toString(36)}`;
    const method = request.headers.get("x-relay-method") ?? "GET";
    const targetUrl = request.headers.get("x-relay-url") ?? "";
    if (!targetUrl) {
      return jsonError(400, "missing x-relay-url");
    }

    // Forward the client's headers verbatim (Worker already stripped
    // hop-by-hop and auth headers).
    const headers = {};
    request.headers.forEach((value, name) => {
      if (!name.toLowerCase().startsWith("x-relay-")) headers[name] = value;
    });

    const { readable, writable } = new TransformStream();
    const pending = {
      writer: writable.getWriter(),
      status: 0,
      statusText: "",
      headers: null,
      headResolve: null,
      headReject: null,
      timer: null,
    };
    this.pending.set(id, pending);
    this.hashIndex.set(fnv1a(id), id);

    pending.timer = setTimeout(
      () => this.failRequest(id, `relay timed out after ${REQUEST_TIMEOUT_MS / 1000}s`),
      REQUEST_TIMEOUT_MS,
    );

    ws.send(JSON.stringify({ type: "req", id, method, url: targetUrl, headers }));

    // Pump the request body (if any) to the agent in base64 chunks.
    const pumpBody = async () => {
      try {
        if (request.body) {
          const reader = request.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            ws.send(JSON.stringify({ type: "body", id, b64: bytesToB64(value) }));
          }
        }
        ws.send(JSON.stringify({ type: "body-end", id }));
      } catch {
        try { ws.send(JSON.stringify({ type: "body-end", id })); } catch {}
      }
    };
    // waitUntil-style: don't block the head wait on body upload.
    pumpBody();

    // Wait for the agent's response head, then stream the body.
    try {
      await waitForHead(pending);
      const resHeaders = new Headers(pending.headers ?? {});
      resHeaders.set("x-proxied-by", "tailssh-relay");
      return new Response(readable, {
        status: pending.status,
        statusText: pending.statusText,
        headers: resHeaders,
      });
    } catch (err) {
      return jsonError(502, String(err?.message ?? err));
    }
  }

  // ── WebSocket events (hibernation-aware) ─────────────────────────────────

  async webSocketMessage(ws, message) {
    if (typeof message === "string") {
      let msg;
      try { msg = JSON.parse(message); } catch { return; }

      switch (msg.type) {
        case "hello":
          this.agentConnected = true;
          break;
        case "res-head": {
          const p = this.pending.get(msg.id);
          if (p) {
            p.status = msg.status ?? 502;
            p.statusText = msg.statusText ?? "";
            p.headers = msg.headers ?? {};
            p.headResolve?.();
          }
          break;
        }
        case "res-end": {
          const p = this.takePending(msg.id);
          if (p) {
            p.headResolve?.();
            await p.writer.close().catch(() => {});
          }
          break;
        }
        case "res-error":
          this.failRequest(msg.id, msg.error ?? "agent error");
          break;
      }
      return;
    }

    // Binary frame: [4-byte BE fnv1a(id)][body chunk]
    if (message instanceof ArrayBuffer || ArrayBuffer.isView(message)) {
      const bytes = new Uint8Array(
        message instanceof ArrayBuffer ? message : message.buffer,
        message instanceof ArrayBuffer ? 0 : message.byteOffset,
        message.byteLength,
      );
      if (bytes.length < 4) return;
      const hash = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
      const id = this.hashIndex.get(hash);
      const p = id ? this.pending.get(id) : null;
      if (p) {
        await p.writer.write(bytes.subarray(4)).catch(() => {});
      }
    }
  }

  async webSocketClose() {
    this.agentConnected = false;
    for (const id of [...this.pending.keys()]) {
      this.failRequest(id, "agent disconnected mid-request");
    }
  }

  async webSocketError() {
    this.agentConnected = false;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  takePending(id) {
    const p = this.pending.get(id);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      this.hashIndex.delete(fnv1a(id));
    }
    return p;
  }

  failRequest(id, message) {
    const p = this.takePending(id);
    if (!p) return;
    p.headReject?.(new Error(message));
    p.writer.abort(new Error(message)).catch(() => {});
  }
}

function waitForHead(pending) {
  if (pending.status !== 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    pending.headResolve = resolve;
    pending.headReject = reject;
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bytesToB64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** FNV-1a 32-bit — mirrors the agent's id→hash mapping for binary frames. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * TailSSH — Alpine.js frontend
 *
 * Architecture:
 *  - One Alpine root component ("tailssh") owns all reactive UI state
 *  - The netmap device cache stays module-level: it is fed by WASM IPN
 *    callbacks rather than the UI, and every picker pane consumes it
 *  - xterm sessions and HTML5 drag-and-drop stay imperative — Alpine is
 *    the wrong tool for mounting terminals
 *
 * All dynamic content renders through x-text/textContent — device names
 * and login URLs are external data, so no innerHTML/x-html anywhere.
 */

import Alpine from "./alpine.esm.js";
import { createIPN, runSSHSession } from "./pkg.js";

// ─── WASM environment patch ──────────────────────────────────────────────────
if (globalThis.fs) {
  globalThis.fs.cwd   = () => "/tmp";
  globalThis.fs.mkdir = (path, perm, cb) => { cb(null); };
}

// ─── Netmap device cache ─────────────────────────────────────────────────────
// Devices are sourced from the netmap pushes the WASM node receives after the
// user logs in interactively — no Tailscale API token is involved. Visibility
// is per-user: a peer only shows up here if the logged-in identity's ACLs
// allow seeing it.
/** @type {Array|null} */
let deviceCache = null;
/** @type {Array<function(Array|null): void>} — wake-ups for pickers waiting on the first netmap */
const deviceWaiters = [];

const DEVICE_WAIT_TIMEOUT_MS = 10_000;

/**
 * Replace the device cache with a mapped netmap snapshot and wake any
 * picker waiting for the first push.
 * @param {{self?: object, peers?: Array, lockedOut?: boolean}} nm
 */
function updateDeviceCache(nm) {
  const peers = Array.isArray(nm?.peers) ? nm.peers : [];
  deviceCache = peers.flatMap((p) => {
    // Guard: skip peers with no name — p.name.split(".") would throw
    if (!p?.name) return [];

    // Netmap `online` is a nullable bool: true/false, or undefined (omitted)
    // when the control plane has no presence data yet.
    const online = p.online === true ? true : p.online === false ? false : null;
    // MagicDNS FQDN e.g. "jkt02-mvn-1.taila58d0.ts.net." (trailing dot ok)
    const displayName = p.name.split(".")[0];
    const addresses = p.addresses ?? [];

    return [{
      id: p.nodeKey ?? p.name,
      name: p.name,
      displayName,
      hostname: displayName,
      addresses,
      ipv4: addresses.find((a) => !a.includes(":")) ?? null,
      ipv6: addresses.find((a) => a.includes(":")) ?? null,
      online,
      sshEnabled: p.tailscaleSSHEnabled === true,
    }];
  });
  for (const wake of deviceWaiters.splice(0)) wake(deviceCache);
}

/**
 * Release cached device data and fail any pending waiters. Used on
 * logout/relogin so stale device lists never survive an identity change.
 */
function clearDevices() {
  deviceCache = null;
  for (const wake of deviceWaiters.splice(0)) wake(null);
}

/**
 * Resolve the current device list. Returns the cached netmap snapshot when
 * available; otherwise waits for the next netmap push (normally within ~1s
 * of reaching Running). Resolves null if no netmap arrives within the
 * timeout window.
 * @returns {Promise<Array|null>}
 */
function fetchDevices() {
  if (deviceCache) return Promise.resolve(deviceCache);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const i = deviceWaiters.indexOf(wake);
      if (i !== -1) deviceWaiters.splice(i, 1);
      resolve(null);
    }, DEVICE_WAIT_TIMEOUT_MS);
    const wake = (devices) => {
      clearTimeout(timer);
      resolve(devices);
    };
    deviceWaiters.push(wake);
  });
}

// ─── Tailnet path latency probe ──────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 3_000;

/**
 * Measure the effective tailnet path RTT to a device: one HTTP round trip
 * through the WASM node's own data plane (ipn.fetch → netstack → WireGuard),
 * the same path an SSH session will use — direct P2P or DERP-relayed.
 *
 * Any settle counts as a round trip: success, CORS block, or protocol error
 * all surface after the network round trip has completed. Only a true hang
 * (ACL drop, device offline) outruns the timeout.
 * @returns {Promise<number|null>} RTT in ms, or null when unreachable
 */
async function probeDevice(ipn, hostname) {
  if (typeof ipn?.fetch !== "function") return null;
  const t0 = performance.now();
  const roundTrip = ipn.fetch(`http://${hostname}`).catch(() => {});
  const timeout = new Promise((resolve) => setTimeout(resolve, PROBE_TIMEOUT_MS));
  return Promise.race([
    roundTrip.then(() => Math.round(performance.now() - t0)),
    timeout.then(() => null),
  ]);
}

// ─── Netmap self identity ────────────────────────────────────────────────────

/**
 * Derive the header identity label from the self node's MagicDNS FQDN, e.g.
 * "jackalope-stonecat.user-space.ts.net." → "jackalope-stonecat@user-space".
 * Custom domains (no ".ts.net") fall back to the full domain.
 */
function parseSelfName(fqdn) {
  const host = fqdn.replace(/\.$/, "");
  const [hostname, ...rest] = host.split(".");
  const tailnet = host.endsWith(".ts.net") && rest.length > 2 ? rest[0] : rest.join(".");
  return `${hostname}@${tailnet}`;
}

// ─── localStorage username persistence ───────────────────────────────────────

const LS_PREFIX = "tailssh:user:";

function getStoredUser(hostname) {
  try { return localStorage.getItem(LS_PREFIX + hostname) ?? ""; } catch { return ""; }
}

function setStoredUser(hostname, username) {
  try {
    if (username) localStorage.setItem(LS_PREFIX + hostname, username);
    else          localStorage.removeItem(LS_PREFIX + hostname);
  } catch {}
}

// ─── xterm options ───────────────────────────────────────────────────────────

function xtermOptions() {
  return {
    fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", monospace',
    fontSize: 14,
    lineHeight: 1.2,
    theme: {
      background:          "#1c1c1e",
      foreground:          "#f2f2f7",
      cursor:              "#f2f2f7",
      cursorAccent:        "#1c1c1e",
      selectionBackground: "rgba(10,132,255,0.25)",
      black:               "#48484a",
      red:                 "#ff453a",
      green:               "#30d158",
      yellow:              "#ffd60a",
      blue:                "#0a84ff",
      magenta:             "#bf5af2",
      cyan:                "#5ac8fa",
      white:               "#aeaeb2",
      brightBlack:         "#636366",
      brightRed:           "#ff6961",
      brightGreen:         "#34c759",
      brightYellow:        "#ffd426",
      brightBlue:          "#409cff",
      brightMagenta:       "#da8fff",
      brightCyan:          "#70d7ff",
      brightWhite:         "#f2f2f7",
    },
  };
}

// ─── Alpine root component ───────────────────────────────────────────────────

Alpine.data("tailssh", () => ({

  // ── state ──
  tsState: "NoState",
  loading: { visible: true, text: "Loading Tailscale WASM…" },
  auth: { visible: false, url: "" },
  logoutPending: false,
  /** @type {Array<{id:number, label:string, view:'picker'|'terminal', sessionDeviceId:number|null, query:string}>} */
  tabs: [],
  activeTabId: null,
  tabSeq: 0,
  dragSrcId: null,
  /** Live SSH sessions keyed by device id: { state, tabId, close } — global so
   *  every picker pane reflects which devices are busy */
  sessions: {},
  devices: [],
  devicesStatus: "waiting",   // waiting | ready | unavailable
  latencies: {},              // device id → "probing" | RTT ms | null (unreachable)
  loginTimer: null,
  everRan: false,
  ipn: null,
  self: null,                 // { label, ipv4 } — set from the first netmap
  modal: { open: false, username: "", desc: "", resolve: null },
  /** Port-proxy feature switch (from config.js, generated by build.js) */
  proxyEnabled: globalThis.TAILSSH_CONFIG?.proxyEnabled === true,

  async init() {
    try {
      this.ipn = await createIPN({
        wasmURL: globalThis.WASM_URL,   // content-hashed path from config.js
        stateStorage: {
          setState: (id, value) => { try { sessionStorage.setItem(`ts:${id}`, value); } catch {} },
          getState: (id) => { try { return sessionStorage.getItem(`ts:${id}`) ?? ""; } catch { return ""; } },
        },
        panicHandler: (err) => {
          console.error("[tailscale] panic:", err);
          this.showLoading(`Tailscale crashed: ${err}`);
          this.clearAllTabs();
        },
      });
      // Expose for the proxy host (module-level startProxyHost reads this)
      window.__tailsshIPN = this.ipn;
    } catch (err) {
      console.error(err);
      this.showLoading(`Failed to load Tailscale: ${err.message}`);
      return;
    }

    // Confirm before leaving while any SSH session is alive. Browsers ignore
    // window.confirm inside beforeunload and show their native leave dialog.
    window.addEventListener("beforeunload", (event) => this.onBeforeUnload(event));

    this.ipn.run({
      notifyState:       (state) => this.onState(state),
      notifyBrowseToURL: (url)   => this.onBrowseToURL(url),
      notifyNetMap:      (json)  => this.onNetMap(json),
      notifyPanicRecover: (err)  => this.onPanic(err),
    });
  },

  get statusInfo() {
    const map = {
      NoState:          ["Initializing",  "status-connecting"],
      InUseOtherUser:   ["In Use",        "status-stopped"],
      NeedsLogin:       ["Needs Login",   "status-needsLogin"],
      NeedsMachineAuth: ["Needs Auth",    "status-needsLogin"],
      Stopped:          ["Stopped",       "status-stopped"],
      Starting:         ["Starting",      "status-connecting"],
      Running:          ["Connected",     "status-running"],
    };
    const [label, cls] = map[this.tsState] ?? ["Unknown", "status-connecting"];
    return { label, cls };
  },

  // ── IPN callbacks ──

  onState(state) {
    console.log("[tailscale] state →", state);
    this.tsState = state;
    switch (state) {
      case "Running":
        if (this.loginTimer !== null) { clearTimeout(this.loginTimer); this.loginTimer = null; }
        this.auth.visible = false;
        this.loading.visible = false;
        this.logoutPending = false;
        this.everRan = true;
        // Open a fresh tab on every arrival at Running (including after re-login)
        if (this.tabs.length === 0) this.createTab();
        break;
      case "NeedsLogin":
      case "NeedsMachineAuth":
        this.clearAllTabs();
        this.showLoading("Waiting for Tailscale authentication…");
        this.scheduleLogin();
        break;
      case "Stopped":
        this.clearAllTabs();
        // Only a post-Running stop is an error; boot-time Stopped is normal
        if (this.everRan) this.showLoading("Tailscale node stopped unexpectedly.");
        break;
    }
  },

  onBrowseToURL(url) {
    console.log("[tailscale] login URL:", url);
    this.loading.visible = false;
    this.auth.url = url;
    this.auth.visible = true;
    window.open(url, "_blank", "noopener,noreferrer");
  },

  onNetMap(netMapJSON) {
    try {
      const nm = JSON.parse(netMapJSON);
      console.log("[tailscale] netmap — self:", nm.self?.name,
        "peers:", nm.peers?.length ?? 0);
      updateDeviceCache(nm);
      // Header identity: the ephemeral node the visitor logged in as
      if (nm.self?.name) {
        const selfAddrs = nm.self.addresses ?? [];
        this.self = {
          label: parseSelfName(nm.self.name),
          ipv4: selfAddrs.find((a) => !a.includes(":")) ?? null,
        };
      }
    } catch {
      console.debug("[tailscale] netmap (raw):", netMapJSON);
    }
  },

  onPanic(err) {
    console.error("[tailscale] panic:", err);
    this.clearAllTabs();
    this.showLoading(`Tailscale panic: ${err}`);
  },

  // ── boot helpers ──

  showLoading(text) {
    this.loading.visible = true;
    this.loading.text = text;
  },

  scheduleLogin() {
    // Defer by a tick so the state handler settles before login starts
    if (this.loginTimer !== null) clearTimeout(this.loginTimer);
    this.loginTimer = setTimeout(() => {
      this.loginTimer = null;
      console.log("[tailscale] calling ipn.login() (deferred)");
      this.ipn.login();
    }, 0);
  },

  clearAllTabs() {
    for (const session of Object.values(this.sessions)) session.close?.();
    this.sessions = {};
    this.tabs = [];
    this.activeTabId = null;
    // Stale device data must not survive a logout/relogin cycle
    clearDevices();
    this.devices = [];
    this.devicesStatus = "waiting";
    this.latencies = {};
  },

  // ── tabs ──

  createTab() {
    if (this.tsState !== "Running") return;   // "+" is inert before login
    const id = ++this.tabSeq;
    this.tabs.push({ id, label: "New tab", view: "picker", sessionDeviceId: null, query: "" });
    this.activateTab(id);
    this.loadPickerData();
  },

  closeTab(id) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const [tab] = this.tabs.splice(idx, 1);
    this.closeSession(tab.sessionDeviceId);

    if (this.tabs.length === 0) {
      this.createTab();   // never leave the workspace blank
      return;
    }
    if (this.activeTabId === id) {
      this.activateTab(this.tabs[Math.min(idx, this.tabs.length - 1)].id);
    }
  },

  activateTab(id) {
    this.activeTabId = id;
    this.$nextTick(() => {
      document
        .querySelector(`#tab-list .tab[data-id="${id}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      // Jump straight into the terminal when a live session is on this tab
      if (this.tabs.some((t) => t.id === id && t.session)) {
        document
          .querySelector(`.pane[data-id="${id}"] .xterm-helper-textarea`)
          ?.focus();
      }
    });
  },

  logout() {
    this.logoutPending = true;
    this.ipn.logout();
  },

  openLoginUrl() {
    if (this.auth.url) window.open(this.auth.url, "_blank", "noopener,noreferrer");
  },

  onBeforeUnload(event) {
    if (Object.keys(this.sessions).length === 0) return;
    event.preventDefault();
    event.returnValue = "";   // required by Chrome to raise the leave dialog
  },

  // ── device picker ──

  async loadPickerData() {
    const devices = await fetchDevices();
    if (devices === null) {
      this.devicesStatus = "unavailable";
      return;
    }
    this.devices = devices;
    this.devicesStatus = "ready";
    this.probeLatencies();
  },

  refreshPicker() {
    this.loadPickerData();
    this.probeLatencies(true);
  },

  get sortedDevices() {
    // SSH-enabled first, then online, then alphabetically
    return [...this.devices].sort((a, b) => {
      if (a.sshEnabled !== b.sshEnabled) return a.sshEnabled ? -1 : 1;
      if (a.online     !== b.online)     return a.online     ? -1 : 1;
      return (a.displayName || a.name || "").localeCompare(b.displayName || b.name || "");
    });
  },

  filteredDevices(tab) {
    const q = tab.query.trim().toLowerCase();
    if (!q) return this.sortedDevices;
    return this.sortedDevices.filter((d) =>
      [d.displayName, d.hostname, ...d.addresses].join(" ").toLowerCase().includes(q));
  },

  // ── device card helpers ──

  onlineState(device) {
    return device.online === true ? "online"
      : device.online === false ? "offline"
      : "unknown";
  },

  onlineLabel(device) {
    return { online: "Online", offline: "Offline", unknown: "Unknown" }[this.onlineState(device)];
  },

  canConnect(device) {
    // Unknown presence may still connect — the SSH attempt is authoritative
    return device.online !== false && device.sshEnabled;
  },

  /**
   * Probe devices lacking a latency sample. Fire-and-forget; Refresh
   * (force=true) re-measures every device.
   */
  probeLatencies(force = false) {
    if (typeof this.ipn?.fetch !== "function") return;
    for (const device of this.devices) {
      if (!force && device.id in this.latencies) continue;
      this.latencies[device.id] = "probing";
      probeDevice(this.ipn, device.ipv4 ?? device.name).then((ms) => {
        // Skip stale results after a clear (logout/relogin)
        if (device.id in this.latencies) this.latencies[device.id] = ms;
      });
    }
  },

  latencyLabel(device) {
    const r = this.latencies[device.id];
    if (r === "probing")       return "probing…";
    if (r === null)            return "unreachable";
    if (typeof r === "number") return `${r}ms`;
    return "";
  },

  isSessionTarget(device) {
    return this.sessions[device.id] !== undefined;
  },

  isConnecting(device) {
    return this.sessions[device.id]?.state === "connecting";
  },

  connectLabel(device) {
    const state = this.sessions[device.id]?.state;
    if (state === "connected")  return "Connected";
    if (state === "connecting") return "Connecting…";
    return device.sshEnabled ? "Connect" : "SSH disabled";
  },

  connectDisabled(device) {
    return this.isSessionTarget(device) || !this.canConnect(device);
  },

  connectBlockReason(device) {
    if (this.isSessionTarget(device)) return null;   // the label already says it
    if (device.online === false) return "Device is offline";
    if (!device.sshEnabled)      return "Tailscale SSH not enabled on this device";
    return null;
  },

  deviceUrl(device) {
    return `https://console.tailscale.com/admin/machines/${device.ipv4}`;
  },

  // ── port proxy ──

  /**
   * Proxy URL for a device port: /proxy/<device>/<port>/ — served by the
   * service worker through this page's WASM tailscale node. The device
   * segment is the MagicDNS short name (stable across IP changes).
   */
  proxyUrl(device, port) {
    const name = device.displayName || device.name.split(".")[0];
    return `/proxy/${encodeURIComponent(name)}/${port}/`;
  },

  /** Prompt for a port and open the proxy URL in a new tab. */
  async openProxy(tab, device) {
    if (!PROXY_ENABLED) return;   // button is hidden when disabled; belt & braces
    const name = device.displayName || device.name.split(".")[0];
    const input = prompt(`Port on ${name} to proxy:`, "80");
    if (input === null) return;
    const port = Number(input.trim());
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      alert(`Invalid port: ${input}`);
      return;
    }
    window.open(this.proxyUrl(device, port), "_blank", "noopener");
  },

  get selfUrl() {
    return this.self?.ipv4
      ? `https://console.tailscale.com/admin/machines/${this.self.ipv4}`
      : null;
  },

  // ── SSH sessions ──

  async openSession(tab, device) {
    // One session per device (reflected in every picker) and per pane —
    // also re-checked after the async username prompt
    if (this.isSessionTarget(device) || tab.sessionDeviceId !== null || tab.view === "terminal") return;

    const user = await this.promptUsername(device);
    if (user === null || this.isSessionTarget(device) || tab.sessionDeviceId !== null || tab.view === "terminal") return;

    setStoredUser(device.displayName || device.name, user);
    tab.label = `${user}@${device.displayName || device.name.split(".")[0]}`;

    // Card feedback for the whole handshake: spinner → "Connected". The pane
    // stays on the picker until the session is live; the hidden terminal
    // mount self-heals via pkg's ResizeObserver/FitAddon on reveal.
    tab.sessionDeviceId = device.id;
    this.sessions[device.id] = { state: "connecting", tabId: tab.id, close: null };

    let closed = false;
    const session = runSSHSession(
      document.querySelector(`.pane[data-id="${tab.id}"] .terminal-wrap`),
      { hostname: device.ipv4 ?? device.name, username: user, timeoutSeconds: 30 },
      this.ipn,
      {
        onConnectionProgress: (msg) => console.log(`[ssh:${tab.label}] progress:`, msg),
        onConnected: () => {
          console.log(`[ssh:${tab.label}] connected`);
          if (this.sessions[device.id]) this.sessions[device.id].state = "connected";
          tab.view = "terminal";
          this.$nextTick(() => {
            document
              .querySelector(`.pane[data-id="${tab.id}"] .xterm-helper-textarea`)
              ?.focus();
          });
        },
        onError: (err) => {
          console.error(`[ssh:${tab.label}] error:`, err);
          if (!closed) this.endSession(device.id);
        },
        onDone: () => {
          console.log(`[ssh:${tab.label}] done`);
          if (!closed) this.endSession(device.id);
        },
      },
      xtermOptions(),
    );

    this.sessions[device.id].close = () => {
      closed = true;
      try { session?.close?.(); } catch {}
    };
  },

  closeSession(deviceId) {
    if (deviceId === null) return;
    const session = this.sessions[deviceId];
    delete this.sessions[deviceId];
    session?.close?.();
  },

  endSession(deviceId) {
    const session = this.sessions[deviceId];
    delete this.sessions[deviceId];
    const tab = this.tabs.find((t) => t.id === session?.tabId);
    if (tab && tab.sessionDeviceId === deviceId) {
      tab.sessionDeviceId = null;
      tab.view = "picker";
    }
    this.loadPickerData();
  },

  // ── username modal ──

  promptUsername(device) {
    // Concurrent opens share one modal — the second caller bails immediately
    if (this.modal.open) return Promise.resolve(null);

    const key = device.displayName || device.name;
    const addrs = device.addresses ?? [];
    return new Promise((resolve) => {
      this.modal = {
        open: true,
        resolve,
        username: getStoredUser(key) || "root",
        desc: `Connecting to ${key} (${addrs[0] ?? device.name ?? key})`,
      };
      this.$nextTick(() => {
        this.$refs.usernameInput.focus();
        this.$refs.usernameInput.select();
      });
    });
  },

  confirmUsername() {
    const username = this.modal.username.trim();
    if (!username) {
      this.$refs.usernameInput.focus();
      return;
    }
    this.modal.resolve(username);
    this.modal.open = false;
    this.modal.resolve = null;
  },

  cancelUsername() {
    this.modal.resolve?.(null);
    this.modal.open = false;
    this.modal.resolve = null;
  },

  // ── drag-and-drop tab reorder ──

  onDragStart(event, id) {
    this.dragSrcId = id;
    event.dataTransfer.effectAllowed = "move";
    // Let the drag image render before dimming the source element
    requestAnimationFrame(() => (event.currentTarget.style.opacity = "0.4"));
  },

  onDragOver(event) {
    event.dataTransfer.dropEffect = "move";
    event.currentTarget.classList.add("drag-over");
  },

  onDragLeave(event) {
    event.currentTarget.classList.remove("drag-over");
  },

  onDrop(event, targetId) {
    event.currentTarget.classList.remove("drag-over");
    const srcId = this.dragSrcId;
    this.dragSrcId = null;
    if (srcId === null || srcId === targetId) return;

    const srcIdx = this.tabs.findIndex((t) => t.id === srcId);
    const dstIdx = this.tabs.findIndex((t) => t.id === targetId);
    if (srcIdx === -1 || dstIdx === -1) return;

    // Keyed x-for reconciles the DOM order — mutating the array is enough
    const [srcTab] = this.tabs.splice(srcIdx, 1);
    this.tabs.splice(dstIdx, 0, srcTab);
  },

  onDragEnd(event) {
    event.currentTarget.style.opacity = "";
    this.dragSrcId = null;
    document.querySelectorAll(".tab.drag-over")
      .forEach((el) => el.classList.remove("drag-over"));
  },
}));

// ─── Proxy host: serve /proxy/<device>/<port>/ requests from the SW ─────────
// The Cloudflare Worker cannot reach tailnet IPs; this page's WASM node can.
// The SW forwards proxied HTTP requests here over a MessagePort, and we speak
// HTTP through the WASM node's ipn.fetch() (this @tailscale/connect build —
// 1.39.98-t02582083d, 2023-03 — exposes run/login/logout/ssh/fetch only; the
// raw-TCP ipn.tcp() arrived in later tsconnect builds).
//
// Feature switch: the whole subsystem (SW registration + Proxy UI) is gated
// on globalThis.TAILSSH_CONFIG.proxyEnabled, generated by build.js from the
// TAILSSH_PROXY env var. When disabled, the SW is never registered and any
// previously-installed copy is unregistered so stale /proxy/* interception
// cannot survive a redeploy with the feature off.

const PROXY_SW_URL = "./proxy-sw.js";
const PROXY_ENABLED = globalThis.TAILSSH_CONFIG?.proxyEnabled === true;

/** @type {MessagePort|null} */
let proxyHostPort = null;

function bytesToBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Resolve a device reference to a tailnet IP. Accepts a bare IPv4 or a
 * MagicDNS name (short form "mbp" or FQDN "mbp.tailnet.ts.net."). The WASM
 * node has no DNS resolver, so names must be mapped via the netmap cache.
 * @returns {Promise<string|null>} tailnet IPv4 or null if unknown
 */
async function resolveDeviceHost(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host; // already an IP
  const devices = await fetchDevices();
  if (!devices) return null;
  const lower = host.toLowerCase().replace(/\.$/, "");
  const dev = devices.find((d) =>
    d.displayName === lower ||
    d.hostname === lower ||
    d.name.toLowerCase().replace(/\.$/, "") === lower);
  return dev?.ipv4 ?? null;
}

/**
 * HTTP GET through the WASM node's ipn.fetch(). The old build's fetch is
 * GET-only and returns no response headers, so the content type is sniffed
 * from the body to keep JSON/HTML rendering usable in the browser.
 * @returns {Promise<{status: number, statusText: string, headers: Object, body: Uint8Array}>}
 */
async function ipnFetch(ipn, host, port, method, path) {
  if (typeof ipn.fetch !== "function") {
    throw new Error("this tailscale.wasm build exposes no ipn.fetch — cannot proxy");
  }
  if (method !== "GET" && method !== "HEAD") {
    throw new Error(`proxy supports GET only (got ${method}) — this tailscale.wasm build has no raw TCP`);
  }
  const ip = await resolveDeviceHost(host);
  if (!ip) throw new Error(`unknown device "${host}" — not in netmap (or still loading)`);
  const url = `http://${ip}:${port}${path || "/"}`;
  const res = await ipn.fetch(url);
  const text = await res.text();
  const body = new TextEncoder().encode(text);
  // Header-less response: sniff a usable content type for browser rendering.
  let contentType = "text/plain; charset=utf-8";
  const head = text.slice(0, 200).trimStart();
  if (/^<\s*(!doctype|html)/i.test(head)) contentType = "text/html; charset=utf-8";
  else if (/^[[{]/.test(head)) contentType = "application/json";
  return {
    status: res.status,
    statusText: res.statusText ?? "",
    headers: { "content-type": contentType },
    body,
  };
}

/**
 * Register this page as the SW's proxy host and start serving requests.
 * Safe to call multiple times (e.g. after reload the SW replaces the port).
 */
async function startProxyHost(getIPN) {
  if (!PROXY_ENABLED) {
    // Feature off: make sure no stale SW from a previous deploy keeps
    // intercepting /proxy/* (its SPA-fallback response would confuse users).
    if ("serviceWorker" in navigator) {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          await reg.unregister();
          console.log("[proxy] disabled — unregistered stale proxy service worker");
        }
      } catch { /* best effort */ }
    }
    return;
  }
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register(PROXY_SW_URL);
    await navigator.serviceWorker.ready;
    const channel = new MessageChannel();
    proxyHostPort = channel.port1;

    proxyHostPort.onmessage = async (event) => {
      const msg = event.data;
      if (!msg || msg.type !== "proxy-request") return;
      const reply = (payload) => proxyHostPort.postMessage({ type: "proxy-response", id: msg.id, ...payload });

      // The SW already extracted device/port into msg.origin ("http://<device>:<port>")
      // and stripped the /proxy/<device>/<port> prefix from msg.path — no URL
      // re-validation needed here, just dial and relay.
      const ipn = getIPN();
      if (!ipn) { reply({ error: "tailscale node not ready" }); return; }

      try {
        // msg.origin is "http://<device>:<port>" — split it for the dial.
        const originUrl = new URL(msg.origin);
        const resp = await ipnFetch(
          ipn,
          originUrl.hostname,
          Number(originUrl.port) || 80,
          msg.method,
          msg.path,
        );
        reply({
          status: resp.status,
          statusText: resp.statusText,
          headers: resp.headers,
          bodyBase64: bytesToBase64(resp.body),
        });
      } catch (err) {
        reply({ error: String(err?.message ?? err) });
      }
    };

    proxyHostPort.start();
    reg.active?.postMessage({ type: "proxy-host-register" }, [channel.port2]);
    console.log("[proxy] host registered with service worker");
  } catch (err) {
    console.warn("[proxy] host registration failed:", err);
  }
}

// Start the proxy host once the IPN exists (module scope — Alpine component
// calls into this via window.__tailsshProxyHost if needed).
startProxyHost(() => window.__tailsshIPN ?? null);

Alpine.start();

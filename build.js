#!/usr/bin/env node
/**
 * build.js — Vendor required assets from node_modules into /public
 *
 * Files produced in /public
 * ──────────────────────────
 *  pkg.js                  @tailscale/connect ESM bundle
 *                          (includes xterm.js, FitAddon, WebLinksAddon, wasm_exec shim,
 *                           and the createIPN / runSSHSession exports)
 *  assets/main.<hash>.wasm Go WASM binary — the Tailscale node itself, under a
 *                          content-hash name so it can be cached immutably
 *                          (see public/_headers)
 *  wasm-url.js             one-liner that exposes the hashed wasm path to app.js
 *  pkg.css                 xterm.js stylesheet (from @xterm/xterm)
 *
 * Why a custom build script?
 * ──────────────────────────
 * • main.wasm (~32 MB) must remain a separate file so the browser can use
 *   WebAssembly.instantiateStreaming() — bundling it into JS would prevent
 *   streaming compilation and exceed size limits.
 * • pkg.js from @tailscale/connect is already a self-contained ESM bundle;
 *   re-bundling it would break its internal WASM path resolution.
 * • Cloudflare Workers Static Assets serves files from /public automatically
 *   with correct MIME types, caching, and global CDN distribution.
 *
 * Run:  node build.js   (or: npm run build)
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { resolve, join } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const PUBLIC  = resolve("public");

// ─── Helper ──────────────────────────────────────────────────────────────────

function copy(src, dest) {
  if (!existsSync(src)) {
    console.error(`  ✗  not found: ${src}`);
    process.exit(1);
  }
  copyFileSync(src, dest);
  console.log(`  ✓  ${dest.replace(process.cwd() + "/", "")}`);
}

function pkgRoot(pkg) {
  return resolve(require.resolve(`${pkg}/package.json`), "..");
}

// ─── @tailscale/connect ───────────────────────────────────────────────────────

console.log("\nCopying @tailscale/connect …");
const tsDir = pkgRoot("@tailscale/connect");

console.log("  package contents:", readdirSync(tsDir).join(", "));

// pkg.js — self-contained ESM bundle (xterm + wasm_exec + createIPN + runSSHSession)
copy(join(tsDir, "pkg.js"),   join(PUBLIC, "pkg.js"));

// main.wasm — the Go Tailscale WASM binary, copied under a content-hash
// filename into /assets/ so it can be served with immutable caching
// (see public/_headers). app.js picks the path up from wasm-url.js via
// createIPN({ wasmURL }).
const wasmSrc  = join(tsDir, "main.wasm");
const wasmHash = createHash("sha256").update(readFileSync(wasmSrc)).digest("hex").slice(0, 8);
const wasmName = `main.${wasmHash}.wasm`;
const assetsDir = join(PUBLIC, "assets");

mkdirSync(assetsDir, { recursive: true });
for (const old of readdirSync(assetsDir)) {
  if (old.endsWith(".wasm") && old !== wasmName) {
    rmSync(join(assetsDir, old));   // drop stale builds
  }
}
copy(wasmSrc, join(assetsDir, wasmName));

// wasm-url.js — tiny classic script (loaded before app.js) that hands the
// hashed wasm path to the runtime.
writeFileSync(join(PUBLIC, "wasm-url.js"),
  `globalThis.WASM_URL = "/assets/${wasmName}";\n`);
console.log(`  ✓  /public/wasm-url.js → ${wasmName}`);

// ─── pkg.css ─────────────────────────────────────────────────────────────────
// @tailscale/connect ships pkg.css which contains xterm CSS + Tailwind.
// We serve it alongside pkg.js.

copy(join(tsDir, "pkg.css"), join(PUBLIC, "pkg.css"));

// ─── Done ────────────────────────────────────────────────────────────────────

console.log("\nBuild complete.  Public assets:\n");
readdirSync(PUBLIC).sort().forEach((f) => console.log(`  /public/${f}`));
console.log();

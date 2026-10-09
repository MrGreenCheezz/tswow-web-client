// Serves a built web page (dist/web, bundled as resources/app/web by build.mjs) to the Electron
// window, so the built Electron version runs without Vite. Loopback only, files under the root
// only, and the same two cross-origin isolation headers vite.config.mjs sends: without them the
// page has no SharedArrayBuffer and the crowd pose worker stays on the main thread. Also the
// JS Self-Profiling policy, so a freeze recording (O → «Записать фризы») carries stack samples
// in an Electron shell that does not add it itself; the profiler samples only while recording.

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const zlib = require("node:zlib");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

const JS_PROFILING_HEADERS = {
  "Document-Policy": "js-profiling",
};

// 10.13: what a public page server adds. Vite names every bundle `assets/<name>-<8-char hash>.<ext>`,
// so those may be cached for good; pages keep `no-cache` and revalidate through a weak validator.
const HASHED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;
const COMPRESSIBLE = /^(text\/|application\/(json|wasm)|image\/svg\+xml)/;
/** Larger files are sent as they are: compressing them on the fly is not worth the memory. */
const MAX_COMPRESSED_SOURCE_BYTES = 16 * 1024 * 1024;
/** The compressed-body cache never holds more than this, whatever is asked for. */
const MAX_COMPRESSED_CACHE_BYTES = 64 * 1024 * 1024;

/** A weak validator from the file's size and modification time (the bytes are never hashed). */
function weakEtag(stats) {
  return `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
}

/** `If-None-Match` against a tag, comparing weakly (`W/` ignored) and accepting `*`. */
function etagMatches(header, etag) {
  if (typeof header !== "string") return false;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((value) => {
    const candidate = value.trim();
    return candidate === "*" || candidate.replace(/^W\//, "") === bare;
  });
}

/** The encoding to answer with: brotli, then gzip, from a plain `Accept-Encoding` list. */
function chooseEncoding(header) {
  if (typeof header !== "string") return undefined;
  const offered = new Map();
  for (const part of header.split(",")) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    const q = parameters.map((p) => p.trim()).find((p) => p.startsWith("q="));
    offered.set(name, q === undefined ? 1 : Number(q.slice(2)));
  }
  for (const encoding of ["br", "gzip"]) if ((offered.get(encoding) ?? 0) > 0) return encoding;
  return undefined;
}

/**
 * Compressed bodies by file, encoding, size and mtime — a rebuilt file is a new key. Bounded in
 * bytes: the oldest entries go first, so a slow trickle of distinct files cannot grow it.
 */
function compressedCache(limit = MAX_COMPRESSED_CACHE_BYTES) {
  const entries = new Map();
  let total = 0;
  return {
    get(key) {
      const hit = entries.get(key);
      if (hit === undefined) return undefined;
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },
    set(key, body) {
      if (body.byteLength > limit) return;
      const old = entries.get(key);
      if (old) total -= old.byteLength;
      entries.set(key, body);
      total += body.byteLength;
      for (const [oldest, value] of entries) {
        if (total <= limit) break;
        entries.delete(oldest);
        total -= value.byteLength;
      }
    },
    get bytes() { return total; },
  };
}

function compress(encoding, data, callback) {
  if (encoding === "br") {
    zlib.brotliCompress(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }, callback);
  } else {
    zlib.gzip(data, { level: 6 }, callback);
  }
}

/** The file a request path names under `root`, or undefined when it would leave the root. */
function resolveInside(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl ?? "/", "http://127.0.0.1").pathname);
  } catch {
    return undefined;
  }
  if (pathname.includes("\0")) return undefined;
  const file = path.resolve(root, `.${pathname}`);
  return file === root || file.startsWith(root + path.sep) ? file : undefined;
}

/**
 * Whether a public server may hand out this file (10.13 `publicPages`). Decided on the file's real
 * name (`fs.realpath.native`), so a Windows alias — another letter case, a trailing dot, an 8.3
 * short name such as `GLUE~1.HTM` — cannot reach a page the list leaves out. Only the listed pages
 * are served as HTML, and the local-only notice never is.
 */
function publicFileAllowed(realBase, realFile, publicPages) {
  const relative = path.relative(realBase, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const urlPath = `/${relative.split(path.sep).join("/")}`.toLowerCase();
  const name = path.basename(urlPath);
  if (name.startsWith("local_only")) return false;
  if (!/\.html?$/.test(name)) return true;
  return publicPages.some((page) => {
    const allowed = page.toLowerCase();
    return allowed === urlPath || (allowed.endsWith("/") && `${allowed}index.html` === urlPath);
  });
}

/**
 * The request handler behind `serveStatic`, exported for tests (an http server on port 0).
 *
 * Options added by 10.13, all off or harmless by default so the Electron window is unchanged:
 * `etag` (default on) — a weak `W/"<size>-<mtime>"` validator and 304; Vite's hashed
 * `assets/…-<hash>.*` are `immutable`, pages stay `no-cache`. `compress` (default off) — brotli or
 * gzip for text, JSON, SVG and wasm up to 16 MB, cached in memory by mtime (64 MB at most), with
 * `Vary: Accept-Encoding`. `publicPages` (default none) — only these pages are served as HTML.
 */
function staticHandler(root, { isolation = true, jsProfiling = true, etag = true, compress: compressBodies = false, publicPages } = {}) {
  const base = path.resolve(root);
  let realBase;
  const cache = compressedCache();
  /** What the handler did, for tests: how many bodies it compressed. */
  const stats = { compressions: 0 };
  /** Compressions in progress: key → the responses waiting for it. */
  const inFlight = new Map();
  const send =(request, response, file, fileStats) => {
    const contentType = MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const urlPath = `/${path.relative(base, file).split(path.sep).join("/")}`;
    const compressible = compressBodies && COMPRESSIBLE.test(contentType) && fileStats.size <= MAX_COMPRESSED_SOURCE_BYTES;
    const tag = etag ? weakEtag(fileStats) : undefined;
    const headers = {
      "Content-Type": contentType,
      // Asset names carry content hashes; the pages themselves must never outlive a rebuild.
      "Cache-Control": HASHED_ASSET.test(urlPath) ? "public, max-age=31536000, immutable" : "no-cache",
      ...(tag ? { ETag: tag } : {}),
      ...(compressible ? { Vary: "Accept-Encoding" } : {}),
      ...(isolation ? ISOLATION_HEADERS : {}),
      ...(jsProfiling ? JS_PROFILING_HEADERS : {}),
    };
    if (tag && etagMatches(request.headers["if-none-match"], tag)) {
      response.writeHead(304, headers).end();
      return;
    }
    const encoding = compressible && request.method === "GET" ? chooseEncoding(request.headers["accept-encoding"]) : undefined;
    if (encoding === undefined) {
      response.writeHead(200, { ...headers, "Content-Length": fileStats.size });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      fs.createReadStream(file).on("error", () => response.destroy()).pipe(response);
      return;
    }
    const key = `${encoding}\0${file}\0${fileStats.size}\0${fileStats.mtimeMs}`;
    const finish = (body) => {
      response.writeHead(200, { ...headers, "Content-Encoding": encoding, "Content-Length": body.byteLength });
      response.end(body);
    };
    const hit = cache.get(key);
    if (hit) {
      finish(hit);
      return;
    }
    // Requests for the same body while it is being compressed wait for that one run: a burst of
    // players (or one client asking in parallel) cannot start one 16 MB compression each.
    let waiting = inFlight.get(key);
    if (!waiting) {
      waiting = [];
      inFlight.set(key, waiting);
      const settle = (status, body) => {
        inFlight.delete(key);
        if (body) cache.set(key, body);
        for (const done of waiting) done(status, body);
      };
      fs.readFile(file, (readError, data) => {
        if (readError) {
          settle(404);
          return;
        }
        stats.compressions++;
        compress(encoding, data, (compressError, body) => settle(compressError ? 500 : 200, compressError ? undefined : body));
      });
    }
    waiting.push((status, body) => {
      if (body) finish(body);
      else response.writeHead(status).end();
    });
  };
  const handler = (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const target = resolveInside(base, request.url);
    if (target === undefined) {
      response.writeHead(404).end();
      return;
    }
    fs.stat(target, (error, stats) => {
      const file = !error && stats.isDirectory() ? path.join(target, "index.html") : target;
      fs.stat(file, (fileError, fileStats) => {
        if (fileError || !fileStats.isFile()) {
          response.writeHead(404).end();
          return;
        }
        if (!publicPages) {
          send(request, response, file, fileStats);
          return;
        }
        const check = (resolvedBase) => fs.realpath.native(file, (realError, realFile) => {
          if (realError || !publicFileAllowed(resolvedBase, realFile, publicPages)) {
            response.writeHead(404).end();
            return;
          }
          send(request, response, file, fileStats);
        });
        if (realBase !== undefined) {
          check(realBase);
          return;
        }
        fs.realpath.native(base, (baseError, resolvedBase) => {
          if (baseError) {
            response.writeHead(404).end();
            return;
          }
          realBase = resolvedBase;
          check(realBase);
        });
      });
    });
  };
  handler.stats = stats;
  return handler;
}

/**
 * Serves `root` on `host:port` and resolves with the page origin, e.g. `http://127.0.0.1:5173`.
 * Rejects with the listen error; EADDRINUSE usually means the Vite dev server holds the port.
 */
function serveStatic(root, { host = "127.0.0.1", port, ...options }) {
  const server = http.createServer(staticHandler(root, options));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(`http://${host}:${server.address().port}`);
    });
  });
}

module.exports = { serveStatic, staticHandler, resolveInside, publicFileAllowed, chooseEncoding };

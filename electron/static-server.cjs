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
 * Serves `root` on `host:port` and resolves with the page origin, e.g. `http://127.0.0.1:5173`.
 * Rejects with the listen error; EADDRINUSE usually means the Vite dev server holds the port.
 */
function serveStatic(root, { host = "127.0.0.1", port, isolation = true, jsProfiling = true }) {
  const base = path.resolve(root);
  const server = http.createServer((request, response) => {
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
        response.writeHead(200, {
          "Content-Type": MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
          "Content-Length": fileStats.size,
          // Asset names carry content hashes; the pages themselves must never outlive a rebuild.
          "Cache-Control": "no-cache",
          ...(isolation ? ISOLATION_HEADERS : {}),
          ...(jsProfiling ? JS_PROFILING_HEADERS : {}),
        });
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        fs.createReadStream(file).on("error", () => response.destroy()).pipe(response);
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(`http://${host}:${server.address().port}`);
    });
  });
}

module.exports = { serveStatic, resolveInside };

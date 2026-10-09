// 10.13 — the page server: validators and 304, compression with Vary, immutable hashed bundles,
// and on a public server only index.html among the pages.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const { staticHandler, chooseEncoding, publicFileAllowed } = createRequire(import.meta.url)("../electron/static-server.cjs");

const BUNDLE = `console.log(${JSON.stringify("x".repeat(4000))});`;

async function site() {
  const root = await mkdtemp(join(tmpdir(), "webclient-static-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>front door</title>");
  await writeFile(join(root, "glue.html"), "<!doctype html><title>bench</title>");
  await writeFile(join(root, "LOCAL_ONLY-NOT-FOR-REDISTRIBUTION.txt"), "local only");
  await writeFile(join(root, "favicon.svg"), "<svg/>");
  await writeFile(join(root, "assets", "app-1a2B3c_D.js"), BUNDLE);
  return root;
}

/** Raw GET: fetch would decompress for us and hide what was on the wire. */
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const call = httpRequest({ host: "127.0.0.1", port, path, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    call.on("error", reject);
    call.end();
  });
}

async function serving(root, options, run) {
  const server = createServer(staticHandler(root, options));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a page revalidates with a weak validator; a hashed bundle is immutable", async () => {
  const root = await site();
  try {
    await serving(root, {}, async (port) => {
      const page = await get(port, "/");
      assert.equal(page.status, 200);
      assert.equal(page.headers["cache-control"], "no-cache");
      assert.match(page.headers.etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
      assert.equal((await get(port, "/", { "if-none-match": page.headers.etag })).status, 304);
      assert.equal((await get(port, "/", { "if-none-match": page.headers.etag.slice(2) })).status, 304, "strong form too");
      const later = new Date(Date.now() + 10_000);
      await utimes(join(root, "index.html"), later, later);
      assert.equal((await get(port, "/", { "if-none-match": page.headers.etag })).status, 200, "a rebuild is a new version");

      const bundle = await get(port, "/assets/app-1a2B3c_D.js");
      assert.equal(bundle.headers["cache-control"], "public, max-age=31536000, immutable");
      assert.equal(bundle.headers["content-encoding"], undefined, "no compression unless asked for");
      assert.equal((await get(port, "/favicon.svg")).headers["cache-control"], "no-cache", "unhashed names revalidate");
      assert.equal((await get(port, "/glue.html")).status, 200, "the local window serves every page");
      assert.equal((await get(port, "/..%2f..%2fWindows%2fwin.ini")).status, 404, "never outside the root");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compression: brotli or gzip on request, Vary always, the same bytes after decoding", async () => {
  const root = await site();
  try {
    await serving(root, { compress: true }, async (port) => {
      const gzip = await get(port, "/assets/app-1a2B3c_D.js", { "accept-encoding": "gzip" });
      assert.equal(gzip.headers["content-encoding"], "gzip");
      assert.equal(gzip.headers.vary, "Accept-Encoding");
      assert.equal(Number(gzip.headers["content-length"]), gzip.body.byteLength);
      assert.ok(gzip.body.byteLength < BUNDLE.length / 4);
      assert.equal(gunzipSync(gzip.body).toString(), BUNDLE);
      const br = await get(port, "/assets/app-1a2B3c_D.js", { "accept-encoding": "gzip, deflate, br" });
      assert.equal(br.headers["content-encoding"], "br");
      assert.equal(brotliDecompressSync(br.body).toString(), BUNDLE);
      const again = await get(port, "/assets/app-1a2B3c_D.js", { "accept-encoding": "br" });
      assert.deepEqual(again.body, br.body, "served from the cache, byte for byte");
      const plain = await get(port, "/assets/app-1a2B3c_D.js");
      assert.equal(plain.headers["content-encoding"], undefined);
      assert.equal(plain.headers.vary, "Accept-Encoding", "a cache must not hand the plain copy to a brotli client");
      assert.equal(plain.body.toString(), BUNDLE);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const parallelRoot = await site();
  try {
    const handler = staticHandler(parallelRoot, { compress: true });
    const server = createServer(handler);
    const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
    try {
      const bodies = await Promise.all(Array.from({ length: 8 },
        () => get(port, "/assets/app-1a2B3c_D.js", { "accept-encoding": "br" })));
      assert.ok(bodies.every((answer) => answer.status === 200 && answer.body.equals(bodies[0].body)));
      assert.equal(handler.stats.compressions, 1, "eight requests at once share one compression");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await rm(parallelRoot, { recursive: true, force: true });
  }
  assert.equal(chooseEncoding("gzip;q=0, br;q=0"), undefined);
  assert.equal(chooseEncoding("br;q=0, gzip"), "gzip");
  assert.equal(chooseEncoding(undefined), undefined);
});

test("a public server answers index.html and assets, and no other page or the local-only notice", async () => {
  const root = await site();
  try {
    await serving(root, { compress: true, publicPages: ["/", "/index.html"] }, async (port) => {
      assert.equal((await get(port, "/")).status, 200);
      assert.equal((await get(port, "/index.html")).status, 200);
      assert.equal((await get(port, "/assets/app-1a2B3c_D.js")).status, 200);
      assert.equal((await get(port, "/favicon.svg")).status, 200);
      assert.equal((await get(port, "/glue.html")).status, 404);
      assert.equal((await get(port, "/GLUE.HTML")).status, 404, "another letter case is the same file on Windows");
      assert.equal((await get(port, "/glue.html%3A%3A%24DATA")).status, 404, "an NTFS stream name is the same file");
      assert.equal((await get(port, "/GLUE~1.HTM")).status, 404, "so is an 8.3 short name, where the volume has them");
      assert.equal((await get(port, "/LOCAL_ONLY-NOT-FOR-REDISTRIBUTION.txt")).status, 404);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(publicFileAllowed("C:\\web", "C:\\web\\index.html", ["/"]), true);
  assert.equal(publicFileAllowed("C:\\web", "C:\\other\\index.html", ["/"]), false);
});

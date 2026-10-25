// 25.10 (serve S1): the gateway compresses its compressible answers (brotli, else gzip) under every route.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";
import zlib from "node:zlib";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import {
  MAX_CONCURRENT_COMPRESSIONS, chooseEncoding, compressibleType, compressionKey, createResponseCompression, installCompression,
} from "../dist/code/gateway/ResponseCompression.js";
import { dbcDirectory } from "../tools/paths.mjs";

const ORIGIN = "http://127.0.0.1:5173";

/** A raw GET: status, headers and the bytes on the wire (nothing decoded). */
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

function decode(response) {
  const encoding = response.headers["content-encoding"];
  if (encoding === "br") return zlib.brotliDecompressSync(response.body);
  if (encoding === "gzip") return zlib.gunzipSync(response.body);
  return response.body;
}

test("chooseEncoding: brotli, then gzip; q=0 and identity refuse; * counts", () => {
  assert.equal(chooseEncoding(undefined), undefined);
  assert.equal(chooseEncoding("gzip, deflate"), "gzip");
  assert.equal(chooseEncoding("gzip, deflate, br"), "br");
  assert.equal(chooseEncoding("br;q=0, gzip"), "gzip");
  assert.equal(chooseEncoding("identity"), undefined);
  assert.equal(chooseEncoding("*"), "br");
  assert.equal(chooseEncoding("gzip;q=0"), undefined);
});

test("compressibleType: text, JSON, fonts and opaque binaries; never images or audio", () => {
  for (const type of ["application/json; charset=utf-8", "text/plain; charset=utf-8", "font/ttf", "application/octet-stream"]) {
    assert.equal(compressibleType(type), true, type);
  }
  for (const type of ["image/png", "audio/mpeg", "audio/wav", "application/x-webclient-hd-texture", undefined]) {
    assert.equal(compressibleType(type), false, String(type));
  }
});

async function withGateway(options, run) {
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN], datasetPollMs: 0, ...options,
  });
  try {
    return await run(`http://127.0.0.1:${gateway.port}`);
  } finally {
    await gateway.close();
  }
}

test("a tile body is sent compressed with the right headers, and as it is to a caller that offers nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-compress-"));
  try {
    const text = Buffer.from("WDL horizon heights 0123456789 ".repeat(4000));
    await writeFile(join(directory, "1.wdl"), text);
    await writeFile(join(directory, "2.wdl"), Buffer.from("tiny"));
    await writeFile(join(directory, "3.wdl"), randomBytes(64 * 1024));
    await writeFile(join(directory, "1.colour.png"), text);
    await withGateway({ horizonDirectory: directory }, async (base) => {
      const gz = await get(`${base}/horizon/1`, { origin: ORIGIN, "accept-encoding": "gzip, deflate" });
      assert.equal(gz.status, 200);
      assert.equal(gz.headers["content-encoding"], "gzip");
      assert.equal(Number(gz.headers["content-length"]), gz.body.byteLength, "the compressed length");
      assert.ok(gz.body.byteLength < text.byteLength / 10);
      assert.match(gz.headers.vary ?? "", /Accept-Encoding/);
      assert.equal(gz.headers["access-control-allow-origin"], ORIGIN, "the route's own headers are kept");
      assert.deepEqual(decode(gz), text);

      const br = await get(`${base}/horizon/1`, { origin: ORIGIN, "accept-encoding": "gzip, br" });
      assert.equal(br.headers["content-encoding"], "br");
      assert.deepEqual(decode(br), text);

      const plain = await get(`${base}/horizon/1`, { origin: ORIGIN });
      assert.equal(plain.headers["content-encoding"], undefined);
      assert.equal(Number(plain.headers["content-length"]), text.byteLength);
      assert.match(plain.headers.vary ?? "", /Accept-Encoding/, "a cache must still tell the two apart");
      assert.deepEqual(plain.body, text);

      const tiny = await get(`${base}/horizon/2`, { origin: ORIGIN, "accept-encoding": "gzip" });
      assert.equal(tiny.headers["content-encoding"], undefined, "under 1 KB is sent as it is");
      const noise = await get(`${base}/horizon/3`, { origin: ORIGIN, "accept-encoding": "gzip" });
      assert.equal(noise.headers["content-encoding"], undefined, "a body that does not shrink is sent as it is");
      assert.equal(noise.body.byteLength, 64 * 1024);
      const png = await get(`${base}/horizon/1/colour.png`, { origin: ORIGIN, "accept-encoding": "gzip, br" });
      assert.equal(png.headers["content-encoding"], undefined, "images are never tried");
      assert.equal(png.headers.vary, undefined);

      // What the page does: fetch() decodes on its own.
      const fetched = await fetch(`${base}/horizon/1`, { headers: { origin: ORIGIN } });
      assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), text);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a dataset answer is compressed under a weak tag, and that tag still earns a 304", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-compress-dbc-"));
  try {
    for (const name of ["BattlemasterList.dbc", "Map.dbc"]) await copyFile(join(dbcDirectory(), name), join(directory, name));
    await withGateway({ dbcDirectory: directory }, async (base) => {
      const first = await get(`${base}/dbc/battlegrounds`, { origin: ORIGIN, "accept-encoding": "gzip" });
      assert.equal(first.status, 200);
      assert.equal(first.headers["content-encoding"], "gzip");
      assert.match(first.headers.etag ?? "", /^W\/"/);
      assert.equal(first.headers.vary, "Origin, Accept-Encoding");
      JSON.parse(decode(first).toString("utf8"));
      const again = await get(`${base}/dbc/battlegrounds`, {
        origin: ORIGIN, "accept-encoding": "gzip", "if-none-match": first.headers.etag,
      });
      assert.equal(again.status, 304);
      assert.equal(again.body.byteLength, 0);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an ETagged body is compressed once: the next request is a cache hit; concurrent ones share the run", async () => {
  const compression = createResponseCompression();
  const body = Buffer.from(JSON.stringify({ rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `row ${i}` })) }));
  const server = createServer((request, response) => {
    installCompression(request, response, compression);
    response.writeHead(200, { "content-type": "application/json", etag: '"v1"' });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/x`;
    const answers = await Promise.all([1, 2, 3].map(() => get(url, { "accept-encoding": "gzip" })));
    for (const answer of answers) assert.deepEqual(decode(answer), body);
    assert.equal(compression.stats.compressed, 1, "three concurrent requests, one run");
    await get(url, { "accept-encoding": "gzip" });
    assert.equal(compression.stats.compressed, 1);
    assert.equal(compression.stats.cacheHits, 1);
    await get(url, { "accept-encoding": "br" });
    assert.equal(compression.stats.compressed, 2, "another encoding is another body");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("review: the cache key names the body, so a random query is a cache hit; compressions run two at a time", async () => {
  const body = Buffer.from("x".repeat(4096));
  assert.equal(compressionKey("gzip", 'W/"c1-1000-abcd"', body), compressionKey("gzip", '"c1-1000-abcd"', body));
  assert.notEqual(compressionKey("gzip", '"d2-0123"', body), compressionKey("gzip", '"d2-0123"', Buffer.from("y".repeat(4096))),
    "a dataset tag is shared by its route's queries: the body decides");
  const compression = createResponseCompression();
  const server = createServer((request, response) => {
    installCompression(request, response, compression);
    const varied = new URL(request.url, "http://x").searchParams.get("body");
    const text = varied === null ? body : Buffer.from(`${varied}`.repeat(3000));
    response.writeHead(200, { "content-type": "text/plain", etag: varied === null ? '"c1-fixed"' : `"c1-${varied}"` });
    response.end(text);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/x`;
    for (const query of ["?x=1", "?x=2", "?x=3"]) await get(`${url}${query}`, { "accept-encoding": "gzip" });
    assert.equal(compression.stats.compressed, 1, "?x=<random> does not compress the same bytes again");
    await Promise.all(Array.from({ length: 8 }, (_, i) => get(`${url}?body=b${i}`, { "accept-encoding": "gzip" })));
    assert.equal(compression.stats.compressed, 9);
    assert.ok(compression.peak <= MAX_CONCURRENT_COMPRESSIONS, `at most ${MAX_CONCURRENT_COMPRESSIONS} at once (${compression.peak})`);
    assert.equal(compression.running, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

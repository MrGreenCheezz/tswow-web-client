// 10.21 (a) — a published cache file is revalidated by its `stat`, never by reading and hashing it.
import assert from "node:assert/strict";
import { mkdtemp, open, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileEtag, respondFile } from "../dist/code/gateway/FileResponse.js";

const ORIGIN = "http://127.0.0.1:5173";

test("fileEtag is size, mtime in ns and index number, in hex", () => {
  assert.equal(fileEtag({ size: 255n, mtimeNs: 4096n, ino: 17n }), '"e1-ff-1000-11"');
  assert.equal(fileEtag({ size: 0n, mtimeNs: 1n, ino: 0n }), '"e1-0-1"', "no index number, no third part");
});

/** A server whose one route is respondFile over `filename`, counting reads through the handle. */
async function serve(filename, extra = {}) {
  const counts = { opens: 0, reads: 0, rebuilds: 0 };
  const opener = async (name) => {
    counts.opens++;
    const handle = await open(name, "r");
    const readFile = handle.readFile.bind(handle);
    handle.readFile = (...args) => {
      counts.reads++;
      return readFile(...args);
    };
    return handle;
  };
  const server = createServer((request, response) => {
    respondFile(request, response, filename, { origin: ORIGIN, contentType: "image/png", open: opener, ...extra(counts) })
      .catch((error) => response.writeHead(error.code === "ENOENT" ? 404 : 500).end());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    counts,
    get: (headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/`, { headers }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("a matching If-None-Match is a 304 that never reads the file; a changed file is a new tag", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-file-response-"));
  const filename = join(directory, "a.png");
  await writeFile(filename, "PNG-one");
  const box = await serve(filename, () => ({}));
  try {
    const first = await box.get();
    assert.equal(first.status, 200);
    assert.equal(await first.text(), "PNG-one");
    assert.equal(first.headers.get("content-length"), "7");
    assert.equal(first.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(first.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    const tag = first.headers.get("etag");
    const stats = await stat(filename, { bigint: true });
    assert.equal(tag, fileEtag(stats));
    assert.equal(box.counts.reads, 1);

    const again = await box.get({ "if-none-match": tag });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), "");
    assert.equal(box.counts.reads, 1, "the 304 did not read the file");
    assert.equal((await box.get({ "if-none-match": `W/${tag}` })).status, 304, "a weakened tag still matches");
    assert.equal((await box.get({ "if-none-match": `"x", ${tag}` })).status, 304);
    assert.equal((await box.get({ "if-none-match": "*" })).status, 304);
    assert.equal(box.counts.reads, 1);

    // A rebuild with a new timestamp is a new version even with the same bytes.
    const later = new Date(Date.now() + 10_000);
    await utimes(filename, later, later);
    const touched = await box.get({ "if-none-match": tag });
    assert.equal(touched.status, 200);
    const touchedTag = touched.headers.get("etag");
    assert.notEqual(touchedTag, tag);
    await touched.arrayBuffer();

    // A publisher's rename over the file with the same size and timestamp: the index number moves.
    const replacement = join(directory, "a.png.tmp");
    await writeFile(replacement, "PNG-two");
    await utimes(replacement, later, later);
    await rename(replacement, filename);
    const replaced = await box.get({ "if-none-match": touchedTag });
    const replacedStats = await stat(filename, { bigint: true });
    if (replacedStats.ino !== 0n) {
      assert.equal(replaced.status, 200, "same size and mtime, different file");
      assert.equal(await replaced.text(), "PNG-two");
    } else {
      await replaced.arrayBuffer();
    }
  } finally {
    await box.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing file is rebuilt once and served; without a rebuild it is the caller's ENOENT", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-file-response-miss-"));
  const filename = join(directory, "b.png");
  const box = await serve(filename, (counts) => ({
    rebuild: async () => {
      counts.rebuilds++;
      await writeFile(filename, "PNG-built");
    },
  }));
  const bare = await serve(join(directory, "never.png"), () => ({}));
  try {
    const built = await box.get();
    assert.equal(built.status, 200);
    assert.equal(await built.text(), "PNG-built");
    assert.equal(box.counts.rebuilds, 1);
    assert.equal((await bare.get()).status, 404, "the error reaches the caller before any header");
  } finally {
    await box.close();
    await bare.close();
    await rm(directory, { recursive: true, force: true });
  }
});

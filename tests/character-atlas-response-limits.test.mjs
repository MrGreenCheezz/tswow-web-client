import assert from "node:assert/strict";
import test from "node:test";
import {
  CharacterAtlasClient,
  decodedCharacterAtlasImagePixels,
} from "../dist/code/browser/CharacterAtlas.js";

const layer = (path) => [{ path }];

function installPage(fetchImpl, bitmapImpl = async () => ({ width: 2, height: 2, close() {} })) {
  const original = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    createImageBitmap: globalThis.createImageBitmap,
  };
  let decodes = 0;
  globalThis.fetch = fetchImpl;
  globalThis.createImageBitmap = async (blob) => {
    decodes++;
    return bitmapImpl(blob);
  };
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }),
  };
  return {
    get decodes() { return decodes; },
    restore() {
      globalThis.fetch = original.fetch;
      globalThis.document = original.document;
      globalThis.createImageBitmap = original.createImageBitmap;
    },
  };
}

const options = {
  limits: {
    sourceResponseBytes: 4,
    sourceEntryPixels: 16,
  },
};

test("declared encoded overflow cancels before blob/decode and is terminal for the source identity", async () => {
  let fetches = 0;
  let cancels = 0;
  let blobs = 0;
  const page = installPage(async () => {
    fetches++;
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name === "content-length" ? "5" : undefined },
      body: { cancel: async () => { cancels++; } },
      blob: async () => { blobs++; return { size: 1 }; },
    };
  });
  try {
    const atlas = new CharacterAtlasClient("http://limits.test", Date.now, options);
    assert.equal(await atlas.compose("one", layer("oversize.blp")), undefined);
    assert.equal(await atlas.compose("two", layer("oversize.blp")), undefined);
    assert.equal(fetches, 1, "a deterministic terminal source does not create a retry storm");
    assert.equal(cancels, 1);
    assert.equal(blobs, 0);
    assert.equal(page.decodes, 0);
    assert.equal(atlas.residencyStats.sources.terminalCount, 1);
  } finally {
    page.restore();
  }
});

test("a lying or missing content-length cannot bypass bounded streaming", async () => {
  let cancels = 0;
  let releases = 0;
  let blobs = 0;
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
  const page = installPage(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => undefined },
    body: {
      getReader() {
        return {
          async read() { return chunks.length > 0 ? { done: false, value: chunks.shift() } : { done: true }; },
          async cancel() { cancels++; },
          releaseLock() { releases++; },
        };
      },
    },
    blob: async () => { blobs++; return { size: 1 }; },
  }));
  try {
    const atlas = new CharacterAtlasClient("http://stream.test", Date.now, options);
    assert.equal(await atlas.compose("one", layer("stream.blp")), undefined);
    assert.equal(cancels, 1);
    assert.equal(releases, 1);
    assert.equal(blobs, 0);
    assert.equal(page.decodes, 0);
  } finally {
    page.restore();
  }
});

test("minimal blob-only Response fallback checks size before decode", async () => {
  let blobs = 0;
  const page = installPage(async () => ({
    ok: true,
    status: 200,
    blob: async () => { blobs++; return { size: 5 }; },
  }));
  try {
    const atlas = new CharacterAtlasClient("http://fallback.test", Date.now, options);
    assert.equal(await atlas.compose("one", layer("fallback.blp")), undefined);
    assert.equal(blobs, 1);
    assert.equal(page.decodes, 0);
  } finally {
    page.restore();
  }
});

test("decoded oversize and invalid dimensions close exact-once and stay terminal", async () => {
  for (const bitmap of [
    { width: 5, height: 4 },
    { width: Number.MAX_SAFE_INTEGER, height: 2 },
    { width: 1.5, height: 1 },
    { width: 0, height: 1 },
  ]) {
    let fetches = 0;
    let closes = 0;
    const image = { ...bitmap, close: () => { closes++; } };
    const page = installPage(async () => {
      fetches++;
      return { ok: true, status: 200, blob: async () => ({ size: 1 }) };
    }, async () => image);
    try {
      const atlas = new CharacterAtlasClient("http://decoded.test", Date.now, options);
      assert.equal(await atlas.compose("one", layer("bad.blp")), undefined);
      assert.equal(await atlas.compose("two", layer("bad.blp")), undefined);
      assert.equal(fetches, 1);
      assert.equal(closes, 1);
      assert.equal(atlas.residencyStats.sources.decodedPixels, 0);
      assert.equal(atlas.residencyStats.sources.terminalCount, 1);
    } finally {
      page.restore();
    }
  }
});

test("decoded pixel arithmetic validates dimensions before multiplication", () => {
  assert.equal(decodedCharacterAtlasImagePixels({ width: 3, height: 4 }, 12), 12);
  assert.equal(decodedCharacterAtlasImagePixels({ width: 4, height: 4 }, 15), undefined);
  assert.equal(decodedCharacterAtlasImagePixels({ width: Number.MAX_SAFE_INTEGER, height: 2 },
    Number.MAX_SAFE_INTEGER), undefined);
  assert.equal(decodedCharacterAtlasImagePixels({ width: 1, height: Number.POSITIVE_INFINITY }), undefined);
});

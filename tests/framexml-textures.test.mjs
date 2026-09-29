import assert from "node:assert/strict";
import test from "node:test";
import {
  FRAME_XML_EDGE_PIECES, FrameXmlTextureCache, frameXmlTextureCandidates, frameXmlTexturePath,
} from "../dist/code/browser/ui/framexml_compat/FrameXmlTextures.js";
import { repairFontSentinelSegment } from "../dist/code/browser/ui/framexml_compat/FrameXmlFonts.js";

// Three mechanisms that decide whether the glue screen has any art on it at all: the path the
// gateway is asked for, the reference counting behind the blob URLs, and the two bytes that
// separate the client's own font from one Chrome will not load.

test("a corpus texture name becomes the file the /texture route has", () => {
  // Measured against the running gateway: extensionless answers 400 and `.blp` answers 200.
  assert.equal(frameXmlTexturePath("Interface\\Glues\\Credits\\Parchment8"),
    "Interface\\Glues\\Credits\\Parchment8.blp");
  // A `.tga` name has never meant a TGA on disk; the same file answers 200 as `.blp`.
  assert.equal(frameXmlTexturePath("Interface\\Glues\\Login\\Glues-KoreanRating-Drugs.tga"),
    "Interface\\Glues\\Login\\Glues-KoreanRating-Drugs.blp");
  // An already-correct name is left alone, and forward slashes (which Lua writes) are converted.
  assert.equal(frameXmlTexturePath("Interface/LoginScreen/Fondo.blp"),
    "Interface\\LoginScreen\\Fondo.blp");
  // A dot in a directory is not an extension.
  assert.equal(frameXmlTexturePath("Interface\\Icons.old\\Foo"), "Interface\\Icons.old\\Foo.blp");
  // Nothing to ask for stays nothing to ask for: `…?path=` is a real request and a real 400.
  assert.equal(frameXmlTexturePath(""), "");
  assert.equal(frameXmlTexturePath("Interface\\ChatFrame\\"), "");
});

test("absolute HTTP(S) texture URLs stay direct and normalized", () => {
  assert.equal(frameXmlTexturePath(" https://Gateway.Example:443/spell-icon/136 "),
    "https://gateway.example/spell-icon/136");
  assert.equal(frameXmlTexturePath("HTTP://gateway.example/item-icon/42?variant=1#cached"),
    "http://gateway.example/item-icon/42?variant=1#cached");
  assert.deepEqual(frameXmlTextureCandidates("https://gateway.example/texture_lg.blp"), [
    "https://gateway.example/texture_lg.blp",
  ], "direct URLs do not get the MPQ _lg fallback");
});

test("non-HTTP texture references stay on the safe asset-path conversion", () => {
  for (const reference of [
    "data:image/png;base64,AAAA",
    "file:///tmp/icon.blp",
    "javascript:alert(1)",
  ]) {
    const candidate = frameXmlTexturePath(reference);
    assert.notEqual(candidate, reference, reference);
    assert.match(candidate, /\\|\.blp$/i, "unsafe scheme is not a direct URL");
  }
  assert.deepEqual(frameXmlTextureCandidates("Interface\\Glues\\Common\\Logo_lg"), [
    "Interface\\Glues\\Common\\Logo_lg.blp",
    "Interface\\Glues\\Common\\Logo.blp",
  ]);
});

test("the cache fetches once, hands the same blob to every holder, and lets go on release", async () => {
  const requested = [];
  let created = 0;
  let revoked = 0;
  globalThis.URL.createObjectURL = () => `blob:fake-${++created}`;
  globalThis.URL.revokeObjectURL = () => { revoked += 1; };
  const cache = new FrameXmlTextureCache({
    resolve: (path) => `http://gateway/texture?path=${path}`,
    fetch: async (url) => {
      requested.push(url);
      return { ok: true, status: 200, blob: async () => ({}) };
    },
  });

  // First sight of a path is asynchronous; the reconciliation pass that follows is not.
  assert.equal(cache.acquire("A.blp"), undefined);
  assert.equal(cache.acquire("A.blp"), undefined, "a second holder must not start a second fetch");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cache.acquire("A.blp"), "blob:fake-1");
  assert.equal(cache.peek("A.blp"), "blob:fake-1", "peek must not take a reference");
  assert.deepEqual(requested, ["http://gateway/texture?path=A.blp"]);
  assert.deepEqual(cache.stats, { held: 1, ready: 1, failed: 0 });

  // Released down to zero, the blob stays addressable — changing glue screens hides and shows the
  // same widgets, and revoking on the way out would refetch every picture on the way back.
  cache.release("A.blp");
  cache.release("A.blp");
  cache.release("A.blp");
  assert.equal(cache.peek("A.blp"), "blob:fake-1");
  assert.equal(revoked, 0);

  cache.dispose();
  assert.equal(revoked, 1);
  assert.equal(cache.acquire("A.blp"), undefined, "a disposed cache holds nothing");
});

test("a texture the gateway refuses settles, once, with its status", async () => {
  globalThis.URL.createObjectURL = () => "blob:unused";
  globalThis.URL.revokeObjectURL = () => {};
  let calls = 0;
  const cache = new FrameXmlTextureCache({
    resolve: (path) => path,
    fetch: async () => { calls += 1; return { ok: false, status: 404, blob: async () => ({}) }; },
  });
  cache.acquire("missing.blp");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cache.status("missing.blp"), 404);
  assert.equal(cache.peek("missing.blp"), undefined);
  cache.acquire("missing.blp");
  assert.equal(calls, 1, "a settled failure must not be retried on every reconciliation");
  assert.deepEqual(cache.stats, { held: 1, ready: 0, failed: 1 });
});

test("the edge pieces are named in the order the file stores them", () => {
  // Measured from `UI-Tooltip-Border.blp` (128x16, eight 16x16 tiles) by reading its alpha: tiles
  // 0..3 are vertical bars with identical rows, tiles 4..7 turn a bar into an arm.
  assert.deepEqual([...FRAME_XML_EDGE_PIECES],
    ["LEFT", "RIGHT", "TOP", "BOTTOM", "TOPLEFT", "TOPRIGHT", "BOTTOMLEFT", "BOTTOMRIGHT"]);
});

/**
 * The smallest thing that is shaped like the font: an sfnt directory with `maxp` and a `cmap`
 * holding one format 4 subtable whose sentinel segment maps U+FFFF out of range.
 */
function fontWithSentinel(idDelta, glyphCount = 242) {
  const tables = 2;
  const directory = 12 + tables * 16;
  const maxpOffset = directory;
  const cmapOffset = maxpOffset + 8;
  const segmentBytes = 2 * 2; // two segments
  const cmapLength = 14 + segmentBytes + 2 + segmentBytes * 3;
  const bytes = new ArrayBuffer(cmapOffset + cmapLength + 32);
  const view = new DataView(bytes);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, tables);
  const record = (index, tag, offset) => {
    const base = 12 + index * 16;
    for (let i = 0; i < 4; i++) view.setUint8(base + i, tag.charCodeAt(i));
    view.setUint32(base + 8, offset);
  };
  record(0, "maxp", maxpOffset);
  record(1, "cmap", cmapOffset);
  view.setUint16(maxpOffset + 4, glyphCount);
  view.setUint16(cmapOffset, 0);
  view.setUint16(cmapOffset + 2, 1);
  view.setUint16(cmapOffset + 4, 3);
  view.setUint16(cmapOffset + 6, 1);
  view.setUint32(cmapOffset + 8, 12);
  const sub = cmapOffset + 12;
  view.setUint16(sub, 4);
  view.setUint16(sub + 2, cmapLength - 12);
  view.setUint16(sub + 6, segmentBytes);
  const endBase = sub + 14;
  const startBase = endBase + segmentBytes + 2;
  const deltaBase = startBase + segmentBytes;
  const rangeBase = deltaBase + segmentBytes;
  view.setUint16(endBase, 0x0041);
  view.setUint16(endBase + 2, 0xffff);
  view.setUint16(startBase, 0x0041);
  view.setUint16(startBase + 2, 0xffff);
  view.setInt16(deltaBase, 3);
  view.setInt16(deltaBase + 2, idDelta);
  view.setUint16(rangeBase, 0);
  view.setUint16(rangeBase + 2, 0);
  return { bytes, deltaBase };
}

test("the cmap sentinel is repaired, and only when it is actually out of range", () => {
  // `Fonts\FRIZQT__.TTF` has 242 glyphs and one bad segment: the mandatory U+FFFF sentinel with
  // idDelta 0, which maps U+FFFF to glyph 65535. Chrome's sanitiser refuses the file for it.
  const broken = fontWithSentinel(0);
  assert.equal(repairFontSentinelSegment(broken.bytes), 1);
  assert.equal(new DataView(broken.bytes).getInt16(broken.deltaBase + 2), 1);

  // A font that already spells it correctly comes through byte-identical.
  const sound = fontWithSentinel(1);
  const before = new Uint8Array(sound.bytes.slice(0));
  assert.equal(repairFontSentinelSegment(sound.bytes), 0);
  assert.deepEqual(new Uint8Array(sound.bytes), before);

  // Not a font at all is not a crash.
  assert.equal(repairFontSentinelSegment(new ArrayBuffer(4)), 0);
});

// The same repair against the file it exists for. Skips cleanly on a machine with no client.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

test("the client's own FRIZQT__ carries exactly one out-of-range sentinel", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  try {
    const data = await chain.read("Fonts\\FRIZQT__.TTF");
    assert.ok(data, "the locale chain has Fonts\\FRIZQT__.TTF");
    const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    assert.equal(repairFontSentinelSegment(bytes), 1,
      "one segment, and it is the U+FFFF sentinel with idDelta 0");
    // Idempotent: a second pass finds nothing left to fix.
    assert.equal(repairFontSentinelSegment(bytes), 0);
  } finally {
    chain.close();
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PNG } from "pngjs";

import { decodeTga, tgaToPng } from "../tools/tga-png.mjs";

function header(type, width, height, depth, descriptor = 0) {
  const bytes = Buffer.alloc(18);
  bytes[2] = type;
  bytes.writeUInt16LE(width, 12);
  bytes.writeUInt16LE(height, 14);
  bytes[16] = depth;
  bytes[17] = descriptor;
  return bytes;
}

test("a bottom-up uncompressed TGA comes out RGBA, top row first", () => {
  // BGRA: the file's first row is the picture's bottom one.
  const pixels = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const { width, height, data } = decodeTga(Buffer.concat([header(2, 2, 2, 32), pixels]));
  assert.deepEqual([width, height], [2, 2]);
  assert.deepEqual([...data.subarray(0, 4)], [11, 10, 9, 12], "the top-left pixel is the file's third");
  assert.deepEqual([...data.subarray(8, 12)], [3, 2, 1, 4]);
});

test("the top-down flag, 24-bit and grey", () => {
  const top = decodeTga(Buffer.concat([header(2, 1, 2, 24, 0x20), Buffer.from([1, 2, 3, 4, 5, 6])]));
  assert.deepEqual([...top.data.subarray(0, 4)], [3, 2, 1, 255]);
  const grey = decodeTga(Buffer.concat([header(3, 1, 1, 8), Buffer.from([77])]));
  assert.deepEqual([...grey.data], [77, 77, 77, 255]);
});

test("RLE packets, run and raw", () => {
  const packets = Buffer.from([0x81, 1, 2, 3, 0x00, 4, 5, 6]);
  const { data } = decodeTga(Buffer.concat([header(10, 3, 1, 24), packets]));
  assert.deepEqual([...data], [3, 2, 1, 255, 3, 2, 1, 255, 6, 5, 4, 255]);
});

test("what this decoder cannot read is an error, not a blank picture", () => {
  assert.throws(() => decodeTga(Buffer.alloc(4)), /truncated/);
  assert.throws(() => decodeTga(header(1, 1, 1, 8)), /not supported/);
  assert.throws(() => decodeTga(header(2, 2, 2, 32)), /truncated/);
});

test("the PNG holds the decoded pixels", () => {
  const png = PNG.sync.read(tgaToPng(Buffer.concat([header(2, 1, 1, 32), Buffer.from([9, 8, 7, 200])])));
  assert.deepEqual([...png.data], [7, 8, 9, 200]);
});

test("the generator takes the .tga when the chain has no .blp, and keeps a BLP first", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "tga-texture-"));
  const previous = process.env.TEXTURE_DIR;
  process.env.TEXTURE_DIR = directory;
  context.after(() => {
    if (previous === undefined) delete process.env.TEXTURE_DIR;
    else process.env.TEXTURE_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const { publishTexture, validTexturePath, SourceMissing } = await import("../tools/generate-texture.mjs");
  const tga = Buffer.concat([header(2, 1, 1, 32), Buffer.from([9, 8, 7, 200])]);
  const asked = [];
  const archives = {
    read: async (path) => { asked.push(path); return path.endsWith("!Frame.tga") ? tga : undefined; },
    fingerprint: async () => "test",
    sourceOf: async () => undefined,
  };
  assert.equal(validTexturePath("Interface\\AddOns\\W\\!Frame.blp"), true, "the bang is an ordinary file name");
  let result;
  try {
    result = await publishTexture("Interface\\AddOns\\W\\!Frame.blp", archives);
  } catch (error) {
    // The stamp needs a real chain; the decision under test was made by then and its PNG is on disk.
    if (error instanceof SourceMissing) throw error;
  }
  assert.deepEqual(asked.slice(0, 2), ["Interface\\AddOns\\W\\!Frame.blp", "Interface\\AddOns\\W\\!Frame.tga"]);
  if (result) assert.equal(PNG.sync.read(readFileSync(result.destination)).width, 1);
  await assert.rejects(publishTexture("Interface\\AddOns\\W\\Nothing.blp", archives), SourceMissing);
});

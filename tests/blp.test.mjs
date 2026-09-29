import assert from "node:assert/strict";
import test from "node:test";
import { BlpError, decodeBlp, dxtFormat, readBlpHeader } from "../tools/blp.mjs";

// Builds a one-mip BLP2. Palette entries are given in file order: blue, green, red, alpha.
function blp({ encoding, alphaDepth = 0, alphaEncoding = 0, width, height, palette = [], mip, type = 1 }) {
  const header = Buffer.alloc(148 + 1024);
  header.write("BLP2", 0, "latin1");
  header.writeUInt32LE(type, 4);
  header[8] = encoding;
  header[9] = alphaDepth;
  header[10] = alphaEncoding;
  header[11] = 1;
  header.writeUInt32LE(width, 12);
  header.writeUInt32LE(height, 16);
  header.writeUInt32LE(148 + 1024, 20);
  header.writeUInt32LE(mip.length, 84);
  palette.forEach((entry, index) => {
    for (let channel = 0; channel < 4; channel++) header[148 + index * 4 + channel] = entry[channel] ?? 0;
  });
  return Buffer.concat([header, Buffer.from(mip)]);
}

const pixel = (image, index) => [...image.data.subarray(index * 4, index * 4 + 4)];

test("the header is validated and JPEG content is rejected", () => {
  assert.throws(() => readBlpHeader(Buffer.alloc(200)), BlpError);
  const jpeg = blp({ encoding: 2, width: 4, height: 4, mip: Buffer.alloc(8), type: 0 });
  assert.throws(() => readBlpHeader(jpeg), /JPEG/);
  const short = Buffer.alloc(20);
  short.write("BLP2", 0, "latin1");
  assert.throws(() => readBlpHeader(short), /shorter/);
});

// blpconverter.exe swaps red and blue on palette files - a human skin comes out blue.
// The palette really is stored blue, green, red, alpha, which is what this pins down.
test("palette entries are read as blue, green, red", () => {
  const image = decodeBlp(blp({
    encoding: 1,
    width: 2,
    height: 1,
    palette: [[10, 20, 30, 40], [200, 100, 50, 0]],
    mip: Buffer.from([0, 1]),
  }));
  assert.deepEqual(pixel(image, 0), [30, 20, 10, 255]);
  assert.deepEqual(pixel(image, 1), [50, 100, 200, 255]);
});

test("palette alpha is read at 1, 4 and 8 bits per pixel", () => {
  const palette = [[0, 0, 0, 0], [255, 255, 255, 0]];

  const oneBit = decodeBlp(blp({
    encoding: 1, alphaDepth: 1, width: 8, height: 1, palette,
    mip: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0b10100101]),
  }));
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((index) => pixel(oneBit, index)[3]), [255, 0, 255, 0, 0, 255, 0, 255]);

  const fourBit = decodeBlp(blp({
    encoding: 1, alphaDepth: 4, width: 4, height: 1, palette,
    mip: Buffer.from([0, 0, 0, 0, 0xf0, 0x8a]),
  }));
  assert.deepEqual([0, 1, 2, 3].map((index) => pixel(fourBit, index)[3]), [0, 255, 170, 136]);

  const eightBit = decodeBlp(blp({
    encoding: 1, alphaDepth: 8, width: 3, height: 1, palette,
    mip: Buffer.from([0, 0, 0, 7, 128, 255]),
  }));
  assert.deepEqual([0, 1, 2].map((index) => pixel(eightBit, index)[3]), [7, 128, 255]);
});

test("truncated palette alpha is rejected at every supported depth", () => {
  for (const [alphaDepth, width] of [[1, 8], [4, 2], [8, 1]]) {
    assert.throws(() => decodeBlp(blp({
      encoding: 1,
      alphaDepth,
      width,
      height: 1,
      // The palette indexes are complete and every required alpha byte is absent. Previously the
      // decoder stopped at `undefined` and silently left those pixels opaque.
      mip: Buffer.alloc(width),
    })), /palette alpha is truncated/, `${alphaDepth}-bit alpha`);
  }
});

test("raw pixels are stored blue, green, red, alpha", () => {
  const opaque = decodeBlp(blp({ encoding: 3, width: 1, height: 1, mip: Buffer.from([1, 2, 3, 9]) }));
  assert.deepEqual(pixel(opaque, 0), [3, 2, 1, 255]);
  const withAlpha = decodeBlp(blp({ encoding: 3, alphaDepth: 8, width: 1, height: 1, mip: Buffer.from([1, 2, 3, 9]) }));
  assert.deepEqual(pixel(withAlpha, 0), [3, 2, 1, 9]);
});

test("the DXT variant follows the alpha encoding, then the alpha depth", () => {
  assert.equal(dxtFormat({ alphaEncoding: 7, alphaDepth: 8 }), 5);
  assert.equal(dxtFormat({ alphaEncoding: 1, alphaDepth: 8 }), 3);
  assert.equal(dxtFormat({ alphaEncoding: 0, alphaDepth: 0 }), 1);
  assert.equal(dxtFormat({ alphaEncoding: 0, alphaDepth: 1 }), 1);
  assert.equal(dxtFormat({ alphaEncoding: 0, alphaDepth: 8 }), 3);
});

function dxt1Block(first, second, indices) {
  return Buffer.from([first & 0xff, first >> 8, second & 0xff, second >> 8, indices, 0, 0, 0]);
}

test("DXT1 interpolates four colours when the first endpoint is larger", () => {
  const image = decodeBlp(blp({
    encoding: 2, width: 4, height: 1,
    mip: dxt1Block(0xf800, 0x001f, 0b11100100), // red, blue, then the two mixes
  }));
  assert.deepEqual(pixel(image, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixel(image, 1), [0, 0, 255, 255]);
  assert.deepEqual(pixel(image, 2), [170, 0, 85, 255]);
  assert.deepEqual(pixel(image, 3), [85, 0, 170, 255]);
});

test("DXT1 punches through to transparent when the second endpoint is larger", () => {
  const image = decodeBlp(blp({
    encoding: 2, width: 4, height: 1,
    mip: dxt1Block(0x001f, 0xf800, 0b11100100),
  }));
  assert.deepEqual(pixel(image, 0), [0, 0, 255, 255]);
  assert.deepEqual(pixel(image, 1), [255, 0, 0, 255]);
  assert.deepEqual(pixel(image, 2), [127, 0, 127, 255]);
  assert.deepEqual(pixel(image, 3), [0, 0, 0, 0]); // the fourth colour is transparent black
});

test("DXT3 reads four bit alpha scaled by 17", () => {
  const alpha = Buffer.from([0xf0, 0x8a, 0, 0, 0, 0, 0, 0]);
  const image = decodeBlp(blp({
    encoding: 2, alphaDepth: 8, alphaEncoding: 1, width: 4, height: 1,
    mip: Buffer.concat([alpha, dxt1Block(0xf800, 0x001f, 0b00000000)]),
  }));
  assert.deepEqual([0, 1, 2, 3].map((index) => pixel(image, index)[3]), [0, 255, 170, 136]);
  assert.deepEqual(pixel(image, 0).slice(0, 3), [255, 0, 0]);
});

// Packs 16 three bit alpha indices into the six byte little endian field.
function dxt5Alpha(first, second, indices) {
  const block = Buffer.alloc(8);
  block[0] = first;
  block[1] = second;
  for (let pixel = 0; pixel < 16; pixel++) {
    for (let bit = 0; bit < 3; bit++) {
      if (!(indices[pixel] & (1 << bit))) continue;
      const position = pixel * 3 + bit;
      block[2 + (position >> 3)] |= 1 << (position & 7);
    }
  }
  return block;
}

test("DXT5 builds both alpha tables and reads three bit indices", () => {
  // first < second selects the six value table, whose last two entries are 0 and 255.
  const sixValue = dxt5Alpha(0, 255, [0, 1, 2, 3, 4, 5, 6, 7, 0, 0, 0, 0, 0, 0, 0, 0]);
  const image = decodeBlp(blp({
    encoding: 2, alphaDepth: 8, alphaEncoding: 7, width: 4, height: 2,
    mip: Buffer.concat([sixValue, dxt1Block(0xf800, 0x001f, 0)]),
  }));
  assert.deepEqual([0, 1, 2, 3].map((index) => pixel(image, index)[3]), [0, 255, 51, 102]);
  assert.deepEqual([4, 5, 6, 7].map((index) => pixel(image, index)[3]), [153, 204, 0, 255]);

  // first > second selects the eight value table, interpolated across all six steps.
  const eightValue = dxt5Alpha(200, 100, [0, 1, 2, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const eight = decodeBlp(blp({
    encoding: 2, alphaDepth: 8, alphaEncoding: 7, width: 4, height: 1,
    mip: Buffer.concat([eightValue, dxt1Block(0xf800, 0x001f, 0)]),
  }));
  assert.deepEqual([0, 1, 2, 3].map((index) => pixel(eight, index)[3]), [200, 100, 185, 114]);
});

test("blocks that hang past the edge are clipped, not written out of bounds", () => {
  const image = decodeBlp(blp({
    encoding: 2, width: 3, height: 2,
    mip: dxt1Block(0xf800, 0x001f, 0b11100100),
  }));
  assert.equal(image.data.length, 3 * 2 * 4);
  assert.deepEqual(pixel(image, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixel(image, 3), [255, 0, 0, 255]); // second row starts at block row 1
});

test("truncated payloads are rejected instead of decoding garbage", () => {
  assert.throws(() => decodeBlp(blp({ encoding: 2, width: 16, height: 16, mip: Buffer.alloc(8) })), /truncated/);
  assert.throws(() => decodeBlp(blp({ encoding: 1, width: 16, height: 16, mip: Buffer.alloc(4) })), /truncated/);
  assert.throws(() => decodeBlp(blp({ encoding: 9, width: 4, height: 4, mip: Buffer.alloc(8) })), /encoding/);
});

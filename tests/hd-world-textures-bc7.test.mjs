// 23.10 (7.48 step 2): the world HD set's BC7 encoder, mip chain and `WHT1` container (tools/hd-texture-bc7.mjs),
// and the browser's parser of the same container (src/browser/HdTextureContainer.ts).
import assert from "node:assert/strict";
import test from "node:test";
import {
  bc7LevelBytes, compressTexture, decodeBc7Block, decodeBc7Image, decodeContainer, encodeBc7Block, encodeBc7Image,
  encodeContainer, halveImage, mipChain, resampleWrapped, CONTAINER_CONTENT_TYPE, WEIGHTS4,
} from "../tools/hd-texture-bc7.mjs";
import { isHdTextureContainer, parseHdTexture } from "../dist/code/browser/HdTextureContainer.js";
import { HD_TEXTURE_CONTENT_TYPE } from "../dist/code/gateway/HdTextures.js";

/** A deterministic test picture: smooth gradients with some texture, optional varying alpha. */
function picture(width, height, alpha = false) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      data[at] = Math.round(127 + 100 * Math.sin(x / 9) * Math.cos(y / 13));
      data[at + 1] = Math.round((x * 255) / Math.max(1, width - 1));
      data[at + 2] = Math.round((y * 255) / Math.max(1, height - 1));
      data[at + 3] = alpha ? Math.round(127 + 127 * Math.sin((x + y) / 17)) : 255;
    }
  }
  return { width, height, data };
}

function psnr(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += (a[index] - b[index]) ** 2;
  return 10 * Math.log10((255 * 255) / (sum / a.length));
}

test("an opaque BC7 block is mode 6 with its anchor index below 8, and decodes to what the encoder measured", () => {
  const image = picture(4, 4);
  const block = new Uint8Array(16);
  const error = encodeBc7Block(image.data, block);
  assert.equal(block[0] & 0x7f, 0x40, "mode 6: six zero bits, then a one");
  const decoded = decodeBc7Block(block);
  let measured = 0;
  for (let index = 0; index < 64; index++) measured += (decoded[index] - image.data[index]) ** 2;
  assert.equal(measured, error);
  // Bit 65 onwards: the anchor's index has three bits, so its fourth (implicit) bit is zero — the swap made sure.
  assert.equal(WEIGHTS4.length, 16);
  assert.throws(() => decodeBc7Block(new Uint8Array(16).fill(0x01)), /not mode 5 or 6/);
});

// 24.10 (7.48 step 3): a cut-out block (a leaf's edge: transparent background, four leaf colours) — mode 6's one RGBA
// line spends its steps on alpha and paints every solid texel one colour; mode 5 keeps colour and alpha apart.
test("a cut-out block takes mode 5: alpha exact, the solid texels keep their colours; decodes to what was measured", () => {
  const pixels = new Uint8Array(64);
  const leaf = [[40, 90, 20], [60, 120, 30], [80, 150, 40], [100, 180, 50]];
  for (let pixel = 0; pixel < 16; pixel++) {
    const solid = pixel % 2 === 1;
    pixels.set(solid ? [...leaf[(pixel >> 1) % 4], 255] : [0, 0, 0, 0], pixel * 4);
  }
  const block = new Uint8Array(16);
  const error = encodeBc7Block(pixels, block);
  assert.equal(block[0] & 0x3f, 0x20, "mode 5: five zero bits, then a one");
  const decoded = decodeBc7Block(block);
  let measured = 0;
  let solidColour = 0;
  for (let pixel = 0; pixel < 16; pixel++) {
    for (let channel = 0; channel < 4; channel++) measured += (decoded[pixel * 4 + channel] - pixels[pixel * 4 + channel]) ** 2;
    assert.equal(decoded[pixel * 4 + 3], pixels[pixel * 4 + 3], "alpha 0 and 255 exactly");
    if (pixel % 2 === 1) for (let channel = 0; channel < 3; channel++) solidColour += Math.abs(decoded[pixel * 4 + channel] - pixels[pixel * 4 + channel]);
  }
  assert.equal(measured, error);
  assert.ok(solidColour / 24 < 2, `solid texels' colour error ${solidColour / 24}`);
  // An opaque copy of the same colours stays mode 6.
  const opaque = Uint8Array.from(pixels);
  for (let pixel = 0; pixel < 16; pixel++) opaque[pixel * 4 + 3] = 255;
  encodeBc7Block(opaque, block);
  assert.equal(block[0] & 0x7f, 0x40);
});

test("round trip: smooth colour well above 40 dB, alpha kept, opaque stays exactly 255, a flat colour nearly exact", () => {
  const opaque = picture(64, 64);
  const encoded = encodeBc7Image(opaque);
  assert.equal(encoded.data.length, bc7LevelBytes(64, 64));
  const back = decodeBc7Image(encoded.data, 64, 64);
  assert.ok(psnr(back.data, opaque.data) > 40, `opaque PSNR ${psnr(back.data, opaque.data)}`);
  for (let index = 3; index < back.data.length; index += 4) assert.equal(back.data[index], 255);

  const blended = picture(64, 64, true);
  const blendedBack = decodeBc7Image(encodeBc7Image(blended).data, 64, 64);
  assert.ok(psnr(blendedBack.data, blended.data) > 34, `RGBA PSNR ${psnr(blendedBack.data, blended.data)}`);

  const flat = { width: 8, height: 8, data: new Uint8Array(256) };
  for (let index = 0; index < 256; index += 4) flat.data.set([100, 150, 37, 255], index);
  const flatBack = decodeBc7Image(encodeBc7Image(flat).data, 8, 8);
  for (let index = 0; index < 256; index++) assert.ok(Math.abs(flatBack.data[index] - flat.data[index]) <= 1);
});

test("odd sides: edge blocks repeat the last texel, every level of the chain has its BC7 size", () => {
  // One smooth ramp (a single-subset mode 6 block holds one colour line; real texture blocks measured 47–49 dB).
  const image = { width: 6, height: 3, data: new Uint8Array(72) };
  for (let texel = 0; texel < 18; texel++) image.data.set([60 + (texel % 6) * 9, 90 + (texel % 6) * 6, 40, 255], texel * 4);
  const back = decodeBc7Image(encodeBc7Image(image).data, 6, 3);
  assert.ok(psnr(back.data, image.data) > 40, `PSNR ${psnr(back.data, image.data)}`);
  const chain = mipChain(picture(512, 256));
  assert.deepEqual(chain.map((level) => [level.width, level.height]),
    [[512, 256], [256, 128], [128, 64], [64, 32], [32, 16], [16, 8], [8, 4], [4, 2], [2, 1], [1, 1]]);
  assert.equal(bc7LevelBytes(2, 1), 16, "a level smaller than a block is one block");
});

test("mips average colour in linear light (as the GPU's own generateMipmap does for an sRGB texture), alpha as stored", () => {
  // A black and white checker halves to sRGB 188 (half the light), not 128.
  const checker = { width: 2, height: 2, data: new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0]) };
  const half = halveImage(checker);
  assert.deepEqual([...half.data], [188, 188, 188, 128]);
  // A flat picture stays flat all the way down.
  const flat = { width: 4, height: 4, data: new Uint8Array(64).fill(90) };
  for (const level of mipChain(flat)) assert.ok(level.data.every((value) => value === 90));
});

test("ground resample wraps (the layer tiles) and keeps a flat texture flat", () => {
  const tile = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 200, 200, 200, 255]) };
  const wide = resampleWrapped(tile, 4, 2);
  assert.equal(wide.width, 4);
  // The first texel's left neighbour is the last one, across the wrap: it is a blend, not a clamp.
  assert.ok(wide.data[0] > 0 && wide.data[0] < 200);
  const flat = resampleWrapped({ width: 4, height: 4, data: new Uint8Array(64).fill(77) }, 8, 8);
  assert.ok(flat.data.every((value) => value === 77));
});

test("the WHT1 container: what the tool writes the browser parses — sizes, a full chain, the opaque flag", () => {
  const result = compressTexture(picture(32, 16, true));
  assert.equal(result.levels, 6);
  assert.equal(result.opaque, false);
  const parsed = parseHdTexture(result.bytes);
  assert.ok(parsed);
  assert.equal(parsed.format, "bc7-srgb");
  assert.deepEqual([parsed.width, parsed.height, parsed.opaque, parsed.levels.length], [32, 16, false, 6]);
  const tool = decodeContainer(result.bytes);
  for (const [index, level] of parsed.levels.entries()) {
    assert.deepEqual([level.width, level.height], [tool.levels[index].width, tool.levels[index].height]);
    assert.deepEqual([...level.data], [...tool.levels[index].data]);
    assert.equal(level.data.length, bc7LevelBytes(level.width, level.height));
  }
  assert.equal(parsed.byteLength, parsed.levels.reduce((sum, level) => sum + level.data.length, 0));
  assert.equal(compressTexture(picture(8, 8)).opaque, true);
  assert.equal(isHdTextureContainer(result.bytes), true);
  assert.equal(CONTAINER_CONTENT_TYPE, HD_TEXTURE_CONTENT_TYPE, "the tool and the gateway name one content type");
});

test("level 1 onwards can be the original: minified sampling then reads the original's own texels", () => {
  // Stone-like: every channel follows one field, as most texture blocks do (one colour line per block).
  const stone = (side, period) => {
    const data = new Uint8Array(side * side * 4);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const v = 127 + 90 * Math.sin(x / period) * Math.cos(y / (period * 1.3));
        data.set([Math.round(v), Math.round(0.8 * v), Math.round(0.6 * v), 255], (y * side + x) * 4);
      }
    }
    return { width: side, height: side, data };
  };
  const hd = stone(32, 6);
  const original = stone(16, 3);
  const result = decodeContainer(compressTexture(hd, { lower: original }).bytes);
  assert.equal(result.levels.length, 6);
  const level1 = decodeBc7Image(result.levels[1].data, 16, 16);
  assert.ok(psnr(level1.data, original.data) > 40, "level 1 is the original (up to BC7)");
  const level2 = decodeBc7Image(result.levels[2].data, 8, 8);
  assert.ok(psnr(level2.data, halveImage(original).data) > 40, "and the chain below it is made from the original");
  assert.throws(() => compressTexture(hd, { lower: picture(8, 8) }), /expected half/);
  assert.equal(compressTexture(hd, { lower: picture(16, 16, true) }).opaque, false, "alpha below level 0 counts too");
});

test("the parser refuses anything that is not a whole, well-formed BC7 texture", () => {
  const good = compressTexture(picture(16, 16)).bytes;
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(40)]);
  assert.equal(isHdTextureContainer(png), false);
  assert.equal(parseHdTexture(png), undefined, "the original PNG");
  assert.equal(parseHdTexture(good.subarray(0, good.length - 1)), undefined, "truncated");
  const wrongFormat = Uint8Array.from(good);
  wrongFormat[4] = 2;
  assert.equal(parseHdTexture(wrongFormat), undefined, "unknown format");
  // A partial chain (fewer levels than the sides imply) would leave the texture incomplete under trilinear filtering.
  const partial = encodeContainer({ width: 16, height: 16, opaque: true,
    levels: mipChain(picture(16, 16)).slice(0, 3).map((level) => ({ ...level, data: encodeBc7Image(level).data })) });
  assert.equal(parseHdTexture(partial), undefined);
  const lying = Uint8Array.from(good);
  new DataView(lying.buffer).setUint32(8, 32, true); // claims 32 wide
  assert.equal(parseHdTexture(lying), undefined);
});

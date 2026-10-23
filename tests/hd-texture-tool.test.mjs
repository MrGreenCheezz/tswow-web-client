// 23.10 (7.48): the offline HD texture tool's pixel work and bookkeeping (tools/hd-texture-*.mjs,
// tools/upscale-textures.mjs). The network is stood in for by deterministic upscalers that would show every
// failure the real one could cause: a blur that bleeds across a cell edge, colour that leaks out from under alpha 0.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ALPHA_SNAP, assemble, boundaries, buildWorkImages, commonGrid, effectScale, fidelity, planLayout, FIDELITY_LIMIT,
} from "../tools/hd-texture-image.mjs";
import {
  EFFECT_TEXTURE_PREFIXES, mergeUses, modelTextureUses, spellVisualModelPaths, upscalable,
} from "../tools/hd-texture-set.mjs";
import { downsample, nativeScale } from "../tools/hd-texture-upscaler.mjs";
import { entryUpToDate, hdTextureId as toolId, PIPELINE } from "../tools/upscale-textures.mjs";
import { hdTextureId as gatewayId } from "../dist/code/gateway/HdTextures.js";
import { HD_EFFECT_TEXTURE_PREFIXES } from "../dist/code/browser/HdEffectTextures.js";

function image(width, height, pixel) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return { width, height, data };
}

/** Nearest ×scale, then a 3×3 box blur over the whole picture: bleeds across any edge it is not kept from. */
function blurryUpscale(picture, scale) {
  const near = image(picture.width * scale, picture.height * scale, (x, y) => {
    const at = ((Math.floor(y / scale)) * picture.width + Math.floor(x / scale)) * 4;
    return picture.data.subarray(at, at + 4);
  });
  return image(near.width, near.height, (x, y) => {
    const sum = [0, 0, 0, 0];
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const sx = x + dx;
        const sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= near.width || sy >= near.height) continue;
        for (let c = 0; c < 4; c++) sum[c] += near.data[(sy * near.width + sx) * 4 + c];
        count++;
      }
    }
    return sum.map((value) => Math.round(value / count));
  });
}

const CELL_COLOURS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];

test("a flip-book sheet is upscaled cell by cell: no cell bleeds into its neighbour, cells land at exact multiples", () => {
  // 16×16, 2×2 cells of 8 px, each one flat colour — the worst case for bleeding: every edge is a hard step.
  const sheet = image(16, 16, (x, y) => [...CELL_COLOURS[(y >= 8 ? 2 : 0) + (x >= 8 ? 1 : 0)], 255]);
  const layout = planLayout(16, 16, { grids: [[2, 2]], pad: 2 });
  assert.equal(layout.rows, 2);
  assert.equal(layout.columns, 2);
  assert.equal(layout.mode, "clamp");
  const { colour, alpha } = buildWorkImages(sheet, layout);
  assert.equal(alpha, undefined, "an opaque sheet has no alpha picture to upscale");
  const result = assemble(layout, 4, blurryUpscale(colour, 4), undefined);
  assert.equal(result.width, 64);
  assert.equal(result.height, 64);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const expected = CELL_COLOURS[(y >= 32 ? 2 : 0) + (x >= 32 ? 1 : 0)];
      const at = (y * 64 + x) * 4;
      assert.deepEqual([...result.data.subarray(at, at + 4)], [...expected, 255], `texel ${x},${y}`);
    }
  }
});

test("two layouts of one texture are cut on the finer common grid; uneven sizes split as integers allow", () => {
  assert.deepEqual(commonGrid([[2, 2], [4, 1]]), { rows: 4, columns: 2 });
  assert.deepEqual(commonGrid([]), { rows: 1, columns: 1 });
  assert.deepEqual(boundaries(10, 4), [0, 3, 5, 8, 10]);
  const tooFine = planLayout(16, 16, { grids: [[8, 8]] });
  assert.equal(tooFine.rows * tooFine.columns, 1, "2 px cells are not cut (they would be all gutter)");
});

test("colour and alpha are upscaled apart: bright colour under alpha 0 does not halo the visible edge", () => {
  // Left half: white under alpha 0 (invisible); right half: dark red, opaque.
  const source = image(8, 4, (x) => (x < 4 ? [255, 255, 255, 0] : [80, 0, 0, 255]));
  const layout = planLayout(8, 4, { pad: 2 });
  const { colour, alpha } = buildWorkImages(source, layout);
  assert.ok(alpha, "a texture with transparency gets an alpha picture");
  for (let index = 0; index < colour.data.length; index += 4) assert.equal(colour.data[index + 3], 255, "the colour picture is opaque");
  for (let index = 0; index < alpha.data.length; index += 4) {
    assert.equal(alpha.data[index], alpha.data[index + 1]);
    assert.equal(alpha.data[index], alpha.data[index + 2]);
  }
  const result = assemble(layout, 4, blurryUpscale(colour, 4), blurryUpscale(alpha, 4));
  // Where the result is visible (alpha > 0) … the blur put some white into the red at the edge (that is the network's
  // business and costs nothing visible since alpha falls with it), but far from the edge both halves are exact.
  const at = (x, y) => (y * result.width + x) * 4;
  assert.deepEqual([...result.data.subarray(at(30, 8), at(30, 8) + 4)], [80, 0, 0, 255]);
  assert.equal(result.data[at(2, 8) + 3], 0, "the invisible half stays invisible");
  // Alpha came from the alpha picture: one blur step from the edge it is between, never the colour's brightness.
  const edge = result.data[at(15, 8) + 3];
  assert.ok(edge > 0 && edge < 255, `a soft alpha edge (${edge})`);
});

test("alpha within ALPHA_SNAP of the ends is snapped, so flat regions carry no faint haze", () => {
  const layout = planLayout(2, 1, { pad: 0 });
  const colour = image(2, 1, () => [10, 10, 10, 255]);
  const alpha = image(2, 1, (x) => (x === 0 ? [ALPHA_SNAP - 1, ALPHA_SNAP - 1, ALPHA_SNAP - 1, 255] : [254, 254, 254, 255]));
  const result = assemble(layout, 1, colour, alpha);
  assert.equal(result.data[3], 0);
  assert.equal(result.data[7], 255);
});

test("a tiled texture is padded from the opposite edge; a sheet cell never is", () => {
  const source = image(4, 1, (x) => [x * 60, 0, 0, 255]);
  const wrapped = planLayout(4, 1, { wrap: true, pad: 1 });
  assert.equal(wrapped.mode, "wrap");
  const { colour } = buildWorkImages(source, wrapped);
  assert.equal(colour.data[0], 180, "the left gutter is the right edge");
  assert.equal(colour.data[(wrapped.workWidth - 1) * 4], 0, "the right gutter is the left edge");
  const sheet = planLayout(8, 8, { wrap: true, grids: [[2, 2]], pad: 1 });
  assert.equal(sheet.mode, "clamp");
});

test("effects scale ×4 up to 128 px, ×2 at 256 px, not at all at 512 px; ×2 comes from the ×4 model", () => {
  assert.equal(effectScale(16, 16), 4);
  assert.equal(effectScale(128, 32), 4);
  assert.equal(effectScale(256, 128), 2);
  assert.equal(effectScale(512, 512), 1);
  assert.equal(nativeScale("realesr-animevideov3", 2), 4);
  const quad = image(4, 4, (x, y) => [x < 2 ? 0 : 200, y < 2 ? 0 : 100, 0, 255]);
  assert.deepEqual([...downsample(quad, 2).data], [0, 0, 0, 255, 200, 0, 0, 255, 0, 100, 0, 255, 200, 100, 0, 255]);
});

test("fidelity: a faithful upscale averages back to its source, a corrupted one is rejected", () => {
  const source = image(8, 8, (x, y) => [x * 30, y * 30, 90, 255]);
  const layout = planLayout(8, 8, { pad: 2 });
  const { colour } = buildWorkImages(source, layout);
  const good = assemble(layout, 4, blurryUpscale(colour, 4), undefined);
  const drift = fidelity(good, source, 4);
  assert.ok(drift.colour < FIDELITY_LIMIT && drift.alpha === 0, JSON.stringify(drift));
  let seed = 7;
  const noise = image(32, 32, () => [(seed = (seed * 1103515245 + 12345) & 0xff), seed ^ 0x55, seed ^ 0xaa, 255]);
  assert.ok(fidelity(noise, source, 4).colour > FIDELITY_LIMIT, "noise is caught");
});

test("a manifest entry is rebuilt when the source bytes, the scale, the model, the pipeline or the cut change", () => {
  const entry = { sourceSha1: "a", scale: 4, model: "m", pipeline: PIPELINE, grid: [2, 2], wrap: false };
  assert.equal(entryUpToDate({ ...entry }, entry), true);
  for (const changed of [{ sourceSha1: "b" }, { scale: 2 }, { model: "n" }, { pipeline: "old" }, { grid: [1, 1] }, { wrap: true }]) {
    assert.equal(entryUpToDate({ ...entry, ...changed }, entry), false, JSON.stringify(changed));
  }
  assert.equal(entryUpToDate(undefined, entry), false);
});

test("the tool and the gateway name an HD file the same way; the browser asks for the folders the set holds", () => {
  for (const path of ["spells\\clouds8x8.blp", "Spells/Clouds8x8.BLP", "particles\\genericglow.blp"]) {
    assert.equal(toolId(path), gatewayId(path), path);
    assert.match(toolId(path), /^[0-9a-f]{40}$/);
  }
  assert.deepEqual([...HD_EFFECT_TEXTURE_PREFIXES], [...EFFECT_TEXTURE_PREFIXES]);
  assert.equal(upscalable("creature\\golemharvest\\red_glow3.blp"), false, "creature art is never upscaled");
  assert.equal(upscalable("character\\human\\male\\humanmaleskin00_00.blp"), false);
  assert.equal(upscalable("spells\\holy_glow.blp"), true);
});

/** A minimal MD20: two own textures, one particle emitter drawing the second as a 4×2 sheet. */
function syntheticModel() {
  const model = Buffer.alloc(0x400);
  model.write("MD20", 0, "latin1");
  model.writeUInt32LE(264, 4);
  // Texture table at 0x200: two records of 16 bytes; names at 0x300 and 0x340.
  model.writeUInt32LE(2, 0x50);
  model.writeUInt32LE(0x200, 0x54);
  const names = ["Spells\\Glow.blp", "Spells\\Sheet.blp"];
  names.forEach((name, index) => {
    const at = 0x200 + index * 16;
    model.writeUInt32LE(0, at);
    model.writeUInt32LE(index === 0 ? 3 : 0, at + 4); // wrap x|y on the first
    model.writeUInt32LE(name.length + 1, at + 8);
    model.writeUInt32LE(0x300 + index * 0x40, at + 12);
    model.write(name, 0x300 + index * 0x40, "latin1");
  });
  // One particle emitter (0x1dc bytes) at 0x220... it must fit: put it after the table and grow the buffer.
  const emitters = Buffer.alloc(0x1dc);
  emitters.writeUInt16LE(1, 0x16); // texture slot 1
  emitters.writeUInt16LE(4, 0x30); // rows
  emitters.writeUInt16LE(2, 0x32); // columns
  const full = Buffer.concat([model, emitters]);
  full.writeUInt32LE(1, 0x128);
  full.writeUInt32LE(0x400, 0x12c);
  return full;
}

test("a spell model's textures are read with their wrap flags and flip-book layouts, and merged per path", () => {
  const uses = modelTextureUses(syntheticModel());
  assert.deepEqual(uses, [
    { path: "spells\\glow.blp", wrap: true, grids: [] },
    { path: "spells\\sheet.blp", wrap: false, grids: [[4, 2]] },
  ]);
  const merged = mergeUses([uses, [{ path: "spells\\sheet.blp", wrap: false, grids: [[2, 2]] }],
    [{ path: "creature\\x\\y.blp", wrap: false, grids: [] }]]);
  assert.deepEqual(merged.map((entry) => entry.path), ["spells\\glow.blp", "spells\\sheet.blp"]);
  assert.deepEqual(merged[1].grids, [[2, 2], [4, 2]]);
  assert.deepEqual(modelTextureUses(Buffer.from("not a model")), []);
});

test("SpellVisualEffectName.dbc model names are read as .m2 paths", () => {
  const strings = Buffer.from("\0Spells\\Holy_Impact.mdx\0World\\Thing.MDL\0", "latin1");
  const records = 2;
  const recordSize = 7 * 4;
  const dbc = Buffer.alloc(20 + records * recordSize + strings.length);
  dbc.write("WDBC", 0, "latin1");
  dbc.writeUInt32LE(records, 4);
  dbc.writeUInt32LE(7, 8);
  dbc.writeUInt32LE(recordSize, 12);
  dbc.writeUInt32LE(strings.length, 16);
  dbc.writeUInt32LE(1, 20 + 8);
  dbc.writeUInt32LE(24, 20 + recordSize + 8);
  strings.copy(dbc, 20 + records * recordSize);
  assert.deepEqual(spellVisualModelPaths(dbc), ["spells\\holy_impact.m2", "world\\thing.m2"]);
});

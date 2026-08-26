// Slice В1: what colour a batch is, and whether it is drawn at all.
//
// Until WVM8 every batch in the game was drawn at colour (1, 1, 1) and opacity 1, because the
// artifact carried each batch's `colorIndex` and `textureWeight` and neither of the two tables
// those index. The tests below are the two ends of that: the file's own numbers, read out of the
// archives, and the material a build gives them.

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { m2Animations, parseM2 } from "../tools/m2.mjs";
import { encodeWvm9 } from "../tools/wvm.mjs";
import { decodeWvm9 } from "../dist/code/browser/Wvm.js";
import { EVERY_GEOSET, buildModel, updateBatchColours } from "../dist/code/browser/ModelBuild.js";
import { ModelTextureLoader, substituteMissingPixel } from "../dist/code/browser/TextureLoad.js";

let archives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
} catch {
  archives = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };

/** One model, all the way through the shipping path: archives → parse → publish → decode → build. */
async function build(path) {
  const [m2, skin] = await Promise.all([archives.read(path), archives.read(`${path.slice(0, -3)}00.skin`)]);
  if (!m2 || !skin) return undefined;
  const model = parseM2(m2, skin);
  const encoded = encodeWvm9(model, undefined, m2Animations(m2).map((animation) => animation.animationId));
  const decoded = decodeWvm9(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
  return {
    model,
    decoded,
    built: buildModel(decoded, {
      modelPath: path,
      baseUrl: "http://127.0.0.1:8090",
      loadTexture: () => new THREE.Texture(),
      geosets: EVERY_GEOSET,
    }),
  };
}

/** Which materials three would draw, by index: it checks `visible` per geometry group. */
function drawn(built) {
  return built.materials.flatMap((material, index) => material.visible ? [index] : []);
}

test.after(() => archives?.close());

test("the ZZZZ is three green letters at 15% strength on three staggered clocks", withClient, async () => {
  // `Spells\Sleep_State_Head.m2` is the marker over a sleeping unit, and the complaint was that it
  // is a blazing white glyph that never fades. It is three Z-shaped submeshes, each drawn three
  // times: an additive `INTERFACE\BUTTONS\WHITE8X8.BLP` card, an opaque green body and an additive
  // glow. The white card is white — the file paints it.
  const loaded = await build("Spells\\Sleep_State_Head.m2");
  if (!loaded) return;
  const { model, built } = loaded;
  assert.equal(model.colours.length, 9, "nine colours, one per batch");
  assert.equal(model.textureWeights.length, 3, "three weights, one per layer of a letter");

  // The three white cards are batches 0, 3 and 6: colour 0, 3 and 6, all weight track 0.
  for (const batch of [0, 3, 6]) {
    const colour = model.colours[model.batches[batch].colorIndex];
    const rgb = [...colour.rgb.tracks[0].values];
    assert.equal(model.batches[batch].textures[0], 0, `batch ${batch} draws the white card`);
    assert.equal(model.textures[0].filename, "INTERFACE\\BUTTONS\\WHITE8X8.BLP");
    assert.equal(model.batches[batch].blendMode, 4, `batch ${batch} is additive`);
    assert.equal(rgb[0], 0, `batch ${batch} red`);
    assert.ok(Math.abs(rgb[1] - 0.898) < 0.001, `batch ${batch} green is 0.898, not 1`);
    assert.equal(rgb[2], 0, `batch ${batch} blue`);
    assert.equal(model.batches[batch].textureWeight, 0, `batch ${batch} weight track`);
  }
  assert.ok(Math.abs(model.textureWeights[0].tracks[0].values[0] - 0.15) < 0.001, "weight 0 is 0.15");

  // The three letters rise one after another: 0/2000/3200 ms, 0/600/2600 and 0/1200/3200. So at
  // time zero one letter is up at 15% and the other two are not drawn at all — which is the whole
  // of the complaint, since the client used to draw all nine batches at white and full strength.
  assert.deepEqual(drawn(built), [0, 1, 2], "at rest only the first letter is drawn");
  assert.ok(Math.abs(built.materials[0].opacity - 0.15) < 0.002, "and at 15% strength, not 1");
  assert.equal(built.materials[0].color.getHexString(), "00f300", "in the green the file paints");
  for (const material of [3, 4, 5, 6, 7, 8]) {
    assert.equal(built.materials[material].opacity, 0, `material ${material} starts at zero`);
  }

  // 700 ms in, the second letter has risen and the first has not yet fallen.
  updateBatchColours(built.animatedBatches, 700);
  assert.deepEqual(drawn(built), [0, 1, 2, 3, 4, 5], "the second letter rises after 600 ms");
  // And 2,000 ms in the first letter's own alpha has reached zero.
  updateBatchColours(built.animatedBatches, 2000);
  assert.ok(!drawn(built).includes(0), "the first letter has faded out by 2,000 ms");
});

test("a doodad's alternatives are sequences, and only the one being played is drawn", withClient, async () => {
  // `dalaran_fountain_01.m2` carries two fountains: under Stand a water one — 12 batches, 5,285
  // triangles — and under Opened a statue one, 15 batches and 32,616 triangles. The two sets are
  // complementary, spelt with alpha tracks that are zero under the other's sequence, and this
  // client used to draw both at once.
  const loaded = await build("world\\expansion02\\doodads\\dalaran\\dalaran_fountain_01.m2");
  if (!loaded) return;
  const { built } = loaded;
  assert.equal(built.materials.length, 25, "twenty-five batches are built");
  assert.equal(drawn(built).length, 12, "and the thirteen the file switches off under Stand are not drawn");
  let triangles = 0;
  let all = 0;
  for (const [index, group] of built.geometry.groups.entries()) {
    all += group.count / 3;
    if (built.materials[index].visible) triangles += group.count / 3;
  }
  assert.equal(all, 37593, "the file's batches ask for 37,593 triangles between them");
  assert.equal(triangles, 5285, "and 5,285 of them are the fountain that is actually standing there");
});

test("the body of a character is not faded by its own corpse track", withClient, async () => {
  // The regression this rule exists to prevent. Every playable model's body batch carries an alpha
  // track whose keys are under Death and Drown and nowhere else — HumanMale's are sequences 7 and
  // 120 — ramping 1 → 0. Reading a batch's first sub-track instead of the one for the sequence
  // being played would fade every character in the game out and back on a two-second loop.
  const loaded = await build("Character\\Human\\Male\\HumanMale.m2");
  if (!loaded) return;
  const { model, built } = loaded;
  const body = model.colours[model.batches[0].colorIndex];
  assert.ok(body.alpha.tracks.length > 0, "the body does carry an alpha track");
  assert.ok(body.alpha.tracks.every((sub) => sub.sequence !== 0),
    "and none of its keys are under sequence 0, which is what makes this a trap");
  assert.ok([...body.alpha.tracks[0].values].includes(0), "the track really does reach zero");

  for (const time of [0, 700, 1600, 2500, 5000]) {
    updateBatchColours(built.animatedBatches, time);
    assert.equal(drawn(built).length, built.materials.length, `every batch is drawn at ${time} ms`);
    assert.equal(built.materials[0].opacity, 1, `and at full opacity at ${time} ms`);
  }
});

test("a batch the file switches off in every sequence is never drawn", withClient, async () => {
  // 128 batches over the 22,112 models of the drawing corpus are zero under every sequence their
  // model has; none of them is drawn. The two synthetic models below are the rule itself, because
  // the corpus number is a sweep and not a test: one batch switched off outright, and one switched
  // off in a sequence that is not being played, which must still draw.
  const model = {
    positions: new Float32Array(9), normals: new Float32Array(9),
    uv0: new Float32Array(6), uv1: new Float32Array(6),
    indices: new Uint16Array([0, 1, 2, 0, 1, 2]),
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 3 }, { geosetId: 0, indexStart: 3, indexCount: 3 }],
    batches: [
      { submesh: 0, blendMode: 0, materialFlags: 0, priorityPlane: 0, materialLayer: 0, textures: [0], uvSets: [0], shaderId: 0, colorIndex: 0, textureWeight: -1, textureTransform: -1 },
      { submesh: 1, blendMode: 0, materialFlags: 0, priorityPlane: 0, materialLayer: 0, textures: [0], uvSets: [0], shaderId: 0, colorIndex: 1, textureWeight: -1, textureTransform: -1 },
    ],
    textures: [{ type: 0, flags: 0, path: "Some\\Texture.blp" }],
    attachments: [],
    bounds: { min: [0, 0, 0], max: [1, 1, 1], radius: 1 },
    globalSequences: new Uint32Array(0),
    particleEmitters: [], ribbonEmitters: [],
    colours: [
      // Switched off where it is being drawn.
      { rgb: track([[0, [1, 1, 1]]], 3, 0), alpha: track([[0, [0]]], 1, 0) },
      // Switched off in another state, and silent about this one.
      { rgb: track([[0, [1, 1, 1]]], 3, 0), alpha: track([[0, [0]]], 1, 2) },
    ],
    textureWeights: [],
  };
  const built = buildModel(model, {
    modelPath: "Test\\Model.m2", baseUrl: "http://127.0.0.1:8090",
    loadTexture: () => new THREE.Texture(), geosets: EVERY_GEOSET,
  });
  assert.deepEqual(drawn(built), [1],
    "the batch switched off under the sequence being drawn is hidden; the other one is not");
});

test("a track bound to a global loop runs on the world clock", withClient, async () => {
  // The one case where the sequence does not decide: a global sequence has its own duration and
  // its keys live in the first sub-array whatever sequence number that array carries.
  const entry = {
    material: new THREE.MeshBasicMaterial(),
    // Under sequence 5, which nothing is playing: reaching these keys at all is the global loop.
    colour: { rgb: track([[0, [1, 1, 1]]], 3, 0), alpha: globalTrack([[0, [1]], [1000, [0]]], 1, 5) },
    globalSequences: new Uint32Array([2000]),
    tinted: true,
  };
  updateBatchColours([entry], 0);
  assert.equal(entry.material.opacity, 1);
  updateBatchColours([entry], 1000);
  assert.equal(entry.material.opacity, 0, "half way through the 2,000 ms loop");
  updateBatchColours([entry], 3000);
  assert.equal(entry.material.opacity, 0, "and again one whole loop later");
});

test("spell batch tracks use a cast-local clock while global loops remain world-clocked", () => {
  const entry = {
    material: new THREE.MeshBasicMaterial(),
    colour: { rgb: track([[0, [1, 1, 1]]], 3, 0), alpha: track([[0, [1]]], 1, 0) },
    weight: track([[0, [0]], [267, [1]], [434, [1]], [534, [0]], [1100, [0]]], 1, 0),
    globalSequences: new Uint32Array(0), tinted: true,
  };
  // The second argument is the local cast age; changing the wall clock must not change the
  // authored Judgement hammer window.
  updateBatchColours([entry], 0, 900);
  assert.equal(entry.material.visible, false, "the hammer starts hidden at cast age zero");
  updateBatchColours([entry], 300, 900);
  assert.equal(entry.material.visible, true, "the hammer appears in its authored 267 ms window");
  updateBatchColours([entry], 700, 900);
  assert.equal(entry.material.visible, false, "the same cast reaches its authored fade at 700 ms");
  updateBatchColours([entry], 300, 1_700);
  assert.equal(entry.material.visible, true, "a later wall-clock timestamp keeps the same cast-local frame");
});

test("the white pixel a failed texture becomes can actually be uploaded", withClient, () => {
  // It never could. The placeholder handed a `DataTexture`'s `{data, width, height}` to the plain
  // `THREE.Texture` the loader returns, and three picks the upload path by `isDataTexture` alone —
  // so it went down the `HTMLImageElement` branch, `texSubImage2D` was called with a bare object,
  // and `WebGLState` caught the `TypeError` and logged it. What was bound was the 1×1 storage
  // three had just allocated: transparent black, the very thing the opaque pixel exists to avoid.
  const texture = new THREE.Texture();
  assert.equal(texture.isDataTexture, undefined, "a plain texture is not a data texture");
  substituteMissingPixel(texture);
  assert.equal(texture.isDataTexture, true, "and after the substitution it is");
  assert.ok(texture.image.data instanceof Uint8Array, "with real bytes");
  assert.deepEqual([...texture.image.data], [255, 255, 255, 255], "one opaque white pixel");
  assert.deepEqual([texture.image.width, texture.image.height], [1, 1]);
  assert.equal(texture.generateMipmaps, false, "three would otherwise try to mip a 1×1 upload");
  assert.equal(texture.unpackAlignment, 1, "four bytes a row need no padding");
  // `needsUpdate` is a write-only setter that bumps `version`; that is what three reads.
  assert.ok(texture.version > 0, "and it is queued for upload at all");
});

test("spell texture readiness follows loader callbacks and cached requests", () => {
  const originalLoad = THREE.TextureLoader.prototype.load;
  const requests = new Map();
  THREE.TextureLoader.prototype.load = function (url, onLoad, _progress, onError) {
    const texture = new THREE.Texture();
    requests.set(url, { texture, onLoad, onError });
    return texture;
  };
  try {
    const loader = new ModelTextureLoader();
    const pending = loader.load("pending.blp");
    assert.equal(loader.status(pending), "pending");
    requests.get("pending.blp").onLoad(pending);
    assert.equal(loader.status(pending), "ready");

    const failed = loader.load("failed.blp");
    requests.get("failed.blp").onError(new Error("missing"));
    assert.equal(loader.status(failed), "failed");
    assert.equal(failed.isDataTexture, true);
    assert.deepEqual([...failed.image.data], [255, 255, 255, 255]);

    const cached = new ModelTextureLoader({ cache: true });
    const first = cached.load("shared.blp");
    const second = cached.load("shared.blp");
    assert.strictEqual(first, second, "a cached spell URL shares one in-flight texture");
    assert.equal(requests.size, 3, "the cache avoids a duplicate network request");
  } finally {
    THREE.TextureLoader.prototype.load = originalLoad;
  }
});

test("model texture readiness records synchronous loader callbacks", () => {
  const originalLoad = THREE.TextureLoader.prototype.load;
  THREE.TextureLoader.prototype.load = function (url, onLoad, _progress, onError) {
    const texture = new THREE.Texture();
    if (url === "sync-failed.blp") {
      onError?.(new Error("missing"));
      // A late success must not resurrect a request that has already failed.
      onLoad?.(texture);
    }
    else onLoad?.(texture);
    return texture;
  };
  try {
    const loader = new ModelTextureLoader({ cache: true });
    const ready = loader.load("sync-ready.blp");
    assert.equal(loader.status(ready), "ready", "inline success cannot remain pending");
    const failed = loader.load("sync-failed.blp");
    assert.equal(loader.status(failed), "failed", "inline failure is terminal");
    assert.equal(failed.isDataTexture, true);
  } finally {
    THREE.TextureLoader.prototype.load = originalLoad;
  }
});

/** An `M2Track` in the shape the artifact decodes to: keys under one animation sequence. */
function track(keys, components, sequence) {
  return {
    interpolation: 1, globalSequence: -1, components,
    tracks: [{
      sequence,
      times: new Uint32Array(keys.map(([time]) => time)),
      values: new Float32Array(keys.flatMap(([, value]) => value)),
    }],
  };
}

/** The same, bound to global loop 0 rather than to an animation. */
function globalTrack(keys, components, sequence) {
  return { ...track(keys, components, sequence), globalSequence: 0 };
}

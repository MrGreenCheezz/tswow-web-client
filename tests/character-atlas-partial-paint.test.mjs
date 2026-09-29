import assert from "node:assert/strict";
import test from "node:test";

import { CHARACTER_ATLAS_PARTIAL_PAINT_MS, CharacterAtlasClient } from "../dist/code/browser/CharacterAtlas.js";

/**
 * A page with no frame clock (paint turns are immediate, as in every page-free test) whose `/texture`
 * answers are held per path until the test lets them go.
 */
function installPage() {
  const previous = {
    fetch: globalThis.fetch,
    createImageBitmap: globalThis.createImageBitmap,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  const held = new Map();
  const canvases = [];
  globalThis.requestAnimationFrame = undefined;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).searchParams.get("path") ?? String(url);
    const gate = held.get(path);
    if (gate) await gate.promise;
    return { ok: true, status: 200, blob: async () => ({}) };
  };
  globalThis.createImageBitmap = async () => ({ width: 256, height: 128, close() {} });
  globalThis.document = {
    createElement() {
      const canvas = {
        width: 0, height: 0, drawn: 0,
        getContext: () => ({ drawImage: () => { canvas.drawn++; } }),
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  return {
    canvases,
    hold(path) {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      held.set(path, { promise, release });
    },
    release(path) { held.get(path)?.release(); },
    restore() { Object.assign(globalThis, previous); },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LOOK = [
  { path: "Character\\Human\\Male\\HumanMaleSkin00_00.blp" },
  { path: "Character\\Human\\Male\\HumanMaleFaceLower00_00.blp", section: "faceLower" },
  { path: "Item\\TextureComponents\\LegUpperTexture\\Slow_Pants_LU_M.blp", section: "legUpper" },
];

test("a first body is painted from its base skin while a slow layer is still on its way", async () => {
  // The unit stays a capsule until `get` answers. Measured on the owner's session of 2026-09-28,
  // cold textures were published one every ~412 ms, and one of a character's up-to-24 layers
  // arriving last held the whole body back.
  const page = installPage();
  const atlas = new CharacterAtlasClient("http://atlas.test");
  try {
    page.hold(LOOK[2].path);
    const composed = atlas.compose("look", LOOK);
    await sleep(CHARACTER_ATLAS_PARTIAL_PAINT_MS + 150);
    const early = atlas.get("look");
    assert.ok(early, "the body is out before its trousers");
    assert.equal(atlas.generation("look"), 1);
    assert.equal(page.canvases.length, 1);
    assert.equal(page.canvases[0].drawn, 2, "skin and face, the two layers that had arrived");

    page.release(LOOK[2].path);
    assert.equal(await composed, early, "the full body lands in the same texture the unit already holds");
    assert.equal(atlas.get("look"), early);
    assert.equal(atlas.generation("look"), 2, "and says it repainted, so portraits follow");
    assert.equal(page.canvases.length, 1, "into the same canvas");
    assert.equal(page.canvases[0].drawn, 2 + 3);
    assert.equal(atlas.failures, 0, "nothing is left owed");
  } finally {
    atlas.dispose();
    page.restore();
  }
});

test("a body whose layers all arrive inside the grace is painted once, never bare", async () => {
  const page = installPage();
  const atlas = new CharacterAtlasClient("http://atlas.test");
  try {
    page.hold(LOOK[2].path);
    const composed = atlas.compose("look", LOOK);
    await sleep(Math.floor(CHARACTER_ATLAS_PARTIAL_PAINT_MS / 3));
    assert.equal(atlas.get("look"), undefined);
    page.release(LOOK[2].path);
    assert.ok(await composed);
    assert.equal(atlas.generation("look"), 1);
    assert.equal(page.canvases.length, 1);
    assert.equal(page.canvases[0].drawn, 3);
  } finally {
    atlas.dispose();
    page.restore();
  }
});

test("a body abandoned after its first paint is recomposed, not handed out as finished", async () => {
  const page = installPage();
  const atlas = new CharacterAtlasClient("http://atlas.test");
  try {
    page.hold(LOOK[2].path);
    void atlas.compose("look", LOOK);
    await sleep(CHARACTER_ATLAS_PARTIAL_PAINT_MS + 150);
    assert.ok(atlas.get("look"));
    assert.equal(atlas.failures, 1, "the partial body is remembered as owing a layer");
  } finally {
    page.release(LOOK[2].path);
    atlas.dispose();
    page.restore();
  }
});

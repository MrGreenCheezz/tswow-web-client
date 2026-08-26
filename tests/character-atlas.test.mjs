// Т6: an atlas that cannot be painted is remembered, and a request that failed is made again.
//
// The three permanent failures the capsule ledger was built to tell apart. Before this, a look that
// composed to nothing allocated a fresh 512x512 canvas on every frame for ever, a layer whose
// picture failed once was never asked for again, and a look whose `/dbc/character-appearance` did
// not answer was dead for the life of the tab. All three are driven here against an injected clock,
// so forty seconds of backoff costs nothing.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ATLAS_FAILURE_LIMIT, CharacterAtlasClient, IMAGE_RETRY_BACKOFF_MS, layerPaths,
} from "../dist/code/browser/CharacterAtlas.js";
import { CreatureModelClient } from "../dist/code/browser/CreatureModelClient.js";
import { StandInLedger } from "../dist/code/browser/StandIn.js";
import { buildSkinnedTemplateFrom } from "../dist/code/browser/AnimatedModel.js";
import * as THREE from "three";

/**
 * The three globals the atlas reaches for in a page, counted rather than faked away.
 *
 * `canvases` is the point of half these tests: the fault being fixed is measured in 512x512
 * allocations per second, so the test has to be able to see one being made.
 */
function stubPage(answer) {
  const asked = [];
  const canvases = [];
  const original = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    createImageBitmap: globalThis.createImageBitmap,
  };
  globalThis.fetch = async (url) => {
    const path = decodeURIComponent(String(url).replace(/^.*\?path=/, ""));
    asked.push(path);
    return answer(path, asked.filter((seen) => seen === path).length);
  };
  globalThis.createImageBitmap = async () => ({ width: 256, height: 128, close() {} });
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      const canvas = { width: 0, height: 0, drawn: [], getContext: () => ({ drawImage: (...args) => canvas.drawn.push(args) }) };
      canvases.push(canvas);
      return canvas;
    },
  };
  return {
    asked,
    canvases,
    restore() {
      globalThis.fetch = original.fetch;
      globalThis.document = original.document;
      globalThis.createImageBitmap = original.createImageBitmap;
    },
  };
}

/** A picture that arrives, and one that does not. */
const found = { ok: true, status: 200, blob: async () => ({}) };
const missing = { ok: false, status: 404 };
const broken = { ok: false, status: 500 };

test("a look that paints nothing is composed once, not once a frame", async () => {
  // The measured fault: `#build` returned undefined on `painted === 0`, `#composing` was cleared in
  // `finally`, and the renderer called `compose` again on the very next frame because the unit's
  // `applied` was still empty. Sixty 512x512 canvases a second, for ever, per affected unit.
  const page = stubPage(() => missing);
  try {
    const atlas = new CharacterAtlasClient("http://gateway", () => 0);
    const layers = [{ path: "Textures\\BakedNpcTextures\\CreatureDisplayExtra-15377.blp" }];

    assert.equal(await atlas.compose("baked", layers), undefined);
    assert.equal(page.asked.length, 1);
    assert.equal(page.canvases.length, 0, "a look with no pictures never needs a canvas");
    assert.equal(atlas.failures, 1);

    // A second of frames at 60 fps.
    for (let frame = 0; frame < 60; frame++) {
      assert.equal(await atlas.compose("baked", layers), undefined);
    }
    assert.equal(page.asked.length, 1, "the gateway is asked once, not once a frame");
    assert.equal(page.canvases.length, 0);
    assert.equal(atlas.failures, 1, "and one look is one entry in the ledger");
  } finally {
    page.restore();
  }
});

test("a look whose pictures arrive and paint nothing is remembered, canvas and all", async () => {
  // The other half of the same fault, and the one that really did cost a canvas a frame: every
  // picture arrives, and every one of them names a rectangle this bundle does not have — a gateway
  // that has learnt a section the page has not. Nothing about that changes on the next frame, so
  // the ledger is what stops the 512x512 being allocated sixty times a second.
  const page = stubPage(() => found);
  try {
    const atlas = new CharacterAtlasClient("http://gateway", () => 0);
    const layers = [{ path: "Character\\Human\\Male\\HumanMaleScalp.blp", section: "scalpUpper" }];

    assert.equal(await atlas.compose("unknown-section", layers), undefined);
    assert.equal(page.canvases.length, 1, "the first attempt is a real attempt");
    assert.equal(atlas.failures, 1);

    for (let frame = 0; frame < 60; frame++) {
      assert.equal(await atlas.compose("unknown-section", layers), undefined);
    }
    assert.equal(page.canvases.length, 1, "and the second call answers without work");
    assert.equal(page.asked.length, 1);
    assert.equal(atlas.failures, 1);
  } finally {
    page.restore();
  }
});

test("a 404 is taken as final and a 500 is retried on the backoff", async () => {
  // The two answers mean different things and Т7 is why: the gateway now asks the archives which
  // spelling exists before it offers one, so a 404 is the client not holding the file at all. A 500
  // is the generation lane busy or a child that died, which is a fact about this second.
  let status = broken;
  const page = stubPage(() => status);
  const clock = { now: 1_000 };
  try {
    const atlas = new CharacterAtlasClient("http://gateway", () => clock.now);
    const layers = [{ path: "Item\\TextureComponents\\LegUpperTexture\\Leather_A_03Black_Pant_LU_U.blp" }];

    assert.equal(await atlas.compose("legs", layers), undefined);
    assert.equal(page.asked.length, 1);

    // Inside the first wait, nothing is asked and nothing is built.
    clock.now = 1_000 + IMAGE_RETRY_BACKOFF_MS[0] - 1;
    assert.equal(await atlas.compose("legs", layers), undefined);
    assert.equal(page.asked.length, 1, "the wait is a wait");

    // Three retries, 2 s, 8 s and 30 s after the failure before each.
    let at = 1_000;
    for (const [index, wait] of IMAGE_RETRY_BACKOFF_MS.entries()) {
      at += wait;
      clock.now = at;
      assert.equal(await atlas.compose("legs", layers), undefined);
      assert.equal(page.asked.length, index + 2, `retry ${index + 1} happened`);
    }

    // And then it is left alone, however long the session runs.
    clock.now = at + 86_400_000;
    assert.equal(await atlas.compose("legs", layers), undefined);
    assert.equal(page.asked.length, IMAGE_RETRY_BACKOFF_MS.length + 1, "four requests in all, then silence");

    // A 404 on a different path gets one request and no retry at all.
    status = missing;
    const gone = [{ path: "Item\\TextureComponents\\LegUpperTexture\\Generic_DwPr_01_Pants_LU_M.blp" }];
    assert.equal(await atlas.compose("gone", gone), undefined);
    clock.now += IMAGE_RETRY_BACKOFF_MS[0] * 100;
    assert.equal(await atlas.compose("gone", gone), undefined);
    assert.equal(page.asked.filter((path) => path.includes("Generic_DwPr")).length, 1);
  } finally {
    page.restore();
  }
});

test("a picture that comes back on the retry finishes the body it was holding up", async () => {
  // The whole point of the backoff: the unit stops being a capsule. The first attempt fails with a
  // 500, the retry succeeds, and the same key that had been deferred composes.
  let status = broken;
  const page = stubPage(() => status);
  const clock = { now: 0 };
  try {
    const atlas = new CharacterAtlasClient("http://gateway", () => clock.now);
    const layers = [{ path: "Character\\Human\\Male\\HumanMaleSkin00_00.blp" }];

    assert.equal(await atlas.compose("human", layers), undefined);
    assert.equal(atlas.failures, 1);

    status = found;
    // Still inside the wait: the gateway is not asked, so a client that had recovered a second ago
    // is not troubled a hundred times before the wait is out.
    clock.now = IMAGE_RETRY_BACKOFF_MS[0] - 1;
    assert.equal(await atlas.compose("human", layers), undefined);
    assert.equal(page.asked.length, 1);

    clock.now = IMAGE_RETRY_BACKOFF_MS[0];
    const texture = await atlas.compose("human", layers);
    assert.ok(texture, "the retry landed and the body is painted");
    assert.equal(page.canvases.length, 1);
    assert.equal(page.canvases[0].width, 512);
    assert.equal(page.canvases[0].drawn.length, 1, "the base skin covers the whole atlas");
    assert.equal(atlas.get("human"), texture, "and it is the cached one from here on");
  } finally {
    page.restore();
  }
});

test("Т6 a body that painted without its trousers gets them when the retry lands", async () => {
  // The review's finding, and the shape of the player report that opened the plan: «у кого-то не
  // видно ног» is a body with no trousers, not a capsule. Such a unit *is* built — `applied` is
  // set — so the renderer never asks the atlas about that look again, and before this the layer's
  // own backoff could never fire: `compose` returned the cached partial atlas on the first line.
  // `refresh` is the driver, and the repaint has to land in the canvas the material already holds.
  const legs = "Item\\TextureComponents\\LegUpperTexture\\Leather_A_05Yellow_Pant_LU_M.blp";
  let trousers = broken;
  const page = stubPage((path) => (path === legs ? trousers : found));
  const clock = { now: 1_000 };
  try {
    const atlas = new CharacterAtlasClient("http://gateway", () => clock.now);
    const layers = [
      { path: "Character\\Human\\Male\\HumanMaleSkin00_00.blp" },
      { path: legs, section: "legUpper", candidates: [legs] },
    ];

    const body = await atlas.compose("dressed", layers);
    assert.ok(body, "the rest of him is drawn rather than held back for one layer");
    assert.equal(page.canvases.length, 1);
    assert.equal(page.canvases[0].drawn.length, 1, "the skin painted and the legs did not");
    assert.equal(atlas.failures, 1, "and the body is remembered as short a layer");

    // Two seconds of frames: the driver runs on every one of them and asks for nothing.
    for (let frame = 0; frame < 120; frame++) {
      clock.now += 16;
      atlas.refresh();
    }
    assert.equal(page.asked.length, 2, "one request each, and no storm while the wait runs");

    // The gateway's generation lane frees up.
    trousers = found;
    clock.now = 1_000 + IMAGE_RETRY_BACKOFF_MS[0];
    atlas.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(page.asked.length, 3, "the leg was asked for again");
    assert.equal(page.canvases.length, 1, "into the canvas that already exists, not a second one");
    assert.equal(page.canvases[0].drawn.length, 3, "skin repainted, and the legs over it");
    assert.equal(atlas.get("dressed"), body,
      "and it is the same Texture object, because that is what the material is sampling");
    assert.equal(atlas.failures, 0, "nothing left to come back for");

    // And nothing comes back for it again.
    clock.now += 86_400_000;
    atlas.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(page.asked.length, 3);
  } finally {
    page.restore();
  }
});

test("Т6 a layer that never comes back leaves the body it painted alone", async () => {
  // The other end of the same ledger: four requests over forty seconds and then the entry is inert.
  // A body missing a layer for good must not be recomposed once a frame for the rest of the tab —
  // that is the fault this slice removed from the capsule path, and `refresh` must not reinvent it.
  const legs = "Item\\TextureComponents\\LegUpperTexture\\Generic_DwPr_01_Pants_LU_M.blp";
  const page = stubPage((path) => (path === legs ? broken : found));
  const clock = { now: 0 };
  try {
    const atlas = new CharacterAtlasClient("http://gateway", () => clock.now);
    const layers = [
      { path: "Character\\Human\\Male\\HumanMaleSkin00_01.blp" },
      { path: legs, section: "legUpper", candidates: [legs] },
    ];
    assert.ok(await atlas.compose("half-dressed", layers));

    let at = 0;
    for (const wait of IMAGE_RETRY_BACKOFF_MS) {
      at += wait;
      clock.now = at;
      atlas.refresh();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(page.asked.filter((path) => path === legs).length, IMAGE_RETRY_BACKOFF_MS.length + 1,
      "four requests for the leg, and then it is left alone");
    // And the look leaves the ledger rather than sitting in it for the session: there is nothing
    // left to come back for, the body it painted is final, and `compose` answers off the cached
    // texture from here on. A partly painted body must not spend one of the 512 slots for ever.
    assert.equal(atlas.failures, 0);

    const canvases = page.canvases.length;
    const requests = page.asked.length;
    for (let frame = 0; frame < 600; frame++) {
      clock.now += 16;
      atlas.refresh();
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(page.asked.length, requests, "ten seconds of frames ask for nothing");
    assert.equal(page.canvases.length, canvases, "and allocate nothing");
  } finally {
    page.restore();
  }
});

test("Т6 the renderer is what drives that repaint, once a frame", async () => {
  // A unit whose body painted at all has `applied` set and is never handed to the atlas again, so
  // the call above has exactly one caller in the client and no other path to it. Read out of the
  // source because the alternative is standing up WebGL for one line.
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /this\.#atlases\?\.refresh\(\);/,
    "the per-frame unit pass has to call CharacterAtlasClient.refresh, or a body short a layer stays short");
});

test("the ledger of unpaintable looks is bounded and forgets the oldest first", async () => {
  // A key is a model path, a texture-slot string and a digest of the look, and a session meets
  // whatever it walks past, so the ledger has to have a ceiling — measured, 512 of them cost
  // 375.1 KiB. The looks here all reach `painted === 0` with their pictures in hand, which is what
  // makes an entry visible from outside: a look still in the ledger allocates no canvas.
  const page = stubPage(() => found);
  const last = ATLAS_FAILURE_LIMIT + 39;
  const look = (index) => [{ path: `Character\\Human\\Male\\Skin-${index}.blp`, section: "scalpUpper" }];
  try {
    const atlas = new CharacterAtlasClient("http://gateway", () => 0);
    for (let index = 0; index <= last; index++) await atlas.compose(`look-${index}`, look(index));
    assert.equal(atlas.failures, ATLAS_FAILURE_LIMIT, "the ledger stops growing");
    assert.equal(page.canvases.length, last + 1, "one attempt each, so far");

    // The most recent is still remembered, and the oldest is the one that got another chance —
    // which is what makes the bound safe: the look a player walked past an hour ago is the one
    // worth re-testing, not the one in front of them.
    await atlas.compose(`look-${last}`, look(last));
    assert.equal(page.canvases.length, last + 1, "the newest entry is still in the ledger");
    await atlas.compose("look-0", look(0));
    assert.equal(page.canvases.length, last + 2, "and the oldest was evicted, so it is tried again");
    assert.equal(atlas.failures, ATLAS_FAILURE_LIMIT, "still at the ceiling");
  } finally {
    page.restore();
  }
});

test("Т7 a layer the gateway decided costs one request where a guessed one costs two", async () => {
  const page = stubPage((path) => (path.endsWith("_U.blp") ? found : missing));
  try {
    const atlas = new CharacterAtlasClient("http://gateway", () => 0);
    const directory = "Item\\TextureComponents\\LegUpperTexture";
    // What the gateway now sends: the spelling the archives hold, first.
    const decided = [{
      path: `${directory}\\Leather_A_03Black_Pant_LU_U.blp`,
      section: "legUpper",
      candidates: [`${directory}\\Leather_A_03Black_Pant_LU_U.blp`],
    }];
    assert.ok(await atlas.compose("decided", decided));
    assert.deepEqual(page.asked, [`${directory}\\Leather_A_03Black_Pant_LU_U.blp`],
      "one request, and it is the file that exists");

    // What a gateway too old to have asked the archives sends: both spellings, gendered first. A
    // different garment, so the image cache the first one filled does not hide the extra request.
    const guessed = [{
      path: `${directory}\\Leather_A_05Yellow_Pant_LU_M.blp`,
      section: "legUpper",
      alternate: `${directory}\\Leather_A_05Yellow_Pant_LU_U.blp`,
    }];
    assert.ok(await atlas.compose("guessed", guessed));
    assert.deepEqual(page.asked.slice(1), [
      `${directory}\\Leather_A_05Yellow_Pant_LU_M.blp`,
      `${directory}\\Leather_A_05Yellow_Pant_LU_U.blp`,
    ], "the old pair still works, at the cost of the 404 it always cost");
  } finally {
    page.restore();
  }
});

test("Т7 a layer's spellings come from candidates, and from the old pair when there are none", () => {
  const both = { path: "a_M.blp", alternate: "a_U.blp" };
  assert.deepEqual([...layerPaths(both)], ["a_M.blp", "a_U.blp"]);
  assert.deepEqual([...layerPaths({ path: "b.blp" })], ["b.blp"]);
  // The list wins over the pair, and the pair is exactly its first two members, so the two branches
  // agree wherever both apply.
  assert.deepEqual([...layerPaths({ ...both, candidates: ["a_U.blp"] })], ["a_U.blp"]);
  assert.deepEqual([...layerPaths({ ...both, candidates: ["a_U.blp", "a_M.blp"] })], ["a_U.blp", "a_M.blp"]);
  // An empty list is a gateway that decided nothing, not a gateway that decided "nothing".
  assert.deepEqual([...layerPaths({ ...both, candidates: [] })], ["a_M.blp", "a_U.blp"]);
});

test("Т6 a look whose appearance did not answer is asked for again, and the capsule count falls", async () => {
  // The third permanent failure, and the one the ledger reports as «внешность не вернулась». The
  // frame loop here is the renderer's in miniature: ask for the look, and note a capsule when it is
  // not there yet.
  const answers = [];
  const original = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async () => {
    asked++;
    return answers.shift() ?? { ok: false, status: 500 };
  };
  const clock = { now: 5_000 };
  try {
    const client = new CreatureModelClient("ws://127.0.0.1:8090/auth", () => clock.now);
    const ledger = new StandInLedger();
    const frame = async () => {
      ledger.begin();
      const look = client.playerAppearance(1, 0, 2, 3, 4, 2, 5);
      if (!look) ledger.note(1n, 49, "appearance", "Character\\Human\\Male\\HumanMale.m2");
      // The fetch is started inside `playerAppearance` and not awaited; one turn of the loop is
      // enough for it to settle, which is what the next frame would give it anyway.
      await new Promise((resolve) => setImmediate(resolve));
      return ledger.report();
    };

    assert.equal((await frame()).byReason.appearance, 1, "the first frame fails and the unit is a pill");
    assert.equal(asked, 1);

    // Every frame of the next two seconds asks for nothing: this is the request storm the wait is
    // there to prevent.
    for (let tick = 0; tick < 30; tick++) {
      clock.now += 60;
      assert.equal((await frame()).byReason.appearance, 1);
    }
    assert.equal(asked, 1);

    // The gateway comes back.
    answers.push({
      ok: true,
      status: 200,
      json: async () => ({ body: [{ path: "Character\\Human\\Male\\HumanMaleSkin00_02.blp" }], hair: "", cloak: "", geosets: [0], attached: [] }),
    });
    clock.now = 5_000 + IMAGE_RETRY_BACKOFF_MS[0];
    const retried = await frame();
    assert.equal(asked, 2, "the retry went out");
    assert.equal(retried.byReason.appearance, 1, "and the answer was still in flight on that frame");

    const recovered = await frame();
    assert.equal(recovered.total, 0, "the capsule count drops the frame after the retry lands");
    assert.equal(asked, 2, "and nothing is asked for again once it has arrived");
  } finally {
    globalThis.fetch = original;
  }
});

test("Т6 the fifth capsule reason is permanent because the file says so, not because it is cached", () => {
  // The plan asked for `buildSkinnedTemplateFrom` to be re-attempted when the held-back animations
  // arrive. It already is — and one step earlier than the retry it asked for: a rig whose whole
  // set was held back counts as a rig, so no such unit ever reaches a null template to cache. This
  // pins that, because it is the only thing standing between the fix and the fault coming back.
  const bone = {
    parents: Int16Array.from([-1]),
    flags: Uint16Array.from([0]),
    pivots: Float32Array.from([0, 0, 0]),
  };
  const heldBack = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), { ...bone, clips: [], animations: [0, 4, 69] }, 2);
  assert.ok(heldBack, "a rig whose keyframes travel separately is still a rig");
  assert.equal(heldBack.clips.size, 0);
  assert.deepEqual([...heldBack.animations], [0, 4, 69], "and it knows which poses are one request away");

  // The two that really are permanent, and neither of them changes when anything else arrives: a
  // file with no bones, and a file that claims no animation at all.
  assert.equal(buildSkinnedTemplateFrom(new THREE.BufferGeometry(), { ...bone, parents: Int16Array.from([]), flags: Uint16Array.from([]), pivots: Float32Array.from([]), clips: [], animations: [0] }, 2), undefined);
  assert.equal(buildSkinnedTemplateFrom(new THREE.BufferGeometry(), { ...bone, clips: [], animations: [] }, 2), undefined);
});

test("Т6 an appearance that never comes back is asked for four times and then left alone", async () => {
  const original = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async () => { asked++; throw new Error("gateway unreachable"); };
  const clock = { now: 0 };
  try {
    const client = new CreatureModelClient("ws://127.0.0.1:8090/auth", () => clock.now);
    const ask = async () => {
      client.playerAppearance(2, 1, 0, 0, 0, 0, 0);
      await new Promise((resolve) => setImmediate(resolve));
    };
    await ask();
    assert.equal(asked, 1);
    for (const wait of IMAGE_RETRY_BACKOFF_MS) {
      clock.now += wait;
      await ask();
    }
    assert.equal(asked, IMAGE_RETRY_BACKOFF_MS.length + 1);
    // A whole day later it is still not asked for: a look the gateway cannot describe is not going
    // to start being describable, and the ledger goes on saying which unit it is.
    clock.now += 86_400_000;
    await ask();
    assert.equal(asked, IMAGE_RETRY_BACKOFF_MS.length + 1);
  } finally {
    globalThis.fetch = original;
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSkinnedTemplateFrom } from "../dist/code/browser/AnimatedModel.js";
import { ATLAS_FAILURE_LIMIT, CharacterAtlasClient, IMAGE_RETRY_BACKOFF_MS, configureCharacterAtlasTexture, layerPaths, CHARACTER_ATLAS_PAINTS_PER_FRAME, CHARACTER_ATLAS_PARTIAL_PAINT_MS, CHARACTER_ATLAS_KNOWN_LOGICAL_TEXTURE_BYTE_LIMIT, decodedCharacterAtlasImagePixels } from "../dist/code/browser/CharacterAtlas.js";
import { CreatureModelClient } from "../dist/code/browser/CreatureModelClient.js";
import { StandInLedger } from "../dist/code/browser/StandIn.js";
import { isCoordinatedVisualTexturePath, TEXTURE_ROUTE_VERSION, textureUrl, VISUAL_MODEL_ROUTE_VERSION, visualAnimationsUrl, visualModelUrl } from "../dist/code/browser/Wvm.js";
import * as THREE from "three";

// Merged 2026-10-20 from 6 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── character-atlas.test.mjs
{
// Т6: an atlas that cannot be painted is remembered, and a request that failed is made again.
//
// The three permanent failures the capsule ledger was built to tell apart. Before this, a look that
// composed to nothing allocated a fresh 512x512 canvas on every frame for ever, a layer whose
// picture failed once was never asked for again, and a look whose `/dbc/character-appearance` did
// not answer was dead for the life of the tab. All three are driven here against an injected clock,
// so forty seconds of backoff costs nothing.


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
    // `textureUrl` may carry the visual route version before `path`; parse the query rather than
    // assuming the path is the first/last field. This mirrors the gateway's URL parser and keeps
    // the test focused on the requested MPQ path.
    const path = new URL(String(url), "http://gateway").searchParams.get("path") ?? "";
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

test("visual texture URLs leave immutable stock entries behind without fragmenting scenery", () => {
  assert.equal(isCoordinatedVisualTexturePath("Character/Human/Male/Skin.blp"), true);
  assert.equal(isCoordinatedVisualTexturePath("Creature/Wolf/WolfSkin.blp"), true);
  assert.equal(isCoordinatedVisualTexturePath("Item\\TextureComponents\\Legs.blp"), true);
  assert.equal(isCoordinatedVisualTexturePath("World\\Tileset\\Grass.blp"), false);
  assert.equal(
    textureUrl("http://gateway", "Character/Human/Male/Skin.blp"),
    `http://gateway/texture?v=${TEXTURE_ROUTE_VERSION}&path=Character%5CHuman%5CMale%5CSkin.blp`,
  );
  assert.equal(
    textureUrl("http://gateway", "World/Tileset/Grass.blp"),
    "http://gateway/texture?path=World%5CTileset%5CGrass.blp",
  );
  assert.equal(
    visualModelUrl("http://gateway", "Character/Human/Male/HumanMale.m2"),
    `http://gateway/visual/model?path=Character%5CHuman%5CMale%5CHumanMale.m2&v=${VISUAL_MODEL_ROUTE_VERSION}`,
  );
  assert.equal(
    visualModelUrl("http://gateway", "World/Stormwind/Stormwind.wmo", 7),
    `http://gateway/visual/model?path=World%5CStormwind%5CStormwind.wmo&group=7&v=${VISUAL_MODEL_ROUTE_VERSION}`,
  );
  assert.equal(
    visualAnimationsUrl("http://gateway", "Character/Human/Male/HumanMale.m2"),
    `http://gateway/visual/animations?path=Character%5CHuman%5CMale%5CHumanMale.m2&v=${VISUAL_MODEL_ROUTE_VERSION}`,
  );
});

test("a body atlas applies renderer sampling once and keeps its state finite", () => {
  const texture = new THREE.Texture();
  assert.equal(configureCharacterAtlasTexture(texture, Number.NaN), true,
    "an invalid capability falls back to the finite baseline");
  assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
  assert.equal(texture.wrapS, THREE.ClampToEdgeWrapping);
  assert.equal(texture.wrapT, THREE.ClampToEdgeWrapping);
  assert.equal(texture.flipY, false);
  assert.equal(texture.anisotropy, 1);

  const version = texture.version;
  assert.equal(configureCharacterAtlasTexture(texture, 1), false,
    "the disabled baseline does not queue another upload");
  assert.equal(texture.version, version);

  assert.equal(configureCharacterAtlasTexture(texture, 8), true,
    "opt-in applies the renderer maximum");
  assert.equal(texture.anisotropy, 8);
  const enabledVersion = texture.version;
  assert.equal(configureCharacterAtlasTexture(texture, 8), false,
    "the same renderer handoff does not queue another upload");
  assert.equal(texture.version, enabledVersion);

  assert.equal(configureCharacterAtlasTexture(texture, 1), true,
    "disabling rolls back to the baseline");
  assert.equal(texture.anisotropy, 1);
  assert.equal(Number.isFinite(texture.anisotropy), true);
  assert.equal(configureCharacterAtlasTexture(texture, Number.POSITIVE_INFINITY), false);
});

test("a cached body atlas toggles anisotropy in place", async () => {
  const page = stubPage(() => found);
  try {
    const atlas = new CharacterAtlasClient("http://gateway", () => 0);
    const body = await atlas.compose("toggle", [{ path: "Character\\Human\\Male\\HumanMaleSkin00_00.blp" }]);
    assert.ok(body);
    assert.equal(body.anisotropy, 1, "the atlas baseline is off until the renderer opts in");

    atlas.setAnisotropy(8);
    assert.equal(body.anisotropy, 8);
    const enabledVersion = body.version;
    atlas.setAnisotropy(8);
    assert.equal(body.version, enabledVersion, "repeating the opt-in is idempotent");

    atlas.setAnisotropy(1);
    assert.equal(body.anisotropy, 1);
    assert.equal(atlas.get("toggle"), body, "rollback keeps the same Texture object");
  } finally {
    page.restore();
  }
});

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

test("a due capsule failure does not defeat the partial-atlas refresh guard", async () => {
  const missingBody = "Character\\Human\\Male\\missing-body.blp";
  const lateLegs = "Item\\TextureComponents\\LegUpperTexture\\late-legs.blp";
  const page = stubPage((path) => path === missingBody || path === lateLegs ? broken : found);
  const clock = { now: 0, reads: 0 };
  try {
    const atlas = new CharacterAtlasClient("http://gateway", () => {
      clock.reads++;
      return clock.now;
    });
    assert.equal(await atlas.compose("capsule", [{ path: missingBody }]), undefined);

    clock.now = 1_000;
    assert.ok(await atlas.compose("partial", [
      { path: "Character\\Human\\Male\\HumanMaleSkin00_00.blp" },
      { path: lateLegs, section: "legUpper", candidates: [lateLegs] },
    ]));

    // The capsule retry became due at 2,000, but it has no atlas and is driven by the renderer.
    // The partial atlas is not due until 3,000, so refresh must stop at its one-number guard.
    clock.now = 2_500;
    clock.reads = 0;
    atlas.refresh();
    assert.equal(clock.reads, 1,
      "an abandoned due capsule cannot force a bounded-ledger scan on every frame");
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
  assert.match(source, /#characterAtlasAnisotropyEnabled = false;/,
    "maximum filtering remains opt-in by default");
  assert.match(source, /setCharacterAtlasAnisotropy\(enabled: boolean\)/,
    "the renderer exposes a rollbackable opt-in");
  assert.match(source, /configureCharacterAtlasTexture\(body, this\.#characterAtlasAnisotropyEnabled/,
    "the body atlas receives the renderer policy at model handoff");
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

test("a successful partial creature-model batch records omitted ids as terminal", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, json: async () => [] };
  };
  try {
    const client = new CreatureModelClient("ws://readiness.test/world");
    client.request(9001);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(client.stats, { pending: 0, success: 1, error: 1, generation: 1 });
    assert.equal(client.get(9001), undefined);
    client.request(9001);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, "a negative result is not re-requested every frame");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
}

// ── character-atlas-lifecycle.test.mjs
{
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function installPage({ fetch, createImageBitmap }) {
  const canvases = [];
  const original = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    createImageBitmap: globalThis.createImageBitmap,
  };
  globalThis.fetch = fetch;
  globalThis.createImageBitmap = createImageBitmap;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      const canvas = {
        width: 0,
        height: 0,
        drawn: [],
        getContext: () => ({ drawImage: (...args) => canvas.drawn.push(args) }),
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  return {
    canvases,
    restore() {
      globalThis.fetch = original.fetch;
      globalThis.document = original.document;
      globalThis.createImageBitmap = original.createImageBitmap;
    },
  };
}

const found = { ok: true, status: 200, blob: async () => ({}) };
const layer = (path) => [{ path }];
const turn = () => new Promise((resolve) => setImmediate(resolve));

for (const stage of ["fetch", "blob", "decode"]) {
  test(`dispose rejects a late ${stage} result without resurrecting atlas state`, async () => {
    const gate = deferred();
    let closes = 0;
    const bitmap = { width: 256, height: 128, close: () => { closes++; } };
    let blobCalls = 0;
    let decodeCalls = 0;
    const response = {
      ok: true,
      status: 200,
      blob: async () => {
        blobCalls++;
        return stage === "blob" ? gate.promise : {};
      },
    };
    const page = installPage({
      fetch: () => stage === "fetch" ? gate.promise : Promise.resolve(response),
      createImageBitmap: async () => {
        decodeCalls++;
        return stage === "decode" ? gate.promise : bitmap;
      },
    });
    try {
      const atlas = new CharacterAtlasClient("http://lifecycle.test");
      const composing = atlas.compose("late", layer("late.blp"));
      if (stage !== "fetch") await turn();
      assert.deepEqual([blobCalls, decodeCalls], stage === "fetch" ? [0, 0]
        : stage === "blob" ? [1, 0] : [1, 1],
      `the request is paused at the ${stage} gate before disposal`);

      atlas.dispose();
      atlas.dispose();
      assert.deepEqual(atlas.stats, { pending: 0, success: 0, error: 0, generation: 0 });

      if (stage === "fetch") gate.resolve(response);
      else if (stage === "blob") gate.resolve({});
      else gate.resolve(bitmap);
      assert.equal(await composing, undefined);
      await turn();

      assert.equal(closes, stage === "decode" ? 1 : 0,
        "work already inside decode closes its late bitmap; earlier aborts never allocate one");
      assert.equal(page.canvases.length, 0, "a stale compose never allocates an atlas canvas");
      assert.equal(atlas.get("late"), undefined);
      assert.equal(atlas.generation("late"), 0);
      assert.equal(atlas.failures, 0);
      assert.deepEqual(atlas.stats, { pending: 0, success: 0, error: 0, generation: 0 },
        "late settlement cannot change disposed readiness state");
    } finally {
      page.restore();
    }
  });
}

test("a late transport failure after dispose cannot recreate retry ownership", async () => {
  const gate = deferred();
  const page = installPage({
    fetch: () => gate.promise,
    createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    const composing = atlas.compose("failed-late", layer("failed-late.blp"));
    atlas.dispose();
    gate.reject(new Error("late network failure"));
    assert.equal(await composing, undefined);
    assert.equal(atlas.failures, 0);
    assert.deepEqual(atlas.stats, { pending: 0, success: 0, error: 0, generation: 0 });
  } finally {
    page.restore();
  }
});

test("an owned canvas failure resolves empty instead of rejecting a fire-and-forget compose", async () => {
  const page = installPage({
    fetch: async () => found,
    createImageBitmap: async () => ({ width: 256, height: 128, close() {} }),
  });
  try {
    globalThis.document.createElement = () => { throw new Error("canvas exploded"); };
    const atlas = new CharacterAtlasClient("http://lifecycle.test");

    await assert.doesNotReject(async () => {
      assert.equal(await atlas.compose("canvas-error", layer("canvas-error.blp")), undefined);
    }, "renderer callers use void compose, so an owned build failure must not reject");
    assert.deepEqual(atlas.stats, { pending: 0, success: 1, error: 1, generation: 2 });

    assert.equal(await atlas.compose("canvas-error", layer("canvas-error.blp")), undefined,
      "the terminal look is not rebuilt on the next renderer frame");
    assert.equal(page.canvases.length, 0);
    atlas.dispose();
  } finally {
    page.restore();
  }
});

test("release cancels exact compose publication and old finally preserves its replacement", async () => {
  const responses = new Map();
  const bitmaps = new Map();
  let closes = 0;
  const page = installPage({
    fetch: (url) => {
      const path = decodeURIComponent(String(url).replace(/^.*\?path=/, ""));
      let gate = responses.get(path);
      if (!gate) {
        gate = deferred();
        responses.set(path, gate);
      }
      return gate.promise;
    },
    createImageBitmap: async (blob) => {
      const bitmap = { width: 256, height: 128, path: blob.path, close: () => { closes++; } };
      bitmaps.set(blob.path, bitmap);
      return bitmap;
    },
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    const oldCompose = atlas.compose("look", layer("old.blp"));
    atlas.release("look");
    const replacement = atlas.compose("look", layer("new.blp"));

    responses.get("old.blp").resolve({
      ok: true, status: 200, blob: async () => ({ path: "old.blp" }),
    });
    assert.equal(await oldCompose, undefined);
    assert.equal(page.canvases.length, 0, "the released request cannot publish an atlas");
    assert.equal(atlas.failures, 0);
    assert.equal(atlas.stats.generation, 0,
      "the released source is stale and cannot change global readiness generation");
    assert.equal(atlas.stats.pending, 2,
      "old finally leaves the replacement compose and its image request registered");

    responses.get("new.blp").resolve({
      ok: true, status: 200, blob: async () => ({ path: "new.blp" }),
    });
    const texture = await replacement;
    assert.ok(texture);
    assert.equal(atlas.get("look"), texture);
    assert.equal(page.canvases.length, 1);
    assert.equal(closes, 0, "release keeps source images available to other looks");

    atlas.dispose();
    assert.equal(closes, 1, "the aborted old source is never decoded; the replacement closes once");
  } finally {
    page.restore();
  }
});

test("a released cached-source build is inert and may be replaced under the same key", async () => {
  let closes = 0;
  let fetches = 0;
  const bitmap = { width: 256, height: 128, close: () => { closes++; } };
  const page = installPage({
    fetch: async () => { fetches++; return found; },
    createImageBitmap: async () => bitmap,
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    assert.ok(await atlas.compose("seed", layer("shared.blp")));
    const canvases = page.canvases.length;
    const generation = atlas.stats.generation;

    const stale = atlas.compose("look", layer("shared.blp"));
    atlas.release("look");
    assert.equal(await stale, undefined);
    assert.equal(atlas.stats.generation, generation,
      "the released compose does not settle readiness or failure state");
    assert.equal(page.canvases.length, canvases,
      "the stale cached-source continuation does not allocate a canvas");

    const replacement = atlas.compose("look", layer("shared.blp"));
    assert.ok(await replacement);
    assert.equal(fetches, 1, "release does not discard the session source cache");
    assert.equal(page.canvases.length, canvases + 1);
    assert.equal(closes, 0);
    atlas.dispose();
    assert.equal(closes, 1);
  } finally {
    page.restore();
  }
});

test("release removes ownership before a dispose listener composes the same key", async () => {
  let closes = 0;
  const page = installPage({
    fetch: async () => found,
    createImageBitmap: async () => ({ width: 256, height: 128, close: () => { closes++; } }),
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    const old = await atlas.compose("reentrant", layer("old-reentrant.blp"));
    assert.ok(old);
    let oldDisposals = 0;
    let replacementPromise;
    old.addEventListener("dispose", () => {
      oldDisposals++;
      replacementPromise = atlas.compose("reentrant", layer("new-reentrant.blp"));
    });

    atlas.release("reentrant");
    assert.equal(oldDisposals, 1);
    assert.ok(replacementPromise, "the synchronous listener started replacement ownership");
    const replacement = await replacementPromise;
    assert.ok(replacement);
    assert.notEqual(replacement, old, "the disposed atlas is never returned as the replacement");
    assert.equal(atlas.get("reentrant"), replacement,
      "the outer release cannot delete a replacement created by its dispose listener");

    atlas.dispose();
    assert.equal(oldDisposals, 1, "the released texture is disposed exactly once");
    assert.equal(closes, 2, "both source identities remain shared until client disposal");
  } finally {
    page.restore();
  }
});

test("inactive no-atlas work is pruned independently of successful texture-cache size", async () => {
  const page = installPage({
    fetch: async (url) => String(url).includes("terminal")
      ? { ok: false, status: 404 }
      : { ok: false, status: 500 },
    createImageBitmap: async () => { throw new Error("failed responses are never decoded"); },
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test", () => 0);
    assert.equal(await atlas.compose("kept-retry", layer("retry.blp")), undefined);
    assert.equal(await atlas.compose("gone-terminal", layer("terminal.blp")), undefined);
    assert.equal(atlas.size, 0, "no-paint ownership is invisible to the composed texture count");
    assert.equal(atlas.stats.pending, 1);
    assert.equal(atlas.stats.error, 1);

    atlas.pruneInactiveWork(new Set(["kept-retry"]));
    assert.equal(atlas.stats.pending, 1, "the prospective current-frame look remains owned");
    assert.equal(atlas.stats.error, 0, "the invisible terminal look no longer blocks readiness");

    atlas.pruneInactiveWork(new Set());
    assert.equal(atlas.stats.pending, 0, "an invisible finite retry is cancelled under the count cap");
    assert.equal(atlas.failures, 0);
    atlas.dispose();
  } finally {
    page.restore();
  }
});

test("pruning the last no-atlas owner aborts its exact source and ignores a late transport answer", async () => {
  const transport = deferred();
  let signal;
  let aborts = 0;
  let decodes = 0;
  let closes = 0;
  const bitmap = { width: 256, height: 128, close: () => { closes++; } };
  const page = installPage({
    fetch: (_url, options) => {
      signal = options?.signal;
      signal?.addEventListener("abort", () => { aborts++; });
      return transport.promise;
    },
    createImageBitmap: async () => {
      decodes++;
      return bitmap;
    },
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    const composing = atlas.compose("gone", layer("gone.blp"));
    await turn();
    assert.equal(atlas.stats.pending, 2, "one source read and its compose are both visible initially");
    const generation = atlas.stats.generation;

    atlas.commitPins(new Set(), new Set());
    atlas.pruneInactiveWork(new Set());
    assert.equal(signal?.aborted, true);
    assert.equal(aborts, 1);
    assert.equal(atlas.residencyStats.sources.count, 0);
    assert.equal(atlas.residencyStats.sources.activeLeases, 0);
    assert.equal(atlas.stats.pending, 0);

    // The test transport deliberately ignores AbortSignal and still resolves. Exact request
    // identity must suppress it before decode/admission/generation changes.
    transport.resolve(found);
    assert.equal(await composing, undefined);
    await turn();
    assert.equal(decodes, 0);
    assert.equal(closes, 0);
    assert.equal(atlas.stats.generation, generation);
    assert.equal(atlas.residencyStats.sources.count, 0);
  } finally {
    page.restore();
  }
});

test("a released candidate chain cannot acquire an alternate source after its primary aborts", async () => {
  const primary = deferred();
  const fetched = [];
  const page = installPage({
    fetch: (url) => {
      const path = new URL(url).searchParams.get("path");
      fetched.push(path);
      if (path === "primary.blp") return primary.promise;
      return Promise.resolve(found);
    },
    createImageBitmap: async () => ({ width: 256, height: 128, close() {} }),
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    const composing = atlas.compose("gone-chain", [{
      path: "primary.blp",
      candidates: ["primary.blp", "alternate.blp"],
    }]);
    await turn();
    atlas.release("gone-chain");
    primary.resolve(found);
    assert.equal(await composing, undefined);
    await turn();
    assert.deepEqual(fetched, ["primary.blp"],
      "the stale continuation cannot create ownership that release never had a chance to visit");
    assert.equal(atlas.residencyStats.sources.count, 0);
    assert.equal(atlas.stats.generation, 0);
  } finally {
    page.restore();
  }
});

test("retain cancels only unretained compose publication and preserves the kept look", async () => {
  let closes = 0;
  const bitmap = { width: 256, height: 128, close: () => { closes++; } };
  const page = installPage({
    fetch: async () => found,
    createImageBitmap: async () => bitmap,
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    assert.ok(await atlas.compose("seed", layer("shared.blp")));
    const generation = atlas.stats.generation;
    const kept = atlas.compose("kept", layer("shared.blp"));
    const dropped = atlas.compose("dropped", layer("shared.blp"));

    atlas.retain(new Set(["seed", "kept"]));
    assert.equal(await dropped, undefined);
    assert.ok(await kept);
    assert.equal(atlas.get("dropped"), undefined);
    assert.ok(atlas.get("kept"));
    assert.equal(atlas.stats.generation, generation + 1,
      "only the retained composition settles readiness");
    assert.equal(page.canvases.length, 2, "the unretained continuation never allocates a canvas");
    assert.equal(closes, 0, "retain/release do not own the shared source cache");
    atlas.dispose();
    assert.equal(closes, 1);
  } finally {
    page.restore();
  }
});

test("dispose closes aliased ready bitmaps once and leaves every public operation inert", async () => {
  let closes = 0;
  let fetches = 0;
  const sharedBitmap = { width: 256, height: 128, close: () => { closes++; } };
  const page = installPage({
    fetch: async () => { fetches++; return found; },
    createImageBitmap: async () => sharedBitmap,
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    const first = await atlas.compose("first", layer("first.blp"));
    const second = await atlas.compose("second", layer("second.blp"));
    assert.ok(first && second);
    let textureDisposals = 0;
    first.addEventListener("dispose", () => { textureDisposals++; });
    second.addEventListener("dispose", () => { textureDisposals++; });

    atlas.dispose();
    atlas.dispose();
    assert.equal(closes, 1, "one decoder identity is closed once even when two paths returned it");
    assert.equal(textureDisposals, 2);
    assert.deepEqual(atlas.stats, { pending: 0, success: 0, error: 0, generation: 0 });

    assert.equal(atlas.get("first"), undefined);
    assert.equal(atlas.generation("first"), 0);
    assert.equal(await atlas.compose("after", layer("after.blp")), undefined);
    atlas.refresh();
    atlas.retain(new Set(["first"]));
    atlas.pruneInactiveWork(new Set(["first"]));
    atlas.release("first");
    atlas.setAnisotropy(8);
    assert.equal(fetches, 2, "post-dispose operations cannot start new work");
    assert.equal(page.canvases.length, 2);
    assert.equal(closes, 1);
  } finally {
    page.restore();
  }
});

test("dispose publishes empty state before listeners and continues after a listener throws", async () => {
  let closes = 0;
  const page = installPage({
    fetch: async () => found,
    createImageBitmap: async () => ({ width: 256, height: 128, close: () => { closes++; } }),
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    const first = await atlas.compose("throwing-first", layer("throwing-first.blp"));
    const second = await atlas.compose("throwing-second", layer("throwing-second.blp"));
    assert.ok(first && second);
    let secondDisposals = 0;
    let observedSize;
    let observedStats;
    first.addEventListener("dispose", () => {
      observedSize = atlas.size;
      observedStats = atlas.stats;
      throw new Error("listener exploded");
    });
    second.addEventListener("dispose", () => { secondDisposals++; });

    assert.doesNotThrow(() => atlas.dispose());
    assert.equal(observedSize, 0, "a synchronous listener observes the closed ownership boundary");
    assert.deepEqual(observedStats, { pending: 0, success: 0, error: 0, generation: 0 });
    assert.equal(secondDisposals, 1, "one bad listener cannot strand later textures");
    assert.equal(closes, 2, "ready source images are still released after the throwing listener");
  } finally {
    page.restore();
  }
});
}

// ── character-atlas-paint-budget.test.mjs
{
function installPage() {
  const previous = {
    fetch: globalThis.fetch,
    createImageBitmap: globalThis.createImageBitmap,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const callbacks = new Map();
  const canvases = [];
  let nextFrameId = 0;
  globalThis.fetch = async () => ({ ok: true, status: 200, blob: async () => ({}) });
  globalThis.createImageBitmap = async () => ({ width: 256, height: 128, close() {} });
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      const canvas = {
        width: 0, height: 0, drawn: 0,
        getContext: () => ({ drawImage: () => { canvas.drawn++; } }),
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++nextFrameId;
    callbacks.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => { callbacks.delete(id); };
  return {
    callbacks,
    canvases,
    async frame() {
      assert.equal(callbacks.size, 1, "one shared paint callback is scheduled");
      const callback = callbacks.values().next().value;
      callback(0);
      await new Promise((resolve) => setImmediate(resolve));
    },
    restore() {
      Object.assign(globalThis, previous);
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const layer = (index) => [{ path: `Body${index}.blp` }];

test("completed character looks paint at most two atlases per animation frame", async () => {
  const page = installPage();
  const atlas = new CharacterAtlasClient("http://atlas.test");
  try {
    const pending = Array.from({ length: 5 }, (_, index) => atlas.compose(`look-${index}`, layer(index)));
    await settle();
    assert.equal(page.canvases.length, 0, "download completion does not paint a whole crowd at once");
    assert.equal(page.callbacks.size, 1);

    await page.frame();
    assert.equal(page.canvases.length, CHARACTER_ATLAS_PAINTS_PER_FRAME);
    await page.frame();
    assert.equal(page.canvases.length, CHARACTER_ATLAS_PAINTS_PER_FRAME * 2);
    await page.frame();
    assert.equal(page.canvases.length, 5);
    assert.equal((await Promise.all(pending)).filter(Boolean).length, 5);
    assert.equal(atlas.size, 5);
  } finally {
    atlas.dispose();
    page.restore();
  }
});

test("release and dispose settle paint waiters without publishing stale canvases", async () => {
  const page = installPage();
  const atlas = new CharacterAtlasClient("http://atlas.test");
  try {
    const released = atlas.compose("released", layer(1));
    await settle();
    atlas.release("released");
    assert.equal(await released, undefined);
    assert.equal(page.callbacks.size, 0);
    assert.equal(page.canvases.length, 0);

    const disposed = atlas.compose("disposed", layer(2));
    await settle();
    atlas.dispose();
    assert.equal(await disposed, undefined);
    assert.equal(page.callbacks.size, 0);
    assert.equal(page.canvases.length, 0);
  } finally {
    atlas.dispose();
    page.restore();
  }
});

test("a hidden tab finishes a queued atlas without waiting for a paused animation frame", async () => {
  const page = installPage();
  globalThis.document.hidden = true;
  const atlas = new CharacterAtlasClient("http://atlas.test");
  try {
    const painted = atlas.compose("hidden", layer(3));
    await settle();
    assert.equal(page.callbacks.size, 1);
    let timeout;
    const completed = await Promise.race([
      painted.then((texture) => texture !== undefined),
      new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 1_000); }),
    ]);
    clearTimeout(timeout);
    assert.equal(completed, true);
    assert.equal(page.canvases.length, 1);
    assert.equal(page.callbacks.size, 0);
  } finally {
    atlas.dispose();
    page.restore();
  }
});
}

// ── character-atlas-partial-paint.test.mjs
{
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
}

// ── character-atlas-residency.test.mjs
{
function layer(path, section) {
  return [{ path, ...(section ? { section } : {}) }];
}

function installPage({ bitmapFor = (path) => ({ path, width: 8, height: 8, close() {} }), fetchHook } = {}) {
  const original = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    createImageBitmap: globalThis.createImageBitmap,
  };
  const fetches = [];
  const canvases = [];
  globalThis.fetch = async (url) => {
    const path = new URL(url).searchParams.get("path");
    fetches.push(path);
    if (fetchHook) return fetchHook(path, url);
    return { ok: true, status: 200, blob: async () => ({ size: 1, path }) };
  };
  globalThis.createImageBitmap = async (blob) => bitmapFor(blob.path);
  globalThis.document = {
    createElement() {
      const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
      canvases.push(canvas);
      return canvas;
    },
  };
  return {
    fetches,
    canvases,
    restore() {
      globalThis.fetch = original.fetch;
      globalThis.document = original.document;
      globalThis.createImageBitmap = original.createImageBitmap;
    },
  };
}

function limits(overrides = {}) {
  return {
    limits: {
      atlasCount: 32,
      atlasKnownLogicalTextureBytes: CHARACTER_ATLAS_KNOWN_LOGICAL_TEXTURE_BYTE_LIMIT,
      sourceCount: 32,
      sourceDecodedPixels: 1_000_000,
      sourceResponseBytes: 1024,
      sourceEntryPixels: 1_000_000,
      ...overrides,
    },
  };
}

test("atlas true LRU touches hits, plateaus, and rebuilds an evicted appearance", async () => {
  const page = installPage();
  try {
    const atlas = new CharacterAtlasClient("http://residency.test", Date.now, limits({ atlasCount: 2 }));
    const first = await atlas.compose("first", layer("first.blp"));
    const second = await atlas.compose("second", layer("second.blp"));
    assert.ok(first && second);
    let firstDisposals = 0;
    let secondDisposals = 0;
    first.addEventListener("dispose", () => { firstDisposals++; });
    second.addEventListener("dispose", () => { secondDisposals++; });

    assert.equal(atlas.get("first"), first, "a cache hit promotes first to newest");
    assert.ok(await atlas.compose("third", layer("third.blp")));
    assert.equal(atlas.get("second"), undefined, "the untouched oldest entry is evicted");
    assert.equal(secondDisposals, 1);
    assert.equal(firstDisposals, 0);
    assert.equal(atlas.residencyStats.atlases.count, 2);

    const rebuilt = await atlas.compose("second", layer("second.blp"));
    assert.ok(rebuilt && rebuilt !== second);
    assert.equal(page.fetches.filter((path) => path === "second.blp").length, 1,
      "atlas re-entry can reuse an independently resident decoded source");
    assert.equal(atlas.residencyStats.atlases.count, 2);
  } finally {
    page.restore();
  }
});

test("active atlas pins may overflow both soft policy and converge after the footprint changes", async () => {
  const page = installPage();
  try {
    const atlas = new CharacterAtlasClient("http://pins.test", Date.now, limits({
      atlasCount: 1,
      atlasKnownLogicalTextureBytes: 1_398_100,
    }));
    atlas.commitPins(new Set(["one", "two"]));
    assert.ok(await atlas.compose("one", layer("one.blp")));
    assert.ok(await atlas.compose("two", layer("two.blp")));
    assert.deepEqual(atlas.residencyStats.atlases, {
      count: 2,
      knownLogicalTextureBytes: 2_796_200,
      unknownLogicalTextureCount: 0,
      pinnedCount: 2,
      overflowCount: 1,
      overflowKnownLogicalTextureBytes: 1_398_100,
    });

    atlas.commitPins(new Set(["two"]));
    assert.equal(atlas.get("one"), undefined);
    assert.ok(atlas.get("two"));
    assert.equal(atlas.residencyStats.atlases.overflowCount, 0);
  } finally {
    page.restore();
  }
});

test("source pixel pressure evicts by exact decoded surface area independently of source count", async () => {
  const page = installPage({
    bitmapFor: (path) => ({ path, width: 8, height: 8, close() {} }),
  });
  try {
    const atlas = new CharacterAtlasClient("http://pixels.test", Date.now, limits({
      sourceCount: 8,
      sourceDecodedPixels: 64,
    }));
    assert.ok(await atlas.compose("one", layer("one.blp")));
    assert.ok(await atlas.compose("two", layer("two.blp")));
    assert.equal(atlas.residencyStats.sources.count, 1);
    assert.equal(atlas.residencyStats.sources.decodedPixels, 64);
    assert.equal(atlas.residencyStats.atlases.count, 2);
    assert.ok(await atlas.compose("one-reentry", layer("one.blp")));
    assert.equal(page.fetches.filter((path) => path === "one.blp").length, 2);
  } finally {
    page.restore();
  }
});

test("pending source pins may overflow count and converge immediately after their leases settle", async () => {
  const resolvers = new Map();
  const page = installPage({
    fetchHook: (path) => new Promise((resolve) => { resolvers.set(path, resolve); }),
  });
  try {
    const atlas = new CharacterAtlasClient("http://source-pins.test", Date.now, limits({ sourceCount: 1 }));
    const one = atlas.compose("one", layer("one.blp"));
    const two = atlas.compose("two", layer("two.blp"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual({
      count: atlas.residencyStats.sources.count,
      activeLeases: atlas.residencyStats.sources.activeLeases,
      pinnedCount: atlas.residencyStats.sources.pinnedCount,
      overflowCount: atlas.residencyStats.sources.overflowCount,
    }, { count: 2, activeLeases: 2, pinnedCount: 2, overflowCount: 1 });

    resolvers.get("one.blp")({ ok: true, status: 200, blob: async () => ({ size: 1, path: "one.blp" }) });
    resolvers.get("two.blp")({ ok: true, status: 200, blob: async () => ({ size: 1, path: "two.blp" }) });
    assert.ok(await one);
    assert.ok(await two);
    assert.equal(atlas.residencyStats.sources.count, 1);
    assert.equal(atlas.residencyStats.sources.overflowCount, 0);
  } finally {
    page.restore();
  }
});

test("source cache hits touch true LRU order", async () => {
  const page = installPage();
  try {
    const atlas = new CharacterAtlasClient("http://source-lru.test", Date.now, limits({ sourceCount: 2 }));
    assert.ok(await atlas.compose("one", layer("one.blp")));
    assert.ok(await atlas.compose("two", layer("two.blp")));
    assert.ok(await atlas.compose("one-touch", layer("one.blp")));
    assert.ok(await atlas.compose("three", layer("three.blp")));
    assert.ok(await atlas.compose("one-still-resident", layer("one.blp")));
    assert.equal(page.fetches.filter((path) => path === "one.blp").length, 1);
    assert.ok(await atlas.compose("two-reentry", layer("two.blp")));
    assert.equal(page.fetches.filter((path) => path === "two.blp").length, 2,
      "the untouched oldest source was evicted after one was promoted");
  } finally {
    page.restore();
  }
});

test("atlas and source budgets are independent and source re-entry fetches after exact eviction", async () => {
  const page = installPage();
  try {
    const atlas = new CharacterAtlasClient("http://independent.test", Date.now, limits({
      atlasCount: 8,
      sourceCount: 1,
    }));
    assert.ok(await atlas.compose("one", layer("one.blp")));
    assert.ok(await atlas.compose("two", layer("two.blp")));
    assert.equal(atlas.residencyStats.atlases.count, 2);
    assert.equal(atlas.residencyStats.sources.count, 1);

    assert.ok(await atlas.compose("one-again", layer("one.blp")));
    assert.equal(page.fetches.filter((path) => path === "one.blp").length, 2);
    assert.equal(atlas.residencyStats.atlases.count, 3,
      "source eviction does not evict composed atlas textures");
    assert.equal(atlas.residencyStats.sources.count, 1);
  } finally {
    page.restore();
  }
});

test("aliased decoder identities count pixels once and close only after the last source owner leaves", async () => {
  let closes = 0;
  const shared = { width: 8, height: 8, close: () => { closes++; } };
  const page = installPage({ bitmapFor: () => shared });
  try {
    const atlas = new CharacterAtlasClient("http://alias.test", Date.now, limits({ sourceCount: 1 }));
    assert.ok(await atlas.compose("one", layer("one.blp")));
    assert.ok(await atlas.compose("two", layer("two.blp")));
    assert.equal(atlas.residencyStats.sources.count, 1);
    assert.equal(atlas.residencyStats.sources.uniqueReadyBitmaps, 1);
    assert.equal(atlas.residencyStats.sources.decodedPixels, 64);
    assert.equal(closes, 0, "evicting one aliased path preserves the remaining owner");

    globalThis.createImageBitmap = async (blob) => ({ path: blob.path, width: 8, height: 8, close() {} });
    assert.ok(await atlas.compose("three", layer("three.blp")));
    assert.equal(closes, 1, "the shared identity closes exactly when its final path is evicted");
  } finally {
    page.restore();
  }
});

test("pixel-only eviction skips non-reducing aliases for the oldest ownership that frees pixels", async () => {
  let sharedCloses = 0;
  const shared = { width: 8, height: 8, close: () => { sharedCloses++; } };
  const page = installPage({
    bitmapFor: (path) => path === "one.blp" || path === "two.blp"
      ? shared
      : { path, width: 8, height: 8, close() {} },
  });
  try {
    const atlas = new CharacterAtlasClient("http://alias-pixels.test", Date.now, limits({
      sourceCount: 10,
      sourceDecodedPixels: 128,
    }));
    assert.ok(await atlas.compose("one", layer("one.blp")));
    assert.ok(await atlas.compose("two", layer("two.blp")));
    assert.ok(await atlas.compose("three", layer("three.blp")));
    assert.ok(await atlas.compose("four", layer("four.blp")));

    assert.equal(sharedCloses, 0, "removing one alias path would not improve pixel pressure");
    assert.equal(atlas.residencyStats.sources.count, 3,
      "both alias paths remain while the oldest unique owner is evicted");
    assert.equal(atlas.residencyStats.sources.decodedPixels, 128);
    assert.ok(await atlas.compose("three-reentry", layer("three.blp")));
    assert.equal(page.fetches.filter((path) => path === "three.blp").length, 2);
  } finally {
    page.restore();
  }
});

test("an entirely aliased unpinned ownership group is evicted together to converge pixel overflow", async () => {
  let closes = 0;
  const shared = { width: 8, height: 8, close: () => { closes++; } };
  const page = installPage({ bitmapFor: () => shared });
  try {
    const atlas = new CharacterAtlasClient("http://alias-group.test", Date.now, limits({
      sourceCount: 10,
      sourceDecodedPixels: 32,
      sourceEntryPixels: 64,
    }));
    const one = atlas.compose("one", layer("one.blp"));
    const two = atlas.compose("two", layer("two.blp"));
    assert.ok(await one);
    assert.ok(await two);
    assert.equal(atlas.residencyStats.sources.count, 0);
    assert.equal(atlas.residencyStats.sources.decodedPixels, 0);
    assert.equal(atlas.residencyStats.sources.overflowDecodedPixels, 0);
    assert.equal(closes, 1);
  } finally {
    page.restore();
  }
});

test("pixel group fallback stops after the first aliased ownership restores the budget", async () => {
  let firstCloses = 0;
  let secondCloses = 0;
  const first = { width: 8, height: 8, close: () => { firstCloses++; } };
  const second = { width: 8, height: 8, close: () => { secondCloses++; } };
  const page = installPage({
    bitmapFor: (path) => path.startsWith("first-") ? first : second,
  });
  try {
    const atlas = new CharacterAtlasClient("http://alias-groups.test", Date.now, limits({
      sourceCount: 10,
      sourceDecodedPixels: 64,
    }));
    assert.ok(await atlas.compose("all", [
      { path: "first-one.blp" },
      { path: "first-two.blp" },
      { path: "second-one.blp" },
      { path: "second-two.blp" },
    ]));

    assert.equal(firstCloses, 1, "the oldest complete alias group is evicted");
    assert.equal(secondCloses, 0, "eviction stops as soon as decoded pixels converge");
    assert.equal(atlas.residencyStats.sources.count, 2);
    assert.equal(atlas.residencyStats.sources.uniqueReadyBitmaps, 1);
    assert.equal(atlas.residencyStats.sources.decodedPixels, 64);
    assert.equal(atlas.residencyStats.sources.overflowDecodedPixels, 0);
    assert.ok(await atlas.compose("second-still-resident", layer("second-one.blp")));
    assert.equal(page.fetches.filter((path) => path === "second-one.blp").length, 1);
  } finally {
    page.restore();
  }
});

test("touching any alias promotes its shared bitmap for resource-level pixel LRU", async () => {
  let firstCloses = 0;
  let secondCloses = 0;
  let newestCloses = 0;
  const first = { width: 8, height: 8, close: () => { firstCloses++; } };
  const second = { width: 8, height: 8, close: () => { secondCloses++; } };
  const secondReplacement = { width: 8, height: 8, close() {} };
  const newest = { width: 8, height: 8, close: () => { newestCloses++; } };
  const page = installPage({
    bitmapFor: (path) => path.startsWith("first-") ? first
      : path.startsWith("second-") ? (secondCloses === 0 ? second : secondReplacement) : newest,
  });
  try {
    const atlas = new CharacterAtlasClient("http://alias-resource-lru.test", Date.now, limits({
      sourceCount: 10,
      sourceDecodedPixels: 128,
    }));
    assert.ok(await atlas.compose("seed", [
      { path: "first-one.blp" }, { path: "first-two.blp" },
      { path: "second-one.blp" }, { path: "second-two.blp" },
    ]));
    assert.ok(await atlas.compose("touch-first", layer("first-one.blp")));
    assert.ok(await atlas.compose("admit-newest", layer("newest.blp")));

    assert.equal(firstCloses, 0, "a hit through one alias promotes the shared decoded surface");
    assert.equal(secondCloses, 1, "pixel pressure evicts the least-recently used bitmap identity");
    assert.equal(newestCloses, 0);
    assert.equal(atlas.residencyStats.sources.decodedPixels, 128);
    assert.ok(await atlas.compose("second-reentry", layer("second-one.blp")));
    assert.equal(page.fetches.filter((path) => path === "second-one.blp").length, 2);
  } finally {
    page.restore();
  }
});

test("compose-owned source leases pin one shared pending request and release after stale/success paths", async () => {
  let resolveFetch;
  const fetchAnswer = new Promise((resolve) => { resolveFetch = resolve; });
  let closes = 0;
  const bitmap = { width: 8, height: 8, close: () => { closes++; } };
  const page = installPage({
    bitmapFor: () => bitmap,
    fetchHook: async () => fetchAnswer,
  });
  try {
    const atlas = new CharacterAtlasClient("http://leases.test", Date.now, limits({ sourceCount: 1 }));
    const dropped = atlas.compose("dropped", layer("shared.blp"));
    const kept = atlas.compose("kept", layer("shared.blp"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(page.fetches.length, 1);
    assert.equal(atlas.residencyStats.sources.activeLeases, 2);
    assert.equal(atlas.residencyStats.sources.pinnedCount, 1);

    atlas.release("dropped");
    resolveFetch({ ok: true, status: 200, blob: async () => ({ size: 1, path: "shared.blp" }) });
    assert.equal(await dropped, undefined);
    assert.ok(await kept);
    assert.equal(atlas.residencyStats.sources.activeLeases, 0);
    assert.equal(closes, 0, "release of one look does not close the shared source cache");
    atlas.dispose();
    assert.equal(closes, 1);
  } finally {
    page.restore();
  }
});

test("formal readiness scopes dormant cached partial failures to committed active raw keys", async () => {
  const missing = new Set(["missing-a.blp", "missing-b.blp"]);
  const page = installPage({
    fetchHook: async (path) => missing.has(path)
      ? { ok: false, status: 404 }
      : { ok: true, status: 200, blob: async () => ({ size: 1, path }) },
  });
  try {
    const atlas = new CharacterAtlasClient("http://readiness-scope.test", Date.now, limits());
    assert.ok(await atlas.compose("partial-a", [
      { path: "base-a.blp" }, { path: "missing-a.blp", section: "legUpper" },
    ]));
    assert.ok(await atlas.compose("partial-b", [
      { path: "base-b.blp" }, { path: "missing-b.blp", section: "legUpper" },
    ]));
    assert.equal(atlas.stats.error, 2, "standalone/pre-first-commit behavior remains fail-closed");

    const resident = new Set(["partial-a", "partial-b"]);
    atlas.commitPins(resident, new Set(["partial-a"]));
    assert.equal(atlas.stats.error, 1);
    atlas.commitPins(resident, new Set());
    assert.equal(atlas.stats.error, 0, "dormant built-cache-only failures do not block formal readiness");
    assert.equal(atlas.residencyStats.atlases.count, 2);
    atlas.commitPins(resident, new Set(["partial-b"]));
    assert.equal(atlas.stats.error, 1, "an active failure remains fail-closed on re-entry");
  } finally {
    page.restore();
  }
});

test("refresh retries only submitted partial atlases and resumes a dormant retry on re-entry", async () => {
  let now = 0;
  const attempts = new Map();
  const retryPaths = new Set(["active-missing.blp", "dormant-missing.blp"]);
  const page = installPage({
    fetchHook: async (path) => {
      const attempt = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, attempt);
      if (retryPaths.has(path) && attempt === 1) return { ok: false, status: 500 };
      return { ok: true, status: 200, blob: async () => ({ size: 1, path }) };
    },
  });
  try {
    const atlas = new CharacterAtlasClient("http://refresh-scope.test", () => now, limits());
    assert.ok(await atlas.compose("active", [
      { path: "active-base.blp" }, { path: "active-missing.blp", section: "legUpper" },
    ]));
    assert.ok(await atlas.compose("dormant", [
      { path: "dormant-base.blp" }, { path: "dormant-missing.blp", section: "legUpper" },
    ]));

    const resident = new Set(["active", "dormant"]);
    atlas.commitPins(resident, new Set(["active"]));
    now = 2_000;
    atlas.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts.get("active-missing.blp"), 2);
    assert.equal(attempts.get("dormant-missing.blp"), 1,
      "a residency-only atlas cannot inject background work into the submitted frame");

    atlas.commitPins(resident, new Set(["dormant"]));
    atlas.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts.get("dormant-missing.blp"), 2,
      "commitPins re-arms an already-due retry when its raw appearance becomes submitted again");
  } finally {
    page.restore();
  }
});

test("residency snapshots are deeply frozen and dispose resets every exact total", async () => {
  const page = installPage();
  try {
    const atlas = new CharacterAtlasClient("http://stats.test", Date.now, limits());
    assert.ok(await atlas.compose("one", layer("one.blp")));
    const before = atlas.residencyStats;
    assert.equal(Object.isFrozen(before), true);
    assert.equal(Object.isFrozen(before.atlases), true);
    assert.equal(Object.isFrozen(before.sources), true);
    atlas.dispose();
    assert.deepEqual(atlas.residencyStats, {
      atlases: {
        count: 0, knownLogicalTextureBytes: 0, unknownLogicalTextureCount: 0,
        pinnedCount: 0, overflowCount: 0, overflowKnownLogicalTextureBytes: 0,
      },
      sources: {
        count: 0, uniqueReadyBitmaps: 0, decodedPixels: 0,
        decodedByteSizeUnsupportedCount: 0, activeLeases: 0, pinnedCount: 0,
        terminalCount: 0, overflowCount: 0, overflowDecodedPixels: 0,
      },
    });
  } finally {
    page.restore();
  }
});

test("constructor preserves old callers and rejects non-positive or unsafe optional limits", () => {
  assert.doesNotThrow(() => new CharacterAtlasClient("http://compat.test"));
  assert.doesNotThrow(() => new CharacterAtlasClient("http://compat.test", () => 0));
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new CharacterAtlasClient(
      "http://compat.test", Date.now, { limits: { sourceCount: value } },
    ), RangeError);
  }
});
}

// ── character-atlas-response-limits.test.mjs
{
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
}

// 22.10 ARC-2 S2c — the model each unit wears reaches the world renderer as a pushed table (RenderLookups.unitModels)
// answered read-only before `draw` (ui/Frames.ts `unitModelPeek`); the asking path (`unitModelFor`) runs right after
// `draw` for exactly the guids the renderer admitted (`WorldRenderer3D.unitModelWants`, RenderLookupsBuilder
// `requestUnitModels`). Frame by frame, the renderer must read what the old in-draw call answered, and the same
// requests must leave in the same frame and order — nothing for the units the renderer culled.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

// ui/Frames.ts builds DOM widgets at import time; the same stand-in replay-bound-lookups.test.mjs uses.
function fakeDocument() {
  const make = () => {
    const node = {
      children: [], dataset: {}, style: { setProperty() {}, removeProperty() {} }, className: "",
      value: "", textContent: "", title: "", hidden: false, disabled: false,
      append(...children) { node.children.push(...children); }, prepend() {}, appendChild(child) { return child; },
      replaceChildren() {}, addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, remove() {},
      setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
      querySelector() { return make(); }, querySelectorAll() { return []; }, closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }; },
      getContext() { return null; },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    };
    return node;
  };
  const byId = new Map();
  return {
    createElement: make, createElementNS: () => make(), createTextNode: (text) => ({ textContent: text }),
    createDocumentFragment: make, body: make(), documentElement: make(), head: make(),
    getElementById(id) { if (!byId.has(id)) byId.set(id, make()); return byId.get(id); },
    querySelector() { return make(); }, querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {},
  };
}
globalThis.document = fakeDocument();
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const { unitModelFor, unitModelInputs, unitModelPeek, unitModelVolatile } = await import("../dist/code/browser/ui/Frames.js");
const { bumpFieldsVersion } = await import("../dist/code/world/FieldsVersion.js");
const { CreatureModelClient } = await import("../dist/code/browser/CreatureModelClient.js");
const { MirrorImages } = await import("../dist/code/world/MirrorImages.js");
const { RenderLookupsBuilder } = await import("../dist/code/browser/game/RenderLookupsBuilder.js");

const F = (name) => UPDATE_FIELDS[name].offset;
const ITEM = F("PLAYER_VISIBLE_ITEM_1_ENTRYID");
const ITEM_STRIDE = F("PLAYER_VISIBLE_ITEM_2_ENTRYID") - ITEM;
const LOOK = { body: [], geosets: [], attached: [], hair: "", cloak: "" };
const CHARACTER = { id: 7, model: "Character\\Human\\Male\\HumanMale.m2", scale: 1, collisionHeight: 2, mountHeight: 0, textures: "", appearance: LOOK };
const OGRE = { id: 20, model: "Creature\\Ogre\\Ogre.m2", scale: 1, collisionHeight: 2, mountHeight: 0, textures: "" };

async function settle() { for (let i = 0; i < 8; i++) await new Promise(setImmediate); }

/** The display records come from a fixture; looks and weapons through the real client code over a logged fetch. */
class FixtureModels extends CreatureModelClient {
  get(displayId) { return displayId === 7 ? CHARACTER : displayId === 20 ? OGRE : undefined; }
}

function position(x) { return { x, y: 0, z: 0, orientation: 0 }; }

function unitObject(guid, typeId, fields, x = 1) {
  return { guid, typeId, position: position(x), movementFlags: 0, fields: new Map(fields) };
}

/** One world: its objects, its clients and the log of every request they made, in order. */
function world() {
  const log = [];
  let absorbOnLoad = false;
  const items = new Map([
    [100, { entry: 100, displayId: 55, inventoryType: 1 }],
    [101, { entry: 101, displayId: 56, inventoryType: 13, subClass: 7 }],
  ]);
  let itemGeneration = 1;
  const itemMetadata = {
    get: (entry) => items.get(entry),
    get generation() { return itemGeneration; },
    bump() { itemGeneration++; },
    load(entries) {
      log.push(`items ${entries.join(",")}`);
      // The documented difference: a template already on the world client lands inside `load`, synchronously.
      if (absorbOnLoad && entries.includes(102) && !items.has(102)) {
        items.set(102, { entry: 102, displayId: 57, inventoryType: 5 });
        itemGeneration++;
      }
      return Promise.resolve(true);
    },
  };
  const creatureModels = new FixtureModels("ws://gateway.test/world");
  let clock = 1_000;
  const mirrorImages = new MirrorImages((guid) => log.push(`mirror ${guid}`), () => clock);
  const bytes0 = 1 | (1 << 8); // human warrior male
  const player = (guid, worn, x) => unitObject(guid, 4, [
    [F("UNIT_FIELD_DISPLAYID"), 7], [F("UNIT_FIELD_NATIVEDISPLAYID"), 7], [F("UNIT_FIELD_BYTES_0"), bytes0],
    [F("PLAYER_BYTES"), 0x04030201], [F("PLAYER_BYTES_2"), 2],
    ...worn.map(([slot, entry]) => [ITEM + slot * ITEM_STRIDE, entry]),
  ], x);
  const armed = (guid, entries, x) => unitObject(guid, 3, [
    [F("UNIT_FIELD_DISPLAYID"), 20], ...entries.map((entry, word) => [F("UNIT_VIRTUAL_ITEM_SLOT_ID") + word, entry]),
  ], x);
  const mirror = (guid, x) => unitObject(guid, 3, [[F("UNIT_FIELD_DISPLAYID"), 7], [F("UNIT_FIELD_FLAGS_2"), 0x10]], x);
  const corpse = (guid, flags, x) => unitObject(guid, 7, [
    [F("CORPSE_FIELD_DISPLAY_ID"), 7], [F("CORPSE_FIELD_BYTES_1"), (1 << 8) | (3 << 24)],
    [F("CORPSE_FIELD_BYTES_2"), 0x01020304], [F("CORPSE_FIELD_FLAGS"), flags],
  ], x);
  const objects = new Map([
    player(1n, [[0, 100], [15, 101]], 0), // the character: dressed, every item row here
    player(2n, [[0, 100], [4, 102]], 2), // an item row missing: pending, a partial look
    armed(3n, [500, 501, 0], 3), // a creature holding two weapons nobody has asked about
    mirror(4n, 4), // a mirror image with no reply yet
    mirror(5n, 5), // a mirror image whose reply is here
    corpse(6n, 0, 6), // a corpse wearing its owner's look
    corpse(7n, 1, 7), // bones
    armed(8n, [502, 0, 0], 8), // culled: the renderer never admits it
    player(9n, [[0, 100]], 9), // culled
    unitObject(10n, 3, [[F("UNIT_FIELD_DISPLAYID"), 999]], 10), // no display record
  ].map((object) => [object.guid, object]));
  mirrorImages.receive({
    guid: 5n, displayId: 7, race: 1, gender: 1, classId: 8, skin: 2, face: 3, hair: 4, hairColour: 5, facialHair: 6,
    guildId: 0, equipmentDisplayIds: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  });
  return {
    log, objects, itemMetadata, creatureModels, mirrorImages, builder: new RenderLookupsBuilder(),
    tick(ms) { clock += ms; },
    absorbFromNowOn() { absorbOnLoad = true; },
    unitModel: (object) => unitModelFor(object, creatureModels, itemMetadata, mirrorImages),
    peek: (object) => unitModelPeek(object, creatureModels, itemMetadata, mirrorImages),
    // What game/Loop.ts hands the builder (22.10 ARC-2 S2c: with the change key).
    units() {
      return {
        objects, peek: this.peek, volatile: unitModelVolatile,
        inputs: unitModelInputs(creatureModels, itemMetadata, mirrorImages),
      };
    },
  };
}

/** The renderer's admitted order this frame: the culled units 8 and 9 are left out (behind the camera). */
const ADMITTED = [1n, 3n, 2n, 5n, 4n, 6n, 7n, 10n];

function admittedObject(state, guid) {
  // What the renderer hands `creatureModel`: a corpse as its body view (the builder's own rule).
  const candidate = state.objects.get(guid);
  return candidate.typeId === 7 ? state.corpseView(candidate) : candidate;
}

/** The old frame: `creatureModel(object)` inside draw for every admitted unit, in order. */
function oldFrame(state) {
  const answers = new Map();
  for (const guid of ADMITTED) answers.set(guid, state.unitModel(admittedObject(state, guid)));
  return answers;
}

/** The new frame: the read-only table before draw, the renderer reading it, the asking path right after. */
function newFrame(state) {
  const table = state.builder.build({
    gameObjectMetadata: undefined, creatureModels: undefined, collision: undefined, environment: [],
    units: state.units(),
  }).unitModels;
  const before = state.log.length;
  const answers = new Map();
  const wants = [];
  for (const guid of ADMITTED) { answers.set(guid, table.get(guid)); wants.push(guid); } // WorldRenderer3D #drawUnit
  assert.equal(state.log.length, before, "the table asked for nothing");
  state.builder.requestUnitModels(state.objects, wants, state.unitModel);
  return { answers, table };
}

async function fetchLog(state, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    state.log.push(`${url.pathname}?${url.searchParams.get("entries") ?? url.searchParams.get("race") ?? ""}`);
    if (url.pathname.endsWith("/npc-weapons")) {
      return new Response(JSON.stringify(url.searchParams.get("entries").split(",").map((entry) =>
        ({ entry: Number(entry), inventoryType: 13, model: `Sword${entry}.m2`, texture: "Sword.blp" }))));
    }
    return new Response(JSON.stringify({ ...LOOK, hair: url.search }));
  };
  try { return await run(); } finally { globalThis.fetch = original; }
}

const { corpseUnitView } = await import("../dist/code/browser/CorpseModel.js");

test("frame by frame the pushed table answers what the in-draw call answered, and the same asks leave", async () => {
  const before = world();
  const after = world();
  before.corpseView = corpseUnitView;
  after.corpseView = corpseUnitView;
  for (let frame = 0; frame < 4; frame++) {
    const oldAnswers = await fetchLog(before, async () => { const answers = oldFrame(before); await settle(); return answers; });
    const { answers, table } = await fetchLog(after, async () => { const result = newFrame(after); await settle(); return result; });
    for (const guid of ADMITTED) assert.deepEqual(answers.get(guid), oldAnswers.get(guid), `frame ${frame}, unit ${guid}`);
    assert.deepEqual(after.log, before.log, `frame ${frame}: the same requests, in the same order`);
    assert.deepEqual(structuredClone(table), table, "the table crosses structuredClone");
    before.tick(16);
    after.tick(16);
  }
  // What the fixture covered: a dressed player, a pending one, a creature armed after its answer, both mirror
  // images, a corpse's look and its bones, a missing record; and the culled two never asked.
  const final = newFrame(after).answers;
  assert.equal(final.get(1n).appearance.hair.length > 0, true, "the character is dressed");
  assert.equal(final.get(2n).appearancePending, true, "a missing item row keeps the look pending");
  assert.deepEqual(final.get(3n).held.map((held) => held.model), ["Sword500.m2", "Sword501.m2"]);
  assert.equal(final.get(4n).appearancePending, true, "the unanswered mirror image waits");
  assert.notEqual(final.get(5n).appearance, LOOK, "the answered mirror image wears its reply's look");
  assert.ok(final.get(6n).appearance, "the corpse wears its owner's look");
  assert.match(final.get(7n).model, /DeathSkeleton/);
  assert.equal(final.get(10n), undefined);
  assert.equal(after.log.some((line) => line.includes("502")), false, "the culled creature's weapon is never asked for");
  assert.equal(after.log.some((line) => line === "items 100"), false, "the culled player's items are never loaded");
  assert.ok(after.log.includes("mirror 4"), "the mirror image question left");
});

test("the one documented difference: an item row the load absorbs synchronously reaches the renderer a frame later", async () => {
  const before = world();
  const after = world();
  before.corpseView = corpseUnitView;
  after.corpseView = corpseUnitView;
  // A first frame and its answers, so the partial look of unit 2 is here; then item 102's template is on the
  // world client, which `ItemMetadataClient.load` absorbs inside the call.
  await fetchLog(before, async () => { oldFrame(before); await settle(); });
  await fetchLog(after, async () => { newFrame(after); await settle(); });
  before.absorbFromNowOn();
  after.absorbFromNowOn();
  const oldAnswers = [];
  const newAnswers = [];
  for (let frame = 0; frame < 3; frame++) {
    oldAnswers.push(await fetchLog(before, async () => { const answers = oldFrame(before); await settle(); return answers; }));
    newAnswers.push(await fetchLog(after, async () => { const { answers } = newFrame(after); await settle(); return answers; }));
    for (const guid of ADMITTED) {
      if (guid !== 2n) assert.deepEqual(newAnswers[frame].get(guid), oldAnswers[frame].get(guid), `frame ${frame}, unit ${guid}`);
    }
  }
  assert.equal(newAnswers[0].get(2n).appearancePending, true, "read before draw: the partial look, still pending");
  assert.notDeepEqual(newAnswers[0].get(2n), oldAnswers[0].get(2n), "inside draw the absorbed row already changed it");
  // Old frame 0 asked for the full look and had none yet (undefined); here it lands before the next frame, so
  // from frame 1 on the two paths agree again — the difference is that one frame.
  assert.equal(oldAnswers[0].get(2n), undefined);
  assert.deepEqual(newAnswers[1].get(2n), oldAnswers[1].get(2n), "the next frame agrees again");
  assert.deepEqual(newAnswers[2].get(2n), oldAnswers[2].get(2n));
  assert.deepEqual(after.log, before.log, "and the requests are the same, in the same frames");
});

test("an unchanged world recomputes nothing on the next frame; a written unit, a moved client or a departure does", async () => {
  const state = world();
  state.corpseView = corpseUnitView;
  // Settle every answer first: looks, weapons and replies land, so the clients stop moving.
  for (let frame = 0; frame < 3; frame++) await fetchLog(state, async () => { newFrame(state); await settle(); });
  const calls = [];
  const peek = state.peek;
  const units = () => ({ ...state.units(), peek: (object) => { calls.push(object.guid); return peek(object); } });
  const build = () => state.builder.build({
    gameObjectMetadata: undefined, creatureModels: undefined, collision: undefined, environment: [], units: units(),
  }).unitModels;
  const first = new Map(build());
  calls.length = 0;
  const second = build();
  // Only the two mirror images (their wait runs on the clock) are asked again.
  assert.deepEqual(calls, [4n, 5n], "an unchanged world asks nothing about the other units");
  for (const [guid, model] of first) assert.strictEqual(second.get(guid), model, `unit ${guid} keeps the same answer object`);

  // A field write on one unit recomputes that unit only.
  calls.length = 0;
  const player = state.objects.get(1n);
  player.fields.set(F("PLAYER_FLAGS"), 0x400); // hide helm
  bumpFieldsVersion(player.fields);
  const third = build();
  assert.deepEqual(calls, [1n, 4n, 5n]);
  assert.deepEqual(third.get(1n), state.peek(player), "and its answer is the fresh one");

  // A client revision (an item row landing) recomputes every unit.
  calls.length = 0;
  state.itemMetadata.bump();
  build();
  assert.equal(calls.length, [...state.objects.values()].filter((object) => object.typeId !== 7 || corpseUnitView(object)).length);

  // A unit leaving the state leaves the table.
  state.objects.delete(3n);
  assert.equal(build().has(3n), false);
});

test("the read-only path asks for nothing: no load, look, mirror question or weapon request", async () => {
  const state = world();
  state.corpseView = corpseUnitView;
  await fetchLog(state, async () => {
    for (const object of state.objects.values()) {
      const view = object.typeId === 7 ? corpseUnitView(object) : object;
      if (view) state.peek(view);
    }
    await settle();
  });
  assert.deepEqual(state.log, []);
});

test("draw takes no model function; the loop, the replay host and the bench push the table instead", () => {
  const source = (path) => readFileSync(new URL(`../src/browser/${path}`, import.meta.url), "utf8");
  const renderer = source("WorldRenderer3D.ts");
  const drawAt = renderer.indexOf("  draw(\n");
  const signature = renderer.slice(drawAt, renderer.indexOf("): WorldSubmissionReceipt | undefined {", drawAt));
  assert.ok(drawAt >= 0 && signature.length > 0);
  assert.equal(signature.match(/\w+\??: \([^)]*\) =>/g), null, "no function-typed parameter (heightAt is HeightSampler)");
  assert.doesNotMatch(renderer, /creatureModel\?\.\(/);
  const loop = source("game/Loop.ts");
  const call = loop.slice(loop.indexOf("renderer.draw("), loop.indexOf("renderer.renderPortraits(now)"));
  assert.doesNotMatch(call.slice(0, call.indexOf("} finally {")), /unitModel/, "the loop hands draw no unit model");
  assert.match(call, /renderLookups\.requestUnitModels\(world\.state\.objects, renderer\.unitModelWants\(\), unitModel\)/);
  const host = source("LiveFormalRenderBenchmarkHost.ts");
  assert.match(host, /requestUnitModels\(replay\.state\.objects, resources\.renderer\.unitModelWants\(\), bindings\.unitModel\)/);
  // 22.10 ARC-2 S6a: the bench's table moved to BenchScene.ts so the worker bench page shares it.
  assert.match(source("bench/BenchScene.ts"), /this\.models\.set\(object\.guid, model\)/);
  assert.match(source("bench/Harness.ts"), /unitModels\.refresh\(state\)/);
});

test("WorldState marks an object's fields written on every write path the unit table keys on", async () => {
  const { WorldState } = await import("../dist/code/world/WorldState.js");
  const { fieldsVersion } = await import("../dist/code/world/FieldsVersion.js");
  const state = new WorldState();
  state.setField(5n, F("UNIT_FIELD_DISPLAYID"), 7);
  const fields = state.objects.get(5n).fields;
  assert.equal(fieldsVersion(fields), 1, "setField");
  assert.equal(state.patchField(5n, F("UNIT_FIELD_DISPLAYID"), 8), true);
  assert.equal(fieldsVersion(fields), 2, "patchField");
  const source = readFileSync(new URL("../src/world/WorldState.ts", import.meta.url), "utf8");
  assert.match(source, /changed\[slot\] = index;\n  \}\n  bumpFieldsVersion\(fields\);/, "create and values blocks (commitValues)");
});

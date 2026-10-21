// 22.10 ARC-2 S2a — what the world renderer used to get by calling back into the main thread (an enchant glow
// resolver, a game-object predicate, the unit facing's registered sources, the page's spell rows and vehicle
// tables) is now one plain record the frame loop builds and pushes before `draw` (src/browser/RenderInputs.ts,
// src/browser/game/RenderInputsBuilder.ts). The record must cross `structuredClone` unchanged and answer exactly
// what the old callbacks answered.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import {
  ItemEnchantmentClient, attachedGlow, enchantGlowSource, enchantGlowTables,
} from "../dist/code/browser/ItemEnchantments.js";
import { NO_RENDER_INPUTS } from "../dist/code/browser/RenderInputs.js";
import { RenderInputsBuilder } from "../dist/code/browser/game/RenderInputsBuilder.js";
import { SpellRows, spellAttributeWordsOf } from "../dist/code/browser/SpellRows.js";
import { GAMEOBJECT_RANGE } from "../dist/code/browser/GameObjectTransportAdmission.js";
import { dungeonDifficultyObjectShown } from "../dist/code/world/DungeonDifficultyObject.js";
import { SPELL_ATTR5_DONT_TURN_DURING_CAST, unitAutoFacing, unitFacingTurn } from "../dist/code/world/UnitFacing.js";
import { VehicleCatalog, vehicleCatalogOfRows } from "../dist/code/world/VehicleDbc.js";

const F = UPDATE_FIELDS;
const HEAD = F.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
const STRIDE = F.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - HEAD;

function gameObject(guid, x, type, entry) {
  return {
    guid, typeId: 5, position: { x, y: 0, z: 0, orientation: 0 },
    fields: new Map([[F.GAMEOBJECT_BYTES_1.offset, type << 8], [F.OBJECT_FIELD_ENTRY.offset, entry]]),
  };
}

function creature(guid, x, { target, entry = 0 } = {}) {
  const fields = new Map([[F.OBJECT_FIELD_ENTRY.offset, entry]]);
  if (target !== undefined) {
    fields.set(F.UNIT_FIELD_TARGET.offset, Number(target & 0xffffffffn));
    fields.set(F.UNIT_FIELD_TARGET.offset + 1, Number(target >> 32n));
  }
  return { guid, typeId: 3, fields, movementFlags: 0, position: { x, y: 0, z: 0, orientation: 0 } };
}

/** A world with the character at the origin, two portals of Gundrak in range, one out of it, a mailbox. */
function fixture() {
  const self = {
    guid: 1n, typeId: 4, movementFlags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 },
    fields: new Map([[HEAD + 15 * STRIDE + 1, (0 << 16) | 1900]]), // mongoose-like permanent enchant on the main hand
  };
  const normal = gameObject(100n, 10, 31, 9001);
  const heroic = gameObject(101n, 10, 31, 9002);
  const far = gameObject(102n, GAMEOBJECT_RANGE + 1, 31, 9002);
  const mailbox = gameObject(103n, 5, 19, 9003);
  const victim = creature(200n, 3);
  const caster = creature(201n, 0, { target: victim.guid, entry: 42 });
  const objects = new Map([self, normal, heroic, far, mailbox, victim, caster].map((object) => [object.guid, object]));
  const templates = new Map([[9001, { type: 31, data: [604, 0] }], [9002, { type: 31, data: [604, 1] }], [9003, { type: 19, data: [] }]]);
  const asked = [];
  const world = {
    state: { selfGuid: 1n, objects },
    casts: new Map([[caster.guid, { spellId: 700, startedAt: performance.now(), duration: 60_000, channel: false, castCount: 3 }]]),
    creatureTemplates: new Map([[42, { entry: 42, movementId: 441 }]]),
    creatureTemplatesRevision: 1,
    gossip: { guid: victim.guid }, questDialog: undefined, questList: undefined, vendor: undefined, trainer: undefined,
    taxiMenu: undefined, bankerGuid: undefined, auctioneerGuid: 0n, tabardVendorGuid: 0n, petitionVendor: undefined,
    stable: undefined, stableMasterGuid: 0n,
  };
  // Loop.ts `loopGameObjectShown`, over this world: the template asked for as the click path asks, normal difficulty.
  const shown = (object) => {
    const type = ((object.fields.get(F.GAMEOBJECT_BYTES_1.offset) ?? 0) >>> 8) & 0xff;
    if (type !== 31) return true;
    asked.push(object.guid);
    const template = templates.get(object.fields.get(F.OBJECT_FIELD_ENTRY.offset));
    return dungeonDifficultyObjectShown(type, template, () => 1, 0);
  };
  const spells = new SpellRows();
  spells.set(700, { id: 700, name: "Cast", attributes: [0, 0, 0, 0, 0, SPELL_ATTR5_DONT_TURN_DURING_CAST, 0, 0] });
  spells.set(701, { id: 701, name: "Plain", attributes: [0, 0, 0, 0, 0, 0, 0, 0] });
  spells.set(702, { id: 702, name: "Unknown words" });
  const enchantments = new ItemEnchantmentClient("http://gateway.test");
  enchantments.enchantments.set(1900, { id: 1900, name: "Crusader", gemItemId: 0, conditionId: 0, visual: 155 });
  enchantments.visuals.set(1900, ["Spells\\Enchantments\\WhiteGlow_Low.mdx"]);
  enchantments.itemVisualSlots.set(155, Object.freeze(["Spells\\Glow.m2", null, null, null, null]));
  enchantments.itemVisualSlots.set(156, Object.freeze([null, "Spells\\Legend.m2", null, null, null]));
  enchantments.displayVisuals.set(5000, 156);
  enchantments.ready = true;
  const vehicles = new VehicleCatalog(
    [Object.freeze({ id: 7, flags: 0, seatIds: Object.freeze([11, 0, 0, 0, 0, 0, 0, 0]), vehicleUIIndicatorId: 3 })],
    [Object.freeze({ id: 11, flags: 0x400, attachmentOffset: Object.freeze({ x: 1, y: 2, z: Number.NaN }) })],
    [{ id: 3, backgroundTexture: "Interface\\Vehicles\\Ring" }],
    [{ id: 1, indicatorId: 3, virtualSeatIndex: 1, x: 0.5, y: 0.25 }],
  );
  return { world, shown, asked, spells, enchantments, vehicles, self, caster, victim };
}

test("the record a frame builds survives structuredClone unchanged: no function, no class instance", () => {
  const { world, shown, spells, enchantments, vehicles } = fixture();
  const inputs = new RenderInputsBuilder().build({ world, spells, enchantments, vehicles, gameObjectShown: shown });
  const copy = structuredClone(inputs);
  assert.deepEqual(copy, inputs);
  assert.deepEqual(structuredClone(NO_RENDER_INPUTS), NO_RENDER_INPUTS);
  // The old pushes were functions, which structuredClone refuses.
  assert.throws(() => structuredClone({ enchantGlow: () => undefined }), /could not be cloned/);
});

test("the portals hidden are the ones the renderer's admission pass asked about and the rule refused", () => {
  const { world, shown, asked, spells } = fixture();
  const builder = new RenderInputsBuilder();
  const inputs = builder.build({ world, spells, enchantments: undefined, vehicles: undefined, gameObjectShown: shown });
  assert.deepEqual([...inputs.hiddenGameObjects], [101n], "the heroic portal hides in normal difficulty");
  assert.deepEqual(asked, [100n, 101n], "the far portal is not asked about (outside GAMEOBJECT_RANGE), nor the mailbox");
  // No view subject: nothing drawn, nothing asked (the renderer returns before its object pass).
  asked.length = 0;
  const away = { ...world, state: { selfGuid: 99n, objects: world.state.objects } };
  assert.equal(builder.build({ world: away, spells, enchantments: undefined, vehicles: undefined, gameObjectShown: shown })
    .hiddenGameObjects.size, 0);
  assert.deepEqual(asked, []);
  assert.equal(NO_RENDER_INPUTS.hiddenGameObjects.has(101n), false, "nothing pushed: every object drawn");
});

test("the enchant glow over the pushed tables is the client's own answer", () => {
  const { self, enchantments } = fixture();
  const tables = enchantGlowTables(enchantments);
  assert.equal(enchantGlowTables(enchantments), tables, "one record per client, not one a frame");
  const creatureWithDisplay = { guid: 300n, typeId: 3, fields: new Map() };
  for (const [object, slot, displayId] of [[self, 15, undefined], [self, 16, undefined], [self, 1, undefined],
    [creatureWithDisplay, 15, 5000], [creatureWithDisplay, 15, 5001], [{ ...self, typeId: 5 }, 15, 5000]]) {
    const before = attachedGlow(object, slot, enchantments, displayId);
    const after = attachedGlow(object, slot, enchantGlowSource(structuredClone(tables)), displayId);
    assert.deepEqual(after, before, `slot ${slot}, display ${displayId}`);
  }
  assert.ok(attachedGlow(self, 15, enchantGlowSource(tables)), "the representative blade does glow");
  enchantments.ready = false;
  assert.equal(enchantGlowTables(enchantments), undefined, "loading: no tables, blades unlit");
});

test("the facing answers off the pushed record are the registered sources' answers", () => {
  const { world, shown, spells, caster, victim } = fixture();
  const builder = new RenderInputsBuilder();
  const inputs = structuredClone(builder.build({ world, spells, enchantments: undefined, vehicles: undefined, gameObjectShown: shown }));
  const objects = world.state.objects;
  // Casting 700 (AttributesEx5 DONT_TURN): keeps its facing, as `casting` + `spellAttributeWords` answered.
  assert.equal(unitAutoFacing(caster, objects, undefined, 1n, inputs.facing), undefined);
  // Casting 701 (no bit), and no cast at all: it faces its target at +x.
  world.casts.set(caster.guid, { spellId: 701, startedAt: performance.now(), duration: 60_000, channel: false });
  const plain = builder.build({ world, spells, enchantments: undefined, vehicles: undefined, gameObjectShown: shown });
  assert.equal(unitAutoFacing(caster, objects, undefined, 1n, plain.facing), 0);
  // The gossip window is open on the victim: with no target it faces the player (at the origin, behind it).
  assert.equal(unitAutoFacing(victim, objects, undefined, 1n, plain.facing), Math.PI);
  assert.equal(plain.facing.interactionNpc, victim.guid);
  // CreatureMovementInfo 441 springs at its SmoothFacingChaseRate where the generated table has it.
  const turn = unitFacingTurn(caster, plain.facing);
  assert.ok(turn === "average" || turn === 10, String(turn));
  assert.equal(plain.facing.movementIds.get(42), 441);
});

test("the spell rows keep their attribute words in step with every write", () => {
  const rows = new SpellRows();
  rows.set(1, { id: 1, attributes: [1, 0, 0, 0, 0, 0, 0, 0] });
  rows.set(2, { id: 2 });
  assert.deepEqual([...rows.attributeWords.keys()], [1]);
  rows.set(1, { id: 1 });
  assert.equal(rows.attributeWords.has(1), false, "a row without words replaces one with");
  rows.set(2, { id: 2, attributes: [0, 0x4000, 0, 0, 0, 0, 0, 0] });
  const revision = rows.revision;
  rows.delete(2);
  assert.equal(rows.attributeWords.size, 0);
  assert.ok(rows.revision > revision);
  rows.set(3, { id: 3, attributes: [3, 0, 0, 0, 0, 0, 0, 0] });
  rows.clear();
  assert.equal(rows.attributeWords.size, 0);
  // A plain map (as tests assign `game.spells`) is read afresh.
  assert.deepEqual([...spellAttributeWordsOf(new Map([[5, { id: 5, attributes: [5] }], [6, { id: 6 }]]))], [[5, [5]]]);
});

test("the vehicle catalog the renderer builds from the pushed rows answers as the page's", () => {
  const { vehicles } = fixture();
  const rebuilt = vehicleCatalogOfRows(structuredClone(vehicles.rows));
  assert.equal(rebuilt.vehicleCount, vehicles.vehicleCount);
  assert.equal(rebuilt.seatCount, vehicles.seatCount);
  assert.deepEqual(rebuilt.vehicle(7), vehicles.vehicle(7));
  assert.deepEqual(rebuilt.seat(11), vehicles.seat(11));
  assert.deepEqual(rebuilt.indicator(3), vehicles.indicator(3));
  assert.equal(rebuilt.vehicle(8), undefined);
});

// ---- import guards: the renderer side no longer reaches main-thread singletons -----------------------

const source = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

/** Every module `path` reaches through relative value imports (type-only imports erase). */
function reachable(path) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let text;
    try { text = source(file); } catch { return; }
    for (const match of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"(\.{1,2}\/[^"]+)\.js";/gms)) {
      const parts = file.split("/").slice(0, -1);
      for (const step of match[1].split("/")) {
        if (step === "..") parts.pop();
        else if (step !== ".") parts.push(step);
      }
      visit(`${parts.join("/")}.ts`);
    }
  };
  visit(path);
  return seen;
}

test("PortraitRenderer.ts no longer reaches game/Context.ts", () => {
  assert.doesNotMatch(source("browser/PortraitRenderer.ts"), /game\/Context\.js/);
  assert.equal(reachable("browser/PortraitRenderer.ts").has("browser/game/Context.ts"), false);
});

test("the facing and the renderer's pushed record hold no live main-thread source", () => {
  const facing = source("world/UnitFacing.ts");
  assert.equal(reachable("world/UnitFacing.ts").has("world/PetCastSpell.ts"), false, "spellAttributeWords is no longer read");
  assert.doesNotMatch(facing, /^let /m, "no module state");
  assert.doesNotMatch(facing, /setUnitFacingSources/);
  const inputs = reachable("browser/RenderInputs.ts");
  for (const singleton of ["browser/game/Context.ts", "world/PetCastSpell.ts", "browser/VehicleClient.ts"]) {
    assert.equal(inputs.has(singleton), false, singleton);
  }
  const renderer = source("browser/WorldRenderer3D.ts");
  assert.doesNotMatch(renderer, /from "\.\/VehicleClient\.js"/, "vehicleCatalog() is pushed");
  assert.doesNotMatch(renderer, /setEnchantGlow\(|setGameObjectShown\(|interactionNpcGuid\(\)/);
});

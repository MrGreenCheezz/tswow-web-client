// 29.10: hunter shots (owner: «у охотника не проигрывается анимация стрельбы») — SMSG_SPELL_GO/START's CAST_FLAG_AMMO
// pair (world/SpellAmmo.ts), the ranged release of every ammo GO and the ammo flying as Wow.exe 0x00732ff0 →
// 0x004eab50 draws it (browser/AmmoMissile.ts, AmmoModelClient.ts, gateway/AmmoModels.ts).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseSpellGo, parseSpellStart } from "../dist/code/world/SpellProtocol.js";
import { CAST_FLAG_AMMO, castCarriesAmmo, castFlightAmmo } from "../dist/code/world/SpellAmmo.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { SpellVisualCoordinator } from "../dist/code/browser/SpellVisualLifecycle.js";
import { castReleasesRangedWeapon, skinAmmoMissiles, withAmmoMissile } from "../dist/code/browser/AmmoMissile.js";
import { AmmoModelClient } from "../dist/code/browser/AmmoModelClient.js";
import { ammoModelFor, parseAmmoItems } from "../dist/code/gateway/AmmoModels.js";

const POWER_LEFT_SELF = 0x800;
const RUNE_LIST = 0x200000;
const ADJUST_MISSILE = 0x20000;
const IMMUNITY = 0x04000000;
const TARGET_FLAG_UNIT = 0x2;
const TARGET_FLAG_DEST_LOCATION = 0x40;

/** SpellCastData's header as SpellPackets.cpp:114-119 writes it. */
const header = (flags, spellId = 3044) =>
  new PacketWriter().packedGuid(1n).packedGuid(1n).u8(3).u32(spellId).u32(flags).u32(123456);

test("SMSG_SPELL_GO: the ammo pair after power, runes and trajectory (SpellPackets.cpp:146-156)", () => {
  const flags = CAST_FLAG_AMMO | POWER_LEFT_SELF | RUNE_LIST | ADJUST_MISSILE;
  const writer = header(flags)
    .u8(1).u64(2n) // one hit
    .u8(0) // no misses
    .u32(TARGET_FLAG_DEST_LOCATION).packedGuid(0n).f32(10).f32(20).f32(30)
    .u32(77) // RemainingPower
    .u8(0b111).u8(0b001).u8(10).u8(20) // runes: two spent, one cooldown byte each
    .f32(0.25).u32(900) // trajectory
    .u32(5996).u32(24); // ammo
  const go = parseSpellGo(writer.toUint8Array());
  assert.deepEqual(go.hits, [2n]);
  assert.deepEqual(go.adjustMissile, { elevation: 0.25, delayMs: 900 });
  assert.deepEqual(go.ammo, { displayId: 5996, inventoryType: 24 });
});

test("SMSG_SPELL_GO: the ammo pair right after the power word, without a trajectory", () => {
  const go = parseSpellGo(header(CAST_FLAG_AMMO | POWER_LEFT_SELF)
    .u8(1).u64(2n).u8(0).u32(TARGET_FLAG_UNIT).packedGuid(2n).u32(1000).u32(5998).u32(24).toUint8Array());
  assert.deepEqual(go.ammo, { displayId: 5998, inventoryType: 24 });
  assert.equal(go.adjustMissile, undefined);
  // A spectator's copy has no power word (Spell.cpp:4583-4586 removes the flag).
  const seen = parseSpellGo(header(CAST_FLAG_AMMO)
    .u8(1).u64(2n).u8(0).u32(TARGET_FLAG_UNIT).packedGuid(2n).u32(16751).u32(25).toUint8Array());
  assert.deepEqual(seen.ammo, { displayId: 16751, inventoryType: 25 });
});

test("SMSG_SPELL_GO: a short or misread ammo tail gives no ammo and keeps the rest", () => {
  const short = parseSpellGo(header(CAST_FLAG_AMMO)
    .u8(1).u64(2n).u8(0).u32(TARGET_FLAG_UNIT).packedGuid(2n).u32(5996).toUint8Array());
  assert.equal(short.ammo, undefined);
  assert.deepEqual(short.hits, [2n]);
  assert.equal(short.targets.unitTarget, 2n);
  const misread = parseSpellGo(header(CAST_FLAG_AMMO)
    .u8(0).u8(0).u32(0).u32(5996).u32(0x4000).toUint8Array());
  assert.equal(misread.ammo, undefined, "no inventory type is above INVTYPE_RELIC");
  const none = parseSpellGo(header(0).u8(0).u8(0).u32(0).u32(5996).u32(24).toUint8Array());
  assert.equal(none.ammo, undefined, "without CAST_FLAG_AMMO the words are not ammo");
});

test("SMSG_SPELL_START: the ammo pair between the power word and the immunities", () => {
  const start = parseSpellStart(header(CAST_FLAG_AMMO | POWER_LEFT_SELF | IMMUNITY, 56641)
    .u32(TARGET_FLAG_UNIT).packedGuid(2n).u32(500).u32(5996).u32(24).u32(0x7f).u32(0x10).toUint8Array());
  assert.deepEqual(start.ammo, { displayId: 5996, inventoryType: 24 });
  assert.equal(start.schoolImmunityMask, 0x7f);
  assert.equal(start.mechanicImmunityMask, 0x10);
});

test("which casts release a ranged weapon and which fly their ammo", () => {
  const ammo = (displayId, inventoryType, flags = CAST_FLAG_AMMO) => ({ spellId: 3044, castFlags: flags, ammo: { displayId, inventoryType } });
  assert.equal(castCarriesAmmo(ammo(5996, 24)), true);
  assert.equal(castCarriesAmmo(ammo(5996, 24, 0)), false, "the flag is the server's word");
  assert.equal(castCarriesAmmo(ammo(0, 26)), false, "a wand with no ammo: nothing on the pair");
  assert.equal(castCarriesAmmo(ammo(1234, 13)), true, "a creature's melee weapon shoots (Spell.cpp:4665-4669)…");
  assert.equal(castFlightAmmo(ammo(1234, 13)), undefined, "…but flies nothing (0x004eab50: 24 or 25 only)");
  assert.deepEqual(castFlightAmmo(ammo(16751, 25)), { displayId: 16751, inventoryType: 25 });
  assert.equal(castReleasesRangedWeapon({ spellId: 75, castFlags: 0 }, { id: 75, autoRepeat: true }), true);
  assert.equal(castReleasesRangedWeapon({ spellId: 1485, castFlags: 0 }, { id: 1485, autoRepeat: true }), false);
  assert.equal(castReleasesRangedWeapon(ammo(5996, 24), undefined), true);
});

// --- the coordinator ------------------------------------------------------------------------------

class Events {
  #listeners = new Map();
  on(name, listener) {
    const set = this.#listeners.get(name) ?? new Set();
    set.add(listener);
    this.#listeners.set(name, set);
    return () => set.delete(listener);
  }
  emit(name, value) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(value);
  }
}

function world() {
  return {
    events: new Events(),
    state: { selfGuid: 1n, objects: new Map([[1n, { position: { x: 1, y: 2, z: 3, orientation: 0 }, targetGuid: 2n }],
      [2n, { position: { x: 21, y: 2, z: 3, orientation: Math.PI } }]]) },
    auras: new Map(), targetGuid: 2n,
  };
}

function recorder() {
  const calls = { plans: [], actions: [] };
  return {
    calls,
    renderer: {
      playSpellVisual(plan) { calls.plans.push(plan); },
      setStateVisuals() {},
      playUnitAction(guid, action) { calls.actions.push({ guid, action }); },
    },
  };
}

const kit = (animation = -1) => ({ startAnimation: -1, animation, effects: [], sound: 0 });
/** Arcane Shot 3044 as the gateway answers it: a missile (ArcaneShot_Missile), no caster animation. */
const arcaneShot = { id: 3044, missile: { path: "Spells\\ArcaneShot_Missile.m2", scale: 1, attachment: 22, speed: 40 }, impact: kit() };
const ammoGo = (spellId, ammo = { displayId: 5996, inventoryType: 24 }) => ({
  casterGuid: 1n, casterUnit: 1n, castId: 0, spellId, castFlags: CAST_FLAG_AMMO, castTime: 0, hits: [2n], misses: [], ammo,
});
const arrow = { displayId: 5996, inventoryType: 24, model: "Item\\ObjectComponents\\Ammo\\ArrowFlight_01.m2",
  texture: "Item\\ObjectComponents\\Ammo\\Arrow_A_01Brown.blp" };

function coordinatorWith(rows, options = {}) {
  const values = new Map(rows.map((row) => [row.id, row]));
  const ref = recorder();
  const current = world();
  const coordinator = new SpellVisualCoordinator({ metadata: { get: (id) => values.get(id) }, renderer: ref.renderer, ...options });
  coordinator.bindWorld(current);
  return { ref, current, coordinator };
}

test("an ammo SPELL_GO plays the caster's shot when its visual authors no caster animation (Arcane Shot)", () => {
  const { ref, current } = coordinatorWith([arcaneShot]);
  current.events.emit("SPELL_GO", ammoGo(3044));
  assert.deepEqual(ref.calls.actions, [{ guid: 1n, action: "shoot" }]);
  assert.equal(ref.calls.plans.length, 1, "its own missile still flies");
  assert.equal(ref.calls.plans[0].instances[0].path, "Spells\\ArcaneShot_Missile.m2", "the visual's model, not the arrow");

  const plain = coordinatorWith([arcaneShot]);
  plain.current.events.emit("SPELL_GO", { ...ammoGo(3044), castFlags: 0, ammo: undefined });
  assert.deepEqual(plain.ref.calls.actions, [], "without CAST_FLAG_AMMO nothing says it is a weapon shot");
});

test("an authored caster animation wins over the ammo shot, and a spell with no visual still shoots", () => {
  const authored = { ...arcaneShot, cast: kit(110) };
  const { ref, current } = coordinatorWith([authored]);
  current.events.emit("SPELL_GO", ammoGo(3044));
  assert.deepEqual(ref.calls.actions, []);

  const values = new Map();
  const empty = recorder();
  const bare = world();
  const coordinator = new SpellVisualCoordinator({ metadata: { get: (id) => values.get(id) }, renderer: empty.renderer });
  coordinator.bindWorld(bare);
  bare.events.emit("SPELL_GO", ammoGo(3018));
  assert.deepEqual(empty.calls.actions, [], "the row is still coming");
  coordinator.onLoaded([3018]);
  assert.deepEqual(empty.calls.actions, [{ guid: 1n, action: "shoot" }], "a row of nothing authors no animation");
  bare.events.emit("SPELL_GO", ammoGo(3018));
  assert.equal(empty.calls.actions.length, 2, "known to have no visual: at once");
});

test("Auto Shot flies its arrow: the ammo missile takes the ammo's model, scale 1 and skin", () => {
  const autoShot = { id: 75, autoRepeat: true, ammoMissile: { attachment: 22, speed: 40 } };
  const models = { model: () => arrow };
  const { ref, current } = coordinatorWith([autoShot], { ammoModels: models });
  current.events.emit("SPELL_GO", ammoGo(75));
  assert.deepEqual(ref.calls.actions, [{ guid: 1n, action: "shoot" }]);
  assert.equal(ref.calls.plans.length, 1);
  const [missile] = ref.calls.plans[0].instances;
  assert.equal(missile.path, arrow.model);
  assert.equal(missile.scale, 1);
  assert.equal(missile.objectSkin, arrow.texture);
  assert.equal(missile.attachment, 22);
  assert.deepEqual(missile.flight.target, { guid: 2n, attachment: 34 }, "the chest, as any missile without a destination");
  assert.ok(Math.abs(missile.endsAt - missile.startedAt - 500) < 1, "20 yards at Spell.Speed 40");

  const unknown = coordinatorWith([autoShot], { ammoModels: { model: () => null } });
  unknown.current.events.emit("SPELL_GO", ammoGo(75));
  assert.equal(unknown.ref.calls.plans.flatMap((plan) => plan.instances).length, 0, "a display that flies nothing: no missile");
  assert.equal(unknown.ref.calls.actions.length, 1);
});

test("a cast waits for its ammo's model, its shot does not; the wait ends with the epoch", () => {
  const autoShot = { id: 75, autoRepeat: true, ammoMissile: { attachment: 22, speed: 40 } };
  let answer;
  const { ref, current, coordinator } = coordinatorWith([autoShot], { ammoModels: { model: () => answer } });
  current.events.emit("SPELL_GO", ammoGo(75));
  assert.equal(ref.calls.actions.length, 1, "the release at once");
  assert.equal(ref.calls.plans.length, 0, "the flight waits for the model");
  answer = arrow;
  coordinator.onAmmoModelsLoaded();
  assert.equal(ref.calls.plans.length, 1);
  assert.equal(ref.calls.plans[0].instances[0].path, arrow.model);
  assert.equal(ref.calls.actions.length, 1, "one shot per cast");

  answer = undefined;
  current.events.emit("SPELL_GO", ammoGo(75));
  coordinator.worldChanged(current);
  answer = arrow;
  coordinator.onAmmoModelsLoaded();
  assert.equal(ref.calls.plans.length, 1, "a teleport drops the waiting flight");
});

test("withAmmoMissile and skinAmmoMissiles leave a visual with its own missile alone", () => {
  const both = { ...arcaneShot, ammoMissile: { attachment: 1, speed: 3 } };
  assert.equal(withAmmoMissile(both, arrow), both);
  const plan = { instances: [{ path: "x.m2", flight: {} }], animations: [], sounds: [] };
  assert.equal(skinAmmoMissiles(plan, arrow).instances[0].objectSkin, undefined);
});

// --- the browser client ---------------------------------------------------------------------------

test("AmmoModelClient: one batch per turn, null for a display that flies nothing, nothing after a 404", async () => {
  const original = globalThis.fetch;
  const urls = [];
  let status = 200;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { status, ok: status === 200, json: async () => [arrow, { displayId: 26499, inventoryType: 24, model: "", texture: "" }] };
  };
  try {
    const client = new AmmoModelClient("ws://127.0.0.1:8090/ws");
    const loaded = [];
    client.onLoaded = (models) => loaded.push(models.length);
    assert.equal(client.model({ displayId: 5996, inventoryType: 24 }), undefined);
    assert.equal(client.model({ displayId: 26499, inventoryType: 24 }), undefined);
    assert.equal(client.model({ displayId: 5996, inventoryType: 24 }), undefined, "asked once");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(urls.length, 1);
    assert.equal(urls[0], "http://127.0.0.1:8090/dbc/ammo-models?v=1&items=5996:24,26499:24");
    assert.deepEqual(loaded, [1]);
    assert.deepEqual(client.model({ displayId: 5996, inventoryType: 24 }), arrow);
    assert.equal(client.model({ displayId: 26499, inventoryType: 24 }), null);

    status = 404;
    const old = new AmmoModelClient("ws://127.0.0.1:8090/ws");
    old.model({ displayId: 5998, inventoryType: 24 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(old.model({ displayId: 5998, inventoryType: 24 }), null, "a gateway without the route");
    assert.equal(urls.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

// --- the gateway, against the dataset -------------------------------------------------------------

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
let displayFile;
try {
  displayFile = dbcDirectory ? await readFile(join(dbcDirectory, "ItemDisplayInfo.dbc")) : undefined;
} catch {
  displayFile = undefined;
}
const withDataset = { skip: displayFile ? false : "no ItemDisplayInfo.dbc in the tswow dataset on this machine" };

test("parseAmmoItems: display:inventoryType pairs only", () => {
  assert.deepEqual(parseAmmoItems("5996:24,5998:24,5996:24"), [[5996, 24], [5998, 24]]);
  for (const bad of [null, "", "5996", "0:24", "a:1", "5996:24;1", Array(65).fill("1:24").map((v, i) => `${i + 1}:24`).join(",")]) {
    assert.equal(parseAmmoItems(bad), undefined, String(bad).slice(0, 20));
  }
});

test("dataset: 5996 is an arrow and 5998 a bullet under Item\\ObjectComponents\\Ammo, by 0x004eab50's rule", withDataset, async () => {
  const { openDbc } = await import("../dist/code/gateway/Dbc.js");
  const displays = openDbc(displayFile, "ItemDisplayInfo");
  assert.deepEqual(ammoModelFor(displays, 5996, 24), { displayId: 5996, inventoryType: 24,
    model: "Item\\ObjectComponents\\Ammo\\ArrowFlight_01.m2", texture: "Item\\ObjectComponents\\Ammo\\Arrow_A_01Brown.blp" });
  assert.deepEqual(ammoModelFor(displays, 5998, 24), { displayId: 5998, inventoryType: 24,
    model: "Item\\ObjectComponents\\Ammo\\BulletFlight_01.m2", texture: "Item\\ObjectComponents\\Ammo\\bullet.blp" });
  assert.equal(ammoModelFor(displays, 16751, 25).model, "Item\\ObjectComponents\\Weapon\\Thrown_1H_Axe_A_01.m2",
    "a thrown weapon flies itself, from Weapon\\");
  assert.equal(ammoModelFor(displays, 26499, 24).model, "", "no second texture: 0x004eab50 draws nothing");
  assert.equal(ammoModelFor(displays, 5996, 26).model, "", "only ammo and thrown weapons");
  assert.equal(ammoModelFor(displays, 1, 24).model, "");
});

test("dataset: the gateway marks the ammo missiles — Auto Shot's, and MissileModel 0 — not Arcane Shot's", withDataset, async () => {
  const { parseSpellVisuals } = await import("../dist/code/gateway/SpellVisual.js");
  const read = (name) => readFile(join(dbcDirectory, name));
  const visuals = parseSpellVisuals(await read("Spell.dbc"), await read("SpellVisual.dbc"), await read("SpellVisualKit.dbc"),
    await read("SpellVisualEffectName.dbc"));
  assert.deepEqual(visuals.get(75).ammoMissile, { attachment: 22, speed: 40 }, "Auto Shot: no SpellVisualID, Spell.Speed 40");
  assert.equal(visuals.get(75).autoRepeat, true);
  assert.equal(visuals.get(3044).ammoMissile, undefined, "Arcane Shot flies ArcaneShot_Missile");
  assert.ok(visuals.get(3044).missile);
  const zeroModel = [...visuals.values()].filter((visual) => visual.ammoMissile && visual.id !== 75);
  assert.ok(zeroModel.length > 40, `ammo missiles: ${zeroModel.length}`);
  assert.ok(visuals.get(6603)?.ammoMissile === undefined, "the melee Attack is no ranged shot");
});

test("wiring: the page hands the coordinator its ammo client, and the renderer skins an ammo missile", async () => {
  const enter = await readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  assert.match(enter, /const ammoModels = new AmmoModelClient\(gatewayInput\.value\);/);
  assert.match(enter, /\n\s+ammoModels, \/\/ 29\.10\n/);
  assert.match(enter, /ammoModels\.onLoaded = \(models\) => \{ \/\/ 29\.10\n\s+spellVisualCoordinator\.onAmmoModelsLoaded\(\);/);
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /\.\.\.\(instance\.objectSkin \? \{ slots: new Map\(\[\[TEXTURE_TYPE_OBJECT_SKIN, instance\.objectSkin\]\]\) \} : \{\}\),/);
  const gateway = await readFile(new URL("../src/gateway/Gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /if \(await serveAmmoModelsRoute\(request, response, url, indexes\.catalogs \?\?= new Map\(\), options\)\) return;/);
});

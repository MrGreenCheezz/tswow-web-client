import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { PacketReader } from "../dist/code/protocol/PacketReader.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { buildCastSpell, TARGET_FLAG_DEST_LOCATION } from "../dist/code/world/SpellProtocol.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import {
  GROUND_TARGET_MODE, groundPointInRange, isGroundTargetSpell, rayGroundPoint, screenGroundPoint,
  screenRay, spellEffectRadius,
} from "../dist/code/browser/game/GroundTarget.js";
import {
  gameObjectPlacementEntry, gameObjectPreviewModel, previewableGameObjectType,
} from "../dist/code/browser/game/GameObjectPreview.js";

test("the browser ground contract mirrors the gateway targeting contract", async () => {
  const gateway = await readFile(new URL("../src/gateway/SpellMetadata.ts", import.meta.url), "utf8");
  assert.match(gateway, /Ground:\s*3/, "SPELL_REQUIRED_TARGET_MODE.Ground pins the browser constant");
  assert.match(gateway, /Ground:\s*4/, "SPELL_REQUIRED_TARGET_MASK.Ground pins the ground flow");
  assert.equal(GROUND_TARGET_MODE, 3);
  assert.equal(isGroundTargetSpell({ requiredTargetMode: 3 }), true);
  assert.equal(isGroundTargetSpell({ requiredTargetMode: 1 }), false);
  assert.equal(isGroundTargetSpell({ requiredTargetMode: 0 }), false);
  assert.equal(isGroundTargetSpell(undefined), false);
});

test("a centred pixel looks straight ahead, and corners lean on the focal length", () => {
  const camera = {
    position: { x: 0, y: 0, z: 10 },
    forward: { x: 1, y: 0, z: 0 },
    right: { x: 0, y: -1, z: 0 },
    up: { x: 0, y: 0, z: 1 },
  };
  const ahead = screenRay(camera, 800, 600, 400, 300);
  assert.deepEqual(ahead.origin, camera.position);
  assert.ok(Math.abs(ahead.direction.x - 1) < 1e-9);
  assert.ok(Math.abs(ahead.direction.y) < 1e-9 && Math.abs(ahead.direction.z) < 1e-9);
  const right = screenRay(camera, 800, 600, 800, 300);
  assert.ok(right.direction.y < 0, "the right edge leans along +right");
  assert.ok(Math.abs(Math.hypot(right.direction.x, right.direction.y, right.direction.z) - 1) < 1e-9);
});

test("a descending ray lands on flat ground, sky and gaps miss", () => {
  const origin = { x: 0, y: 0, z: 10 };
  const down = { x: 0.5, y: 0, z: -0.5 };
  const length = Math.hypot(down.x, down.y, down.z);
  const direction = { x: down.x / length, y: down.y / length, z: down.z / length };
  const flat = () => 0;
  const landing = rayGroundPoint(origin, direction, 100, (x, y) => flat(x, y));
  assert.ok(landing);
  assert.ok(Math.abs(landing.z) < 1e-6);
  assert.ok(Math.abs(landing.x - 10) < 0.6, "a 45-degree descent lands one height out");
  const sky = rayGroundPoint(origin, { x: 0, y: 0, z: 1 }, 100, flat);
  assert.equal(sky, undefined);
  const gap = rayGroundPoint(origin, direction, 100, () => undefined);
  assert.equal(gap, undefined, "unloaded columns are stepped over, never treated as sea level");
  assert.equal(rayGroundPoint(origin, direction, 0, flat), undefined);
});

test("a higher floor wins over terrain inside one column", () => {
  const origin = { x: 0, y: 0, z: 10 };
  const direction = { x: 0, y: 0, z: -1 };
  const landing = rayGroundPoint(origin, direction, 100, (x, y, refZ) => {
    assert.ok(Number.isFinite(refZ), "the column query carries its reference height");
    return Math.max(-5, 2);
  });
  assert.ok(landing);
  assert.equal(landing.z, 2);
});

function groundInputs(overrides = {}) {
  return {
    player: { x: 0, y: 0, z: 0, orientation: 0 },
    yaw: 0,
    viewPitch: -Math.atan2(11, 25),
    view: 21.31,
    pivotHeight: 1.6,
    canvasWidth: 1920,
    canvasHeight: 1080,
    pixelX: 960,
    pixelY: 540,
    targetRange: 5,
    ...overrides,
  };
}

test("short-range ground targets remain reachable from a distant camera", () => {
  const landing = screenGroundPoint(groundInputs({ view: 55, heightAt: () => 0 }));
  assert.ok(landing, "the ray reach includes the camera arm before applying the caster's range");
  assert.ok(Math.abs(landing.z) < 1e-6);
  assert.ok(Math.abs(landing.x - 3.64) < 0.1);
});

test("ground targeting uses collision floors below hidden terrain and in terrain holes", () => {
  const cave = screenGroundPoint(groundInputs({
    targetRange: 30,
    heightAt: () => 20,
    floorUnder: () => 0,
  }));
  assert.ok(cave);
  assert.equal(cave.z, 0, "ADT above a cave must not replace its collision floor");

  const hole = screenGroundPoint(groundInputs({
    targetRange: 30,
    heightAt: () => 0,
    isHole: (x) => x > 1,
    floorUnder: () => -5,
  }));
  assert.ok(hole);
  assert.equal(hole.z, -5, "an authored terrain hole exposes the collision floor below it");
});

test("the reticle radius is the spell's own EffectRadius, never a guessed size", () => {
  assert.equal(spellEffectRadius(undefined), 0);
  assert.equal(spellEffectRadius({}), 0);
  assert.equal(spellEffectRadius({ effectRadius: [0, 0, 0] }), 0);
  assert.equal(spellEffectRadius({ effectRadius: [8, 0, 3] }), 8, "the widest effect wins");
  assert.equal(spellEffectRadius({ effectRadius: [Number.NaN, Number.POSITIVE_INFINITY] }), 0,
    "a malformed radius draws no ring at all rather than a huge one");
  assert.equal(spellEffectRadius({ effectRadius: [50_000] }), 0,
    "the unlimited sentinel is a range, not a radius to draw");
});

test("the reticle's range rule is the click's, tolerance included", () => {
  const player = { x: 0, y: 0 };
  assert.equal(groundPointInRange({ x: 30, y: 0 }, player, 30), true);
  assert.equal(groundPointInRange({ x: 32, y: 0 }, player, 30), true, "the two-yard tolerance holds");
  assert.equal(groundPointInRange({ x: 33, y: 0 }, player, 30), false);
  assert.equal(groundPointInRange({ x: 500, y: 0 }, player, undefined), true,
    "an unlimited range always fits");
});

test("only a template-owned model from a placement effect becomes a ghost", () => {
  const spell = (effects, effectMiscValue) => ({ effects, effectMiscValue });
  assert.equal(gameObjectPlacementEntry(undefined), undefined);
  assert.equal(gameObjectPlacementEntry(spell([50, 0, 0], [123, 0, 0])), 123, "Transmitted");
  assert.equal(gameObjectPlacementEntry(spell([6, 76, 0], [999, 42, 0])), 42, "the effect slot decides");
  // 77 SCRIPT_EFFECT, 61 SEND_EVENT, 3 DUMMY and 28 SUMMON key on the spell id or a creature;
  // their misc value is not a game object entry and must never be drawn as one.
  assert.equal(gameObjectPlacementEntry(spell([77, 0, 0], [123, 0, 0])), undefined);
  assert.equal(gameObjectPlacementEntry(spell([61, 0, 0], [123, 0, 0])), undefined);
  assert.equal(gameObjectPlacementEntry(spell([3, 0, 0], [123, 0, 0])), undefined);
  assert.equal(gameObjectPlacementEntry(spell([28, 0, 0], [123, 0, 0])), undefined);
  assert.equal(gameObjectPlacementEntry(spell([50, 0, 0], [0, 0, 0])), undefined);
  assert.equal(gameObjectPlacementEntry(spell([50, 0, 0], [-5, 0, 0])), undefined);

  const entry = (type, displayId, size = 1) => ({
    entry: 123, type, displayId, name: "", iconName: "", castBarCaption: "", data: [], size,
  });
  assert.equal(previewableGameObjectType(5), true);
  assert.equal(previewableGameObjectType(15), false, "a transport is drawn from its path");
  assert.equal(previewableGameObjectType(17), false, "a fishing node is the client's own bobber");
  assert.equal(previewableGameObjectType(33), false, "a destructible building swaps models on damage");
  assert.equal(previewableGameObjectType(0), false);
  assert.equal(previewableGameObjectType(36), false);

  assert.deepEqual(gameObjectPreviewModel(123, entry(5, 8, 1.5), "World\\Chest.m2"),
    { entry: 123, displayId: 8, model: "World\\Chest.m2", scale: 1.5 });
  assert.equal(gameObjectPreviewModel(123, entry(5, 8, Number.NaN), "Chest.m2").scale, 1,
    "a missing size falls back to the wire's own default");
  assert.equal(gameObjectPreviewModel(123, entry(5, 0), "Chest.m2"), undefined);
  assert.equal(gameObjectPreviewModel(123, entry(5, 8), "Buildings\\House.wmo"), undefined,
    "a building-shaped preview is a room query the point has not committed to");
  assert.equal(gameObjectPreviewModel(123, entry(15, 8), "Boat.m2"), undefined);
  assert.equal(gameObjectPreviewModel(123, undefined, "Chest.m2"), undefined,
    "a template that is still on the wire shows nothing yet");
});

test("the reticle wiring pushes rings and the placing ghost from the frame loop", async () => {
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /setGroundTargetPreview\(preview/);
  assert.match(renderer, /setGameObjectPreview\(preview/);
  assert.match(renderer, /#updateGameObjectPreview\(environmentClient\)/,
    "the ghost is placed after the model passes that stock its caches");
  const host = await readFile(new URL("../src/browser/LiveFormalRenderBenchmarkHost.ts", import.meta.url), "utf8");
  assert.match(host, /"setGroundTargetPreview", "setGameObjectPreview"/,
    "a formal run intercepts both new renderer mutators");
  const loop = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  assert.match(loop, /updateGroundTargetPreview\(\)/,
    "the loop resolves the reticle after the camera has advanced for the frame");
  const controls = await readFile(new URL("../src/browser/input/Controls.ts", import.meta.url), "utf8");
  assert.match(controls, /recordGroundTargetPointer\(/,
    "the pointer path feeds the preview its position");
  const preview = await readFile(new URL("../src/browser/game/GroundTargetPreview.ts", import.meta.url), "utf8");
  assert.match(preview, /spellEffectRadius\(metadata\)/,
    "the radius ring takes the DBC radius, not one invented in the renderer");
});

function connection() {
  const packets = []; let wake;
  return {
    sent: [],
    push(opcode, payload) { if (wake) { const resume = wake; wake = undefined; resume({ opcode, payload }); }
      else packets.push({ opcode, payload }); },
    read() { return packets.length ? Promise.resolve(packets.shift()) : new Promise((resolve) => { wake = resolve; }); },
    send(opcode, payload) { this.sent.push({ opcode, payload }); }, close() {},
  };
}
async function settle() { for (let i = 0; i < 6; i++) await new Promise(setImmediate); }

test("castSpellAt sends the explicit destination the reticle resolved", async () => {
  const transport = connection();
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(transport);
  try {
    await world.loginCharacter(1n); await settle(); transport.sent.length = 0;
    world.state.selfGuid = 1n;
    world.knownSpells = [{ id: 133 }];
    world.castSpellAt(133, { x: 1, y: 2, z: 3 });
    assert.deepEqual(transport.sent.at(-1), {
      opcode: OPCODES.CMSG_CAST_SPELL, payload: buildCastSpell(133, 1, { x: 1, y: 2, z: 3 }),
    });
    const before = transport.sent.length;
    world.castSpellAt(133, { x: NaN, y: 2, z: 3 });
    assert.equal(transport.sent.length, before, "a non-finite point never reaches the wire");
    world.castSpellAt(999, { x: 1, y: 2, z: 3 });
    assert.equal(transport.sent.length, before, "unknown spells stay gated exactly like castSpell");
  } finally { world.close(); }
});

test("casts while riding send world destinations in world coordinates", async () => {
  const transport = connection();
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(transport);
  try {
    await world.loginCharacter(1n); await settle(); transport.sent.length = 0;
    world.state.selfGuid = 1n;
    world.knownSpells = [{ id: 133 }];
    world.state.move(1n, {
      flags: 0,
      position: { x: 100, y: 200, z: 30, orientation: 0 },
      transport: { guid: 11n, x: 2, y: 3, z: 4, orientation: 0, time: 0, seat: 0 },
    });
    for (const [send, expected] of [
      [() => world.castSpellAt(133, { x: 101, y: 202, z: 30 }), [101, 202, 30]],
      [() => world.castSpell(133), [100, 200, 30]],
    ]) {
      send();
      const packet = transport.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_CAST_SPELL).at(-1)?.payload;
      assert.ok(packet);
      const reader = new PacketReader(packet);
      reader.u8(); reader.u32(); reader.u8();
      assert.equal(reader.u32(), TARGET_FLAG_DEST_LOCATION);
      assert.equal(reader.packedGuid(), 0n,
        "TrinityCore interprets a nonzero transport GUID's floats as local offsets");
      assert.deepEqual([reader.f32(), reader.f32(), reader.f32()], expected);
      reader.assertFinished();
    }
  } finally { world.close(); }
});

test("ground spells arm the reticle, clicks resolve it, Esc and right-click release it", async () => {
  const controls = await readFile(new URL("../src/browser/input/Controls.ts", import.meta.url), "utf8");
  assert.match(controls, /pendingGroundTarget\(\)/,
    "the pointer path must yield to an armed reticle");
  assert.match(controls, /pendingGroundTargetItem\(\)/,
    "the click resolves into an item use when the reticle belongs to one");
  assert.match(controls, /world\.useItemAt\(item\.bag, item\.slot, item\.guid, point\)/,
    "an item reticle sends the landing point instead of a bare use");
  assert.match(controls, /Не удалось выбрать точку/,
    "a click that resolves nowhere says so instead of dying silently");
  assert.match(controls, /confirmGroundTargetAt\(event, world, pendingSpell\)/,
    "a clean left click resolves the landing point");
  assert.match(controls, /releasedRight && clicked\(2\)\) \{\s*\n?\s*cancelGroundTarget\(\)/,
    "a right click cancels targeting instead of interacting");
  const book = await readFile(new URL("../src/browser/ui/Spellbook.ts", import.meta.url), "utf8");
  assert.match(book, /isGroundTargetSpell\(metadata\)/,
    "the book arms the reticle only through the targeting contract, never an id list");
  const ground = await readFile(new URL("../src/browser/game/GroundTarget.ts", import.meta.url), "utf8");
  assert.match(ground, /export function requestSpellCast/,
    "direct casts share one routing helper");
  for (const path of [
    "../src/browser/ui/CharacterSheet.ts",
    "../src/browser/ui/Tracking.ts",
    "../src/browser/ui/Talents.ts",
    "../src/browser/ui/WindowActions.ts",
    "../src/browser/ui/Professions.ts",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /requestSpellCast\(/,
      `${path} must route its cast through the reticle check`);
  }
  for (const path of [
    "../src/browser/ui/ActionBar.ts",
    "../src/browser/ui/CombatCommands.ts",
    "../src/browser/ui/ItemSlots.ts",
    "../src/browser/framexml/LiveWorldSeam.ts",
    "../src/browser/ui/WindowActions.ts",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /requestInventoryItemUse\(/,
      `${path} must route its item use through the reticle check`);
  }
});

test("item uses arm the reticle only when the item's own spell needs ground", async () => {
  const ground = await import("../dist/code/browser/game/GroundTarget.js");
  const { game } = await import("../dist/code/browser/game/Context.js");
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const entryOffset = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;
  const fakeItem = (entry) => ({ fields: new Map([[entryOffset, entry]]) });
  const templates = new Map([
    [1001, { spells: [{ spellId: 133, trigger: 0, charges: 0, cooldown: 0, category: 0, categoryCooldown: 0 }] }],
    [1002, { spells: [{ spellId: 134, trigger: 1, charges: 0, cooldown: 0, category: 0, categoryCooldown: 0 }] }],
    [1003, { spells: [] }],
  ]);
  const spells = new Map([
    [133, { requiredTargetMode: 3 }],
    [134, { requiredTargetMode: 1 }],
  ]);
  game.world = { itemTemplates: new Map(), onSpellStatus: () => {} };
  try {
    assert.equal(ground.itemUseSpellId(undefined), undefined);
    assert.equal(ground.itemUseSpellId({ spells: [] }), undefined);
    assert.equal(ground.itemUseSpellId(templates.get(1001)), 133);
    assert.equal(ground.itemUseSpellId(templates.get(1002)), undefined,
      "an equip trigger is not a use");
    // A ground item arms spell 133 and parks its bag/slot/guid beside the reticle.
    let sent = 0;
    ground.requestItemUse({ bag: 23, slot: 4, guid: 0x1234n, entry: 1001 },
      () => { sent++; }, templates, spells);
    assert.equal(sent, 0);
    assert.equal(ground.pendingGroundTarget(), 133);
    assert.deepEqual(ground.pendingGroundTargetItem(), { bag: 23, slot: 4, guid: 0x1234n });
    ground.cancelGroundTarget();
    assert.equal(ground.pendingGroundTarget(), undefined);
    assert.equal(ground.pendingGroundTargetItem(), undefined);
    // A unit-target item spell and an unknown template go straight through.
    ground.requestItemUse({ bag: 23, slot: 4, guid: 0x1234n, entry: 1002 },
      () => { sent++; }, templates, spells);
    assert.equal(sent, 1);
    assert.equal(ground.pendingGroundTarget(), undefined);
    ground.requestItemUse({ bag: 23, slot: 4, guid: 0x1234n, entry: 9999 },
      () => { sent++; }, templates, spells);
    assert.equal(sent, 2, "a template that has not arrived yet fails open to a plain use");
    // The slot helper reads the entry off the standing item.
    ground.requestInventoryItemUse(
      { bag: 23, slot: 4, guid: 0x1234n, item: fakeItem(1001) }, () => { sent++; });
    assert.equal(sent, 3, "the live session cache has no template, so this fails open too");
    assert.equal(ground.pendingGroundTarget(), undefined);
    // Arming a spell reticle drops a previous item reticle: the click below must not
    // inherit another item's bag and slot.
    ground.requestItemUse({ bag: 23, slot: 4, guid: 0x1234n, entry: 1001 },
      () => { sent++; }, templates, spells);
    assert.deepEqual(ground.pendingGroundTargetItem(), { bag: 23, slot: 4, guid: 0x1234n });
    assert.equal(ground.beginGroundTarget(133), true);
    assert.equal(ground.pendingGroundTarget(), 133);
    assert.equal(ground.pendingGroundTargetItem(), undefined);
    ground.cancelGroundTarget();
  } finally {
    game.world = undefined;
    ground.cancelGroundTarget();
  }
});

test("useItemAt sends the explicit destination the item reticle resolved", async () => {
  const { buildUseItem } = await import("../dist/code/world/ItemProtocol.js");
  const transport = connection();
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(transport);
  try {
    await world.loginCharacter(1n); await settle(); transport.sent.length = 0;
    world.state.selfGuid = 1n;
    world.useItemAt(23, 4, 0x1234n, { x: 1, y: 2, z: 3 });
    assert.deepEqual(transport.sent.at(-1), {
      opcode: OPCODES.CMSG_USE_ITEM,
      payload: buildUseItem(23, 4, 1, 0, 0x1234n, { x: 1, y: 2, z: 3 }),
    });
    const before = transport.sent.length;
    world.useItemAt(23, 4, 0x1234n, { x: NaN, y: 2, z: 3 });
    assert.equal(transport.sent.length, before, "a non-finite point never reaches the wire");
  } finally { world.close(); }
});

test("buildUseItem keeps the legacy no-target shape and appends a dest tail", async () => {
  const { buildUseItem } = await import("../dist/code/world/ItemProtocol.js");
  const plain = buildUseItem(23, 4, 7, 0, 0x1234n);
  // Bag, slot, count, spell, guid, glyph, flags, empty mask — the shape bandages always used.
  assert.deepEqual([...plain], [23, 4, 7, 0, 0, 0, 0, 0x34, 0x12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const aimed = buildUseItem(23, 4, 7, 0, 0x1234n, { x: 1, y: 2, z: 3 });
  assert.deepEqual([...aimed.slice(0, 20)], [...plain.slice(0, 20)], "the head is untouched");
  // Mask DEST_LOCATION, packed zero transport guid, three floats — the cast tail.
  assert.equal(new DataView(aimed.buffer, aimed.byteOffset + 20, 4).getUint32(0, true), 0x40);
  assert.equal(aimed[24], 0, "zero transport guid packs to one zero byte");
  const view = new DataView(aimed.buffer, aimed.byteOffset + 25, 12);
  assert.equal(view.getFloat32(0, true), 1);
  assert.equal(view.getFloat32(4, true), 2);
  assert.equal(view.getFloat32(8, true), 3);
});

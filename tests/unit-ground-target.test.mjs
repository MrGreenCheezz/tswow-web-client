// 11.02 (26.10): the reticle for a steered unit's ground spells — a catapult's boulder, a siege engine's area spell.
// The page arms it for that unit when the spell's targeting contract says ground (fetching the row once when it is
// not in), and the click sends CMSG_PET_CAST_SPELL from the unit, ranged from the unit.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import { GROUND_TARGET_MODE, cancelGroundTarget, pendingGroundTarget, pendingGroundTargetCaster } from "../dist/code/browser/game/GroundTarget.js";
import { installUnitGroundTarget } from "../dist/code/browser/game/UnitGroundTarget.js";
import { cancelItemTarget, pendingItemTarget, targetGameObjectWithCursor, targetItemWithCursor } from "../dist/code/browser/game/SpellCursor.js";

const VEHICLE = 0xf150_7d9a_0000_0042n;
const BOULDER = 54158;
const RAM = 54159;

function setup(rows, loader) {
  const saved = { world: game.world, client: game.spellMetadataClient, spells: new Map(game.spells) };
  const statuses = [];
  const world = { onSpellStatus: (text) => statuses.push(text) };
  game.world = world;
  game.spells.clear();
  for (const [id, row] of rows) game.spells.set(id, row);
  game.spellMetadataClient = loader;
  installUnitGroundTarget(world);
  return {
    world, statuses,
    restore() {
      cancelGroundTarget();
      game.world = saved.world;
      game.spellMetadataClient = saved.client;
      game.spells.clear();
      for (const [id, row] of saved.spells) game.spells.set(id, row);
    },
  };
}

test("a ground spell of the steered unit arms the reticle for that unit; any other spell is not taken", () => {
  const { world, statuses, restore } = setup([[BOULDER, { requiredTargetMode: GROUND_TARGET_MODE }], [RAM, { requiredTargetMode: 1 }]]);
  try {
    let sent = 0;
    assert.equal(world.armUnitGroundTarget(VEHICLE, RAM, () => sent++), false, "a unit spell goes out at once");
    assert.equal(pendingGroundTarget(), undefined);
    assert.equal(world.armUnitGroundTarget(VEHICLE, BOULDER, () => sent++), true);
    assert.equal(pendingGroundTarget(), BOULDER);
    assert.equal(pendingGroundTargetCaster(), VEHICLE, "the click casts for the vehicle");
    assert.equal(sent, 0);
    assert.match(statuses.at(-1), /Кликните по земле/);
    cancelGroundTarget();
    assert.equal(pendingGroundTargetCaster(), undefined, "cleared with the arming");
  } finally {
    restore();
  }
});

test("2.05: a steered unit's spell that waits for an item raises the item cursor, and the pick goes out from the unit", () => {
  const PICK = 54160;
  const { world, restore } = setup([[PICK, { itemOrObject: true }]]);
  const casts = [];
  world.castUnitSpellOnTarget = (...args) => { casts.push(args); return true; };
  world.state = { objects: new Map([[77n, { guid: 77n, typeId: 5, fields: new Map() }], [55n, { guid: 55n, typeId: 1, fields: new Map() }]]) };
  world.castSpellOnItem = () => assert.fail("not as the character");
  world.castSpellOnGameObject = () => assert.fail("not as the character");
  try {
    let sent = 0;
    assert.equal(world.armUnitGroundTarget(VEHICLE, PICK, () => sent++), true);
    assert.equal(sent, 0);
    assert.equal(pendingGroundTarget(), undefined, "not the ground reticle");
    assert.equal(pendingItemTarget(world).caster, VEHICLE);
    assert.equal(targetItemWithCursor(world.state.objects.get(55n), 55n, world, () => undefined).kind, "sent");
    assert.equal(pendingItemTarget(world), undefined, "the pick takes the cursor down");

    assert.equal(world.armUnitGroundTarget(VEHICLE, PICK, () => sent++), true);
    assert.equal(targetGameObjectWithCursor(77n, world, () => undefined).kind, "sent");
    assert.deepEqual(casts, [[VEHICLE, PICK, { item: 55n }], [VEHICLE, PICK, { gameObject: 77n }]]);
  } finally {
    cancelItemTarget();
    restore();
  }
});

test("a spell whose row is not in is fetched once and decided when it comes (failing open to the plain cast)", async () => {
  const asked = [];
  const loader = { load: async (ids) => { asked.push(...ids); return new Map(ids.map((id) => [id, { requiredTargetMode: id === BOULDER ? GROUND_TARGET_MODE : 1 }])); } };
  const { world, restore } = setup([], loader);
  try {
    let sent = 0;
    assert.equal(world.armUnitGroundTarget(VEHICLE, RAM, () => sent++), true, "taken while its row is fetched");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent, 1, "no ground spell: it goes out the usual way");
    assert.equal(world.armUnitGroundTarget(VEHICLE, BOULDER, () => sent++), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent, 1);
    assert.equal(pendingGroundTargetCaster(), VEHICLE, "a ground spell arms once its row is in");
    assert.deepEqual(asked, [RAM, BOULDER]);
  } finally {
    restore();
  }
});

test("the click: ranged from the caster unit, sent from it (Controls.ts); the world gets the hook at entry", async () => {
  const controls = await readFile(new URL("../src/browser/input/Controls.ts", import.meta.url), "utf8");
  assert.match(controls, /const casterGuid = caster \?\? world\.state\.selfGuid;/);
  assert.match(controls, /if \(caster !== undefined\) \{\s+world\.castUnitSpellAt\(caster, spellId, point\);/);
  const enter = await readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  assert.match(enter, /installUnitGroundTarget\(world\);/);
});

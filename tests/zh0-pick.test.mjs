import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import {
  UNIT_FLAG_NON_ATTACKABLE, UNIT_FLAG_UNINTERACTIBLE, UNIT_FLAGS_UNCLICKABLE, UNIT_FLAGS_UNTARGETABLE,
} from "../dist/code/world/FactionRules.js";
import { GO_FLAG_NOT_SELECTABLE } from "../dist/code/world/GameObjectProtocol.js";
import {
  CAMERA_DEFAULT_DISTANCE, CAMERA_FIRST_PERSON_DISTANCE, SimpleScene, createCamera, projectPoint,
} from "../dist/code/browser/SimpleScene.js";

const WIDTH = 1280;
const HEIGHT = 720;
/** The height every unit in these frames is told to be, so the boxes can be worked out here too. */
const BODY = 2;

/** A canvas that measures instead of painting: `draw` fills the hit list on its way through. */
function frame(objects, { selfGuid = 1n, distance = undefined, anchor = undefined } = {}) {
  const context = new Proxy({
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: (text) => ({ width: text.length * 6 }),
  }, { get: (target, property) => target[property] ?? (() => {}) });
  const canvas = {
    width: 0, height: 0,
    getContext: () => context,
    getBoundingClientRect: () => ({ width: WIDTH, height: HEIGHT }),
  };
  const previous = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    // `drawWorld` false is the mode with WebGL alive, which is the one being played.
    const scene = new SimpleScene(canvas, false);
    scene.draw({ selfGuid, objects: new Map(objects.map((object) => [object.guid, object])) },
      () => 0, undefined, [], undefined, 0, undefined, distance, () => BODY, () => undefined, anchor);
    return scene;
  } finally {
    globalThis.window = previous;
  }
}

/** Text painted by one overlay frame, used to tell a player-facing label from a hit-only pass. */
function labelsInFrame(objects, drawWorld, unitHeight = () => BODY) {
  const labels = [];
  const context = new Proxy({
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: (text) => ({ width: text.length * 6 }),
    fillText: (text) => labels.push(text),
  }, { get: (target, property) => target[property] ?? (() => {}) });
  const canvas = {
    width: 0, height: 0,
    getContext: () => context,
    getBoundingClientRect: () => ({ width: WIDTH, height: HEIGHT }),
  };
  const previous = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    const scene = new SimpleScene(canvas, drawWorld);
    scene.draw({ selfGuid: 1n, objects: new Map(objects.map((object) => [object.guid, object])) },
      () => 0, undefined, [], undefined, 0, undefined, undefined, unitHeight, () => undefined);
    return labels;
  } finally {
    globalThis.window = previous;
  }
}

function unit(guid, { x = 0, y = 0, typeId = 3, flags = undefined, health = 100 } = {}) {
  const fields = new Map([
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health],
    [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 100],
    [UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, 49],
  ]);
  if (flags !== undefined) fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, flags);
  return { guid, typeId, position: { x, y, z: 0, orientation: 0 }, fields };
}

/**
 * The box `#pushUnitHit` lays down for a living unit with WebGL running, worked out from the same
 * two projected points the scene works it out from. Repeated here rather than reached into,
 * because what is being tested is which box wins, not how wide it is.
 */
function boxOf(position, distance = undefined) {
  const camera = createCamera({ x: 0, y: 0, z: 0, orientation: 0 }, 0, undefined, distance);
  const feet = projectPoint(position, camera, WIDTH, HEIGHT);
  const top = projectPoint({ ...position, z: position.z + BODY }, camera, WIDTH, HEIGHT);
  assert.ok(feet && top, "the unit has to be on screen for any of this to mean anything");
  const bodyHeight = Math.max(4, feet.y - top.y);
  const width = Math.max(20, bodyHeight * 0.55);
  return { x: feet.x - width / 2, y: top.y - 2, width, height: feet.y - top.y + 6 };
}

const inside = (box) => [box.x + box.width / 2, box.y + box.height / 2];
/** Six pixels off the left edge: outside the box, well inside the 12px slop. */
const nearMiss = (box) => [box.x - 6, box.y + box.height / 2];

test("Ж0.1 the player's own body is a click target, except from inside its own head", () => {
  const self = unit(1n, { typeId: 4 });
  const scene = frame([self]);
  assert.equal(scene.pick(...inside(boxOf(self.position))), 1n,
    "a click on one's own body has to select oneself: nothing else in the client can");

  // In first person the camera sits inside the character. Its box would cover the middle of the
  // screen with nothing under it, so the whole object leaves the frame — plate, body and box.
  const firstPerson = frame([self], { distance: CAMERA_FIRST_PERSON_DISTANCE });
  for (let x = 0; x < WIDTH; x += 17) {
    for (let y = 0; y < HEIGHT; y += 17) assert.equal(firstPerson.pick(x, y), undefined);
  }
});

test("Н3 one's own body stays clickable through the tightest squeeze a wall can make", () => {
  // «I cannot select myself indoors» is the report this exists for, and the arithmetic that used
  // to cause it is gone rather than patched: with the camera hung on the character there is no
  // look-ahead left to run past them. This drives the real `SimpleScene.draw` down the whole range
  // a squeeze can reach — `CAMERA_MIN_WALL_DISTANCE` floors it at 0.75 — with the anchor held at
  // what the wheel asked for, which is what tells a squeeze apart from first person.
  //
  // The pre-P2 camera fails it from a view of 5 downwards: the aim point stayed seven yards in
  // front of the character, the camera crossed in front of them at +2.42, and `projectPoint`
  // answered nothing for a body behind the lens — no box, no click, no self-cast.
  const self = unit(1n, { typeId: 4 });
  for (const view of [CAMERA_DEFAULT_DISTANCE, 8, 7, 5, 3, 1.5, 0.75]) {
    const scene = frame([self], { distance: view, anchor: CAMERA_DEFAULT_DISTANCE });
    assert.equal(scene.pick(...inside(boxOf(self.position, view))), 1n,
      `squeezed to ${view} the player can no longer click on themselves`);
  }
  // And the anchor still decides first person, not the granted view: squeezed to 0.75 the body is
  // a click target, asked for at zero it is not there at all.
  const firstPerson = frame([self], { distance: 0.75, anchor: CAMERA_FIRST_PERSON_DISTANCE });
  for (let x = 0; x < WIDTH; x += 17) {
    for (let y = 0; y < HEIGHT; y += 17) assert.equal(firstPerson.pick(x, y), undefined);
  }
});

test("Ж0.1 one's own box takes an exact click and never wins a near miss", () => {
  // The player stands in the middle of the screen on every frame. If its box joined the forgiving
  // pass, every click that missed a mob by a few pixels would be dragged home — the player would
  // attack themselves out of every near miss, which is worse than not being selectable at all.
  const self = unit(1n, { typeId: 4 });
  const mob = unit(2n, { y: 8 });
  const scene = frame([self, mob]);

  const selfBox = boxOf(self.position);
  const mobBox = boxOf(mob.position);
  assert.ok(mobBox.x + mobBox.width < selfBox.x, "the two bodies must not overlap for this to test anything");

  assert.equal(scene.pick(...inside(selfBox)), 1n);
  assert.equal(scene.pick(...nearMiss(selfBox)), undefined, "six pixels off one's own body is not a hit");
  // And the same six pixels off any other body still is: the slop itself has not been weakened.
  assert.equal(scene.pick(...inside(mobBox)), 2n);
  assert.equal(scene.pick(...nearMiss(mobBox)), 2n);
});

test("Ж0.2 a unit the server marked unselectable is not in the hit list at all", () => {
  // Spell triggers, totem aura anchors and quest bunnies stand invisibly all over a zone. Plates
  // skip them and Tab skips them; only the click walked into them, and with a 12px slop they no
  // longer even had to be under the cursor to take it.
  const trigger = unit(2n, { y: 8, flags: UNIT_FLAG_UNINTERACTIBLE });
  const scene = frame([unit(1n, { typeId: 4 }), trigger]);
  const box = boxOf(trigger.position);
  assert.equal(scene.pick(...inside(box)), undefined);
  assert.equal(scene.pick(...nearMiss(box)), undefined);
});

test("a spell dynamic object is a marker only in the Canvas fallback", () => {
  const self = unit(1n, { typeId: 4 });
  const dynamic = {
    guid: 2n,
    typeId: 6,
    position: { x: 24, y: 8, z: 0, orientation: 0 },
    fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 1234]]),
  };
  assert.deepEqual(labelsInFrame([self, dynamic], false), [],
    "the WebGL overlay must not paint a service-object label through the authored spell");
  assert.ok(labelsInFrame([self, dynamic], true).some((label) => label.includes("Объект 1234")),
    "the Canvas-only fallback keeps its only representation of the dynamic object");

  const corpse = {
    ...dynamic,
    guid: 3n,
    typeId: 7,
    fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 4321]]),
  };
  // 05.10 suite-fix: since 05.10-A7a-G2 (6.05) WebGL draws a corpse as its body or bones
  // (CorpseModel.ts) and reports its height; only a corpse it has not drawn keeps the marker.
  const undrawnCorpse = (guid) => guid === corpse.guid ? undefined : BODY;
  assert.ok(labelsInFrame([self, corpse], false, undrawnCorpse).some((label) => label.includes("Объект 4321")),
    "a Corpse WebGL has not drawn keeps the overlay marker as its only representation");
  assert.equal(labelsInFrame([self, corpse], false).some((label) => label.includes("Объект 4321")), false,
    "a Corpse WebGL draws as its body needs no marker painted through it");
});

test("Ж0.2 the click mask is not Tab's, because 0x02 is the innkeeper", () => {
  // `UNIT_FLAG_NON_ATTACKABLE` — `UNIT_FLAG_SPAWNING` in the core — is worn by vendors, flight
  // masters, quest givers and anything mid-spawn. Tab is right to skip them; a click is not.
  assert.notEqual(UNIT_FLAGS_UNTARGETABLE & UNIT_FLAG_NON_ATTACKABLE, 0, "Tab does skip it");
  assert.equal(UNIT_FLAGS_UNCLICKABLE & UNIT_FLAG_NON_ATTACKABLE, 0, "and the click must not");

  const vendor = unit(2n, { y: 8, flags: UNIT_FLAG_NON_ATTACKABLE });
  const scene = frame([unit(1n, { typeId: 4 }), vendor]);
  assert.equal(scene.pick(...inside(boxOf(vendor.position))), 2n);
});

test("Ж0.2 the forgiving pass resolves a tie the way the strict one does", () => {
  // Two mobs on one spawn point is an ordinary sight — a totem inside its owner, two patrols
  // meeting, a pet standing in its master. Their boxes are then bit-identical, so every point
  // outside is exactly the same distance from both and the tie-break decides the answer on its
  // own. The strict pass scans the list from the front of the scene backwards and takes the
  // first box it lands in; the forgiving pass used `no further than the best so far`, which
  // keeps overwriting on equal distances and so ended on the *last* box it looked at — the
  // opposite end of the same list. The two passes answered different guids for the same pair.
  const stacked = { x: 24, y: 8, z: 0, orientation: 0 };
  const scene = frame([
    unit(1n, { typeId: 4 }),
    { ...unit(2n), position: stacked },
    { ...unit(3n), position: stacked },
  ]);
  const box = boxOf(stacked);
  const strict = scene.pick(...inside(box));
  assert.ok(strict === 2n || strict === 3n);
  assert.equal(scene.pick(...nearMiss(box)), strict,
    "a click beside two stacked bodies has to select the same one a click on them would");
});

test("Ж0.2 an object the server marked unselectable is not a click target either", () => {
  // `gameObjectAction` has always refused `GO_FLAG_NOT_SELECTABLE`, and the hit list never knew.
  // So the empty collision hulls a city is full of could be picked, become the target and wear a
  // selection ring, and then silently refuse every interaction offered to them.
  const object = (guid, flags) => ({
    guid, typeId: 5,
    position: { x: 24, y: 8, z: 0, orientation: 0 },
    fields: new Map([
      [UPDATE_FIELDS.GAMEOBJECT_DISPLAYID.offset, 321],
      [UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 3 << 8],
      [UPDATE_FIELDS.GAMEOBJECT_FLAGS.offset, flags],
    ]),
  });
  const chest = frame([unit(1n, { typeId: 4 }), object(2n, 0)]);
  const hull = frame([unit(1n, { typeId: 4 }), object(2n, GO_FLAG_NOT_SELECTABLE)]);

  let clickable = 0;
  let refused = 0;
  for (let x = 0; x < WIDTH; x += 5) {
    for (let y = 0; y < HEIGHT; y += 5) {
      if (chest.pick(x, y) === 2n) clickable++;
      if (hull.pick(x, y) === 2n) refused++;
    }
  }
  assert.ok(clickable > 0, "a chest is still clickable");
  assert.equal(refused, 0, "and a hull is nowhere on the screen");
});

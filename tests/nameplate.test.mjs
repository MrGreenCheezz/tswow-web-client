import assert from "node:assert/strict";
import test from "node:test";
import {
  PLATE_NAME_HEIGHT, PLATE_RANGE, PLATE_TARGET_SCALE, RANK_BOSS, RANK_ELITE, RANK_NORMAL, RANK_RARE,
  drawLootBag, drawPlate, drawRaidMark, plateColour, plateLayout, plateLevelText, plateRankMark,
  plateVisible, stackPlates,
} from "../dist/code/browser/NamePlate.js";
import {
  SELECTION_RING_RELIEF, SELECTION_RING_SEGMENTS, buildSelectionRingGeometry, buildWorldCamera,
  updateSelectionRing,
} from "../dist/code/browser/WorldRenderer3D.js";
import { HORIZON_RANGE, HORIZON_FAR_PLANE } from "../dist/code/browser/Horizon.js";
import { REACTION_FRIENDLY, REACTION_HOSTILE, REACTION_NEUTRAL } from "../dist/code/world/FactionRules.js";
import { RAID_MARKS } from "../dist/code/browser/ui/UnitSnapshot.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

/** Records everything a plate asks a 2D context to do, so a drawing can be asserted about. */
function recordingContext() {
  const calls = [];
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 0, font: "", textAlign: "", textBaseline: "" };
  const record = (name) => (...args) => {
    calls.push({ name, args, fillStyle: state.fillStyle, strokeStyle: state.strokeStyle, lineWidth: state.lineWidth });
  };
  const context = new Proxy(state, {
    get: (target, property) => property in target ? target[property] : record(property),
    set: (target, property, value) => { target[property] = value; return true; },
  });
  return { context, calls };
}

const plate = (overrides = {}) => ({
  guid: 7n,
  name: "Гоблин-механик",
  level: 12,
  reaction: REACTION_HOSTILE,
  classColour: undefined,
  health: 0.5,
  raidMark: undefined,
  questMark: undefined,
  rank: RANK_NORMAL,
  cast: undefined,
  target: false,
  lootable: false,
  tappedByOther: false,
  ...overrides,
});

test("the two plate switches are read separately, and the target answers to neither", () => {
  const filter = { hostile: true, friendly: false };
  assert.equal(plateVisible({ reaction: REACTION_HOSTILE, target: false }, 10, filter), true);
  assert.equal(plateVisible({ reaction: REACTION_FRIENDLY, target: false }, 10, filter), false);
  // Neutral is drawn by the enemy switch: a critter and a quest mob before it notices you are
  // both neutral, and both are things the player is about to hit.
  assert.equal(plateVisible({ reaction: REACTION_NEUTRAL, target: false }, 10, filter), true);
  assert.equal(plateVisible({ reaction: REACTION_HOSTILE, target: false }, PLATE_RANGE + 1, filter), false);
  // The ring under the target is drawn at any distance, so its plate has to be too.
  assert.equal(plateVisible({ reaction: REACTION_FRIENDLY, target: true }, 90, { hostile: false, friendly: false }), true);
});

test("a plate is coloured by reaction first and by class only for a friend", () => {
  assert.equal(plateColour({ reaction: REACTION_HOSTILE, classColour: "#9482c9" }), "#c5423d");
  assert.equal(plateColour({ reaction: REACTION_FRIENDLY, classColour: "#9482c9" }), "#9482c9");
  assert.equal(plateColour({ reaction: REACTION_FRIENDLY, classColour: undefined }), "#3fae5a");
  assert.equal(plateColour({ reaction: REACTION_NEUTRAL, classColour: "#9482c9" }), "#d8bb3f");
  assert.equal(plateColour({ reaction: undefined, classColour: undefined }), "#d8bb3f");
});

test("the level is what the original client would have written there", () => {
  assert.equal(plateLevelText(12, RANK_NORMAL), "12");
  assert.equal(plateLevelText(12, RANK_ELITE), "12+");
  assert.equal(plateLevelText(83, RANK_BOSS), "??", "a world boss has no useful number");
  assert.equal(plateLevelText(undefined, RANK_NORMAL), "");
  assert.equal(plateRankMark(RANK_RARE), "★");
  assert.equal(plateRankMark(RANK_NORMAL), "");
});

test("two units on one spot get two plates instead of one bar at some third value", () => {
  const near = { box: plateLayout(plate(), 400, 300), depth: 10 };
  const far = { box: plateLayout(plate(), 400, 300), depth: 25 };
  const nearY = near.box.y;
  stackPlates([near, far]);
  assert.equal(near.box.y, nearY, "the nearer plate is the one the player is looking at");
  assert.ok(far.box.y + far.box.height <= near.box.y, `the further plate was pushed clear: ${far.box.y}`);
});

test("plates that do not overlap are left where they were", () => {
  const left = { box: plateLayout(plate(), 100, 300), depth: 10 };
  const right = { box: plateLayout(plate(), 400, 300), depth: 25 };
  const before = right.box.y;
  stackPlates([left, right]);
  assert.equal(right.box.y, before);
});

test("a stack of three ends up as three separate plates", () => {
  const plates = [10, 12, 14].map((depth) => ({ box: plateLayout(plate(), 400, 300), depth }));
  stackPlates(plates);
  const boxes = plates.map((entry) => entry.box).sort((a, b) => a.y - b.y);
  for (let index = 1; index < boxes.length; index++) {
    assert.ok(boxes[index - 1].y + boxes[index - 1].height <= boxes[index].y,
      "every pair is clear of the one below it");
  }
});

test("the target's plate is drawn larger and framed in gold", () => {
  const ordinary = plateLayout(plate(), 400, 300);
  const targeted = plateLayout(plate({ target: true }), 400, 300);
  assert.ok(Math.abs(targeted.width / ordinary.width - PLATE_TARGET_SCALE) < 1e-9);
  // The frame is one strokeRect either way, so counting them says nothing: what marks the target
  // is the colour it is stroked in.
  const frameOf = (data) => {
    const { context, calls } = recordingContext();
    drawPlate(context, plateLayout(data, 400, 300), data);
    return calls.find((call) => call.name === "strokeRect").strokeStyle;
  };
  assert.equal(frameOf(plate({ target: true })), "#ffe36e");
  assert.notEqual(frameOf(plate()), "#ffe36e");
});

test("a cast bar appears over a head only while something is being cast", () => {
  const quiet = recordingContext();
  drawPlate(quiet.context, plateLayout(plate(), 400, 300), plate());
  const casting = recordingContext();
  const data = plate({ cast: { name: "Огненный шар", progress: 0.4, channel: false } });
  drawPlate(casting.context, plateLayout(data, 400, 300), data);
  assert.ok(casting.calls.filter((call) => call.name === "fillRect").length
    > quiet.calls.filter((call) => call.name === "fillRect").length);
  assert.ok(casting.calls.some((call) => call.name === "fillText" && call.args[0] === "Огненный шар"));
  // The bar has room for the cast: the plate grew by exactly the cast row.
  assert.ok(plateLayout(data, 400, 300).height > plateLayout(plate(), 400, 300).height);
});

test("the plate's cast bar shows the fraction it is handed, and does not invert it again", () => {
  // `WorldClient.castProgress` already returns the fill and not the elapsed share: for a channel
  // the two are opposite numbers, and it has turned it round. Inverting it a second time here made
  // the plate's bar run backwards against the target frame's bar for the very same spell.
  const barOf = (cast) => {
    const { context, calls } = recordingContext();
    const data = plate({ cast });
    drawPlate(context, plateLayout(data, 400, 300), data);
    const fills = calls.filter((call) => call.name === "fillRect");
    return fills[fills.length - 1].args[2] / (plateLayout(data, 400, 300).width - 2);
  };
  assert.ok(Math.abs(barOf({ name: "Огненный шар", progress: 0.25, channel: false }) - 0.25) < 1e-6);
  assert.ok(Math.abs(barOf({ name: "Иссушение", progress: 0.25, channel: true }) - 0.25) < 1e-6);
  // The flag still decides the colour, which is the one thing that has to tell them apart.
  const colourOf = (channel) => {
    const { context, calls } = recordingContext();
    const data = plate({ cast: { name: "Тест", progress: 0.5, channel } });
    drawPlate(context, plateLayout(data, 400, 300), data);
    const fills = calls.filter((call) => call.name === "fillRect");
    return fills[fills.length - 1].fillStyle;
  };
  assert.notEqual(colourOf(true), colourOf(false));
});

test("all eight raid marks draw, and a ninth draws nothing", () => {
  for (let icon = 0; icon < 8; icon++) {
    const { context, calls } = recordingContext();
    drawRaidMark(context, icon, 100, 100, 16);
    assert.ok(calls.some((call) => call.name === "fill"), `mark ${icon} filled nothing`);
    assert.equal(calls.filter((call) => call.name === "save").length, 1);
    assert.equal(calls.filter((call) => call.name === "restore").length, 1, `mark ${icon} left the context transformed`);
  }
  const { context, calls } = recordingContext();
  drawRaidMark(context, 8, 100, 100, 16);
  assert.equal(calls.length, 0);
});

test("the crescent and the skull are cut out rather than painted over", () => {
  for (const icon of [4, 7]) {
    const { context, calls } = recordingContext();
    drawRaidMark(context, icon, 100, 100, 16);
    const fill = calls.find((call) => call.name === "fill");
    assert.equal(fill.args[0], "evenodd", `mark ${icon} would be a solid disc under the non-zero rule`);
  }
});

test("the raid mark glyphs are in the order the server numbers them", () => {
  assert.equal(RAID_MARKS.length, 8);
  assert.equal(RAID_MARKS[6], "✖", "slot 6 is the cross");
  assert.equal(RAID_MARKS[7], "☠", "slot 7 is the skull, and it used to be a second cross");
});

test("a plate over a nameless unit still draws its bar", () => {
  const { context, calls } = recordingContext();
  const data = plate({ name: "", health: undefined });
  drawPlate(context, plateLayout(data, 400, 300), data);
  assert.ok(calls.some((call) => call.name === "fillRect"), "the empty track is drawn");
  assert.equal(calls.filter((call) => call.name === "fillRect").length, 1, "and nothing is filled into it");
});

test("the selection ring follows the slope it is standing on", () => {
  const geometry = buildSelectionRingGeometry();
  const centre = { x: 100, y: 200, z: 50, orientation: 0 };
  // A plane tilted a tenth of a yard per yard along x, and flat along y.
  const ground = (x) => 50 + (x - 100) * 0.1;
  updateSelectionRing(geometry, centre, 2, ground);
  const position = geometry.getAttribute("position");
  let lowest = Infinity;
  let highest = -Infinity;
  for (let index = 0; index < position.count; index++) {
    lowest = Math.min(lowest, position.getY(index));
    highest = Math.max(highest, position.getY(index));
  }
  // The outer ring reaches two yards each way, so the two ends differ by 0.4 yards of relief.
  assert.ok(Math.abs((highest - lowest) - 0.4) < 0.02, `relief was ${highest - lowest}`);
  assert.ok(Math.abs(highest - (50.2 + 0.08)) < 0.02);
});

test("a cliff under either edge of the ring does not throw it into the sky or the pit", () => {
  const geometry = buildSelectionRingGeometry();
  const centre = { x: 0, y: 0, z: 10, orientation: 0 };
  const measure = (ground) => {
    updateSelectionRing(geometry, centre, 2, ground);
    const position = geometry.getAttribute("position");
    let lowest = Infinity;
    let highest = -Infinity;
    for (let index = 0; index < position.count; index++) {
      lowest = Math.min(lowest, position.getY(index));
      highest = Math.max(highest, position.getY(index));
    }
    return { lowest, highest };
  };
  // A forty-yard drop under one side. Asserting only on the lowest vertex would pass with the
  // clamp deleted, because the drop is downward — the tower next to it is what catches that.
  const pit = measure((x) => x > 0.5 ? 10 : -30);
  assert.ok(pit.lowest >= 10 - SELECTION_RING_RELIEF + 0.07, `the drop was followed: ${pit.lowest}`);
  const tower = measure((x) => x > 0.5 ? 10 : 50);
  assert.ok(tower.highest <= 10 + SELECTION_RING_RELIEF + 0.09, `the rise was followed: ${tower.highest}`);
});

test("indoors the ring lies flat at the unit's own feet", () => {
  // There is no height field inside a building: the sampler answers with the terrain under the
  // floor, or with nothing at all, and either one would put the ring somewhere the unit is not.
  const geometry = buildSelectionRingGeometry();
  const centre = { x: 0, y: 0, z: 63.5, orientation: 0 };
  updateSelectionRing(geometry, centre, 1.4, undefined);
  const position = geometry.getAttribute("position");
  for (let index = 0; index < position.count; index++) {
    // Float32, so the tolerance is the storage and not the arithmetic: one ulp at 63.58 is 7.6e-6.
    assert.ok(Math.abs(position.getY(index) - (63.5 + 0.08)) < 1e-4);
  }
});

test("the ring is a closed band with a soft edge and no seam", () => {
  const geometry = buildSelectionRingGeometry();
  const position = geometry.getAttribute("position");
  const colour = geometry.getAttribute("color");
  assert.equal(position.count, 3 * (SELECTION_RING_SEGMENTS + 1));
  assert.equal(colour.itemSize, 4, "the fade is vertex alpha, so there is no texture to fetch");
  // Only the middle ring is opaque; the two edges fade out.
  assert.equal(colour.getW(0), 0);
  assert.equal(colour.getW(SELECTION_RING_SEGMENTS + 1), 1);
  assert.equal(colour.getW(2 * (SELECTION_RING_SEGMENTS + 1)), 0);
  updateSelectionRing(geometry, { x: 5, y: 5, z: 0, orientation: 0 }, 1, undefined);
  // The last vertex of each ring is the first one again, which is what closes the band.
  for (let ring = 0; ring < 3; ring++) {
    const first = ring * (SELECTION_RING_SEGMENTS + 1);
    const last = first + SELECTION_RING_SEGMENTS;
    assert.ok(Math.abs(position.getX(first) - position.getX(last)) < 1e-5);
    assert.ok(Math.abs(position.getZ(first) - position.getZ(last)) < 1e-5);
  }
  assert.ok(geometry.getIndex().count === 2 * SELECTION_RING_SEGMENTS * 6);
});

test("the camera is built with the far plane the horizon needs, not merely told about it", () => {
  // R5 raised this constant, imported it into the renderer and never applied it: the camera went
  // on stopping at 900 yards while the horizon reached 2,133, so more than half of what that slice
  // built was clipped. Comparing the two constants would have passed on the broken code — the
  // camera itself has to be asked.
  const camera = buildWorldCamera();
  assert.equal(camera.far, HORIZON_FAR_PLANE);
  assert.ok(camera.far > HORIZON_RANGE, `${camera.far} has to clear ${HORIZON_RANGE}`);
  assert.equal(camera.near, 0.25, "and the near plane is what depth precision actually rides on");
});

/**
 * A SimpleScene over a stub canvas, drawn once: the scene to ask what a click would hit, and every
 * 2D call the frame made, so that what was painted can be asserted about too.
 */
async function overlayDraw(objects, plateFor) {
  const { SimpleScene } = await import("../dist/code/browser/SimpleScene.js");
  const calls = [];
  const state = {
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: (text) => ({ width: String(text).length * 6 }),
    setTransform() {},
    fillStyle: "", strokeStyle: "", lineWidth: 0, font: "", textAlign: "", textBaseline: "",
    globalAlpha: 1,
  };
  const context = new Proxy(state, {
    get: (target, property) => (property in target
      ? target[property]
      : (...args) => { calls.push({ name: property, args, fillStyle: state.fillStyle }); }),
    set: (target, property, value) => { target[property] = value; return true; },
  });
  const canvas = {
    width: 0, height: 0,
    getContext: () => context,
    getBoundingClientRect: () => ({ width: 1280, height: 720 }),
  };
  const previous = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    // `drawWorld` false is the mode with WebGL alive, which is the one the plates belong to.
    const scene = new SimpleScene(canvas, false);
    scene.draw({ selfGuid: 1n, objects }, () => 0, undefined, [], undefined, 0, undefined, undefined,
      () => 2, plateFor);
    return { scene, calls };
  } finally {
    globalThis.window = previous;
  }
}

/** The same, for the tests that only ever ask the scene what a click would hit. */
async function overlayScene(objects, plateFor) {
  return (await overlayDraw(objects, plateFor)).scene;
}

const worldUnit = (guid, typeId, x, health, y = 0) => ({
  guid, typeId,
  position: { x, y, z: 0, orientation: 0 },
  fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health],
    [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 100]]),
});

test("a plate is a click target, because at any distance it is the larger one", async () => {
  const { createCamera, projectPoint } = await import("../dist/code/browser/SimpleScene.js");
  const player = worldUnit(1n, 4, 0, 100);
  const mob = worldUnit(2n, 3, 22, 60);
  const objects = new Map([[1n, player], [2n, mob]]);
  const camera = createCamera(player.position, 0, undefined, undefined);
  const head = projectPoint({ x: 22, y: 0, z: 2 }, camera, 1280, 720);
  assert.ok(head, "the mob has to be on screen for this to mean anything");

  const withPlate = await overlayScene(objects, () => plate({ guid: 2n }));
  // Twenty pixels above the crown of the head is inside the plate and outside the body.
  assert.equal(withPlate.pick(head.x, head.y - 20), 2n);
  // And the body itself is still clickable.
  const feet = projectPoint({ x: 22, y: 0, z: 0 }, camera, 1280, 720);
  assert.equal(withPlate.pick(feet.x, feet.y - 4), 2n);

  // With no plate — a friendly unit while friendly plates are off — that spot hits nothing, and
  // the body still does. The plate box has to come from the plate rather than from the unit.
  const without = await overlayScene(objects, () => undefined);
  assert.equal(without.pick(head.x, head.y - 20), undefined);
  assert.equal(without.pick(feet.x, feet.y - 4), 2n);
});

test("a corpse can be clicked, and the box is where the corpse is", async () => {
  const { createCamera, projectPoint } = await import("../dist/code/browser/SimpleScene.js");
  const player = worldUnit(1n, 4, 0, 100);
  const corpse = worldUnit(2n, 3, 12, 0);
  const scene = await overlayScene(new Map([[1n, player], [2n, corpse]]), () => undefined);
  const camera = createCamera(player.position, 0, undefined, undefined);
  const feet = projectPoint({ x: 12, y: 0, z: 0 }, camera, 1280, 720);
  assert.ok(feet);
  // Looting is `interactWithTarget` on a dead creature, and picking is the only way to target one.
  // The body lies centred on its own position, so the box is centred there too rather than ending
  // at it: a box that ended at the feet sat half a body-length above the corpse.
  assert.equal(scene.pick(feet.x, feet.y), 2n);
  assert.equal(scene.pick(feet.x, feet.y + 6), 2n, "and it reaches below the anchor");
  // A corpse wears no plate, so far above it there is nothing to click.
  assert.equal(scene.pick(feet.x, feet.y - 60), undefined);
});

test("Л1 the corpse's plate is drawn on its body and takes no click off a neighbour", async () => {
  // The review's blocker, and the only test in the repository that builds a *dead* unit which
  // `plateFor` answers about — without one, `SimpleScene`'s whole share of this slice could be
  // reverted with every test still green.
  //
  // A lootable body at (15, 0) and a live mob one yard behind it at (15, 1), both fifteen yards
  // from the camera: a camp with a respawn, and the ordinary shape of the bug. The corpse's plate
  // hangs over the middle of its own lying body, which at that range is exactly the height of the
  // standing mob's chest, and it is 104 px wide against the mob's 22.5 px hit box — so a plate box
  // pushed into the hit list after every body took the click off the mob for a third of its height.
  const { createCamera, projectPoint } = await import("../dist/code/browser/SimpleScene.js");
  const player = worldUnit(1n, 4, 0, 100);
  const corpse = worldUnit(2n, 3, 15, 0);
  const living = worldUnit(3n, 3, 15, 60, 1);
  const objects = new Map([[1n, player], [2n, corpse], [3n, living]]);
  const { scene, calls } = await overlayDraw(objects, (object) => (object.guid === 2n
    ? plate({ guid: 2n, name: "Труп", lootable: true, health: 0 })
    : plate({ guid: 3n, name: "Живой" })));

  const camera = createCamera(player.position, 0, undefined, undefined);
  const feet = projectPoint({ x: 15, y: 0, z: 0 }, camera, 1280, 720);
  const top = projectPoint({ x: 15, y: 0, z: 2 }, camera, 1280, 720);
  assert.ok(feet && top);

  // 1. The plate reached the screen, and it is anchored on the middle of the body rather than on
  //    `top` — the feet plus a standing height, which for a body lying down is empty air.
  const expected = plateLayout(plate({ lootable: true }), feet.x,
    feet.y - Math.max(14, Math.max(4, feet.y - top.y) * 0.45) / 2);
  const nameCall = calls.find((call) => call.name === "fillText" && call.args[0] === "Труп");
  assert.ok(nameCall, "no plate was painted over the lootable body");
  assert.equal(nameCall.args[1], expected.x);
  assert.equal(nameCall.args[2], expected.y + PLATE_NAME_HEIGHT - 3, "the name sits on its own row");
  assert.ok(expected.y > top.y, `${expected.y} has to be below the standing crown at ${top.y}`);

  // 2. And it is not a click target. Straight down the middle of the living mob, through the band
  //    the corpse's plate covers, every click is the mob's.
  const mobFeet = projectPoint({ x: 15, y: 1, z: 0 }, camera, 1280, 720);
  for (let y = Math.ceil(expected.y); y <= Math.floor(expected.y + expected.height); y++) {
    assert.equal(scene.pick(mobFeet.x, y), 3n, `the corpse plate stole the click at y ${y}`);
  }

  // 3. The body itself is still reachable, which is what makes 2 affordable: the corpse is clicked
  //    on the corpse, not on the label over it.
  assert.equal(scene.pick(feet.x, feet.y), 2n);
  assert.equal(scene.pick(feet.x, feet.y + 6), 2n);
});

// ---------------------------------------------------------------------------
// Л1. The corpse plate.
// ---------------------------------------------------------------------------

test("Л1 someone else's kill is grey before it is anything else", () => {
  // TAPPED without TAPPED_BY_PLAYER, which is the pair the core writes per viewer. It answers
  // «not yours», and that answer outranks the reaction — which is the original client's order:
  // `TargetFrame_CheckFaction` greys on the tap test alone and reaches `UnitSelectionColor` only in
  // the `else` (`Interface/FrameXML/TargetFrame.lua:261-272`). The reference client reads the same
  // two bits *inside* its hostile branch (`wowee/src/ui/game_screen_hud.cpp:1024-1030`), so the
  // friendly line below is where the two part company and this client follows the original:
  // `hasLootRecipient()` sets TAPPED whatever the faction (`Unit.cpp:14747-14749`).
  assert.equal(plateColour({ reaction: REACTION_HOSTILE, classColour: undefined, tappedByOther: true }), "#8d9298");
  assert.equal(plateColour({ reaction: REACTION_FRIENDLY, classColour: "#9482c9", tappedByOther: true }), "#8d9298");
  // And a plate with the flag absent altogether is exactly the plate it was before the flag.
  assert.equal(plateColour({ reaction: REACTION_HOSTILE, classColour: undefined }), "#c5423d");
  assert.equal(plateColour({ reaction: REACTION_HOSTILE, classColour: undefined, tappedByOther: false }), "#c5423d");

  const barOf = (tappedByOther) => {
    const data = plate({ tappedByOther });
    const { context, calls } = recordingContext();
    drawPlate(context, plateLayout(data, 400, 300), data);
    return calls.filter((call) => call.name === "fillRect")[1].fillStyle;
  };
  assert.equal(barOf(true), "#8d9298");
  assert.equal(barOf(false), "#c5423d");
});

test("Л1 a lootable corpse gets the short plate: a name, a bag, and no bar at all", () => {
  const corpse = plate({ lootable: true, health: 0 });
  const box = plateLayout(corpse, 400, 300);
  const living = plateLayout(plate(), 400, 300);
  assert.equal(box.height, PLATE_NAME_HEIGHT, "the box is the name row and nothing under it");
  assert.ok(box.height < living.height, `${box.height} has to be shorter than ${living.height}`);

  const { context, calls } = recordingContext();
  drawPlate(context, box, corpse);
  // No track, no fill, no frame. A dead unit's health is zero, so the bar would be an empty strip
  // repeated over every body in a cleared camp — which is what the old plate would have drawn had
  // corpses not been dropped outright before they reached here.
  assert.equal(calls.filter((call) => call.name === "fillRect").length, 0);
  assert.equal(calls.filter((call) => call.name === "strokeRect").length, 0);
  // The name is still written, and the level is not: the number answers «can I take this one»,
  // and that question is over.
  const written = calls.filter((call) => call.name === "fillText").map((call) => call.args[0]);
  assert.deepEqual(written, ["Гоблин-механик"]);
  // And the bag is drawn where the level stood.
  assert.ok(calls.some((call) => call.name === "fill"), "the bag paints something");
  assert.equal(calls.filter((call) => call.name === "save").length, 1);
  assert.equal(calls.filter((call) => call.name === "restore").length, 1, "and leaves the context as it found it");
});

test("Л1 the bag is a path, and it puts the context back", () => {
  const { context, calls } = recordingContext();
  drawLootBag(context, 100, 100, 14);
  assert.ok(calls.some((call) => call.name === "fill"));
  assert.ok(calls.some((call) => call.name === "stroke"));
  assert.equal(calls.filter((call) => call.name === "save").length, 1);
  assert.equal(calls.filter((call) => call.name === "restore").length, 1);
});

/**
 * `plateSource` reaches into `game`, the settings and the quest log, so it is exercised over the
 * same document stub `loot.test.mjs` uses rather than read. Installed at module scope so that
 * `overlayScene`'s own window swap above still saves and restores whatever was here.
 */
function stubBrowser() {
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      title: "", hidden: false, disabled: false, id: "", value: "", type: "",
      style: { setProperty() {}, removeProperty() {} },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      append() {}, prepend() {}, appendChild(child) { return child; }, replaceChildren() {},
      remove() {}, focus() {}, blur() {},
      addEventListener() {}, removeEventListener() {},
      setAttribute() {}, getAttribute: () => null, removeAttribute() {},
      querySelector() { return make("div"); }, querySelectorAll() { return []; }, closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }; },
      getContext() { return null; },
    };
    return node;
  };
  const byId = new Map();
  globalThis.document = {
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }), createDocumentFragment: () => make("fragment"),
    body: make("body"), documentElement: make("html"), head: make("head"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) {
        node = make("div");
        node.id = id;
        byId.set(id, node);
      }
      return node;
    },
    querySelector() { return make("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
  globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1,
    innerWidth: 1280, innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  globalThis.localStorage = globalThis.window.localStorage;
  globalThis.matchMedia = globalThis.window.matchMedia;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.HTMLElement = class {};
  globalThis.performance ??= { now: () => 1000 };
}

stubBrowser();
const { game } = await import("../dist/code/browser/game/Context.js");
const { plateSource } = await import("../dist/code/browser/ui/NamePlates.js");

/** One unit as `plateSource` reads it: health, max health and the dynamic flags. */
function plateUnit(guid, { typeId = 3, health = 100, dynamicFlags = 0 } = {}) {
  return {
    guid, typeId,
    position: { x: 0, y: 0, z: 0, orientation: 0 },
    fields: new Map([
      [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health],
      [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 100],
      [UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset, dynamicFlags],
    ]),
  };
}

/** Everything `plateSource` asks the world for, and nothing else. */
function plateWorld() {
  return {
    raidTargets: new Map(),
    state: { selfGuid: 1n, objects: new Map() },
    targetGuid: undefined,
    casts: new Map(),
    names: new Map(),
    questGiverStatus: new Map(),
    castProgress: () => 0,
  };
}

test("Л1 a lootable corpse keeps a plate; a spent one does not, and neither does the player", () => {
  const previous = game.world;
  try {
    game.world = plateWorld();
    const source = plateSource(0);
    // Every corpse used to be refused on the same line as the player's own body, so a cleared camp
    // looked identical whether the loot had been taken or not.
    const withLoot = source(plateUnit(2n, { health: 0, dynamicFlags: 0x01 }), 10);
    assert.ok(withLoot, "a body the server still marks lootable carries a plate");
    assert.equal(withLoot.lootable, true);
    assert.equal(withLoot.health, 0);
    assert.equal(plateLayout(withLoot, 400, 300).height, PLATE_NAME_HEIGHT);

    assert.equal(source(plateUnit(3n, { health: 0, dynamicFlags: 0 }), 10), undefined,
      "a body with nothing left on it is nothing to draw");
    assert.equal(source(plateUnit(1n, { health: 100 }), 10), undefined, "and never one's own body");

    // The bit and only the bit: 0x04 is TAPPED, which every kill carries, and it is not loot.
    assert.equal(source(plateUnit(4n, { health: 0, dynamicFlags: 0x04 }), 10), undefined);

    // The two plate switches do not reach a body. They are a rule about a crowd of names in a
    // city; the corpse in front of the player is the only sign the kill left.
    const far = source(plateUnit(5n, { health: 0, dynamicFlags: 0x01 }), PLATE_RANGE + 1);
    assert.equal(far, undefined, "though the plate's own forty-yard limit still applies");
    assert.ok(source(plateUnit(6n, { health: 0, dynamicFlags: 0x01 }), PLATE_RANGE - 1));
  } finally {
    game.world = previous;
  }
});

test("Л1 the tap pair reaches the plate from the field rather than being guessed at", () => {
  const previous = game.world;
  try {
    game.world = plateWorld();
    const source = plateSource(0);
    assert.equal(source(plateUnit(2n, { health: 60, dynamicFlags: 0x04 }), 10).tappedByOther, true);
    assert.equal(source(plateUnit(3n, { health: 60, dynamicFlags: 0x0c }), 10).tappedByOther, false,
      "TAPPED_BY_PLAYER is the half that says the kill is the viewer's own");
    assert.equal(source(plateUnit(4n, { health: 60, dynamicFlags: 0 }), 10).tappedByOther, false);
  } finally {
    game.world = previous;
  }
});

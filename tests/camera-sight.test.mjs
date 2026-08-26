import assert from "node:assert/strict";
import test from "node:test";
import {
  CAMERA_TERRAIN_ESCAPE_DEPTH, CAMERA_TERRAIN_SAMPLE_SPACING, CAMERA_WALL_CLEARANCE,
  CollisionMesh, CollisionWorld, boomLimits, boomTerrainSamples, clearBoom,
} from "../dist/code/browser/game/Collision.js";
import {
  CAMERA_DEFAULT_DISTANCE, CAMERA_DEFAULT_EYE_HEIGHT, CAMERA_DEFAULT_PITCH, CAMERA_DEFAULT_PIVOT_HEIGHT,
  CAMERA_EYE_BODY_SHARE, CAMERA_FIRST_PERSON_DISTANCE, CAMERA_MAX_DISTANCE, CAMERA_MAX_PIVOT_HEIGHT,
  CAMERA_MIN_DISTANCE, CAMERA_MIN_PIVOT_HEIGHT, CAMERA_PIVOT_BODY_SHARE,
  boomAnchor, cameraBodyHeight, cameraPivot, createCamera, projectPoint,
} from "../dist/code/browser/SimpleScene.js";
import {
  CAMERA_FEET_CLEARANCE, CAMERA_FLOOR_CLEARANCE, CAMERA_LOOK_SENSITIVITY, CAMERA_PITCH_LIMIT,
  CAMERA_RECOVERY_TAU, CAMERA_TERRAIN_TAU_IN, CAMERA_TERRAIN_TAU_OUT, CAMERA_ZOOM_TAU,
  advanceCameraFrame, advanceCameraRig, approachCamera, boomLength, cameraAllowsUpwardOrbit,
  cameraFloorHeight, cameraFloorPitch,
  zoomedDistance,
} from "../dist/code/browser/game/CameraRig.js";
import { coerceSetting, settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";
import { ATTACHMENT_HELM, ATTACHMENT_SHOULDER_RIGHT } from "../dist/code/browser/Wvm.js";
import { attachmentHeight } from "../dist/code/browser/Attachment.js";
import { buildWorldCamera } from "../dist/code/browser/WorldRenderer3D.js";
import { cameraPivotHeight, game } from "../dist/code/browser/game/Context.js";
import { inSightFromCamera } from "../dist/code/browser/game/Targeting.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";

function quad(a, b, c, d) {
  return Float32Array.of(...a, ...b, ...c, ...a, ...c, ...d);
}

/** A wall standing in the plane x = at, spanning y and rising from z. */
function wall(at, z = -20, height = 40, size = 40) {
  return quad([at, -size, z], [at, size, z], [at, size, z + height], [at, -size, z + height]);
}

test("Ж1.3 an open boom is granted in full, and a wall across it is not", () => {
  const head = { x: 0, y: 0, z: 2 };
  const wanted = { x: -20, y: 0, z: 8 };
  assert.equal(clearBoom(head, wanted, {}), 1, "with nothing to ask, nothing is in the way");

  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(wall(-10)));
  const reach = clearBoom(head, wanted, { world });
  const length = Math.hypot(20, 0, 6);
  // The wall is halfway along the boom in x, and the camera stops its clearance short of it.
  assert.ok(Math.abs(reach - (0.5 - CAMERA_WALL_CLEARANCE / length)) < 1e-6, `${reach}`);
  assert.ok(reach * length < 0.5 * length, "and it stops short rather than at the stone");
});

test("Ж1.3 the ground stops the camera too, which the collision world cannot", () => {
  // `CollisionWorld` holds placed models and has never heard of the heightfield, so a boom sinking
  // into an open hillside meets nothing there. This is the half of the answer that is sampled.
  const head = { x: 0, y: 0, z: 10 };
  const wanted = { x: 20, y: 0, z: 0 };
  const hillside = (x) => x / 2;

  assert.equal(clearBoom(head, wanted, {}), 1);
  const reach = clearBoom(head, wanted, { heightAt: (x) => hillside(x) });
  assert.ok(reach < 1, "the boom dives under the hill and has to be cut short");

  // Wherever it was cut, the camera is above the ground there by at least the clearance — that is
  // the whole claim, and the bisection is what makes it true to within a few centimetres.
  const x = 20 * reach;
  const z = 10 - 10 * reach;
  assert.ok(z >= hillside(x) + CAMERA_WALL_CLEARANCE - 0.05, `${z} against ${hillside(x)}`);
  // And it is not merely cautious. The exact edge is where 10 - 10t equals 5t + clearance, so
  // t = (10 - clearance) / 20; five halvings of a sixth of the boom land inside 0.006 of it.
  const edge = (10 - CAMERA_WALL_CLEARANCE) / 20;
  assert.ok(reach <= edge + 1e-9 && reach > edge - 0.006, `${reach} against ${edge}`);
});

test("К1 a hinge under the heightfield means the heightfield is not the ground", () => {
  // A cave, a WMO's basement, the inside of a bridge, the hole a city is dug into: the terrain
  // above the player's head is not something the camera can be «under». Every sample along the
  // boom reads sunk, the scan cuts the arm to nothing, and the camera is pinned to the back of the
  // character's head for as long as they stay indoors — so the terrain limit is dropped outright
  // and the real geometry, which a cave has and which is in the collision world, does the work.
  const ground = () => 0;
  const under = { x: 0, y: 0, z: -6 };
  assert.equal(clearBoom(under, { x: -20, y: 0, z: -2 }, { heightAt: ground }), 1);
  // Including the boom that climbs back out towards the surface: partway along it the ground would
  // start answering «clear», and cutting the arm at the first sunk sample would cut it at nothing.
  assert.equal(clearBoom(under, { x: -20, y: 0, z: 9 }, { heightAt: ground }), 1);
  // And the escape is about the hinge alone. Hinged above the ground, an arm that dives under it
  // is still cut short exactly as before.
  assert.ok(clearBoom({ x: 0, y: 0, z: 4 }, { x: -20, y: 0, z: -6 }, { heightAt: ground }) < 1);
});

test("К1 «under the map» is measured as under the map, not as close to it", () => {
  // The escape used to be `sunk(0)` — the same «below the ground plus the wall clearance» the
  // samples use — which fires 0.65 yards earlier than wowee's rule (`pivot.z < terrain - 0.2f`,
  // camera_controller.cpp:193-197). That gap is exactly where `CAMERA_MIN_PIVOT_HEIGHT` lives:
  // a polymorphed player, a display scale of 0.01 or a model with a broken attachment table hangs
  // the arm 0.4 above their own feet, which is below `ground + 0.45` — so a sheep standing on open
  // grass read as being inside a cave and lost the terrain limit on every hillside behind it.
  const ground = () => 0;
  const downhill = { x: -20, y: 0, z: -3 };

  // A player on flat ground with the smallest pivot the clamp allows. The boom dives into the
  // hillside behind them and has to be cut, exactly as it is for a full-sized character.
  const tiny = clearBoom({ x: 0, y: 0, z: CAMERA_MIN_PIVOT_HEIGHT }, downhill, { heightAt: ground });
  assert.ok(tiny < 1, `a ${CAMERA_MIN_PIVOT_HEIGHT}-yard pivot on flat ground turned the terrain limit off`);
  assert.ok(clearBoom({ x: 0, y: 0, z: CAMERA_DEFAULT_PIVOT_HEIGHT }, downhill, { heightAt: ground }) < 1,
    "and so does the ordinary one");

  // The threshold itself, from either side. A hand's width under the map is a rounding error in
  // the heightfield; two tenths of a yard under it is a cave.
  const shallow = clearBoom({ x: 0, y: 0, z: -(CAMERA_TERRAIN_ESCAPE_DEPTH - 0.05) }, downhill, { heightAt: ground });
  assert.ok(shallow < 1, `hinged ${CAMERA_TERRAIN_ESCAPE_DEPTH - 0.05} under the map the limit still applies`);
  assert.equal(clearBoom({ x: 0, y: 0, z: -(CAMERA_TERRAIN_ESCAPE_DEPTH + 0.05) }, downhill, { heightAt: ground }), 1,
    "and below it the heightfield is not the ground");
});

test("К1 a low pivot on flat ground does not read the flat ground as an obstruction", () => {
  // The other half of the shrunken player, and the half the escape depth cannot answer: hinged
  // 0.4 above flat grass, *every* sample of a level boom — the hinge included — sits below
  // `ground + CAMERA_WALL_CLEARANCE`, so the scan cut the arm at its first sample and
  // `advanceCameraView` floored it at CAMERA_MIN_WALL_DISTANCE. Measured before the clearance was
  // capped: the whole 21.31-yard boom collapsed to 0.75 yards at every pitch below 2.02 degrees
  // and snapped back to 21.31 above it. The clearance the ground scan uses is capped by the
  // hinge's own height above the ground, so a legitimately low pivot cannot declare the floor it
  // stands on an obstruction.
  const ground = () => 0;
  const level = { x: -CAMERA_DEFAULT_DISTANCE, y: 0, z: CAMERA_MIN_PIVOT_HEIGHT };
  assert.equal(clearBoom({ x: 0, y: 0, z: CAMERA_MIN_PIVOT_HEIGHT }, level, { heightAt: ground }), 1,
    `a ${CAMERA_MIN_PIVOT_HEIGHT}-yard pivot on flat ground kept its whole boom`);
  // And every pitch from level to the two degrees the collapse used to reach, which is where a
  // player looking straight ahead actually is.
  for (let degrees = 0; degrees <= 3; degrees += 0.25) {
    const radians = (degrees * Math.PI) / 180;
    const camera = {
      x: -CAMERA_DEFAULT_DISTANCE * Math.cos(radians), y: 0,
      z: CAMERA_MIN_PIVOT_HEIGHT + CAMERA_DEFAULT_DISTANCE * Math.sin(radians),
    };
    assert.equal(clearBoom({ x: 0, y: 0, z: CAMERA_MIN_PIVOT_HEIGHT }, camera, { heightAt: ground }), 1,
      `${degrees} degrees of pitch on flat ground`);
  }

  // The cap lowers the clearance and never the other way about: a full-sized pivot is nowhere near
  // it, so К1's own numbers stand. The boom that dives into the hillside is still cut at the same
  // place, to within the bisection.
  const hillside = (x) => x / 2;
  const dive = clearBoom({ x: 0, y: 0, z: 10 }, { x: 20, y: 0, z: 0 }, { heightAt: (x) => hillside(x) });
  const edge = (10 - CAMERA_WALL_CLEARANCE) / 20;
  assert.ok(dive <= edge + 1e-9 && dive > edge - 0.006, `${dive} against ${edge}`);

  // And a low pivot is still stopped by ground that rises in front of it: the cap is 0.4 there,
  // not nothing, and the far half of this boom is two yards inside the hill.
  const rise = (x) => (x < -6 ? 2 : 0);
  const into = clearBoom({ x: 0, y: 0, z: CAMERA_MIN_PIVOT_HEIGHT }, { x: -20, y: 0, z: CAMERA_MIN_PIVOT_HEIGHT },
    { heightAt: (x) => rise(x) });
  assert.ok(into < 1 && into * 20 <= 6, `the boom runs into the rise at 6 yards, not ${(into * 20).toFixed(3)}`);
});

test("К1 the ground is asked about by the yard and a half, however long the arm is", () => {
  // Six samples however long the boom was is what this replaces: at the boom К1 inherited they
  // stood 4.552 yards apart and at the wheel's maximum they would stand 9.17, so the further the
  // player zoomed out the more hillside the scan marched through without asking. The rule lives
  // with the scan rather than at the call site, because the segment `advanceCameraView` hands over
  // *is* the boom — saying the length twice is one place for the two to disagree.
  assert.equal(boomTerrainSamples(CAMERA_DEFAULT_DISTANCE), 15, "the default boom, 1.421 yards apart");
  assert.equal(boomTerrainSamples(27.313), 19, "the boom before К1 retuned it");
  assert.equal(boomTerrainSamples(CAMERA_MAX_DISTANCE), 37);
  assert.equal(boomTerrainSamples(CAMERA_MIN_DISTANCE), 3);
  // Never zero, whatever it is handed: a boom of nothing still has to answer about one point.
  assert.equal(boomTerrainSamples(0), 1);
  for (let length = 0.5; length <= CAMERA_MAX_DISTANCE; length += 0.25) {
    assert.ok(length / boomTerrainSamples(length) <= CAMERA_TERRAIN_SAMPLE_SPACING + 1e-12,
      `a ${length}-yard boom samples every ${length / boomTerrainSamples(length)} yards`);
  }

  // And the scan really uses it. A ridge 1.2 yards wide standing 5 yards proud of the ground,
  // 7 yards along a 24-yard boom: sampled every 1.5 yards the boom is stopped at its near face,
  // and the six samples that used to be the rule step straight over it — x = 4 and x = 8.
  const ridge = (x) => (x > 6.4 && x < 7.6 ? 5 : 0);
  const head = { x: 0, y: 0, z: 3 };
  const wanted = { x: 24, y: 0, z: 3 };
  const reach = clearBoom(head, wanted, { heightAt: ridge });
  assert.ok(reach < 1, "the boom runs straight through the ridge");
  assert.ok(reach * 24 > 6.4 - 0.05 && reach * 24 <= 6.4,
    `the camera stops at ${(reach * 24).toFixed(3)} yards rather than at the ridge's near face, 6.4`);
  assert.equal(clearBoom(head, wanted, { heightAt: ridge, samples: 6 }), 1,
    "and six samples 4 yards apart are what stepped over it");
});

test("Ж1.3 terrain with nothing to say about a point leaves the boom alone", () => {
  // `heightAt` answers `undefined` for a tile that has not landed. Treating that as ground at zero
  // would jam the camera into the character's back for as long as a tile was in flight.
  const reach = clearBoom({ x: 0, y: 0, z: 10 }, { x: 20, y: 0, z: -10 }, { heightAt: () => undefined });
  assert.equal(reach, 1);
});

test("Ж1.3 the camera stays behind the character however far a wall pushes it in", () => {
  // This used to assert `camera.position.x < 0` and pass on arithmetic that only just managed it:
  // the camera aimed at a point seven yards in front of the character and stood behind *that*, so
  // it was behind the character only while the look-ahead was shorter than the boom, and holding
  // the look-ahead at the full seven while a wall squeezed the boom to three put the camera a yard
  // and a half in *front*, facing away — the body left the frame and its hit box with it, which is
  // what made it impossible to click on oneself indoors.
  //
  // К1 makes it structural rather than lucky: the camera is the pivot swung back along its own
  // axis, so `x = -cos(pitch) * view` for a character facing +x, negative for every positive view
  // with no clamp anywhere. Asserting the identity rather than the sign is the point — the old
  // assertion survives the change while measuring nothing.
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  for (const view of [CAMERA_DEFAULT_DISTANCE, 20, 12, 8, 7, 5, 3, 1.5, 0.75]) {
    const camera = createCamera(player, 0, CAMERA_DEFAULT_PITCH, view);
    assert.ok(Math.abs(camera.position.x - -Math.cos(CAMERA_DEFAULT_PITCH) * view) < 1e-12,
      `at a boom of ${view} the camera stands at x=${camera.position.x}, not at -cos(pitch)*view`);
    assert.ok(camera.position.x < 0, `and behind the character rather than in front of them`);
    // And the character is still in the frame, which is the thing that actually broke.
    assert.ok(projectPoint({ x: 0, y: 0, z: 0 }, camera, 1280, 720), `feet lost at ${view}`);
    assert.ok(projectPoint({ x: 0, y: 0, z: 2 }, camera, 1280, 720), `head lost at ${view}`);
  }
});

test("Ж1.3 an unobstructed camera stands where the numbers say it does", () => {
  // This used to compare a camera built with an anchor against one built without, which after К1
  // are trivially the same object — the anchor left `createCamera` altogether. Against a golden
  // position instead, so that the next time the rig is rebuilt the test has something to say.
  // Measured: default boom 21.31, default pitch -atan2(11,25), pivot 1.6.
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const camera = createCamera(player, 0, CAMERA_DEFAULT_PITCH, CAMERA_DEFAULT_DISTANCE);
  assert.ok(Math.abs(camera.position.x - -19.505363) < 1e-5, `${camera.position.x}`);
  assert.equal(camera.position.y, 0);
  assert.ok(Math.abs(camera.position.z - 10.182360) < 1e-5, `${camera.position.z}`);
  // And the axis really does run through the pivot rather than merely near it.
  assert.ok(Math.abs(camera.forward.z - Math.sin(CAMERA_DEFAULT_PITCH)) < 1e-12);
});

test("К1 the camera orbits the character and nothing else", () => {
  // The defect in one line. The wheel's number was the distance to a point seven yards in front of
  // the character, so the distance to the *character* wandered with the pitch: measured on the old
  // rig, one unchanging asked-for 27.313 gave 25.669 / 23.333 / 21.306 / 20.317 / 21.192 / 23.245
  // over the pitches below. It is now the asked-for number at every pitch and every yaw, exactly.
  const player = { x: 12, y: -7, z: 3.5, orientation: 1.3 };
  const pivotHeight = 1.725;
  for (const pitch of [-1.15, -0.8, CAMERA_DEFAULT_PITCH, 0, 0.5, 0.9]) {
    for (const distance of [CAMERA_DEFAULT_DISTANCE, 27.313, 20, 10, 5, 3.5]) {
      for (const yaw of [0, 0.5, 1.5, 3, -2.2]) {
        const camera = createCamera(player, yaw, pitch, distance, { pivotHeight });
        const pivot = cameraPivot(player, pivotHeight);
        const range = Math.hypot(camera.position.x - pivot.x, camera.position.y - pivot.y, camera.position.z - pivot.z);
        assert.ok(Math.abs(range - distance) < 1e-9,
          `pitch ${pitch}, yaw ${yaw}: asked for ${distance}, camera stands ${range} away`);
      }
    }
  }
});

test("К1 the pivot is the point on the optical axis", () => {
  // Nailed to the middle of the screen at every zoom and every angle — which is what «the camera
  // orbits me» means to look at. The old aim point was a spot in front of the character, so the
  // character themselves was never on the axis and slid about as the view turned.
  const player = { x: -30, y: 18, z: 1.25, orientation: -0.4 };
  const pivotHeight = 0.823;
  for (const pitch of [-1.15, CAMERA_DEFAULT_PITCH, 0, 0.9]) {
    for (const distance of [CAMERA_DEFAULT_DISTANCE, 10, 3.5, 0.75]) {
      for (const yaw of [0, 1.5, -2.2]) {
        const camera = createCamera(player, yaw, pitch, distance, { pivotHeight });
        const point = projectPoint(cameraPivot(player, pivotHeight), camera, 1920, 1080);
        assert.ok(point, `the pivot fell out of the frame at pitch ${pitch}, boom ${distance}`);
        assert.ok(Math.abs(point.x - 960) < 1e-6 && Math.abs(point.y - 540) < 1e-6,
          `pitch ${pitch}, yaw ${yaw}, boom ${distance}: pivot at (${point.x}, ${point.y})`);
      }
    }
  }
});

/** A HumanMale, measured from Character\Human\Male\HumanMale.m2 in the configured client. */
const HUMAN_MALE_HEIGHT = 2.1274;

test("К1 the character is framed near the middle of the screen, not near the bottom", () => {
  // Measured at 1920x1080 with a 2.1274-yard HumanMale, default boom and pitch, pivot 1.6. Before
  // К1: feet 777.1, head 683.5, body centre 190 px below the middle of the screen, and at the
  // closest zoom the feet stood at y=1236, 156 px below the bottom edge of the window.
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const camera = createCamera(player, 0, CAMERA_DEFAULT_PITCH, CAMERA_DEFAULT_DISTANCE);
  const feet = projectPoint({ x: 0, y: 0, z: 0 }, camera, 1920, 1080);
  const head = projectPoint({ x: 0, y: 0, z: HUMAN_MALE_HEIGHT }, camera, 1920, 1080);
  assert.ok(feet && head);
  assert.ok(Math.abs(feet.y - 613.9) < 0.1, `feet at ${feet.y}`);
  assert.ok(Math.abs(head.y - 514.7) < 0.1, `head at ${head.y}`);
  assert.ok(Math.abs((feet.y + head.y) / 2 - 540) < 40,
    `the body centre is ${((feet.y + head.y) / 2 - 540).toFixed(1)} px from the middle of the screen`);

  // And it stays framed all the way in, which is where it used to be worst.
  const close = createCamera(player, 0, CAMERA_DEFAULT_PITCH, 3.5);
  const closeFeet = projectPoint({ x: 0, y: 0, z: 0 }, close, 1920, 1080);
  assert.ok(closeFeet && closeFeet.y < 1080, `the feet are at ${closeFeet?.y}, off the bottom of the window`);
});

test("К1 pitching moves the world rather than the character", () => {
  // The whole pitch range `Controls` allows, swept the way a drag sweeps it. Measured before К1:
  // the body centre travelled from 296 px below the middle of the screen to 243 px above it, 539
  // px, half the window. After: 18 px.
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  let low = Infinity;
  let high = -Infinity;
  for (let pitch = -1.15; pitch <= 0.9001; pitch += 0.01) {
    const camera = createCamera(player, 0, pitch, CAMERA_DEFAULT_DISTANCE);
    const feet = projectPoint({ x: 0, y: 0, z: 0 }, camera, 1920, 1080);
    const head = projectPoint({ x: 0, y: 0, z: HUMAN_MALE_HEIGHT }, camera, 1920, 1080);
    assert.ok(feet && head, `the body left the frame at pitch ${pitch.toFixed(2)}`);
    const centre = (feet.y + head.y) / 2 - 540;
    low = Math.min(low, centre);
    high = Math.max(high, centre);
  }
  assert.ok(high - low <= 40, `the body travels ${(high - low).toFixed(0)} px across the pitch range`);
  assert.ok(Math.abs(low - 10.2) < 1 && Math.abs(high - 27.9) < 1, `${low.toFixed(1)}..${high.toFixed(1)}`);
});

test("К1 the boom is hinged on the pivot, wherever the camera happens to be", () => {
  // `advanceCameraView` scans the boom from this point outwards, and it is written as «walk the
  // boom forwards from the camera» rather than as «the character plus a height» — which is only
  // the pivot because the camera was built by swinging the pivot back along the same axis. Before
  // К1 the same expression landed on the aim point seven yards in front of the character, so the
  // scan started in front of them and the floor behind them was never asked about.
  const player = { x: 4, y: -2, z: 9.75, orientation: 2.1 };
  for (const pivotHeight of [CAMERA_DEFAULT_PIVOT_HEIGHT, 0.823, 2.667]) {
    for (const pitch of [-1.15, CAMERA_DEFAULT_PITCH, 0, 0.9]) {
      for (const distance of [CAMERA_DEFAULT_DISTANCE, 12, 0.75]) {
        for (const yaw of [0, 1.5, -2.2]) {
          const camera = createCamera(player, yaw, pitch, distance, { pivotHeight });
          const anchor = boomAnchor(camera, distance);
          const pivot = cameraPivot(player, pivotHeight);
          assert.ok(Math.hypot(anchor.x - pivot.x, anchor.y - pivot.y, anchor.z - pivot.z) < 1e-9,
            `pitch ${pitch}, yaw ${yaw}, boom ${distance}: hinge at `
            + `(${anchor.x}, ${anchor.y}, ${anchor.z}) against a pivot at (${pivot.x}, ${pivot.y}, ${pivot.z})`);
        }
      }
    }
  }
});

test("К1 a squeezed boom is not first person, and stands its granted distance from the pivot", () => {
  // Two numbers that must not be confused. `CAMERA_MIN_WALL_DISTANCE` floors a squeeze at 0.75 so
  // a tight corner can never reach zero, and zero is what first person means: `draw` reads the
  // distance the wheel asked for, never the one the wall granted. So a camera drawn at 0.75 stands
  // 0.75 from the pivot and the body is still on the screen and still clickable — the half of this
  // that needs a scene is `zh0-pick`'s own «through a squeeze» test.
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const squeezed = createCamera(player, 0, CAMERA_DEFAULT_PITCH, 0.75, { pivotHeight: 1.725 });
  const pivot = cameraPivot(player, 1.725);
  const range = Math.hypot(squeezed.position.x - pivot.x, squeezed.position.y - pivot.y, squeezed.position.z - pivot.z);
  assert.ok(Math.abs(range - 0.75) < 1e-9, `${range}`);
  assert.ok(projectPoint({ x: 0, y: 0, z: 0 }, squeezed, 1280, 720), "the feet are still in the frame");
  assert.ok(projectPoint({ x: 0, y: 0, z: HUMAN_MALE_HEIGHT }, squeezed, 1280, 720), "and so is the head");
});

test("К1 the wall clearance clears the near plane", () => {
  // `CAMERA_WALL_CLEARANCE` exists to stop the camera parking so close to a wall that the near
  // plane cuts the wall away and puts the room behind it on screen. Until now that reasoning was
  // in a comment and in nothing executable, so raising the near plane — which R5 did to the far
  // one — would have broken it silently.
  assert.ok(CAMERA_WALL_CLEARANCE > buildWorldCamera().near,
    `${CAMERA_WALL_CLEARANCE} has to clear ${buildWorldCamera().near}`);
});

/**
 * The four models the pivot chain is pinned against, measured on this machine from
 * the configured client (the M2 vertex block and attachment table) and the dataset's
 * `CreatureModelData` / `CreatureDisplayInfo`. `z` is the model-space height of the attachment
 * point, before the display scale; `height` is the tallest vertex, likewise before scale — the
 * same number `ModelBuild` publishes as `boundingBox.max.z`.
 */
const BODIES = [
  { name: "HumanMale", display: 49, scale: 1, shoulder: 1.725361, helm: 2.027154, height: 2.127355, collisionHeight: 2.031 },
  { name: "GnomeMale", display: 1563, scale: 1.149999976158142, shoulder: 0.715278, helm: 0.996359, height: 1.324996, collisionHeight: 1.2144 },
  { name: "TaurenMale", display: 59, scale: 1.350000023841858, shoulder: 1.975409, helm: 1.978731, height: 2.328648, collisionHeight: 2.2316 },
  { name: "TrollMale", display: 1478, scale: 1, shoulder: 2.512417, helm: 2.823797, height: 3.191520, collisionHeight: 2.031 },
];

/** What the renderer holds for a unit whose model has been built: the artifact and its scale. */
const wvmOf = (body) => ({
  attachments: [
    { id: ATTACHMENT_SHOULDER_RIGHT, bone: 0, position: [0.11, -0.2, body.shoulder] },
    { id: ATTACHMENT_HELM, bone: 0, position: [0.02, 0, body.helm] },
  ],
});

test("К1 the pivot comes from the model's own shoulder, then from its height, then from a constant", () => {
  // Three deep, not two. `unitHeight` is not a body height until a real model has been applied —
  // until then it is the clamped combat reach the stand-in capsule was shaped to — so the constant
  // is reached exactly when the drawn height would be a lie.
  //
  // Golden numbers, scaled: HumanMale 1.7254, GnomeMale 0.8226, TaurenMale 2.6668, TrollMale
  // 2.5124. The gnome is the case that rules out a flat constant: 1.6 is above its own head.
  const golden = { HumanMale: 1.7254, GnomeMale: 0.8226, TaurenMale: 2.6668, TrollMale: 2.5124 };
  for (const body of BODIES) {
    const shoulder = attachmentHeight(wvmOf(body), ATTACHMENT_SHOULDER_RIGHT) * body.scale;
    const pivot = cameraBodyHeight(shoulder, body.height * body.scale, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT);
    assert.ok(Math.abs(pivot - golden[body.name]) < 5e-4, `${body.name}: ${pivot} against ${golden[body.name]}`);
    assert.ok(pivot < body.height * body.scale, `${body.name}: the pivot has to be inside the body`);

    // A model with no shoulder point at all — 9.5% of this client's creature models carry no rig
    // and some carry no attachment table — falls back to a share of the drawn body.
    const share = cameraBodyHeight(undefined, body.height * body.scale, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT);
    assert.ok(Math.abs(share - CAMERA_PIVOT_BODY_SHARE * body.height * body.scale) < 1e-9, `${body.name}: ${share}`);
  }

  // And nothing at all — no attachment, no model, the first frames in a world — is the constant.
  assert.equal(cameraBodyHeight(undefined, undefined, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT),
    CAMERA_DEFAULT_PIVOT_HEIGHT);
  assert.equal(cameraBodyHeight(undefined, undefined, CAMERA_EYE_BODY_SHARE, CAMERA_DEFAULT_EYE_HEIGHT),
    CAMERA_DEFAULT_EYE_HEIGHT);
});

test("К1 a degenerate attachment falls through to the body, not past it to the constant", () => {
  // Three deep means three deep. `attachment ?? bodyHeight * share` reads the attachment as
  // *present* when it is 0 or NaN and then throws the whole chain at the constant — 1.6 yards,
  // which on a gnome (drawn 1.524) is above its own head, with the gnome's own drawn body standing
  // right there able to answer 1.220. Both bad attachments now fall to the same place a missing
  // one does.
  const gnome = 1.5237;
  const share = cameraBodyHeight(undefined, gnome, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT);
  assert.ok(Math.abs(share - gnome * CAMERA_PIVOT_BODY_SHARE) < 1e-9, `${share}`);
  for (const broken of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(cameraBodyHeight(broken, gnome, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT), share,
      `an attachment of ${broken} skipped the body and took the constant`);
  }
  // With no body to fall to either, the constant is still the last word.
  assert.equal(cameraBodyHeight(0, 0, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT),
    CAMERA_DEFAULT_PIVOT_HEIGHT);
});

test("К1 which of the two heights is in force is decided by the wheel, not by the wall", () => {
  // `cameraPivotHeight` is read by four separate places that build a camera in the same frame —
  // the world, the plates, the bubbles and the picker — and they have to agree, so the switch is
  // asked once and in one place. What it must not read is `view`: a corner tight enough to squeeze
  // the boom to `CAMERA_MIN_WALL_DISTANCE` would put the orbit centre behind the player's eyes and
  // hide their own body, which is a different camera mode arrived at by accident.
  const previous = { ...game.camera };
  try {
    game.camera.pivotHeight = 1.725;
    game.camera.eyeHeight = 2.027;

    game.camera.distance = CAMERA_DEFAULT_DISTANCE;
    game.camera.view = CAMERA_DEFAULT_DISTANCE;
    assert.equal(cameraPivotHeight(), 1.725, "out in the open the arm hangs on the shoulder");

    // Squeezed to nearly nothing by a wall, and still third person.
    game.camera.view = 0.75;
    assert.equal(cameraPivotHeight(), 1.725, "a wall must not move the camera behind the eyes");

    // The wheel itself, all the way in. This is first person and the eye is where it goes.
    game.camera.distance = 0;
    game.camera.view = 0;
    assert.equal(cameraPivotHeight(), 2.027);
    // Even with the view left out at the last number a wall granted, which is the state one frame
    // after the wheel is rolled home.
    game.camera.view = CAMERA_DEFAULT_DISTANCE;
    assert.equal(cameraPivotHeight(), 2.027);
  } finally {
    Object.assign(game.camera, previous);
  }
});

test("К1 the first-person eye is the helm point, and a gnome's is not a tauren's", () => {
  // Until К1 the eye stood at a flat `player.z + 2` for every race: 0.476 yards above a gnome's
  // own head (drawn 1.5237) and below a tauren's shoulders (drawn 3.1437). A decision, not a side
  // effect of moving the pivot — the eye is a different point on the body from the orbit centre.
  const golden = { HumanMale: 2.0272, GnomeMale: 1.1458, TaurenMale: 2.6713, TrollMale: 2.8238 };
  for (const body of BODIES) {
    const helm = attachmentHeight(wvmOf(body), ATTACHMENT_HELM) * body.scale;
    const eye = cameraBodyHeight(helm, body.height * body.scale, CAMERA_EYE_BODY_SHARE, CAMERA_DEFAULT_EYE_HEIGHT);
    assert.ok(Math.abs(eye - golden[body.name]) < 5e-4, `${body.name}: ${eye} against ${golden[body.name]}`);
    // The eye is above the shoulder on every one of them, which is the reason for two numbers.
    const shoulder = attachmentHeight(wvmOf(body), ATTACHMENT_SHOULDER_RIGHT) * body.scale;
    assert.ok(eye > shoulder, `${body.name}: eye ${eye} against shoulder ${shoulder}`);
  }
});

test("К1 the pivot height is clamped, because a model may be absurd and a scale may be tiny", () => {
  assert.equal(cameraBodyHeight(9, undefined, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT), CAMERA_MAX_PIVOT_HEIGHT);
  assert.equal(cameraBodyHeight(0.01, undefined, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT), CAMERA_MIN_PIVOT_HEIGHT);
  // A model that says its shoulder is on the floor is saying nothing, and gets the constant.
  assert.equal(cameraBodyHeight(0, undefined, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT), CAMERA_DEFAULT_PIVOT_HEIGHT);
  assert.equal(cameraBodyHeight(Number.NaN, undefined, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT), CAMERA_DEFAULT_PIVOT_HEIGHT);
  // A troll's helm point at 0.95 of its drawn body would be 3.03, which the clamp brings back.
  assert.equal(cameraBodyHeight(undefined, 3.19152, CAMERA_EYE_BODY_SHARE, CAMERA_DEFAULT_EYE_HEIGHT), CAMERA_MAX_PIVOT_HEIGHT);
});

test("К1 CollisionHeight is not the source of the pivot, however handy it is on the wire", () => {
  // `/dbc/creature-models` already carries `CollisionHeight` and the physics already reads it, so
  // it is the field somebody will reach for. It is the water-depth threshold `Unit::GetCollision
  // Height` builds, not a body height: measured over the 20 playable displays, with the display
  // scale already applied the way the gateway applies it, it puts 31 of 190 pairs in the wrong
  // order outright and ties another 11 — five displays share one 2.031 across bodies from 2.033
  // to 3.192 yards. A human and a troll are two of those five.
  const [human, , tauren, troll] = BODIES;
  const pivotOf = (body) =>
    cameraBodyHeight(attachmentHeight(wvmOf(body), ATTACHMENT_SHOULDER_RIGHT) * body.scale,
      body.height * body.scale, CAMERA_PIVOT_BODY_SHARE, CAMERA_DEFAULT_PIVOT_HEIGHT);
  assert.equal(human.collisionHeight, troll.collisionHeight, "the field really does give them the same number");
  assert.ok(Math.abs(pivotOf(human) - pivotOf(troll)) > 0.75,
    `and the pivot must not: ${pivotOf(human)} against ${pivotOf(troll)}`);
  // Nor can it be rescued by scaling: as a share of the drawn body the field is 0.955 of a human,
  // 0.710 of a tauren and 0.636 of a troll, so no one multiplier turns it into a height.
  const share = (body) => body.collisionHeight / (body.height * body.scale);
  assert.ok(share(human) - share(troll) > 0.3, `${share(human)} against ${share(troll)}`);
  assert.ok(share(human) - share(tauren) > 0.2, `${share(human)} against ${share(tauren)}`);
});

const unit = (guid, x, y) => ({
  guid, typeId: 3, position: { x, y, z: 0, orientation: 0 }, fields: new Map(),
});

/** The pieces of `game` that `inSightFromCamera` reads, and nothing else. */
function withWorld(objects, collisionWorld) {
  const previous = { world: game.world, collision: game.collision, renderer: game.renderer, camera: { ...game.camera } };
  game.world = { state: { selfGuid: 1n, objects: new Map(objects.map((object) => [object.guid, object])) } };
  game.collision = collisionWorld ? { world: collisionWorld } : undefined;
  game.renderer = undefined;
  game.camera.yaw = 0;
  game.camera.pitch = CAMERA_DEFAULT_PITCH;
  game.camera.viewPitch = CAMERA_DEFAULT_PITCH;
  game.camera.distance = CAMERA_DEFAULT_DISTANCE;
  game.camera.view = CAMERA_DEFAULT_DISTANCE;
  return () => {
    game.world = previous.world;
    game.collision = previous.collision;
    game.renderer = previous.renderer;
    Object.assign(game.camera, previous.camera);
  };
}

test("Ж1.2 a wall between the camera and a unit takes the click away from it", () => {
  const self = unit(1n, 0, 0);
  const mob = unit(2n, 20, 0);
  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(wall(10)));

  let restore = withWorld([self, mob], world);
  try {
    assert.equal(inSightFromCamera(2n), false, "the wall at x = 10 is between the camera and x = 20");
  } finally { restore(); }

  // Move the wall past the unit and the same click goes through.
  const behind = new CollisionWorld();
  behind.set(1, new CollisionMesh(wall(30)));
  restore = withWorld([self, mob], behind);
  try {
    assert.equal(inSightFromCamera(2n), true);
  } finally { restore(); }
});

test("Ж1.2 a unit standing against a wall is still clickable", () => {
  // Its own doorway, bridge or building is within arm's reach of its chest, and a line drawn all
  // the way to the chest meets it. Stopping short is what separates «behind that» from «beside it».
  const self = unit(1n, 0, 0);
  const mob = unit(2n, 20, 0);
  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(wall(19.4)));
  const restore = withWorld([self, mob], world);
  try {
    assert.equal(inSightFromCamera(2n), true);
  } finally { restore(); }
});

test("Ж1.2 nothing known yet is not a reason to refuse a click", () => {
  // The collision world streams in. A veto that fired on missing data would make the client
  // unclickable for the first seconds in a zone, which is when a player clicks most.
  const self = unit(1n, 0, 0);
  const mob = unit(2n, 20, 0);
  let restore = withWorld([self, mob], undefined);
  try {
    assert.equal(inSightFromCamera(2n), true, "no collision world at all");
  } finally { restore(); }

  restore = withWorld([self, mob], new CollisionWorld());
  try {
    assert.equal(inSightFromCamera(2n), true, "an empty one");
    assert.equal(inSightFromCamera(9n), true, "and a guid that is not in the frame");
    assert.equal(inSightFromCamera(1n), true, "and oneself, who is never behind anything");
  } finally { restore(); }
});

/** One frame at sixty a second, which is what every easing here is quoted against. */
const FRAME = 1 / 60;

/** The camera rig exactly as `game.camera` holds it, so the loop's own function can be driven. */
function rig(overrides = {}) {
  return {
    yaw: 0, pitch: CAMERA_DEFAULT_PITCH, distance: CAMERA_DEFAULT_DISTANCE, view: CAMERA_DEFAULT_DISTANCE,
    viewPitch: CAMERA_DEFAULT_PITCH, zoom: CAMERA_DEFAULT_DISTANCE,
    wallView: Number.POSITIVE_INFINITY, terrainView: Number.POSITIVE_INFINITY,
    pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT, eyeHeight: CAMERA_DEFAULT_EYE_HEIGHT,
    ...overrides,
  };
}

/** What the scan says when there is nothing at all in the boom: the whole arm, and flat ground. */
const clear = (state) => ({
  wall: state.distance, terrain: state.distance,
  pivotZ: CAMERA_DEFAULT_PIVOT_HEIGHT, floorZ: CAMERA_FEET_CLEARANCE,
});

test("К2 a notch of the wheel glides to where it asked for, and lands inside half a second", () => {
  // The wheel used to write the drawn distance itself, so every notch was a jump of its whole
  // length. Measured on the default boom: one 100-unit notch is 2.5572 yards.
  const asked = zoomedDistance(CAMERA_DEFAULT_DISTANCE, 100, CAMERA_MAX_DISTANCE);
  const notch = asked - CAMERA_DEFAULT_DISTANCE;
  assert.ok(Math.abs(notch - 2.5572) < 1e-3, `a notch is ${notch} yards`);

  // A second of standing still first, so that the rig is in the state a player's is when they
  // reach for the wheel: this is the case the release of a recovered limit is for, and starting
  // the clock on a rig that has never been advanced measures nothing.
  const state = rig();
  for (let frame = 0; frame < 60; frame++) advanceCameraRig(state, clear(state), FRAME);
  assert.equal(state.view, CAMERA_DEFAULT_DISTANCE, "standing still in the open changes nothing");

  state.distance = asked;
  let previous = state.view;
  let biggest = 0;
  let landed;
  for (let frame = 1; frame <= 120; frame++) {
    advanceCameraRig(state, clear(state), FRAME);
    assert.ok(state.view >= previous - 1e-12, `the drawn distance went backwards on frame ${frame}`);
    assert.ok(state.view <= boomLength(state) + 1e-12,
      `frame ${frame} draws ${state.view} yards of arm out of an arm the world was asked about ${boomLength(state)} of`);
    biggest = Math.max(biggest, state.view - previous);
    previous = state.view;
    if (landed === undefined && Math.abs(state.view - asked) < 0.01) landed = frame;
  }
  // Measured: 0.5657 yards on the first frame, and nothing after it is bigger.
  assert.ok(Math.abs(biggest - 0.5657) < 1e-3, `biggest frame step ${biggest} against the notch's own ${notch}`);
  assert.ok(biggest < notch / 4, `${biggest} of a ${notch}-yard notch is still a jump`);
  assert.ok(landed !== undefined && landed * FRAME <= 0.5,
    `the wheel's number was reached after ${landed === undefined ? "never" : (landed * FRAME).toFixed(3)} s`);
  assert.equal(state.view, asked, "and it arrives rather than approaching for ever");
});

test("К2 the arm the world is asked about covers wherever the camera may be drawn", () => {
  // Zooming *in*, the eased camera is still outside the wheel's new number for a third of a
  // second. An arm scanned only as far as `distance` would have nothing to say about a wall
  // standing between the two, and the camera would be drawn through it for those frames.
  const state = rig();
  for (let frame = 0; frame < 60; frame++) advanceCameraRig(state, clear(state), FRAME);

  state.distance = 10;
  assert.equal(boomLength(state), CAMERA_DEFAULT_DISTANCE, "zooming in, the arm is where the camera still is");
  for (let frame = 0; frame < 120; frame++) {
    advanceCameraRig(state, { ...clear(state), wall: boomLength(state), terrain: boomLength(state) }, FRAME);
    assert.ok(state.view <= boomLength(state) + 1e-12, `${state.view} drawn out of ${boomLength(state)} scanned`);
  }
  assert.equal(state.view, 10);

  state.distance = 40;
  assert.equal(boomLength(state), 40, "and zooming out it is where the camera is going");
  for (let frame = 0; frame < 120; frame++) {
    advanceCameraRig(state, { ...clear(state), wall: boomLength(state), terrain: boomLength(state) }, FRAME);
    assert.ok(state.view <= boomLength(state) + 1e-12, `${state.view} drawn out of ${boomLength(state)} scanned`);
  }
  assert.equal(state.view, 40);
});

test("К2 the crossing into first person is the one thing the wheel still does at once", () => {
  // First person is decided by `distance` alone, so easing across the boundary is frames with the
  // body hidden and the camera still yards behind it — or, coming back, with the body on the lens.
  const state = rig({ distance: CAMERA_MIN_DISTANCE, zoom: CAMERA_MIN_DISTANCE, view: CAMERA_MIN_DISTANCE });
  state.distance = zoomedDistance(state.distance, -100, CAMERA_MAX_DISTANCE);
  assert.equal(state.distance, CAMERA_FIRST_PERSON_DISTANCE, "one notch below the closest orbit is first person");
  advanceCameraRig(state, clear(state), FRAME);
  assert.equal(state.view, CAMERA_FIRST_PERSON_DISTANCE, "and the very next frame draws it there");

  state.distance = zoomedDistance(state.distance, 100, CAMERA_MAX_DISTANCE);
  assert.equal(state.distance, CAMERA_MIN_DISTANCE);
  advanceCameraRig(state, clear(state), FRAME);
  assert.equal(state.view, CAMERA_MIN_DISTANCE, "and the way back out is not eased either");
});

test("К2 a wall takes the camera in at once and lets it back out on an exponential", () => {
  const state = rig();
  const squeezed = { ...clear(state), wall: 5 };
  advanceCameraRig(state, squeezed, FRAME);
  assert.equal(state.view, 5, "eased inwards, those frames would be spent inside the stone");

  // And out. The time to close all but 1/e of the gap is the time constant, by definition.
  const gap = CAMERA_DEFAULT_DISTANCE - 5;
  const mark = 5 + gap * (1 - Math.exp(-1));
  let frames = 0;
  while (state.view < mark && frames < 600) {
    advanceCameraRig(state, clear(state), FRAME);
    frames++;
  }
  assert.ok(Math.abs(frames * FRAME - CAMERA_RECOVERY_TAU) < 2 * FRAME,
    `${(frames * FRAME).toFixed(3)} s to close 1-1/e of the gap, against a time constant of ${CAMERA_RECOVERY_TAU}`);
  // The flat 14 yards a second this replaces would have covered the same gap in a straight line.
  assert.ok(frames * FRAME < gap / 14, `an exponential has to beat 14 yd/s over the first 1-1/e of ${gap} yards`);
});

test("К2 «nothing in the way» is a state, not a number that happens to equal the arm", () => {
  // This is what keeps a zoom out from being governed by the recovery instead of by the wheel.
  // A limit standing at the old twenty-one yards and easing towards the new twenty-four over its
  // own four tenths of a second is the slowest of the three easings, and `min` picks it.
  const state = rig();
  advanceCameraRig(state, clear(state), FRAME);
  assert.equal(state.wallView, Number.POSITIVE_INFINITY);
  assert.equal(state.terrainView, Number.POSITIVE_INFINITY);

  advanceCameraRig(state, { ...clear(state), wall: 5 }, FRAME);
  assert.equal(state.wallView, 5, "a wall makes it a number again");

  let frames = 0;
  while (Number.isFinite(state.wallView) && frames < 600) {
    advanceCameraRig(state, clear(state), FRAME);
    frames++;
  }
  assert.ok(frames < 600, "the recovery has to end rather than approach the arm for ever");
  assert.equal(state.view, CAMERA_DEFAULT_DISTANCE, "and the camera is back where the wheel put it");
});

test("К2 the ground is eased on a clock of its own, and coming in it is not a wall", () => {
  // A wall is a plane and answers the same thing twice running. A hillside marched every yard and
  // a half gives a new number every frame, and passing that straight through is a shudder.
  //
  // The two numbers are wowee's (`camera_controller.cpp:1767-1769`) and they are asserted rather
  // than derived: the shape below is checked against whatever the constants say, so the constants
  // themselves are the only place the reference can be recorded.
  assert.equal(CAMERA_TERRAIN_TAU_IN, 0.18);
  assert.equal(CAMERA_TERRAIN_TAU_OUT, 0.45);
  assert.ok(CAMERA_TERRAIN_TAU_IN < CAMERA_TERRAIN_TAU_OUT, "the ground comes in faster than it goes out");
  assert.ok(CAMERA_TERRAIN_TAU_IN < CAMERA_RECOVERY_TAU && CAMERA_TERRAIN_TAU_OUT > CAMERA_RECOVERY_TAU,
    "and neither of them is the wall's clock, which is the whole reason for two of them");

  const hill = rig();
  advanceCameraRig(hill, { ...clear(hill), terrain: 5 }, FRAME);
  const expected = CAMERA_DEFAULT_DISTANCE
    + (5 - CAMERA_DEFAULT_DISTANCE) * (1 - Math.exp(-FRAME / CAMERA_TERRAIN_TAU_IN));
  assert.ok(Math.abs(hill.view - expected) < 1e-9, `${hill.view} against ${expected}`);
  assert.ok(hill.view > 5, "the ground does not snap the camera in the way a wall does");

  const walled = rig();
  advanceCameraRig(walled, { ...clear(walled), wall: 5 }, FRAME);
  assert.equal(walled.view, 5, "and the wall on the same frame is already there");
});

test("К2 a walk down a hillside stops being a series of nudges", () => {
  // The whole ground falls away towards +y, so a character running that way has the hill behind
  // them and the camera over ground higher than they are standing on; the ripple is what makes it
  // a hillside rather than a ramp — the boom's fifteen samples land somewhere different every
  // frame, which is exactly the input the terrain time constants exist for.
  const slope = Math.tan((30 * Math.PI) / 180);
  const heightAt = (x, y) => -y * slope + Math.sin(y * 2.1) * 0.35;
  const frames = 240;
  const speed = 7;

  const walk = (advance) => {
    let previous;
    let biggest = 0;
    let travel = 0;
    for (let frame = 0; frame < frames; frame++) {
      const at = { x: 0, y: (frame * speed) / 60, z: 0, orientation: Math.PI / 2 };
      at.z = heightAt(at.x, at.y);
      const camera = createCamera(at, 0, CAMERA_DEFAULT_PITCH, CAMERA_DEFAULT_DISTANCE,
        { pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT });
      const limits = boomLimits(boomAnchor(camera, CAMERA_DEFAULT_DISTANCE), camera.position, { heightAt });
      const view = advance(limits, at);
      // The first second is the camera settling from 21.31 onto the slope, which both rules do
      // once and neither does again.
      if (frame > 60 && previous !== undefined) {
        biggest = Math.max(biggest, Math.abs(view - previous));
        travel += Math.abs(view - previous);
      }
      previous = view;
    }
    return { biggest, travel, last: previous };
  };

  // The rule К2 replaces, for the sake of the message: one number for both, in at once and out at
  // a flat fourteen yards a second.
  let linear = CAMERA_DEFAULT_DISTANCE;
  const before = walk((limits) => {
    const want = Math.max(0.75, CAMERA_DEFAULT_DISTANCE * Math.min(limits.wall, limits.terrain));
    linear = want <= linear ? want : Math.min(want, linear + 14 * FRAME);
    return linear;
  });
  const state = rig();
  const after = walk((limits, at) => {
    advanceCameraRig(state, {
      wall: CAMERA_DEFAULT_DISTANCE * limits.wall, terrain: CAMERA_DEFAULT_DISTANCE * limits.terrain,
      pivotZ: at.z + CAMERA_DEFAULT_PIVOT_HEIGHT, floorZ: at.z + CAMERA_FEET_CLEARANCE,
    }, FRAME);
    return state.view;
  });

  // Measured over the last three seconds of the walk: 2.6194 -> 0.2450 yards for the worst single
  // frame, and 56.34 -> 14.87 yards of total travel.
  assert.ok(after.biggest < 0.30,
    `worst frame step ${after.biggest.toFixed(4)} yd, against ${before.biggest.toFixed(4)} under the rule it replaces`);
  assert.ok(after.travel < 20,
    `the camera travelled ${after.travel.toFixed(2)} yd over three seconds, against ${before.travel.toFixed(2)}`);
  assert.ok(after.biggest * 5 < before.biggest, "and it has to be a difference in kind, not a rounding");
  // Smoother is not the whole of it. An eased limit still has to *arrive*: a ground clock slow
  // enough to lag the hillside would leave the camera inside the hill it was measured against, so
  // the two rules have to end the walk in the same place. Measured: 7.583 against 7.340.
  assert.ok(Math.abs(after.last - before.last) < 0.5,
    `the eased camera ends at ${after.last.toFixed(3)} against the unsmoothed ${before.last.toFixed(3)}`);
});

test("К2 the camera does not go under the character's own feet, whatever the drag asks for", () => {
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const floorZ = player.z + CAMERA_FEET_CLEARANCE;
  // Measured unclamped at the default boom: -15.093 at pitch 0.9, -19.400 at 1.4, -19.629 at the
  // clamp itself. The character is standing at z = 0.
  const golden = { 0.9: -15.093, 1.4: -19.4, [CAMERA_PITCH_LIMIT]: -19.629 };
  for (const pitch of [0.9, 1.4, CAMERA_PITCH_LIMIT]) {
    const asked = createCamera(player, 0, pitch, CAMERA_DEFAULT_DISTANCE, { pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT });
    assert.ok(Math.abs(asked.position.z - golden[pitch]) < 0.01, `${asked.position.z} at pitch ${pitch}`);
    const granted = cameraFloorPitch(pitch, CAMERA_DEFAULT_PIVOT_HEIGHT, CAMERA_DEFAULT_DISTANCE, floorZ);
    const held = createCamera(player, 0, granted, CAMERA_DEFAULT_DISTANCE, { pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT });
    assert.ok(held.position.z >= floorZ - 1e-9, `held at ${held.position.z}, floor at ${floorZ}`);
    assert.ok(Math.abs(held.position.z - floorZ) < 1e-9, `and right on it: ${held.position.z}`);
  }

  // A floor under the camera raises it further: a tavern's first floor three yards up.
  const upstairs = { x: 0, y: 0, z: 3, orientation: 0 };
  const solid = 3 + CAMERA_FLOOR_CLEARANCE;
  const granted = cameraFloorPitch(0.9, upstairs.z + CAMERA_DEFAULT_PIVOT_HEIGHT, CAMERA_DEFAULT_DISTANCE, solid);
  const held = createCamera(upstairs, 0, granted, CAMERA_DEFAULT_DISTANCE, { pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT });
  assert.ok(Math.abs(held.position.z - solid) < 1e-9, `${held.position.z} against ${solid}`);

  // And the clamp only ever lowers the tilt: looking down at the character from above is not the
  // floor's business, and a floor must never push the view up into an angle nobody asked for.
  assert.equal(cameraFloorPitch(CAMERA_DEFAULT_PITCH, CAMERA_DEFAULT_PIVOT_HEIGHT, CAMERA_DEFAULT_DISTANCE, floorZ),
    CAMERA_DEFAULT_PITCH);
  assert.equal(cameraFloorPitch(-CAMERA_PITCH_LIMIT, CAMERA_DEFAULT_PIVOT_HEIGHT, CAMERA_DEFAULT_DISTANCE, floorZ),
    -CAMERA_PITCH_LIMIT);
  // A floor higher than the whole band could lift the camera to is a case of its own, and the
  // clamp answers it by saying it has no answer rather than by turning the view over: its own
  // test, below.
  // A shorter arm dips less for the same tilt, so a squeezed boom is allowed more of it.
  assert.ok(cameraFloorPitch(1.4, CAMERA_DEFAULT_PIVOT_HEIGHT, 3, floorZ)
    > cameraFloorPitch(1.4, CAMERA_DEFAULT_PIVOT_HEIGHT, CAMERA_DEFAULT_DISTANCE, floorZ));
});

test("К2 holding the camera off the floor does not take the pivot off the optical axis", () => {
  // The reference lifts the camera's own z (`camera_controller.cpp:1943-1948`). This client turns
  // the tilt down instead, and the reason is К1: the boom's hinge is recovered by walking the boom
  // forwards from the camera (`boomAnchor`), and the plates and the bubbles are projected through
  // the same camera the world was drawn with. A camera lifted off its axis is no longer hinged on
  // the character — the scan would start in mid-air and the body would slide down the screen.
  const player = { x: 3, y: -2, z: 1.5, orientation: 0.7 };
  const pivotHeight = 1.725;
  const pivot = cameraPivot(player, pivotHeight);
  const floorZ = player.z + CAMERA_FEET_CLEARANCE;
  const granted = cameraFloorPitch(1.4, pivot.z, CAMERA_DEFAULT_DISTANCE, floorZ);
  const camera = createCamera(player, 0.4, granted, CAMERA_DEFAULT_DISTANCE, { pivotHeight });

  const range = Math.hypot(camera.position.x - pivot.x, camera.position.y - pivot.y, camera.position.z - pivot.z);
  assert.ok(Math.abs(range - CAMERA_DEFAULT_DISTANCE) < 1e-9, `${range}`);
  const point = projectPoint(pivot, camera, 1920, 1080);
  assert.ok(point && Math.abs(point.x - 960) < 1e-6 && Math.abs(point.y - 540) < 1e-6,
    `the pivot projects to (${point?.x}, ${point?.y})`);
  const hinge = boomAnchor(camera, CAMERA_DEFAULT_DISTANCE);
  assert.ok(Math.hypot(hinge.x - pivot.x, hinge.y - pivot.y, hinge.z - pivot.z) < 1e-9);

  // Lifting z to the same floor instead is what that would have cost, in yards of hinge.
  const asked = createCamera(player, 0.4, 1.4, CAMERA_DEFAULT_DISTANCE, { pivotHeight });
  const lifted = { ...asked, position: { ...asked.position, z: floorZ } };
  const strayed = boomAnchor(lifted, CAMERA_DEFAULT_DISTANCE);
  assert.ok(Math.abs(strayed.z - pivot.z) > 15,
    `a lifted camera hinges its boom ${Math.abs(strayed.z - pivot.z).toFixed(2)} yards off the body`);
});

test("К2 one sensitivity for both axes, and the reference's pitch band", () => {
  // wowee's 0.2 deg/px (`camera_controller.hpp:342`), against the 0.006 across and 0.004 up this
  // replaces: measured, a 100-pixel drag used to turn the view 34.38 degrees and lift it 22.92,
  // so the diagonal turned half as far again as it lifted, for no reason anybody wrote down.
  assert.ok(Math.abs((CAMERA_LOOK_SENSITIVITY * 180) / Math.PI - 0.2) < 1e-12,
    `${(CAMERA_LOOK_SENSITIVITY * 180) / Math.PI} deg/px`);
  assert.ok(Math.abs((CAMERA_PITCH_LIMIT * 180) / Math.PI - 85) < 1e-12);
  assert.ok(CAMERA_PITCH_LIMIT > 1.15, "the band it replaces reached 1.15 down and 0.9 up");

  // The band belongs to the drag. What actually stops the view tilting up is the floor, and on
  // flat ground at the default boom it stops it at 3.90 degrees — measured.
  const granted = cameraFloorPitch(CAMERA_PITCH_LIMIT, CAMERA_DEFAULT_PIVOT_HEIGHT,
    CAMERA_DEFAULT_DISTANCE, CAMERA_FEET_CLEARANCE);
  assert.ok(Math.abs((granted * 180) / Math.PI - 3.90) < 0.01, `${(granted * 180) / Math.PI} deg`);
  // Downwards nothing stops it, which is the direction a top-down orbit needs.
  assert.equal(cameraFloorPitch(-CAMERA_PITCH_LIMIT, CAMERA_DEFAULT_PIVOT_HEIGHT,
    CAMERA_DEFAULT_DISTANCE, CAMERA_FEET_CLEARANCE), -CAMERA_PITCH_LIMIT);
});

test("К2 flying camera gets the upward pitch the feet fallback used to block", () => {
  const player = { x: 0, y: 0, z: 100, orientation: 0 };
  const state = rig({ pitch: 1.2 });
  // No collision floor is known under a flying mover. The synthetic feet plane must not be
  // treated as a roof: at the default boom it would otherwise reduce +1.2 rad to +0.068 rad.
  advanceCameraFrame(state, player, CAMERA_DEFAULT_PIVOT_HEIGHT,
    { allowUpwardOrbit: true }, FRAME);
  assert.equal(state.view, CAMERA_DEFAULT_DISTANCE);
  assert.equal(state.viewPitch, state.pitch, "flight keeps the requested upward view");
  assert.ok(Number.isFinite(state.viewPitch));
  assert.ok(state.viewPitch > 1, `${state.viewPitch} rad should remain a useful flight view`);

  // A malformed drag cannot escape the same finite pitch band, and never propagates NaN into the
  // camera even when the floor source is unavailable.
  const malformed = cameraFloorPitch(Number.NaN, CAMERA_DEFAULT_PIVOT_HEIGHT,
    CAMERA_DEFAULT_DISTANCE, Number.NaN);
  assert.equal(malformed, 0);
  assert.ok(Math.abs(cameraFloorPitch(100, CAMERA_DEFAULT_PIVOT_HEIGHT,
    CAMERA_DEFAULT_DISTANCE, Number.NEGATIVE_INFINITY)) <= CAMERA_PITCH_LIMIT);
  const firstPerson = rig({ distance: 0, pitch: Number.NaN });
  advanceCameraRig(firstPerson, { wall: 0, terrain: 0, pivotZ: CAMERA_DEFAULT_PIVOT_HEIGHT, floorZ: 0 }, FRAME);
  assert.equal(firstPerson.viewPitch, 0, "first person also rejects a malformed pitch");
});

test("К2 movement toggles open the flight camera before self flags catch up", () => {
  assert.equal(cameraAllowsUpwardOrbit(0), false);
  assert.equal(cameraAllowsUpwardOrbit(0, { canFly: true }), true,
    "SMSG_MOVE_SET_CAN_FLY is effective immediately");
  assert.equal(cameraAllowsUpwardOrbit(0, { gravityDisabled: true }), true,
    "gravity disable is effective immediately");
  assert.equal(cameraAllowsUpwardOrbit(MOVEMENT_FLAGS.flying), true,
    "a packet/spline flying flag remains supported");
  assert.equal(cameraAllowsUpwardOrbit(MOVEMENT_FLAGS.forward, { canFly: false, gravityDisabled: false }), false,
    "ordinary movement does not inherit flight mode");
});

test("К2 flying camera still respects a real collision floor", () => {
  const player = { x: 0, y: 0, z: 10, orientation: 0 };
  const floor = new CollisionWorld();
  floor.set(1, new CollisionMesh(quad([-40, -40, 0], [40, -40, 0], [40, 40, 0], [-40, 40, 0])));
  const state = rig({ pitch: 1.2 });
  advanceCameraFrame(state, player, CAMERA_DEFAULT_PIVOT_HEIGHT,
    { collision: floor, allowUpwardOrbit: true }, FRAME);
  const camera = createCamera(player, state.yaw, state.viewPitch, state.view,
    { pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT });
  assert.ok(camera.position.z >= CAMERA_FLOOR_CLEARANCE - 1e-9,
    `real floor at z=0 must remain clear, got ${camera.position.z}`);
  assert.ok(state.viewPitch <= state.pitch, "the real floor may only preserve or lower the flight view");
  assert.ok(Number.isFinite(state.viewPitch));
});

test("К2 the wheel stops where the player's own ceiling says, not where the constant does", () => {
  const definition = settingDefinition("cameraMaxDistance");
  assert.ok(definition, "«Максимальная дистанция камеры» has to exist to be applied");
  assert.equal(definition.kind, "number");
  assert.equal(definition.group, "Мир");
  assert.equal(definition.fallback, CAMERA_MAX_DISTANCE, "by default the wheel goes where it always went");
  assert.equal(definition.max, CAMERA_MAX_DISTANCE);
  assert.ok(definition.min > CAMERA_MIN_DISTANCE, "and the tightest ceiling is still an orbit");

  for (const ceiling of [definition.min, 30, definition.max]) {
    let distance = CAMERA_DEFAULT_DISTANCE;
    for (let notch = 0; notch < 60; notch++) distance = zoomedDistance(distance, 100, ceiling);
    assert.equal(distance, ceiling, `sixty notches out under a ${ceiling}-yard ceiling`);
  }
  // The blob the account carries is not a promise: a ceiling above the constant is still refused.
  assert.equal(zoomedDistance(CAMERA_DEFAULT_DISTANCE, 100_000, 900), CAMERA_MAX_DISTANCE);
  assert.equal(coerceSetting(definition, 900), CAMERA_MAX_DISTANCE);
  assert.equal(coerceSetting(definition, 1), definition.min);
  // And the way in is not the ceiling's business: first person is reachable under the tightest.
  assert.equal(zoomedDistance(CAMERA_MIN_DISTANCE, -100, definition.min), CAMERA_FIRST_PERSON_DISTANCE);
  assert.equal(zoomedDistance(CAMERA_FIRST_PERSON_DISTANCE, 100, definition.min), CAMERA_MIN_DISTANCE);
});

test("К2 the boom's two answers are measured apart, and the ground behind the wall as well", () => {
  // They are eased on different clocks, so they have to be measured separately — and the ground
  // has to be measured even on the frames a wall is nearer. The scan used to stop where the wall
  // was, so the ground's eased limit had nothing to be eased from while the player stood behind a
  // pillar: it decayed towards «clear» and jumped when they stepped out from behind it.
  const head = { x: 0, y: 0, z: 3 };
  const wanted = { x: 24, y: 0, z: 3 };
  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(wall(6)));
  const ridge = (x) => (x > 12 ? 5 : 0);
  const options = { world, heightAt: (x) => ridge(x) };

  const limits = boomLimits(head, wanted, options);
  assert.ok(Math.abs(limits.wall - (0.25 - CAMERA_WALL_CLEARANCE / 24)) < 1e-9, `${limits.wall}`);
  assert.ok(limits.terrain > 0.49 && limits.terrain <= 0.5,
    `the ridge starts halfway along the boom, behind the wall: ${limits.terrain}`);
  // And the single number every other caller wants is still the nearer of the two.
  assert.equal(clearBoom(head, wanted, options), Math.min(limits.wall, limits.terrain));
  assert.equal(clearBoom(head, wanted, options), limits.wall);
});

test("К2 a limit is let go of by the arm that was scanned, not by the number on the wheel", () => {
  // Zooming *in*, the two part company: the wheel's number drops on the frame it is turned and the
  // drawn camera takes a third of a second to follow it, so the scan covers `boomLength` — the
  // longer of the two — and a wall standing between them is measured on every one of those frames.
  // Compared against `distance` that measurement reads «further out than the camera is going», the
  // limit is thrown away as «nothing in the way», and the drawn distance falls back to the eased
  // `zoom`, which is still outside the wall. Measured with the wheel's number in the comparison: a
  // wall holding the camera at 12 drew 18.7861 on the frame after the wheel — a 6.7861-yard step
  // *outward* — and spent six frames behind the stone; a pillar granting 5 drew 17.3704 and nine.
  for (const [granted, asked, popped] of [[12, 9.9, 18.7861], [5, CAMERA_MIN_DISTANCE, 17.3704]]) {
    const state = rig();
    // What a scan answers: this much of whatever arm it was given. A wall says the same yardage
    // however long the arm is, until the arm is shorter than the wall and it says «all of it».
    const limits = () => ({
      ...clear(state), wall: Math.min(granted, boomLength(state)), terrain: boomLength(state),
    });
    for (let frame = 0; frame < 120; frame++) advanceCameraRig(state, limits(), FRAME);
    assert.equal(state.view, granted, "the wall has the camera before the wheel is touched");

    state.distance = asked;
    let previous = state.view;
    let outward = 0;
    let beyond = 0;
    for (let frame = 0; frame < 120; frame++) {
      advanceCameraRig(state, limits(), FRAME);
      outward = Math.max(outward, state.view - previous);
      if (state.view > granted + 1e-9) beyond++;
      previous = state.view;
    }
    assert.equal(beyond, 0, `${beyond} frames drawn past a wall the scan reported on every one of them`);
    assert.equal(outward, 0, `the camera stepped ${outward} yards outward while the wheel was coming in`);
    assert.equal(state.view, asked, "and it ends where the wheel asked, once the ease has come inside");
    // The size of what that would have been: the eased zoom on the first of those frames, which is
    // what a released limit leaves `view` equal to.
    const zoomed = approachCamera(CAMERA_DEFAULT_DISTANCE, asked, CAMERA_ZOOM_TAU, FRAME);
    assert.ok(Math.abs(zoomed - popped) < 1e-3, `${zoomed} against the measured ${popped}`);
    assert.ok(zoomed > granted, "which is outside the wall, and is what used to be drawn there");
  }

  // The other direction is unchanged: an arm growing past a wall does not release it either.
  const state = rig();
  const held = () => ({ ...clear(state), wall: Math.min(12, boomLength(state)), terrain: boomLength(state) });
  for (let frame = 0; frame < 120; frame++) advanceCameraRig(state, held(), FRAME);
  state.distance = 40;
  for (let frame = 0; frame < 120; frame++) advanceCameraRig(state, held(), FRAME);
  assert.equal(state.view, 12, "a wall is still a wall when the wheel asks for more arm than it grants");
});

test("К2 the tilt the floor grants is the tilt the rig writes, not one the caller has to remember", () => {
  // The clamp is a pure function and was tested as one, which left the wiring — the line in the
  // per-frame step that puts its answer into `viewPitch` — unmeasured: taking that line out left
  // every other test in this file passing. This is that line. The camera built here is the camera
  // the frame draws: `renderer.draw` and `scene.draw` are both handed `viewPitch` and `view`.
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const options = { pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT };
  const floorZ = player.z + CAMERA_FEET_CLEARANCE;
  const state = rig({ pitch: 1.4 });
  advanceCameraRig(state, { ...clear(state), floorZ }, FRAME);

  const drawn = createCamera(player, state.yaw, state.viewPitch, state.view, options);
  assert.ok(drawn.position.z >= floorZ - 1e-9, `the frame draws the camera at z = ${drawn.position.z}`);
  assert.ok(Math.abs(drawn.position.z - floorZ) < 1e-9, `and right on the floor: ${drawn.position.z}`);
  // Measured: the same arm at the same tilt without the clamp stands 19.400 yards under the feet.
  const asked = createCamera(player, state.yaw, state.pitch, state.view, options);
  assert.ok(Math.abs(asked.position.z + 19.400) < 0.01, `${asked.position.z} unclamped`);
  // And the drag goes on meaning what it meant, so the view comes back when the floor lets it.
  assert.equal(state.pitch, 1.4);
  assert.ok(state.viewPitch < state.pitch);
});

test("К2 a floor no tilt can reach is left alone rather than answered with a flip", () => {
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const options = { pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT };
  const pivotZ = CAMERA_DEFAULT_PIVOT_HEIGHT;
  // What a building four yards behind a character grants the arm — measured against its collision
  // mesh in the test below.
  const squeezed = 3.920;
  // The highest the camera can be lifted at that arm: straight up the band, and no further.
  const reach = pivotZ + Math.sin(CAMERA_PITCH_LIMIT) * squeezed;
  assert.ok(Math.abs(reach - 5.505) < 1e-3, `${reach}`);

  // Under it the clamp is a clamp, and it stands the camera exactly on the floor.
  const near = cameraFloorPitch(CAMERA_DEFAULT_PITCH, pivotZ, squeezed, reach - 0.01);
  const held = createCamera(player, 0, near, squeezed, options);
  assert.ok(Math.abs(held.position.z - (reach - 0.01)) < 1e-9, `${held.position.z}`);
  assert.ok(near > -CAMERA_PITCH_LIMIT, "and inside the band, which is what makes it reachable");

  // Above it no tilt clears the floor, and the top of the band does not clear it either — it only
  // turns the view over. Measured with the rule that saturated: a floor at 8.35 against this arm
  // took the drag's -23.75 degrees to -85.00, and sweeping the floor gave -26.51 at three yards up,
  // -44.55 at four and the full -85.00 from six.
  for (const floorZ of [reach + 1e-6, 6.35, 8.35, 100]) {
    assert.equal(cameraFloorPitch(CAMERA_DEFAULT_PITCH, pivotZ, squeezed, floorZ), CAMERA_DEFAULT_PITCH,
      `a floor at ${floorZ} moved a tilt that cannot reach it`);
  }
  assert.equal(cameraFloorPitch(0.9, pivotZ, CAMERA_DEFAULT_DISTANCE, 100), 0.9);
  // The shorter the arm the lower the reach, which is why this is the squeezed camera's case and
  // not the open one's: the same 8.35-yard floor is well inside the reach of a whole boom, and
  // there it clamps like any other.
  assert.ok(pivotZ + Math.sin(CAMERA_PITCH_LIMIT) * CAMERA_DEFAULT_DISTANCE > 8.35);
  const wide = cameraFloorPitch(0.9, pivotZ, CAMERA_DEFAULT_DISTANCE, 8.35);
  assert.ok(wide < 0.9, `${wide}`);
  const clamped = createCamera(player, 0, wide, CAMERA_DEFAULT_DISTANCE, options);
  assert.ok(Math.abs(clamped.position.z - 8.35) < 1e-9, `${clamped.position.z} against a floor at 8.35`);
});

test("К2 the floor is asked about under the camera the frame draws, not under the arm it asked for", () => {
  // A character in a street with a building four yards behind them and its first floor four yards
  // up. The wall cuts the arm to 3.920 yards, so the camera is drawn at (-3.59, 0, 3.18) — outside
  // the building, with nothing under it at all. Asked under a camera built at the *full* arm, the
  // question is put 19.51 yards away and inside the building instead, `floorUnder` answers 4, and
  // the clamp turns a -23.75-degree view into a -44.55-degree one. With that first floor at eight
  // yards rather than four the same mistake saturates and the view goes to -85.00.
  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(wall(-4)));
  world.set(2, new CollisionMesh(quad([-4, -40, 4], [-60, -40, 4], [-60, 40, 4], [-4, 40, 4])));
  const player = { x: 0, y: 0, z: 0, orientation: 0 };
  const options = { pivotHeight: CAMERA_DEFAULT_PIVOT_HEIGHT };
  const pivotZ = player.z + CAMERA_DEFAULT_PIVOT_HEIGHT;
  const state = rig();

  // The trap is still there to fall into, which is what makes where the question is asked the
  // whole of it: the full arm really does find that floor, four yards over the camera's head.
  const full = createCamera(player, state.yaw, state.pitch, boomLength(state), options);
  assert.ok(Math.abs(full.position.x + 19.51) < 0.01 && Math.abs(full.position.z - 10.18) < 0.01,
    `the full arm puts the camera at ${full.position.x}, ${full.position.z}`);
  assert.equal(cameraFloorHeight(player, full.position, pivotZ, world), 4 + CAMERA_FLOOR_CLEARANCE);

  advanceCameraFrame(state, player, CAMERA_DEFAULT_PIVOT_HEIGHT, { collision: world }, FRAME);
  assert.ok(Math.abs(state.view - 3.920) < 0.01, `the wall grants ${state.view} yards of arm`);
  assert.equal(state.viewPitch, state.pitch, "and the tilt is the drag's own, not a floor overhead");
  const drawn = createCamera(player, state.yaw, state.viewPitch, state.view, options);
  assert.ok(Math.abs(drawn.position.x + 3.59) < 0.01 && Math.abs(drawn.position.z - 3.18) < 0.01,
    `drawn at ${drawn.position.x}, ${drawn.position.z}`);
  assert.equal(cameraFloorHeight(player, drawn.position, pivotZ, world), player.z + CAMERA_FEET_CLEARANCE,
    "there is no floor under where the camera actually stands, only the character's own feet");

  // And the clamp itself is untouched by any of this: a character standing on that first floor has
  // the camera held above it, which is the case the whole mechanism exists for.
  const upstairs = { x: -10, y: 0, z: 4, orientation: 0 };
  const above = rig({ pitch: 1.4 });
  for (let frame = 0; frame < 60; frame++) {
    advanceCameraFrame(above, upstairs, CAMERA_DEFAULT_PIVOT_HEIGHT, { collision: world }, FRAME);
    const standing = createCamera(upstairs, above.yaw, above.viewPitch, above.view, options);
    assert.ok(standing.position.z >= 4 + CAMERA_FLOOR_CLEARANCE - 1e-9,
      `a camera over the first floor stands at ${standing.position.z}, floor at ${4 + CAMERA_FLOOR_CLEARANCE}`);
  }
});

test("К2 walking a corner does not flash the view over for a frame", () => {
  // A wall comes into the boom all at once — that is the point of taking the camera in without
  // easing — so the arm can go from 21.31 yards to 3.92 between two frames. Whatever answers «how
  // low may the camera stand» has to be answering about the arm of *this* frame: asked under the
  // camera the last frame drew, the question is put 19.51 yards away on exactly the frame the
  // answer changes, and the drag's -23.75 degrees came out as -44.55 for one frame in sixty.
  // Measured over a 7 yd/s walk past the corner of a building with a first floor four yards up.
  const world = new CollisionWorld();
  world.set(1, new CollisionMesh(quad([-4, 0, -20], [-4, 60, -20], [-4, 60, 20], [-4, 0, 20])));
  world.set(2, new CollisionMesh(quad([-4, 0, 4], [-40, 0, 4], [-40, 60, 4], [-4, 60, 4])));
  const state = rig();
  const speed = 7;

  let previous = state.viewPitch;
  let worst = 0;
  let snapped = 0;
  let arm = state.view;
  for (let frame = 0; frame < 180; frame++) {
    const player = { x: 0, y: -5 + (frame * speed) / 60, z: 0, orientation: 0 };
    advanceCameraFrame(state, player, CAMERA_DEFAULT_PIVOT_HEIGHT, { collision: world }, FRAME);
    worst = Math.max(worst, Math.abs(state.viewPitch - previous));
    if (arm - state.view > 10) snapped++;
    previous = state.viewPitch;
    arm = state.view;
  }
  assert.equal(snapped, 1, "the walk has to actually take the camera in at once, or it measures nothing");
  assert.equal(worst, 0, `the view swung ${((worst * 180) / Math.PI).toFixed(2)} degrees in one frame`);
  assert.equal(state.viewPitch, state.pitch, "and it is the drag's own tilt at the end of the walk");
});

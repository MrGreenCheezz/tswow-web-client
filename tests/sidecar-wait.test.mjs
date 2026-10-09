import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ANIMATION_IDS } from "../dist/code/generated/animations.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";
import {
  UNIT_STAND_STATE_KNEEL, UNIT_STAND_STATE_SIT, UNIT_STAND_STATE_SLEEP, UNIT_STAND_STATE_STAND,
} from "../dist/code/world/CharacterProgressProtocol.js";
import {
  ACTION_SIDECAR_LIMIT, SIDECAR_WAIT_MARGIN, extendSidecarWait, poseExitClips, sidecarClaims,
} from "../dist/code/browser/SidecarWait.js";
import { pendingActionFate } from "../dist/code/browser/AnimatedModel.js";
import { UnitActionQueue } from "../dist/code/browser/UnitActionArbiter.js";

// 6.19 (line A7a, slice G2, 05.10): a pose asked for while its rig's sidecar (HumanMale 9.8 MB) is
// still on the wire is not dropped at the 3-second mark; it waits while the download is really in
// progress, to 8 seconds after it was asked for.

const SIDECAR_WAIT = 3_000;

function entry(now, { held = false, action = undefined, until } = {}) {
  return {
    layer: "emote", held, until: until ?? (now + SIDECAR_WAIT), sequence: 1, started: false,
    payload: {
      wanted: [ANIMATION_IDS.EmoteDance ?? 69], action, stage: "main", sequenceAt: 0,
      waitUntil: now + 900, sidecarWaitUntil: now + SIDECAR_WAIT, source: "external", waitingForClip: true,
    },
  };
}

test("a one-shot waiting on a sidecar in flight lives past three seconds, to the limit", () => {
  const queued = 1_000;
  const e = entry(queued);
  for (let now = queued; now < queued + 12_000; now += 100) {
    const fate = pendingActionFate({ hasClip: false, promised: true, sidecarInFlight: true, now,
      waitUntil: e.payload.waitUntil, sidecarWaitUntil: e.payload.sidecarWaitUntil });
    if (!(e.until > now) || fate === "drop") {
      assert.ok(now >= queued + ACTION_SIDECAR_LIMIT - 100, `dropped at ${now - queued} ms`);
      assert.ok(now <= queued + ACTION_SIDECAR_LIMIT + 100, `kept to ${now - queued} ms`);
      return;
    }
    extendSidecarWait(e, now, true);
  }
  assert.fail("never dropped");
});

test("nothing in flight, nothing extended: the old three seconds", () => {
  const e = entry(0);
  assert.equal(extendSidecarWait(e, 2_900, false), false);
  assert.equal(e.until, SIDECAR_WAIT);
  assert.equal(e.payload.sidecarWaitUntil, SIDECAR_WAIT);
});

test("a shot is never extended, a started pose neither", () => {
  const shot = entry(0, { action: "shoot" });
  assert.equal(extendSidecarWait(shot, 2_000, true), false);
  assert.equal(shot.until, SIDECAR_WAIT);
  const started = entry(0);
  started.started = true;
  assert.equal(extendSidecarWait(started, 2_000, true), false);
});

test("a hold keeps its authored end; only its keyframe wait grows", () => {
  const hold = entry(0, { held: true, until: 5_000 });
  extendSidecarWait(hold, 2_900, true);
  assert.equal(hold.until, 5_000, "a cast ends when the cast ends");
  assert.equal(hold.payload.sidecarWaitUntil, 2_900 + SIDECAR_WAIT_MARGIN);
  extendSidecarWait(hold, 4_500, true);
  assert.equal(hold.payload.sidecarWaitUntil, 5_000, "never past the hold's own end");
  const stun = entry(0, { held: true, until: Number.POSITIVE_INFINITY });
  extendSidecarWait(stun, 7_900, true);
  assert.equal(stun.payload.sidecarWaitUntil, ACTION_SIDECAR_LIMIT, "a flag stun waits to the limit too");
});

test("the queue keeps the extended one-shot: expire() reads the new deadline", () => {
  const queue = new UnitActionQueue();
  const now = 0;
  const kept = queue.submit({ layer: "emote", held: false, until: now + SIDECAR_WAIT,
    payload: entry(0).payload }, now);
  extendSidecarWait(kept, 2_950, true);
  queue.expire(3_100);
  assert.equal(queue.size, 1);
  queue.expire(2_950 + SIDECAR_WAIT_MARGIN + 1);
  assert.equal(queue.size, 0);
});

test("the way out of a pose is asked for while the unit is in it", () => {
  const pose = (standState, movementFlags = 0) => ({ dead: false, movementFlags, spline: false, standState });
  const has = (list, name) => ANIMATION_IDS[name] === undefined || list.includes(ANIMATION_IDS[name]);
  assert.ok(has(poseExitClips(pose(UNIT_STAND_STATE_KNEEL)), "KneelEnd"));
  assert.ok(has(poseExitClips(pose(UNIT_STAND_STATE_SLEEP)), "SleepUp"));
  assert.ok(has(poseExitClips(pose(UNIT_STAND_STATE_SIT)), "SitGroundUp"));
  const air = poseExitClips(pose(UNIT_STAND_STATE_STAND, MOVEMENT_FLAGS.falling));
  assert.ok(has(air, "JumpLandRun") && has(air, "JumpEnd"));
  assert.equal(poseExitClips(pose(UNIT_STAND_STATE_STAND)).length, 0);
  assert.equal(poseExitClips({ ...pose(UNIT_STAND_STATE_KNEEL), dead: true }).length, 0);
  assert.equal(poseExitClips(pose(UNIT_STAND_STATE_STAND)), poseExitClips(pose(UNIT_STAND_STATE_STAND)), "no allocation");
});

test("an exact claim: JumpLandRun is asked for although its fallback Run is built", () => {
  const landRun = ANIMATION_IDS.JumpLandRun ?? 187;
  const run = ANIMATION_IDS.Run ?? 5;
  const template = { clips: new Map([[run, {}]]), animations: new Set([run, landRun]), merged: false };
  assert.equal(sidecarClaims(template, [landRun]), true);
  assert.equal(sidecarClaims({ ...template, merged: true }, [landRun]), false, "one fetch per model");
  assert.equal(sidecarClaims({ ...template, animations: new Set([run]) }, [landRun]), false, "not claimed");
  assert.equal(sidecarClaims({ ...template, clips: new Map([[landRun, {}]]) }, [landRun]), false, "built");
});

test("the renderer extends at the top of #entryAnimation and asks for the exits in #poseBase", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const entryAnimation = source.slice(source.indexOf("  #entryAnimation("), source.indexOf("  #startUnitAction("));
  assert.match(entryAnimation, /extendSidecarWait\(entry, now,/);
  assert.ok(entryAnimation.indexOf("extendSidecarWait") < entryAnimation.indexOf("pendingActionExpired"),
    "before the deadlines are read");
  const poseBase = source.slice(source.indexOf("  #poseBase("), source.indexOf("  #playAnimation("));
  assert.match(poseBase, /poseExitClips\(pose\)/);
});

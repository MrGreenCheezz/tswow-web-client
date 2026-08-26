import assert from "node:assert/strict";
import test from "node:test";
import {
  DOODAD_ANIMATION_BUDGET, DOODAD_ANIMATION_RANGE, ENVIRONMENT_RANGE, GAMEOBJECT_BUDGET,
  GAMEOBJECT_RANGE, MODEL_RANGE, drawableModel, selectEnvironment, standInKind,
  failedVisualEffectPhaseKeys, visualEffectContentVisible, visualEffectPhaseKey, visualEffectPhaseStatuses,
  rejectedVisualEffectGroups, selectVisualEffectGroups,
  spellEffectPrimeSeconds,
  spellEffectNeedsFirstBurst,
  spellEffectPhaseOrigin,
  visualAnimationIsDue, visualFlightProgress, visualHasStarted, visualPlaybackOrigin, visualPlaybackWindow,
  spellVisualFlightQuaternion, unitContentVisible,
} from "../dist/code/browser/WorldRenderer3D.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { UNIT_FLAG_UNINTERACTIBLE } from "../dist/code/world/FactionRules.js";
import { expiredInstances } from "../dist/code/browser/SpellVisuals.js";
import { animatesAsDoodad } from "../dist/code/browser/AnimatedModel.js";
import { GameObjectMetadataClient } from "../dist/code/browser/GameObjectMetadata.js";
import { modelOwnTexturePaths } from "../dist/code/browser/Wvm.js";
import * as THREE from "three";
import { readFile } from "node:fs/promises";

test("spell asset enumeration includes mesh, particle and ribbon maps exactly once", () => {
  const model = {
    batches: [{ textures: [0, 1] }, { textures: [0] }],
    particleEmitters: [{ texture: 2 }],
    ribbonEmitters: [{ textures: Uint16Array.of(3, 2) }],
    textures: [
      { type: 0, path: "spells\\judgement_mesh.blp" },
      { type: 1, path: "character\\skin.blp" },
      { type: 0, path: "spells\\judgement_particles.blp" },
      { type: 0, path: "spells\\judgement_ribbon.blp" },
    ],
  };
  assert.deepEqual(modelOwnTexturePaths(model), [
    "spells\\judgement_mesh.blp", "spells\\judgement_particles.blp", "spells\\judgement_ribbon.blp",
  ]);
});

test("V4 future spell visuals are hidden until start, expire at the endpoint, and clamp flight", () => {
  const instance = {
    path: "future.m2", scale: 1, attachment: -1,
    startedAt: 100, endsAt: 300,
    flight: { from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 20, z: 30 } },
  };
  assert.equal(visualHasStarted(instance, 99), false);
  assert.equal(visualHasStarted(instance, 100), true);
  assert.equal(visualHasStarted(instance, 300), true,
    "the node remains active through its authored end, then expiry removes it");
  assert.deepEqual(expiredInstances([instance], 300), [0]);
  assert.equal(visualFlightProgress(instance, 0), 0);
  assert.equal(visualFlightProgress(instance, 200), 0.5);
  assert.equal(visualFlightProgress(instance, 999), 1);
});

test("spell missiles turn their M2 +X axis toward the full 3D flight tangent", async () => {
  const from = { x: 0, y: 0, z: 0 };
  const to = { x: 30, y: 8, z: 10 };
  const rotation = spellVisualFlightQuaternion(from, to, 0.5);
  const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(rotation).normalize();
  const expected = new THREE.Vector3(30, 10, -8).normalize();
  assert.ok(forward.distanceTo(expected) < 1e-6,
    `expected scene direction ${expected.toArray()}, got ${forward.toArray()}`);
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /M2_FROM_SCENE = M2_TO_SCENE\.clone\(\)\.invert\(\)/,
    "attached skinned effects cancel the model-to-scene turn already present in a unit bone matrix");
  assert.match(source, /visual\.frame\.quaternion\.copy\(visual\.skinned \? M2_FROM_SCENE : IDENTITY_QUATERNION\)/,
    "plain and skinned target attachments use different inner model frames");
});

test("V4 future visual animations are not early and are consumed once by the renderer queue", async () => {
  const animation = { guid: 1n, animation: 7, at: 200, hold: 500 };
  assert.equal(visualAnimationIsDue(animation, 199), false);
  assert.equal(visualAnimationIsDue(animation, 200), true);
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /#pendingVisualAnimations\.splice\(index, 1\)/,
    "a due animation is removed before it is scheduled, preventing replay");
  assert.match(source, /#setUnitAnimation\(pending\.animation, "visual",[\s\S]*pending\.handle\)/,
    "future impact animations are dispatched only when due");
});

test("V5 spell effect budget never alternates between halves of one composite kit", () => {
  const entries = [
    { key: "impact", handleId: 10, distance: 10 },
    { key: "missile", handleId: 10, distance: 10.001 },
    { key: "cast", handleId: 10, distance: 10.002 },
    { key: "other", handleId: 11, distance: 11 },
  ];
  const first = selectVisualEffectGroups(entries, 3);
  assert.deepEqual(first.selected.map((entry) => entry.key), ["impact", "missile", "cast"]);
  assert.equal(first.droppedGroups, 1);
  // A tiny distance change cannot reorder the same handle's members or make one part appear alone.
  const second = selectVisualEffectGroups(entries.map((entry) => ({
    ...entry, distance: entry.key === "impact" ? 10.003 : entry.distance,
  })), 3);
  assert.deepEqual(second.selected.map((entry) => entry.key), ["missile", "cast", "impact"]);
  assert.equal(second.selected.every((entry) => entry.handleId === 10), true);
  const oversized = selectVisualEffectGroups(
    Array.from({ length: 25 }, (_, index) => ({ key: `oversized-${index}`, handleId: 12, distance: index })),
    24,
  );
  assert.equal(oversized.selected.length, 0, "an oversized kit cannot bypass the hard budget");
  assert.equal(oversized.droppedGroups, 1);
});

test("V5 composite effect groups wait for all active models before budget admission", () => {
  const now = 500;
  const phase = visualEffectPhaseKey(14, 100);
  const loaded = [
    { key: "cast", handleId: 14, phaseKey: phase, distance: 10 },
    { key: "missile", handleId: 14, phaseKey: phase, distance: 11 },
  ];
  const partialStatuses = visualEffectPhaseStatuses([
    { phaseKey: phase, startedAt: 100, modelReady: true, activeUntil: 1_000, loadDeadline: 900 },
    { phaseKey: phase, startedAt: 100, modelReady: false, activeUntil: 1_000, loadDeadline: 900 },
  ], now);
  assert.equal(partialStatuses.get(phase), "pending",
    "a loaded subset is pending while one model is within load grace");
  assert.equal(selectVisualEffectGroups(loaded, 4, new Set()).selected.length, 0,
    "the loaded half does not start on its own");

  const texturePendingStatuses = visualEffectPhaseStatuses([
    { phaseKey: phase, startedAt: 100, modelReady: true, assetsReady: false,
      activeUntil: 1_000, loadDeadline: 900 },
    { phaseKey: phase, startedAt: 100, modelReady: true, assetsReady: true,
      activeUntil: 1_000, loadDeadline: 900 },
  ], now);
  assert.equal(texturePendingStatuses.get(phase), "pending",
    "a WVM-ready phase stays hidden while one mesh/particle texture is still loading");
  assert.equal(visualEffectPhaseStatuses([
    { phaseKey: phase, startedAt: 100, modelReady: true, assetsReady: false, assetsFailed: true,
      activeUntil: 1_000, loadDeadline: 900 },
    { phaseKey: phase, startedAt: 100, modelReady: true, assetsReady: true,
      activeUntil: 1_000, loadDeadline: 900 },
  ], now).get(phase), "failed",
    "a texture failure suppresses the complete phase instead of admitting its visible sibling");
  assert.equal(visualEffectPhaseStatuses([
    { phaseKey: phase, startedAt: 100, modelReady: true, assetsReady: true,
      activeUntil: 1_000, loadDeadline: 900, phaseStatus: "failed" },
    { phaseKey: phase, startedAt: 100, modelReady: true, assetsReady: true,
      activeUntil: 1_000, loadDeadline: 900, phaseStatus: "failed" },
  ], now).get(phase), "failed",
    "a late texture callback cannot resurrect a phase that already failed");

  const shortAfterAuthoredEnd = visualEffectPhaseStatuses([
    { phaseKey: phase, startedAt: 100, modelReady: true, activeUntil: 150, loadDeadline: 900 },
    { phaseKey: phase, startedAt: 100, modelReady: false, activeUntil: 150, loadDeadline: 900 },
  ], now);
  assert.equal(shortAfterAuthoredEnd.get(phase), "pending",
    "request grace keeps a short loaded sibling in the phase after its authored end");

  const allLoadedAfterAuthoredEnd = visualEffectPhaseStatuses([
    { phaseKey: phase, startedAt: 100, modelReady: true, activeUntil: 150, loadDeadline: 900,
      phaseStatus: "pending", rebasable: true },
    { phaseKey: phase, startedAt: 100, modelReady: true, activeUntil: 150, loadDeadline: 900,
      phaseStatus: "pending", rebasable: true },
  ], now);
  assert.equal(allLoadedAfterAuthoredEnd.get(phase), "ready",
    "all-ready short members settle together so the renderer can install one shared origin");

  const missileTimeoutWithActiveSibling = visualEffectPhaseStatuses([
    { phaseKey: phase, startedAt: 100, modelReady: true, activeUntil: Number.POSITIVE_INFINITY,
      loadDeadline: 400, phaseStatus: "pending", rebasable: false },
    { phaseKey: phase, startedAt: 100, modelReady: false, activeUntil: 150, loadDeadline: 400,
      phaseStatus: "pending", rebasable: false },
  ], now);
  assert.equal(missileTimeoutWithActiveSibling.get(phase), "failed",
    "a timed-out missile member fails the active sibling too instead of admitting a partial kit");
  assert.equal(visualEffectPhaseStatuses([
    { phaseKey: phase, startedAt: 100, modelReady: true, activeUntil: Number.POSITIVE_INFINITY,
      rebasable: false },
    { phaseKey: phase, startedAt: 100, modelReady: false, activeUntil: Number.POSITIVE_INFINITY,
      rebasable: false },
  ], now).get(phase), "failed",
    "a missile without a bounded readiness deadline fails instead of waiting forever");

  assert.equal(visualEffectPhaseStatuses([
    { phaseKey: phase, startedAt: 100, modelReady: true, activeUntil: Number.POSITIVE_INFINITY,
      phaseStatus: "failed", rebasable: false },
    { phaseKey: phase, startedAt: 100, modelReady: true, activeUntil: Number.POSITIVE_INFINITY,
      phaseStatus: "failed", rebasable: false },
  ], now).get(phase), "failed",
    "a late response cannot resurrect a persistently failed phase");

  const readyStatuses = visualEffectPhaseStatuses([
    { phaseKey: phase, startedAt: 100, modelReady: true, activeUntil: 1_000, loadDeadline: 900 },
    { phaseKey: phase, startedAt: 100, modelReady: true, activeUntil: 1_000, loadDeadline: 900 },
  ], now);
  assert.equal(readyStatuses.get(phase), "ready");
  assert.equal(selectVisualEffectGroups(loaded, 4, new Set([phase])).selected.length, 2,
    "all loaded kit members start together once the group is ready");
  const timedOutStatuses = visualEffectPhaseStatuses([
    { phaseKey: phase, startedAt: 100, modelReady: true, activeUntil: 1_000, loadDeadline: 400 },
    { phaseKey: phase, startedAt: 100, modelReady: false, activeUntil: 1_000, loadDeadline: 400 },
  ], now);
  assert.equal(timedOutStatuses.get(phase), "failed",
    "a timed-out member fails and suppresses the entire phase");
  assert.equal(selectVisualEffectGroups(loaded, 4, new Set()).selected.length, 0,
    "successful siblings remain suppressed after a terminal timeout");
  assert.equal(visualEffectPhaseStatuses([
    { phaseKey: phase, startedAt: 100, modelReady: true, activeUntil: 100 },
    { phaseKey: phase, startedAt: 100, modelReady: false, activeUntil: 100 },
  ], now).has(phase), false, "an expired phase has no active barrier");
  const future = visualEffectPhaseKey(14, 900);
  const current = visualEffectPhaseStatuses([
    { phaseKey: phase, startedAt: 100, modelReady: true, activeUntil: 1_000 },
    { phaseKey: future, startedAt: 900, modelReady: false, activeUntil: 1_500, loadDeadline: 1_200 },
  ], now);
  assert.equal(current.get(phase), "ready", "a future impact phase does not hold the current cast");
  assert.equal(current.has(future), false);
  assert.equal(visualEffectPhaseStatuses([
    { phaseKey: phase, startedAt: 100, modelReady: true, activeUntil: 1_000, failed: true },
    { phaseKey: phase, startedAt: 100, modelReady: true, activeUntil: 1_000, failed: true },
  ], now).get(phase), "failed", "a late model response cannot resurrect a failed phase");
  const hold = visualEffectPhaseKey(15, 0);
  assert.equal(visualEffectPhaseStatuses([
    { phaseKey: hold, startedAt: 0, modelReady: false, activeUntil: Number.POSITIVE_INFINITY, loadDeadline: 800 },
  ], now).get(hold), "pending", "a persistent aura gets the same bounded load grace");
  assert.equal(visualEffectPhaseStatuses([
    { phaseKey: hold, startedAt: 0, modelReady: false, activeUntil: Number.POSITIVE_INFINITY, loadDeadline: 400 },
  ], now).get(hold), "failed", "an aura missing past grace is terminal for this cast");
  assert.equal(visualEffectContentVisible(true, "pending"), false,
    "pending phase geometry stays hidden while the parent remains transformable");
  assert.equal(visualEffectContentVisible(true, "failed"), false,
    "failed phase geometry stays hidden with its emitters");
  assert.equal(visualEffectContentVisible(true, "ready"), true);
});

test("V5 failed phases purge every owned member before late model fetch", async () => {
  const failedPhase = visualEffectPhaseKey(21, 100);
  const otherPhase = visualEffectPhaseKey(22, 100);
  const entries = [
    { key: "cast", phaseKey: failedPhase, phaseStatus: "failed" },
    { key: "missile", phaseKey: failedPhase, phaseStatus: "ready" },
    { key: "other", phaseKey: otherPhase, phaseStatus: "ready" },
  ];
  const failed = failedVisualEffectPhaseKeys(entries);
  assert.deepEqual([...failed], [failedPhase], "only the terminal phase is selected for purge");
  assert.deepEqual(entries.filter((entry) => failed.has(entry.phaseKey)).map((entry) => entry.key),
    ["cast", "missile"], "all members of the failed phase are removed together");

  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const sweep = source.indexOf("this.#purgeFailedSpellEffectPhases();");
  const modelFetch = source.indexOf("const model = client?.model");
  assert.ok(sweep >= 0 && modelFetch > sweep,
    "failed-phase purge runs before the model loader can consume a late response");
});

test("V5 emitter budget hides the whole spell kit, including non-emitter mesh members", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /const selectedSpellGroups = new Set\(selectedVisuals\.map/,
    "budget admission is recorded per spell phase rather than per emitter node");
  assert.match(source, /const phaseEmitterGroups = new Set\(this\.#visuals/,
    "all WVM members, including out-of-range emitters, associate mesh siblings with the same phase");
  assert.match(source, /const groupSelected = !hasEmitterMember \|\| selectedSpellGroups\.has/,
    "a rejected emitter group also hides its hammer/mesh sibling");
  assert.match(source, /visual\.frame\.visible = visualEffectContentVisible\(visual\.node\.visible, phaseStatus\)\s*&& groupSelected && groupAdmitted/,
    "mesh visibility is released only after budget and root/range admission");
  const budget = source.indexOf("const budgeted = selectVisualEffectGroups(");
  const origin = source.indexOf("Install the shared local origin only after the effect budget");
  assert.ok(budget >= 0 && origin > budget,
    "a ready-but-unselected kit cannot age before budget admission");
  assert.match(source, /if \(!admitted\) \{\s*visual\.phaseOriginAt = undefined;/,
    "rejected phases reset their release origin for a fresh full-cycle replay");
});

test("V6 mixed-distance and missing-root members reject one spell phase atomically", () => {
  const judgement = "20271:20271:500";
  const rejected = rejectedVisualEffectGroups([
    // The close impact emitter is otherwise a valid budget candidate.
    { groupKey: judgement, due: true, rootVisible: true, hasEmitter: true, distance: 12 },
    // A second authored emitter/mesh member is outside the range. The close half must not start.
    { groupKey: judgement, due: true, rootVisible: true, hasEmitter: true, distance: 91 },
  ], 90);
  assert.deepEqual([...rejected], [judgement],
    "Judgement with a near emitter and far emitter+mesh is paused as one phase");

  const emitterOnly = "53407:53407:500";
  assert.deepEqual([...rejectedVisualEffectGroups([
    { groupKey: emitterOnly, due: true, rootVisible: true, hasEmitter: true, distance: 91 },
  ], 90)], [emitterOnly], "an emitter-only phase outside range is rejected");

  const meshOnly = "53408:53408:500";
  assert.equal(rejectedVisualEffectGroups([
    { groupKey: meshOnly, due: true, rootVisible: true, hasEmitter: false, distance: 91 },
  ], 90).has(meshOnly), false, "a mesh-only phase has no emitter-range admission constraint");

  const missingRoot = "20271:20271:600";
  assert.deepEqual([...rejectedVisualEffectGroups([
    { groupKey: missingRoot, due: true, rootVisible: false, hasEmitter: true, distance: 12 },
  ], 90)], [missingRoot], "a due attachment without a root cannot admit a sibling");
  assert.equal(rejectedVisualEffectGroups([
    { groupKey: missingRoot, due: false, rootVisible: false, hasEmitter: true, distance: 91 },
  ], 90).has(missingRoot), false, "future hidden members do not reject before their phase is due");
});

test("V5 newly resolved finite effects keep age zero for an emitter-aware first burst", () => {
  const finite = { fitToModel: true, flight: undefined, modelPlayback: "once" };
  assert.equal(spellEffectPrimeSeconds(finite, 0), 0,
    "rebased finite one-shots remain at authored age zero");
  assert.equal(spellEffectPrimeSeconds(finite, 700), 0.7,
    "an already-aged one-shot catches up to its real local age");
  assert.equal(spellEffectPrimeSeconds(finite, 5_000), 1,
    "async priming is bounded even when a model response is very late");
  assert.equal(spellEffectPrimeSeconds({ fitToModel: false, flight: {}, modelPlayback: "once" }, 0), 0,
    "a missile is not given an artificial burst that changes its travel timeline");
  assert.equal(spellEffectPrimeSeconds({ fitToModel: true, flight: undefined, modelPlayback: "hold" }, 0), 0,
    "held/aura visuals keep their packet clock");
  const startedAt = 100;
  const firstFrameAgeMs = 16;
  const preloadedPrime = spellEffectPrimeSeconds(finite, firstFrameAgeMs, startedAt, startedAt);
  assert.equal(preloadedPrime, 0,
    "a preloaded one-shot's positive first-RAF age is not treated as async catch-up");
  assert.equal(spellEffectNeedsFirstBurst(finite, true, startedAt, startedAt, firstFrameAgeMs, preloadedPrime), true,
    "a preloaded finite one-shot gets the explicit first burst on its first visible RAF");
  assert.equal(spellEffectNeedsFirstBurst({ fitToModel: false, flight: { from: {}, to: {} }, modelPlayback: "once" }, true, startedAt, startedAt, 0, 0), false,
    "missiles do not receive a second burst after their local clock starts");
  assert.equal(spellEffectNeedsFirstBurst({ fitToModel: true, flight: undefined, modelPlayback: "hold" }, true, startedAt, startedAt, 0, 0), false,
    "held/aura visuals do not receive a one-shot burst");
  assert.equal(spellEffectPrimeSeconds(finite, firstFrameAgeMs, 600, startedAt), firstFrameAgeMs / 1000,
    "an effect resolved after its start keeps its real local age");
  assert.equal(spellEffectNeedsFirstBurst(finite, true, 600, startedAt, firstFrameAgeMs, firstFrameAgeMs / 1000), false,
    "aged finite effects use catch-up instead of an extra first burst");
  assert.equal(spellEffectNeedsFirstBurst(finite, true, startedAt, startedAt, 0, 0.1), false,
    "catch-up and first-burst paths cannot both be selected");
  assert.equal(spellEffectNeedsFirstBurst(finite, true, 600, startedAt, 0, 0), true,
    "a late model rebased on its resolve frame gets one burst only at age zero");
  assert.equal(spellEffectNeedsFirstBurst(finite, false, startedAt, startedAt, 700, 0), false,
    "a preloaded effect admitted after a budget delay catches up instead of replaying at t=0");
  assert.equal(spellEffectPrimeSeconds(finite, 700, startedAt, startedAt, false), 0.7,
    "a delayed preloaded admission keeps real age for bounded catch-up");
  const release = 300;
  const firstOrigin = spellEffectPhaseOrigin(finite, release, 150);
  const secondOrigin = spellEffectPhaseOrigin(finite, release, 250);
  assert.equal(firstOrigin, release);
  assert.equal(secondOrigin, release);
  assert.equal(spellEffectPrimeSeconds(finite, 0, firstOrigin, startedAt, true), 0,
    "the first finite member uses the shared phase release origin");
  assert.equal(spellEffectPrimeSeconds(finite, 0, secondOrigin, startedAt, true), 0,
    "the later finite member uses the same shared phase release origin");
});

test("V4 cold-loaded one-shot VFX rebase their local clock and retain a full window", () => {
  const instance = {
    path: "late.m2", scale: 1, attachment: -1,
    startedAt: 100, endsAt: 800, fitToModel: true,
  };
  assert.equal(visualPlaybackOrigin(instance, 50), 100,
    "a model resolved before its authored start keeps the schedule origin");
  assert.equal(visualPlaybackOrigin(instance, 600), 600,
    "a cold model resolved after start begins its local one-shot clock at resolve");
  assert.equal(visualPlaybackWindow(instance, 1_200), 1_200,
    "late loading retains the bounded model clip rather than only the authored tail");
});

test("V4 visual effects gate emitters and follow moving roots, while explicit positions stay static", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /if \(!visual\.node\.visible\) continue;/,
    "future or unavailable root-bound visuals cannot advance particles at the origin");
  assert.match(source, /instance\.anchor !== undefined && instance\.attachment < 0/,
    "world-bound state effects use a distinct root-following branch");
  assert.match(source, /root\.matrixWorld\.decompose\(visual\.node\.position, visual\.node\.quaternion/,
    "root-bound effects read the unit's current world transform each frame");
  assert.match(source, /const at = instance\.position;/,
    "area effects with an explicit point retain their static placement fallback");
});

test("V4 spell unit clips run once for their full duration and lead into held primaries", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /next\.setLoop\(wantedLoop, Infinity\)/);
  assert.match(source, /fullDuration \? 0 : ANIMATION_BLEND \* 1000/,
    "visual one-shots are not shortened by the crossfade blend");
  assert.match(source, /if \(pending\.sequenceAt === 0\)/,
    "lead-in timing is armed once and cannot move every frame");
  assert.match(source, /pending\.sequence\?\.mode === "hold"/,
    "a precast lead-in retains ownership of the held primary");
  assert.match(source, /if \(unit\.action\.loop === wantedLoop && unit\.action\.isRunning\(\)\) return;/,
    "same-id lead-ins avoid restarting a running action");
  assert.match(source, /unit\.action\.setLoop\(wantedLoop, Infinity\)/,
    "same-id lead-ins still switch LoopOnce to LoopRepeat for the primary");
});

test("V4 spell M2 effects use a local clock and a skinned emitter rig", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /buildSkinnedTemplateFrom\(built\.geometry, rig, built\.height\)/,
    "a spell skeleton is built through the normal skinned path");
  assert.match(source, /instantiateSkinned\(visual\.template, built\.materials\)/,
    "spell M2s get a mixer and bone matrices even when they have no mesh vertices");
  assert.match(source, /new THREE\.AnimationClip\("spell-default", 1, \[\]\)/,
    "a bone-only spell still gets a deterministic default clip");
  assert.match(source, /now - \(entry\.spell\.playbackStartedAt \?\? entry\.spell\.instance\.startedAt\)/,
    "late model responses do not seed particle tracks from wall-clock time");
  assert.match(source, /MODEL_VFX_MAX_MS/,
    "model-derived lifetime is bounded");
  assert.match(source, /visual\.loadDeadline = undefined;/,
    "a successful non-rig WVM does not retain the request grace as its lifetime");
  assert.match(source, /const modelLoop = instance\.modelPlayback === "hold"/,
    "packet-held and aura-owned model clips have explicit looping semantics");
  assert.match(source, /applyBillboardBones\(visual\.skinned, visual\.template, this\.#camera\)/,
    "spell skinned rigs update billboard bones after their mixer step");
  assert.match(source, /Math\.max\(now, instance\.startedAt\) \+ MODEL_VFX_LOAD_GRACE_MS/,
    "future visuals receive loading grace from their scheduled start");
  assert.match(source, /visual\.authoredEndsAt = visual\.instance\.endsAt/,
    "retiming a finite fit-to-model visual survives a later model resolve");
  assert.match(source, /visualPlaybackOrigin\(instance, now\)/,
    "cold-loaded one-shot clips use an explicit playback origin");
  assert.match(source, /visualPlaybackWindow\(instance, modelMs, visual\.authoredEndsAt\)/,
    "model lifetime is measured from the actual playback origin");
  assert.match(source, /const built = buildModel\(model\.wvm,/,
    "spell mesh materials are per visual rather than shared with the scenery cache");
  assert.match(source, /updateBatchColours\(visual\.built\.animatedBatches, Math\.max\(0, now - origin\), now\)/,
    "spell mesh alpha/weight tracks use the local phase age");
});

test("V4 visual cleanup and cancellation are ownership-scoped", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /playSpellVisual\(plan: SpellVisualPlan\): SpellVisualHandle/);
  assert.match(source, /cancelSpellVisual\(handle: SpellVisualHandle\)/);
  assert.match(source, /retimeSpellVisual\(handle: SpellVisualHandle, endsAt: number\)/);
  assert.match(source, /pending\.animation\.hold = Math\.max\(0, endsAt - pending\.animation\.at\)/,
    "retiming a cast also updates pending scheduled animation duration");
  assert.match(source, /if \(action\.visualHandle !== handle\) continue;/,
    "retiming a cast updates the absolute held-action deadline");
  assert.match(source, /const hold = loop && animation\.hold > 0 \? at \+ animation\.hold : 0;/,
    "a late frame cannot shift a visual hold window forward");
  assert.match(source, /if \(visual\.handle !== handle\) continue;/,
    "cancelling one cast cannot remove another cast's nodes");
  assert.match(source, /if \(action\.visualHandle !== handle\) continue;/,
    "cancelling one cast cannot remove another cast's pending action");
  assert.match(source, /clearSpellVisuals\(\): void/);
  assert.match(source, /if \(action\.source !== "visual"\) continue;/,
    "clearSpellVisuals leaves ordinary locomotion/actions alone");
  assert.match(source, /cancelUnitAction\(guid: bigint\): void/);
  assert.match(source, /if \(!pending\?\.cancelable\) return;/,
    "ordinary one-shots are not interrupted by the held-action cancel seam");
});

test("Ж4.3 nothing is ranked into the scene only to be drawn as a stand-in", () => {
  // The two radii used to be 180 and 230; the live exterior radius is now 300, and the old gap was
  // a band where a placement was selected, kept and then drawn as a grey cone because its model was never
  // fetched. Probed across the world that band held a stand-in on 67% of points and averaged 36
  // of them per point — a permanent ring of cones around a standing player.
  assert.equal(MODEL_RANGE, ENVIRONMENT_RANGE,
    "a placement close enough to be drawn is close enough to have its model");

  // And raising it does not draw more: what a placement is drawn *as* is a different decision
  // from whether it is drawn at all, and the second one is the budget's.
  const objects = Array.from({ length: 40 }, (_, index) => ({
    id: index, kind: "m2", name: `Doodad${index}.m2`,
    x: index * 6, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
  }));
  const ranked = selectEnvironment(objects, { x: 0, y: 0, z: 0, orientation: 0 });
  for (const { distance } of ranked) {
    assert.ok(distance <= ENVIRONMENT_RANGE, `${distance} is past the selection radius`);
  }
});

test("Ж0 a building with no model yet is drawn as nothing — not as a box, not as a hull", async () => {
  // The player's «серый куб в Оргриммаре». Both halves are here because both had to go: the box
  // was what a placement with `bounds` and no model was drawn as, and the collision hull was what
  // it was drawn as when the model request came back with something unusable.
  //
  // The six real MODF extents over Orgrimmar's four tiles (map 1, grids 28-39, 28-40, 29-39,
  // 29-40), read out of the published tiles: the city, Ragefire's cave mouth, two zeppelin houses
  // and two orc huts. Of 3,131 placements those six are the only ones carrying bounds, and all six
  // are WMOs, because `tools/adt-placements.mjs` writes the field for nothing else.
  const orgrimmar = [
    { name: "WORLD\\WMO\\AZEROTH\\BUILDINGS\\OGRIMMAR\\OGRIMMAR.WMO", size: [1270.1, 1406.4, 268.8] },
    { name: "WORLD\\WMO\\KALIMDOR\\MD_WARMCAVE\\MD_WARMCAVE.WMO", size: [167.3, 242.1, 130.3] },
    { name: "WORLD\\WMO\\KALIMDOR\\ORCZEPPELINHOUSE.WMO", size: [76.4, 75.5, 45.7] },
    { name: "WORLD\\WMO\\KALIMDOR\\ORCZEPPELINHOUSE_DUROTAR01.WMO", size: [68.4, 65.6, 45.7] },
    { name: "WORLD\\WMO\\KALIMDOR\\ORCHUT.WMO", size: [37.5, 36.4, 22.7] },
    { name: "WORLD\\WMO\\KALIMDOR\\ORCHUT02.WMO", size: [43.3, 43.5, 22.7] },
  ];
  for (const { name, size } of orgrimmar) {
    const placement = {
      id: 1, kind: "wmo", name, x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: size[0], maxY: size[1], maxZ: size[2] },
    };
    assert.equal(standInKind(placement), "none", `${name} is still drawn as something`);
  }
  // A tree keeps an honest vegetation silhouette. Generic doodads do not expose loader state as a
  // cone: they remain empty until their authored model arrives.
  assert.equal(standInKind({ name: "World\\NoDXT\\Detail\\ElwynnTree01.m2", x: 0, y: 0, z: 0, scale: 1 }), "tree");
  assert.equal(standInKind({ name: "World\\Azeroth\\Elwynn\\Crate01.m2", x: 0, y: 0, z: 0, scale: 1 }), "none");

  // The hull. `/environment/model/<basename>` answers with the server's own vmap geometry — bare
  // vertices and indices, no textures, no groups, no `visual` flag — and the environment path drew
  // whatever came back, so a failed `/visual/model` for Orgrimmar painted 283,165 vertices and
  // 379,079 triangles of collision shell in flat tan. The game-object path has refused that since
  // «серые коробки больше не рисуются вовсе»; now one predicate answers for both.
  assert.equal(drawableModel({ vertices: [0, 0, 0], indices: [0, 0, 0] }), false, "a collision hull is not art");
  assert.equal(drawableModel(undefined), false, "and neither is a model that has not come back");
  assert.equal(drawableModel({ vertices: [], indices: [], visual: true }), true);
  assert.equal(drawableModel({ vertices: [], indices: [], wvm: {} }), true);
  assert.equal(drawableModel({ vertices: [], indices: [], wmo: {} }), true);

  // And there is no cube in the renderer at all any more. A grep for every `new THREE.*Geometry`
  // in `src/browser` used to return exactly one `BoxGeometry`, at the declaration that fed the
  // branch above; with the branch gone the geometry is dead, so the honest guard is that neither
  // comes back — the shape being guarded against is one line, restored by hand, in one file.
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.equal(source.includes("BoxGeometry"), false,
    "the only cube this renderer could draw is back");
});

test("server-invisible units hide only their synthetic capsule", () => {
  const object = {
    guid: 2n,
    typeId: 3,
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, UNIT_FLAG_UNINTERACTIBLE]]),
  };
  assert.equal(unitContentVisible(object, false, false, true), false,
    "a spell trigger must not expose the renderer's capsule");
  assert.equal(unitContentVisible(object, false, false, false), true,
    "authored model content remains visible after the stand-in body is removed");
  assert.equal(unitContentVisible(object, true, false, true), true,
    "the player is not hidden by a transient server flag");
  assert.equal(unitContentVisible(object, true, true, false), false,
    "first person still hides the player's authored body");
});

test("Ж4.2 the game-object budget is a budget and not a radius", () => {
  // The radius was a bare literal inside a filter and there was no budget at all, so the worst
  // measured circle in a city built and posed 739 nodes on every frame.
  assert.ok(GAMEOBJECT_RANGE > 0);
  assert.ok(GAMEOBJECT_BUDGET > 0);
  assert.ok(GAMEOBJECT_BUDGET < 739,
    "a budget that could hold the worst measured circle is not a budget");
  // Animating scenery is the most expensive thing in this file per object, so its own radius has
  // to be tighter than the one that merely draws.
  assert.ok(DOODAD_ANIMATION_RANGE < GAMEOBJECT_RANGE);
  assert.ok(DOODAD_ANIMATION_BUDGET < GAMEOBJECT_BUDGET);
});

test("Ж4.4 a rig is what a doodad needs, and the gate asks for exactly that", () => {
  // Every doodad is built with the skinned flag off, so a model with a wing-flap in it is drawn
  // in its bind pose and stands there. The gate is deliberately the weakest test that means
  // anything: bones, and something to play.
  const rig = (parents, animations, clips = []) => ({
    parents: Int16Array.from(parents),
    flags: Uint16Array.from(parents.map(() => 0)),
    pivots: Float32Array.from(parents.flatMap(() => [0, 0, 0])),
    clips,
    animations,
  });

  assert.equal(animatesAsDoodad(undefined), false, "a model with no skeleton at all");
  assert.equal(animatesAsDoodad(rig([], [])), false, "a skeleton with no bones is not a rig");
  assert.equal(animatesAsDoodad(rig([-1], [])), false, "bones with nothing to play are a bind pose");

  // A bird's flap *is* its Stand, so a gate reading «declares something other than Stand» would
  // exclude the models this exists for. Of 405 published WVM artifacts on this dataset, 60 carry
  // bones and all 60 of those declare animation 0.
  assert.equal(animatesAsDoodad(rig([-1, 0], [0])), true);
  assert.equal(animatesAsDoodad(rig([-1, 0], [], [{ animationId: 0, duration: 1, channels: [] }])), true,
    "a clip that shipped with the model counts, even when the declaration list is empty");
});

test("Ж4.1 game-object metadata is asked for in batches the route will accept", async () => {
  // The caller used to cap the whole nearby list at forty, so this was never handed more than
  // forty ids. The moment game objects got a list of their own — because in a city forty of
  // *everything* is creatures and players before a door is reached — an unchunked request would
  // have been one 400 for the whole city.
  const original = globalThis.fetch;
  const batches = [];
  globalThis.fetch = async (url) => {
    const ids = new URL(String(url)).searchParams.get("ids").split(",").map(Number);
    batches.push(ids.length);
    return { ok: true, status: 200, json: async () => ids.map((id) => ({ id, model: `Model${id}.m2` })) };
  };
  try {
    const client = new GameObjectMetadataClient("ws://127.0.0.1:8090/auth");
    const ids = Array.from({ length: 450 }, (_, index) => index + 1);
    assert.equal(await client.load(ids), true);
    assert.deepEqual(batches, [200, 200, 50]);
    assert.equal(client.get(1)?.model, "Model1.m2");
    assert.equal(client.get(450)?.model, "Model450.m2");

    // And nothing already asked for is asked for again.
    assert.equal(await client.load(ids), false);
    assert.deepEqual(batches, [200, 200, 50]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Ж4.2 frustum culling is asked only of things that have geometry", async () => {
  // `Frustum.intersectsObject` reads `object.geometry.boundingSphere` for anything that carries no
  // `boundingSphere` of its own — so a `THREE.Group` throws a TypeError rather than answering.
  // Every game-object node is a Group, and the call sat inside `draw`, which is one call inside a
  // frame wrapped in a single `try`. `updateLoadingScreen` runs after that call: one invisible
  // TypeError per frame left the world unrendered behind a loading screen that never lifted.
  const frustum = new THREE.Frustum();
  frustum.setFromProjectionMatrix(new THREE.Matrix4());
  assert.throws(() => frustum.intersectsObject(new THREE.Group()), TypeError,
    "if three ever starts tolerating this, the rule below is no longer load-bearing");
  assert.equal(frustum.intersectsObject(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))), true);

  // So the renderer may only ever test a mesh, and the only meshes it has for a game object or a
  // doodad are the ones inside a rig.
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const calls = [...source.matchAll(/#frustum\.intersectsObject\(([^)]*)\)/g)].map((match) => match[1]);
  assert.ok(calls.length > 0, "the culling has to still be there for this to guard anything");
  for (const argument of calls) {
    assert.match(argument, /\.mesh$/,
      `frustum culling is asked of \`${argument}\`, which is not a mesh and will throw`);
  }
});

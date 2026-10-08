import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { createWmoPortalWalkScratch, selectWmoPortalGroups } from "../dist/code/browser/WmoOcclusion.js";
import { createWmoPortalMemo, wmoPortalMemoAnswer, wmoPortalMemoNote } from "../dist/code/browser/WmoPortalMemo.js";
import { createWmoOpenAirState, wmoOpenAirNoteCandidates, wmoOpenAirNoteWalk, wmoOpenAirWalkStale } from "../dist/code/browser/WmoOpenAir.js";

// P1-12c: the portal walks of a placed building. (1) The open-air walk allocates nothing per walk:
// its projection reads the parent rectangle from the scratch, and its answer array is kept or
// overwritten in place. (2) The indoor walk is skipped while its inputs are the same
// (`WmoPortalMemo.ts`). Both must answer exactly what the walks before P1-12c answered: the
// reference below is that code, ported as it was (rectangles as four doubles, `length = 0` + push).

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- The walks before P1-12c (WmoOcclusion.ts at 529d1c0), trimmed to what these tests call. ----
const CLIP_W_EPSILON = 1e-4;
const CLIP_NEAR_EPSILON = 1e-4;
const APERTURE_EPSILON = 1e-6;
const FULL = { minX: -1, maxX: 1, minY: -1, maxY: 1 };
const finitePoint = (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
const validMatrix = (m) => m.length === 16 && m.every((v) => Number.isFinite(v));
const validBounds = (b) => Number.isFinite(b.minX) && Number.isFinite(b.minY) && Number.isFinite(b.minZ)
  && Number.isFinite(b.maxX) && Number.isFinite(b.maxY) && Number.isFinite(b.maxZ)
  && b.minX <= b.maxX && b.minY <= b.maxY && b.minZ <= b.maxZ;
const contains = (b, p) => p.x > b.minX && p.x < b.maxX && p.y > b.minY && p.y < b.maxY && p.z > b.minZ && p.z < b.maxZ;

function oldProject(vertices, definition, matrix, pMinX, pMaxX, pMinY, pMaxY) {
  const parent = { minX: pMinX, maxX: pMaxX, minY: pMinY, maxY: pMaxY };
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  let front = 0; let behind = 0; let uncertain = 0; let nearUncertain = false;
  for (let vertex = definition.startVertex; vertex < definition.startVertex + definition.vertexCount; vertex++) {
    const at = vertex * 3;
    const x = vertices[at]; const y = vertices[at + 1]; const z = vertices[at + 2];
    const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    const clipZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    if (!Number.isFinite(clipX) || !Number.isFinite(clipY) || !Number.isFinite(clipZ) || !Number.isFinite(w)) return parent;
    if (w > CLIP_W_EPSILON) {
      front++;
      if (clipZ <= -w + CLIP_NEAR_EPSILON) nearUncertain = true;
      const ndcX = clipX / w; const ndcY = clipY / w;
      if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return parent;
      minX = Math.min(minX, ndcX); maxX = Math.max(maxX, ndcX); minY = Math.min(minY, ndcY); maxY = Math.max(maxY, ndcY);
    } else if (w < -CLIP_W_EPSILON) behind++;
    else uncertain++;
  }
  if (front === 0) return uncertain > 0 ? parent : undefined;
  if (behind > 0 || uncertain > 0 || nearUncertain) return parent;
  const out = { minX: Math.max(pMinX, minX), maxX: Math.min(pMaxX, maxX), minY: Math.max(pMinY, minY), maxY: Math.min(pMaxY, maxY) };
  return out.minX <= out.maxX && out.minY <= out.maxY ? out : undefined;
}

/** The open-air walk before P1-12c; its answer plus the apertures it wrote (or undefined). */
function oldOpenAir(groups, portals, distanceGroups, camera, matrix, viewer, screen) {
  const fallback = { groups: [...distanceGroups], candidates: distanceGroups.length, visible: distanceGroups.length, culled: 0, used: false };
  const count = groups.length;
  if (!portals || count === 0 || !finitePoint(camera) || !validMatrix(matrix)) return fallback;
  for (const group of groups) if (group.boundsValid === false || !validBounds(group.bounds)) return fallback;
  const apertures = new Float64Array(count * 4);
  const reached = new Uint8Array(count);
  const queued = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0; let size = 0;
  const seed = (index) => {
    apertures.set([-1, 1, -1, 1], index * 4);
    reached[index] = 1;
    if (queued[index] !== 0) return;
    queued[index] = 1;
    queue[size++] = index;
  };
  const viewerValid = viewer !== undefined && finitePoint(viewer);
  for (let index = 0; index < count; index++) {
    const group = groups[index];
    const room = group.indoor && !group.exterior;
    if (!room || contains(group.bounds, camera) || (viewerValid && contains(group.bounds, viewer))) seed(index);
  }
  if (size === 0) return fallback;
  const iterationLimit = Math.max(64, count * 16 + portals.references.length * 4);
  let iterations = 0;
  while (size > 0) {
    if (++iterations > iterationLimit) return fallback;
    const sourceIndex = queue[head];
    head = (head + 1) % count; size--;
    queued[sourceIndex] = 0;
    const source = groups[sourceIndex];
    const s = sourceIndex * 4;
    const sMinX = apertures[s]; const sMaxX = apertures[s + 1]; const sMinY = apertures[s + 2]; const sMaxY = apertures[s + 3];
    for (let at = source.portalStart; at < source.portalStart + source.portalCount; at++) {
      const reference = portals.references[at];
      const target = reference.group;
      if (target === sourceIndex) continue;
      const portal = oldProject(portals.vertices, portals.definitions[reference.portal], matrix, sMinX, sMaxX, sMinY, sMaxY);
      if (!portal) continue;
      const base = target * 4;
      if (reached[target] === 0) {
        reached[target] = 1;
        apertures[base] = portal.minX; apertures[base + 1] = portal.maxX; apertures[base + 2] = portal.minY; apertures[base + 3] = portal.maxY;
      } else {
        const minX = Math.min(apertures[base], portal.minX); const maxX = Math.max(apertures[base + 1], portal.maxX);
        const minY = Math.min(apertures[base + 2], portal.minY); const maxY = Math.max(apertures[base + 3], portal.maxY);
        if (!(minX < apertures[base] - APERTURE_EPSILON || maxX > apertures[base + 1] + APERTURE_EPSILON
          || minY < apertures[base + 2] - APERTURE_EPSILON || maxY > apertures[base + 3] + APERTURE_EPSILON)) continue;
        apertures[base] = minX; apertures[base + 1] = maxX; apertures[base + 2] = minY; apertures[base + 3] = maxY;
      }
      if (queued[target] === 0) { queued[target] = 1; queue[(head + size) % count] = target; size++; }
    }
  }
  const selected = [];
  for (const index of distanceGroups) {
    const group = groups[index];
    if (reached[index] === 1 || group.exterior || !group.indoor || group.portalCount === 0) selected.push(index);
  }
  if (screen) {
    for (let index = 0; index < count; index++) screen.set([1, -1, 1, -1], index * 4);
    for (const index of selected) {
      const whole = reached[index] !== 1;
      screen.set(whole ? [-1, 1, -1, 1] : apertures.subarray(index * 4, index * 4 + 4), index * 4);
    }
  }
  return { groups: selected, candidates: distanceGroups.length, visible: selected.length,
    culled: Math.max(0, distanceGroups.length - selected.length), used: true };
}

/** The indoor walk before P1-12c (rectangles as objects in a `Map`), for its selection. */
function oldIndoor(groups, portals, distanceGroups, camera, matrix, viewer, screen) {
  const fallback = { groups: distanceGroups, candidates: distanceGroups.length, visible: distanceGroups.length, culled: 0, used: false };
  if (!portals || groups.length === 0 || !finitePoint(camera) || !validMatrix(matrix)) return fallback;
  const seeds = [];
  for (const [index, group] of groups.entries()) {
    if (group.boundsValid === false || !validBounds(group.bounds)) return fallback;
    if (group.indoor && !group.exterior && contains(group.bounds, camera)) seeds.push(index);
  }
  if (seeds.length === 0) return fallback;
  if (viewer && finitePoint(viewer)) {
    for (const [index, group] of groups.entries()) {
      if (group.indoor && !group.exterior && contains(group.bounds, viewer) && !seeds.includes(index)) seeds.push(index);
    }
  }
  const apertures = new Map();
  const queue = [];
  for (const seed of seeds) { apertures.set(seed, FULL); queue.push(seed); }
  const iterationLimit = Math.max(64, groups.length * 16 + portals.references.length * 4);
  let cursor = 0; let iterations = 0;
  while (cursor < queue.length) {
    if (++iterations > iterationLimit) return fallback;
    const sourceIndex = queue[cursor++];
    const source = groups[sourceIndex];
    const parent = apertures.get(sourceIndex);
    for (let at = source.portalStart; at < source.portalStart + source.portalCount; at++) {
      const reference = portals.references[at];
      if (reference.group === sourceIndex) continue;
      const portal = oldProject(portals.vertices, portals.definitions[reference.portal], matrix, parent.minX, parent.maxX, parent.minY, parent.maxY);
      if (!portal) continue;
      const previous = apertures.get(reference.group);
      if (!previous) { apertures.set(reference.group, portal); queue.push(reference.group); continue; }
      const merged = { minX: Math.min(previous.minX, portal.minX), maxX: Math.max(previous.maxX, portal.maxX),
        minY: Math.min(previous.minY, portal.minY), maxY: Math.max(previous.maxY, portal.maxY) };
      if (merged.minX < previous.minX - APERTURE_EPSILON || merged.maxX > previous.maxX + APERTURE_EPSILON
        || merged.minY < previous.minY - APERTURE_EPSILON || merged.maxY > previous.maxY + APERTURE_EPSILON) {
        apertures.set(reference.group, merged); queue.push(reference.group);
      }
    }
  }
  const selected = [];
  for (const index of distanceGroups) {
    const group = groups[index];
    if (apertures.has(index) || group.exterior || !group.indoor || group.portalCount === 0) selected.push(index);
  }
  if (screen) {
    for (let index = 0; index < groups.length; index++) screen.set([1, -1, 1, -1], index * 4);
    for (const index of selected) {
      const a = apertures.get(index) ?? FULL;
      screen.set([a.minX, a.maxX, a.minY, a.maxY], index * 4);
    }
  }
  return { groups: selected, candidates: distanceGroups.length, visible: selected.length,
    culled: Math.max(0, distanceGroups.length - selected.length), used: true };
}

// ---- Synthetic buildings: a valid portal graph over random rooms, streets and shells. ----
function building(seed) {
  const next = random(seed);
  const count = 4 + Math.floor(next() * 36);
  const groups = [];
  const box = () => {
    const x = -40 + next() * 80; const y = -40 + next() * 80; const z = -10 + next() * 20;
    return { minX: x, maxX: x + 2 + next() * 30, minY: y, maxY: y + 2 + next() * 30, minZ: z, maxZ: z + 2 + next() * 12 };
  };
  const vertices = [];
  const definitions = [];
  const portalCount = 2 + Math.floor(next() * count * 1.5);
  for (let portal = 0; portal < portalCount; portal++) {
    const corners = 3 + Math.floor(next() * 3);
    definitions.push({ startVertex: vertices.length / 3, vertexCount: corners });
    const cx = -40 + next() * 80; const cy = -40 + next() * 80; const cz = -5 + next() * 10;
    for (let corner = 0; corner < corners; corner++) vertices.push(cx + next() * 4, cy + next() * 4, cz + next() * 4);
  }
  const references = [];
  for (let index = 0; index < count; index++) {
    const roll = next();
    const owned = roll < 0.15 ? 0 : 1 + Math.floor(next() * 4);
    groups.push({ bounds: box(), indoor: roll > 0.2, exterior: next() < 0.15, portalStart: references.length, portalCount: owned });
    for (let at = 0; at < owned; at++) {
      references.push({ portal: Math.floor(next() * portalCount), group: Math.floor(next() * count), side: next() < 0.5 ? 1 : -1 });
    }
  }
  if (references.length === 0) {
    groups[0].portalCount = 1;
    references.push({ portal: 0, group: count - 1, side: 1 });
  }
  const candidates = groups.map((_, index) => index).filter(() => next() < 0.85);
  return { groups, portals: { vertices: new Float32Array(vertices), definitions, references }, candidates };
}

const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 600);
const clip = new THREE.Matrix4();
/** A camera somewhere around (or inside) the building looking at a random point of it. */
function view(next) {
  const position = { x: -70 + next() * 140, y: -70 + next() * 140, z: -20 + next() * 40 };
  camera.position.set(position.x, position.y, position.z);
  camera.up.set(0, 0, 1);
  camera.lookAt(-30 + next() * 60, -30 + next() * 60, -5 + next() * 10);
  camera.updateMatrixWorld();
  clip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const viewer = next() < 0.8 ? { x: -40 + next() * 80, y: -40 + next() * 80, z: -5 + next() * 10 } : undefined;
  return { camera: position, matrix: [...clip.elements], viewer };
}

const plain = (selection) => ({ ...selection, groups: [...selection.groups] });

test("P1-12c: the open-air walk answers and writes exactly what the walk before it did", () => {
  let used = 0;
  let walks = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const { groups, portals, candidates } = building(seed);
    const next = random(seed + 1000);
    const scratch = createWmoPortalWalkScratch();
    const options = { exteriorSeeds: true, scratch };
    for (let step = 0; step < 60; step++) {
      const { camera: eye, matrix, viewer } = view(next);
      const screen = new Float32Array(groups.length * 4).fill(7);
      const expectedScreen = new Float32Array(groups.length * 4).fill(7);
      const expected = oldOpenAir(groups, portals, candidates, eye, matrix, viewer, expectedScreen);
      const answer = selectWmoPortalGroups(groups, portals, candidates, eye, matrix, viewer, screen, options);
      assert.deepEqual(plain(answer), expected, `seed ${seed} step ${step}`);
      assert.deepEqual([...screen], [...expectedScreen], `seed ${seed} step ${step}: screen rectangles`);
      walks++;
      if (answer.used) used++;
    }
  }
  assert.ok(used > walks / 3, `the walk answered (${used} of ${walks})`);
});

test("P1-12c: signed zeros on a portal's corners come out as Math.min/Math.max gave them", () => {
  // A clip whose off-diagonal terms are all -0: with positive other coordinates each sum is the one
  // coordinate itself, its zero's sign kept (x + -0 = x), so -0 and +0 corners meet in the min/max.
  const identity = [1, -0, -0, -0, -0, 1, -0, -0, -0, -0, 1, -0, -0, -0, -0, 1];
  const orders = [[-0, 0, 0.5], [0, -0, 0.5], [-0.5, -0, 0], [-0.5, 0, -0], [-0, -0, 0.25], [0, 0, -0.25]];
  const positive = [0.25, 0.5, 0.75];
  const cases = [...orders.map((xs) => [xs, positive]), ...orders.map((ys) => [positive, ys])];
  for (const [xs, ys] of cases) {
    {
      const corners = [];
      for (let corner = 0; corner < 3; corner++) corners.push(xs[corner], ys[corner], 0.5);
      const groups = [
        { bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10, minZ: -10, maxZ: 10 }, indoor: false, exterior: false, portalStart: 0, portalCount: 1 },
        { bounds: { minX: 20, maxX: 21, minY: 20, maxY: 21, minZ: 20, maxZ: 21 }, indoor: true, exterior: false, portalStart: 1, portalCount: 1 },
      ];
      const portals = {
        vertices: new Float32Array(corners),
        definitions: [{ startVertex: 0, vertexCount: 3 }],
        references: [{ portal: 0, group: 1, side: 1 }, { portal: 0, group: 0, side: -1 }],
      };
      const eye = { x: 50, y: 50, z: 50 };
      const screen = new Float32Array(8);
      const expectedScreen = new Float32Array(8);
      const expected = oldOpenAir(groups, portals, [0, 1], eye, identity, undefined, expectedScreen);
      const answer = selectWmoPortalGroups(groups, portals, [0, 1], eye, identity, undefined, screen,
        { exteriorSeeds: true, scratch: createWmoPortalWalkScratch() });
      assert.deepEqual(plain(answer), expected, `${xs} / ${ys}`);
      assert.deepEqual([...screen], [...expectedScreen], `${xs} / ${ys}: the room's rectangle, zeros signed alike`);
    }
  }
});

test("P1-12c: the indoor walk answers exactly what it did before", () => {
  let used = 0;
  for (let seed = 41; seed <= 80; seed++) {
    const { groups, portals, candidates } = building(seed);
    const next = random(seed + 1000);
    for (let step = 0; step < 60; step++) {
      const { camera: eye, matrix, viewer } = view(next);
      // Half the cameras inside a room, so the walk has a seed.
      if (next() < 0.5) {
        const room = groups.find((group) => group.indoor && !group.exterior);
        if (room) Object.assign(eye, { x: (room.bounds.minX + room.bounds.maxX) / 2, y: (room.bounds.minY + room.bounds.maxY) / 2,
          z: (room.bounds.minZ + room.bounds.maxZ) / 2 });
      }
      const screen = new Float32Array(groups.length * 4).fill(7);
      const expectedScreen = new Float32Array(groups.length * 4).fill(7);
      const expected = oldIndoor(groups, portals, candidates, eye, matrix, viewer, expectedScreen);
      const answer = selectWmoPortalGroups(groups, portals, candidates, eye, matrix, viewer, screen);
      assert.deepEqual(plain(answer), plain(expected), `seed ${seed} step ${step}`);
      assert.deepEqual([...screen], [...expectedScreen], `seed ${seed} step ${step}: screen rectangles`);
      if (answer.used) used++;
    }
  }
  assert.ok(used > 100, `the walk answered ${used} times`);
});

test("P1-12c: the open-air answer array is kept while its length is, and nothing grows per walk", () => {
  const { groups, portals, candidates } = building(3);
  const next = random(77);
  const scratch = createWmoPortalWalkScratch();
  const options = { exteriorSeeds: true, scratch };
  let previous;
  let replaced = 0;
  for (let step = 0; step < 400; step++) {
    const { camera: eye, matrix, viewer } = view(next);
    const answer = selectWmoPortalGroups(groups, portals, candidates, eye, matrix, viewer, undefined, options);
    if (!answer.used) continue;
    assert.equal(answer, scratch.result, "the scratch's own result");
    assert.equal(answer.groups, scratch.selected, "the scratch's own selection");
    if (previous !== undefined) {
      if (previous.length === answer.groups.length) assert.equal(answer.groups, previous, `step ${step}: same length, same array`);
      else replaced++;
    }
    previous = answer.groups;
    assert.ok(scratch.picks.length <= candidates.length, "the pick buffer never outgrows the candidates");
  }
  assert.ok(replaced > 0, "the answer's length changed at least once");
});

test("P1-12c: the indoor memo answers only for equal inputs", () => {
  const memo = createWmoPortalMemo();
  const model = {};
  const candidates = [0, 1, 2];
  const eye = { x: 1, y: 2, z: 3 };
  const viewer = { x: 4, y: 5, z: 6 };
  const matrix = Array.from({ length: 16 }, (_, index) => index + 0.5);
  const apertures = new Float32Array(12);
  const result = { groups: [0, 2], candidates: 3, visible: 2, culled: 1, used: true };
  assert.equal(wmoPortalMemoAnswer(memo, model, candidates, eye, matrix, viewer, apertures), undefined, "nothing walked yet");
  wmoPortalMemoNote(memo, model, candidates, eye, matrix, viewer, apertures, result);
  assert.equal(wmoPortalMemoAnswer(memo, model, candidates, { ...eye }, [...matrix], { ...viewer }, apertures), result,
    "the same numbers in other objects");
  for (let index = 0; index < 16; index++) {
    const moved = [...matrix];
    moved[index] += 1e-9;
    assert.equal(wmoPortalMemoAnswer(memo, model, candidates, eye, moved, viewer, apertures), undefined, `matrix ${index}`);
  }
  for (const axis of ["x", "y", "z"]) {
    assert.equal(wmoPortalMemoAnswer(memo, model, candidates, { ...eye, [axis]: eye[axis] + 1e-9 }, matrix, viewer, apertures),
      undefined, `camera ${axis}`);
    assert.equal(wmoPortalMemoAnswer(memo, model, candidates, eye, matrix, { ...viewer, [axis]: viewer[axis] + 1e-9 }, apertures),
      undefined, `viewer ${axis}`);
  }
  assert.equal(wmoPortalMemoAnswer(memo, model, [0, 1, 2], eye, matrix, viewer, apertures), undefined, "other candidates");
  assert.equal(wmoPortalMemoAnswer(memo, {}, candidates, eye, matrix, viewer, apertures), undefined, "another model");
  assert.equal(wmoPortalMemoAnswer(memo, model, candidates, eye, matrix, viewer, undefined), undefined, "no room record");
  assert.equal(wmoPortalMemoAnswer(memo, model, candidates, eye, matrix, undefined, apertures), undefined, "no viewer");
  assert.equal(wmoPortalMemoAnswer(memo, model, candidates, { ...eye, x: Number.NaN }, matrix, viewer, apertures), undefined, "NaN");
  wmoPortalMemoNote(memo, model, candidates, eye, matrix, undefined, apertures, result);
  assert.equal(wmoPortalMemoAnswer(memo, model, candidates, eye, matrix, undefined, apertures), result, "no viewer, noted");
  assert.equal(wmoPortalMemoAnswer(memo, model, candidates, eye, matrix, viewer, apertures), undefined, "a viewer again");
  assert.equal(memo.reused, 2);
  assert.equal(memo.walked, 2);
});

test("P1-12c: memoised walks answer and write what a walk on every frame does", () => {
  for (let seed = 81; seed <= 100; seed++) {
    const { groups, portals, candidates } = building(seed);
    const model = { groups, portals };
    const next = random(seed + 2000);
    const memo = createWmoPortalMemo();
    const memoScreen = new Float32Array(groups.length * 4);
    const directScreen = new Float32Array(groups.length * 4);
    let held = view(next);
    let heldCandidates = candidates;
    for (let step = 0; step < 300; step++) {
      // Mostly a still camera and character; sometimes either moves, sometimes the candidates change.
      const roll = next();
      if (roll < 0.15) held = view(next);
      else if (roll < 0.2) held = { ...held, viewer: view(next).viewer };
      else if (roll < 0.23) heldCandidates = candidates.filter(() => next() < 0.8);
      const { camera: eye, matrix, viewer } = held;
      let answer = wmoPortalMemoAnswer(memo, model, heldCandidates, eye, matrix, viewer, memoScreen);
      if (answer === undefined) {
        answer = selectWmoPortalGroups(groups, portals, heldCandidates, eye, matrix, viewer, memoScreen);
        wmoPortalMemoNote(memo, model, heldCandidates, eye, matrix, viewer, memoScreen, answer);
      }
      const direct = selectWmoPortalGroups(groups, portals, heldCandidates, eye, matrix, viewer, directScreen);
      assert.deepEqual(plain(answer), plain(direct), `seed ${seed} step ${step}`);
      assert.deepEqual([...memoScreen], [...directScreen], `seed ${seed} step ${step}: screen rectangles`);
    }
    assert.ok(memo.reused > memo.walked, `seed ${seed}: reused ${memo.reused}, walked ${memo.walked}`);
  }
});

test("P1-12c: a new player position re-walks from open air even with the same candidate array", () => {
  const state = createWmoOpenAirState();
  const candidates = [0, 1];
  const matrix = Array.from({ length: 16 }, (_, index) => index);
  wmoOpenAirNoteCandidates(state, candidates, 0, 0, 0);
  wmoOpenAirNoteWalk(state, matrix, undefined);
  assert.equal(wmoOpenAirWalkStale(state, matrix, undefined), false);
  wmoOpenAirNoteCandidates(state, candidates, 1, 0, 0);
  assert.equal(wmoOpenAirWalkStale(state, matrix, undefined), true, "the viewer seed moved with the player");
});

test("P1-12c: the renderer asks the rest-radius table and the memo", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const openAir = source.slice(source.indexOf("  #wmoRoomsFromOpenAir("), source.indexOf("  #considerWmoFog("));
  assert.match(openAir, /placed\.openAirRanges \?\?= new WmoRangeTable\(model, placed\.boxes, WMO_OPEN_AIR_ROOM_RANGE, wmoShellRange\)/);
  assert.match(openAir, /wmoOpenAirNoteCandidates\(state, ranges\.select\(player\.x, player\.y\), player\.x, player\.y, player\.z\);/);
  assert.doesNotMatch(openAir, /wmoGroupsInRange\(/, "no per-move candidate array");
  const update = source.slice(source.indexOf("  #updateWmoGroups("), source.indexOf("  #wmoRoomsFromOpenAir("));
  assert.match(update, /let portalSelection = wmoPortalMemoAnswer\(memo, placed\.model, distanceGroups, this\.#wmoCameraModel,/);
  assert.match(update, /wmoPortalMemoNote\(memo, placed\.model, distanceGroups, this\.#wmoCameraModel,/);
});

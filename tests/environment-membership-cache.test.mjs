import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';

const source = readFileSync(new URL('../src/browser/WorldRenderer3D.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('renderer.ts', source, ts.ScriptTarget.ES2022, true);
const renderer = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'WorldRenderer3D');
const member = name => {
  const found = renderer.members.find(node => node.name?.getText(parsed) === name);
  assert.ok(found, name);
  return found;
};
const reset = member('clearWorldResources');
const membershipReset = reset.body.statements.filter(statement => ts.isExpressionStatement(statement)
  && ts.isBinaryExpression(statement.expression)
  && ['this.#residentMembership', 'this.#admittedMembership'].includes(statement.expression.left.getText(parsed)));
assert.equal(membershipReset.length, 2, 'world-resource reset must release both membership caches');
const body = ts.transpileModule(`class Harness {
  ${['#residentMembership', '#admittedMembership', '#updateEnvironment'].map(name => member(name).getText(parsed)).join('\n')}
  resetMembership() { ${membershipReset.map(statement => statement.getText(parsed)).join('\n')} }
}`.replaceAll('#', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

function fixture() {
  const dependencies = {
    THREE, shouldReselect: () => false, CAMERA_FAST_TURN_RATE: 3, WARM_PRUNE_INTERVAL_FRAMES: 60,
    ENVIRONMENT_BUILD_BUDGET: 16, MODEL_RANGE: 100, legacyDecodedModelReplaced: () => false,
    environmentVegetation: () => false,
    // 05.10 suite-fix 2: the 7.18 stand-in ledger (05.10-A7b-9) names the far-eligible rule.
    environmentFarEligible: () => false, drawableModel: model => model !== undefined, standInKind: () => 'none',
    selectEnvironmentAdmission: candidates => candidates.filter(row => row.object.selected !== false),
  };
  const Harness = Function(...Object.keys(dependencies), body + '; return Harness;')(...Object.values(dependencies));
  const harness = new Harness(), decisions = [], sourceObjects = [];
  Object.assign(harness, {
    environmentObjects: sourceObjects, environmentCandidates: [], environmentResidents: [],
    cameraTurnRate: 0, submissionSerial: 1, warmPruneAtSerial: 0, turnSuppressUntilSerial: 0,
    experimentalShaderProfile: { vegetationWind: false },
    environment: new Map(), environmentGroup: new THREE.Group(), camera: new THREE.PerspectiveCamera(),
    frustum: new THREE.Frustum(), frustumMatrix: new THREE.Matrix4(),
    environmentBuildBudget: { begin() {}, take: () => false },
    environmentStandIns: { begin() {} }, environmentStandInMarkers: { beginFrame() {}, endFrame() {} },
    noteEnvironmentStandIn() {},
    prefetchEnvironmentModels() {}, updateVegetationGrowth() {}, poseDoodads() {}, updateInstances() {},
    setEnvironmentAdmitted(rendered, drawn) { decisions.push([rendered.source, drawn ? 'draw' : 'warm']); },
    removeEnvironment(id, rendered) { decisions.push([rendered.source, 'remove']); this.environment.delete(id); },
  });
  const draw = () => {
    decisions.length = 0;
    harness.updateEnvironment({ x: 0, y: 0, z: 0 }, sourceObjects, undefined, .016);
    return [...decisions];
  };
  const retain = object => harness.environment.set(object.id, { source: object, actual: true, node: new THREE.Group() });
  const set = (residents, admitted) => {
    harness.environmentResidents = residents;
    harness.environmentCandidates = admitted;
    harness.admissionCandidates = admitted;
    harness.lastAdmitted = admitted;
  };
  return { harness, draw, retain, set };
}
const placement = (id, extra = {}) => ({ id, kind: 'm2', name: `prop${id}.m2`, x: id, y: 0, z: 0, scale: 1, ...extra });
const ranked = objects => objects.map(object => ({ object, distance: 1 }));

test('actual environment pass reuses membership while applying every-frame resident visibility decisions', () => {
  const f = fixture(), a = placement(1), b = placement(2), stale = placement(99);
  const residents = ranked([a, b]), admitted = ranked([a]);
  f.set(residents, admitted); [a, b, stale].forEach(f.retain);
  assert.deepEqual(f.draw(), [[a, 'draw'], [b, 'warm'], [stale, 'remove']]);
  const map = f.harness.residentMembership, set = f.harness.admittedMembership;
  assert.deepEqual(f.draw(), [[a, 'draw'], [b, 'warm']]);
  assert.equal(f.harness.residentMembership, map);
  assert.equal(f.harness.admittedMembership, set);
  assert.equal(map.source, residents); assert.equal(set.source, admitted);
});

test('new admission and resident array identities invalidate independently, including reused numeric IDs', () => {
  const f = fixture(), a = placement(1), b = placement(2);
  const residents = ranked([a, b]); f.set(residents, ranked([a])); [a, b].forEach(f.retain); f.draw();
  const oldMap = f.harness.residentMembership, oldSet = f.harness.admittedMembership;
  f.set(residents, ranked([b]));
  assert.deepEqual(f.draw(), [[a, 'warm'], [b, 'draw']]);
  assert.equal(f.harness.residentMembership, oldMap);
  assert.notEqual(f.harness.admittedMembership, oldSet);
  const newSet = f.harness.admittedMembership;
  const replacement = placement(1, { name: 'replacement.m2' });
  f.set(ranked([replacement, b]), newSet.source);
  assert.deepEqual(f.draw(), [[a, 'remove'], [b, 'draw']]);
  assert.notEqual(f.harness.residentMembership, oldMap);
  assert.equal(f.harness.residentMembership.values.get(1), replacement);
  assert.equal(f.harness.admittedMembership, newSet);
});

test('fresh even-frame and fast-camera admission feeds fresh membership on that same frame', () => {
  const f = fixture(), a = placement(1), b = placement(2, { selected: false });
  const residents = ranked([a, b]); f.set(residents, residents); [a, b].forEach(f.retain); f.draw();
  const previous = f.harness.admittedMembership;
  f.harness.submissionSerial = 2;
  assert.deepEqual(f.draw(), [[a, 'draw'], [b, 'warm']]);
  assert.notEqual(f.harness.admittedMembership, previous);
  const even = f.harness.admittedMembership;
  f.harness.submissionSerial = 3; f.harness.cameraTurnRate = 4;
  f.draw();
  assert.notEqual(f.harness.admittedMembership, even, 'existing fast-camera gate still runs');
});

test('last duplicate source wins exactly as fresh Map and empty/reentry/reset release old membership', () => {
  const f = fixture(), old = placement(7), latest = placement(7, { name: 'last.m2' });
  f.set(ranked([old, latest]), ranked([latest, latest])); f.retain(latest);
  assert.deepEqual(f.draw(), [[latest, 'draw']]);
  assert.deepEqual([...f.harness.residentMembership.values], [[7, latest]]);
  assert.deepEqual([...f.harness.admittedMembership.values], [7]);
  const oldMap = f.harness.residentMembership;
  f.set([], []);
  assert.deepEqual(f.draw(), [[latest, 'remove']]);
  assert.equal(f.harness.residentMembership.values.size, 0);
  assert.equal(f.harness.admittedMembership.values.size, 0);
  f.harness.resetMembership();
  assert.equal(f.harness.residentMembership, undefined);
  assert.equal(f.harness.admittedMembership, undefined);
  f.set(ranked([old]), ranked([old])); f.retain(old);
  assert.deepEqual(f.draw(), [[old, 'draw']]);
  assert.notEqual(f.harness.residentMembership, oldMap);
  assert.equal(f.harness.residentMembership.values.get(7), old);
});

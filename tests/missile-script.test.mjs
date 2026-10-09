// 05.10-A7a-E (6.12): SpellMissileMotion scripts — the interpreter subset (browser/MissileScript.ts)
// against synthetic scripts and against every row of the dataset's SpellMissileMotion.dbc.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  MISSILE_MOTION_INPUTS, MISSILE_MOTION_OUTPUTS, MOTION_IN, MOTION_OUT, compileMissileScript, missileProgram,
} from "../dist/code/browser/MissileScript.js";
import { parseSpellMissileMotions } from "../dist/code/gateway/SpellMissileMotion.js";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
let motions;
try {
  motions = dbcDirectory ? parseSpellMissileMotions(await readFile(join(dbcDirectory, "SpellMissileMotion.dbc"))) : undefined;
} catch {
  motions = undefined;
}
const withDataset = { skip: motions ? false : "no SpellMissileMotion.dbc in the tswow dataset on this machine" };

function inputs(values = {}) {
  const array = new Float64Array(MISSILE_MOTION_INPUTS.length);
  array[MOTION_IN.missileCount] = 1;
  for (const [name, value] of Object.entries(values)) array[MOTION_IN[name]] = value;
  return array;
}

function run(script, values) {
  const compiled = compileMissileScript(script);
  assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.reason);
  const out = new Float64Array(MISSILE_MOTION_OUTPUTS.length);
  compiled.program.evaluate(inputs(values), out);
  return out;
}

const near = (actual, expected, message, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: ${actual} vs ${expected}`);

test("the vocabulary is Wow.exe's two name tables, in their order", () => {
  assert.deepEqual([...MISSILE_MOTION_INPUTS], [
    "progress", "time", "missileIndex", "missileCount", "distanceToFirePos", "distanceToImpactPos",
    "startDistance", "totalDistance", "rand1", "rand2", "rand3", "spellID"]);
  assert.deepEqual([...MISSILE_MOTION_OUTPUTS], [
    "transAngle", "transMag", "transRight", "transFront", "transUp", "modelYaw", "modelPitch", "modelRoll",
    "speedAbs", "speedScalar", "speedOffset", "scale"]);
});

test("precedence, power, modulo, unary minus and degrees follow Lua", () => {
  const out = run(`
    transMag = 2 + 3 * 4 ^ 2 / 8   -- 2 + 3*16/8 = 8
    transUp = -2 ^ 2               ; transRight = 2 ^ -1
    transFront = -7 % 3            -- Lua: 2 (sign of the divisor)
    modelYaw = math.fmod(-7, 3)    -- C fmod: -1 (sign of the dividend)
    modelPitch = sin(90) + cos(180)
    --[[ transAngle = 99 ]]
    scale = 1 - - 1
  `);
  assert.equal(out[MOTION_OUT.transMag], 8);
  assert.equal(out[MOTION_OUT.transUp], -4);
  assert.equal(out[MOTION_OUT.transRight], 0.5);
  assert.equal(out[MOTION_OUT.transFront], 2);
  assert.equal(out[MOTION_OUT.modelYaw], -1);
  near(out[MOTION_OUT.modelPitch], 0, "sin 90° + cos 180°");
  assert.equal(out[MOTION_OUT.transAngle], 0, "a block comment is not code");
  assert.equal(out[MOTION_OUT.scale], 2);
});

test("if / elseif / else take exactly one branch, and block locals stay in their block", () => {
  const script = `
    local x = 1
    if missileIndex == 1 then
      local x = 10
      transRight = x
    elseif missileIndex == 2 and progress > .5 then
      transRight = 20
    elseif not (missileIndex < 3) then
      transRight = 30
    else
      transRight = 40
    end
    transUp = x
  `;
  assert.equal(run(script, { missileIndex: 1 })[MOTION_OUT.transRight], 10);
  assert.equal(run(script, { missileIndex: 1 })[MOTION_OUT.transUp], 1, "the inner local shadowed only its block");
  assert.equal(run(script, { missileIndex: 2, progress: 0.7 })[MOTION_OUT.transRight], 20);
  assert.equal(run(script, { missileIndex: 2, progress: 0.2 })[MOTION_OUT.transRight], 40);
  assert.equal(run(script, { missileIndex: 5 })[MOTION_OUT.transRight], 30);
});

test("an output never assigned reads 0, as Wow.exe turns nil into 0; an input may be reassigned", () => {
  const out = run("progress = 1 - progress\ntransMag = progress\ntransFront = distanceFromImpactPos", { progress: 0.25 });
  assert.equal(out[MOTION_OUT.transMag], 0.75);
  assert.equal(out[MOTION_OUT.transFront], 0, "a plain read of an unknown name is nil, not an error");
  assert.equal(out[MOTION_OUT.speedScalar], 0);
  assert.equal(out[MOTION_OUT.scale], 0, "scale 0 means 'not set' to the flight (Wow.exe 0x006feb20 tests > 0)");
});

test("what Lua would raise on, or what this subset does not read, fails to compile with a reason", () => {
  for (const [script, reason] of [
    ["speedAbs = speedAbs * .5", /nil 'speedAbs'/],
    ["transMag = unknownName + 1", /nil 'unknownName'/],
    ["for i = 1, 3 do transMag = i end", /unsupported statement 'for'/],
    ["transMag = abs(-1)", /unsupported function 'abs'/],
    ["transMag = progress or 1", /value-producing 'or'/],
    ["transMag = 'a' .. 'b'", /./],
    ["transMag, transUp = 1, 2", /multiple assignment/],
    ["return 1", /unsupported statement 'return'/],
  ]) {
    const compiled = compileMissileScript(script);
    assert.equal(compiled.ok, false, script);
    assert.match(compiled.reason, reason, script);
  }
  assert.equal(missileProgram("transMag = nope * 2"), undefined, "the cached helper answers undefined for a failed compile");
});

test("evaluation allocates nothing and reuses one environment", () => {
  const program = missileProgram("local a = progress * 2\ntransMag = a\nif a > 1 then transUp = sin(time * 360) end");
  const values = inputs({ progress: 0.75, time: 0.25 });
  const out = new Float64Array(MISSILE_MOTION_OUTPUTS.length);
  program.evaluate(values, out);
  assert.equal(out[MOTION_OUT.transMag], 1.5);
  near(out[MOTION_OUT.transUp], 1, "sin(90°)");
  values[MOTION_IN.progress] = 0.25;
  program.evaluate(values, out);
  assert.equal(out[MOTION_OUT.transUp], 0, "the previous run's output does not leak into the next");
});

test("dataset: every SpellMissileMotion script compiles except the ones listed, and gives finite outputs", withDataset, () => {
  const failures = [];
  const out = new Float64Array(MISSILE_MOTION_OUTPUTS.length);
  for (const row of motions.values()) {
    const compiled = compileMissileScript(row.script);
    if (!compiled.ok) {
      failures.push(`${row.id}: ${compiled.reason}`);
      continue;
    }
    for (let index = 0; index < row.count; index++) {
      for (const progress of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
        for (const time of [0, 0.25, 1, 3]) {
          compiled.program.evaluate(inputs({
            progress, time, missileIndex: index, missileCount: row.count, startDistance: 30, totalDistance: 30,
            distanceToFirePos: progress * 30, distanceToImpactPos: (1 - progress) * 30, rand1: 0.3, rand2: 0.6, rand3: 0.9,
            spellID: 133,
          }), out);
          for (let slot = 0; slot < out.length; slot++) {
            assert.ok(Number.isFinite(out[slot]), `${row.id} ${MISSILE_MOTION_OUTPUTS[slot]} at p=${progress} t=${time}`);
          }
        }
      }
    }
  }
  // 204 rows; 1662 and 2044 have no script and count 2/3 — kept (and an empty script compiles to no motion).
  assert.equal(motions.size, 204);
  assert.equal(motions.get(1662).script, "");
  assert.equal(motions.get(2044).count, 3);
  // Only the one script that multiplies an output it has not assigned (Lua raises on nil; Wow.exe then
  // drops the script and the missile flies straight).
  assert.deepEqual(failures, ["2764: '*' on nil 'speedAbs'"]);
});

test("dataset: Parabola 13 peaks at 0.15 · startDistance halfway and is zero at both ends; 224/501 are 0.30/0.10", withDataset, () => {
  const out = new Float64Array(MISSILE_MOTION_OUTPUTS.length);
  for (const [id, factor] of [[13, 0.15], [224, 0.3], [501, 0.1]]) {
    const program = missileProgram(motions.get(id).script);
    for (const [progress, expected] of [[0, 0], [0.5, 30 * factor], [1, 0]]) {
      program.evaluate(inputs({ progress, startDistance: 30 }), out);
      near(out[MOTION_OUT.transMag], expected, `${id} at ${progress}`);
      assert.equal(out[MOTION_OUT.transAngle], 0, `${id}: the bow is straight up`);
    }
  }
});

test("dataset: Spiral Vortex 19 puts its seven missiles at seven different angles; Forward Spin 23 pitches 720°/s", withDataset, () => {
  const out = new Float64Array(MISSILE_MOTION_OUTPUTS.length);
  const vortex = missileProgram(motions.get(19).script);
  assert.equal(motions.get(19).count, 7);
  const angles = new Set();
  for (let index = 0; index < 7; index++) {
    vortex.evaluate(inputs({ progress: 0.5, time: 0.5, missileIndex: index, missileCount: 7 }), out);
    angles.add(Math.round(out[MOTION_OUT.transAngle] * 1000));
  }
  assert.equal(angles.size, 7);
  const spin = missileProgram(motions.get(23).script);
  for (const time of [0, 0.5, 1.25]) {
    spin.evaluate(inputs({ time }), out);
    near(out[MOTION_OUT.modelPitch], time * 720, `23 at ${time}`);
  }
});

test("dataset: the elseif scripts (Laser Barrage 2124) and math.fmod (Triple Parabola 721) run their branches", withDataset, () => {
  const out = new Float64Array(MISSILE_MOTION_OUTPUTS.length);
  const barrage = missileProgram(motions.get(2124).script);
  const rights = [];
  for (let index = 0; index < 3; index++) {
    barrage.evaluate(inputs({ progress: 1, missileIndex: index, missileCount: 3, rand1: 0.5, rand2: 0.5, rand3: 0.5 }), out);
    rights.push(out[MOTION_OUT.transRight]);
  }
  // index 1: +0.75, index 2 (elseif): -0.75, index 0 (else): 0 when rand2 = 0.5.
  assert.deepEqual(rights.map((value) => Math.round(value * 100) / 100), [0, 0.75, -0.75]);
  const triple = missileProgram(motions.get(721).script);
  // progress 0.5 → fmod(1.5, 1) = 0.5 → the bow's peak; 1/3 → fmod(1, 1) = 0 → the ground.
  triple.evaluate(inputs({ progress: 0.5, startDistance: 30 }), out);
  near(out[MOTION_OUT.transMag], 3, "721 at 0.5");
  triple.evaluate(inputs({ progress: 1 / 3 + 1e-12, startDistance: 30 }), out);
  near(out[MOTION_OUT.transMag], 0, "721 at a third", 1e-6);
});

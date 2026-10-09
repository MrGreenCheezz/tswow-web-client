// 05.10-A7a-E (6.13): chain beams — SpellChainEffects (raw 177-byte layout), kit CharProc 0/12 slots, the
// planner's beams and the renderer-side band (browser/ChainBeam.ts).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import * as THREE from "three";
import { kitChains, parseSpellChainEffects } from "../dist/code/gateway/SpellKitExtras.js";
import { parseSpellVisualKits, parseSpellVisuals } from "../dist/code/gateway/SpellVisual.js";
import {
  BEAM_CAPACITY, ChainBeams, beamBlending, beamColour, beamQuad, channelObjectOf,
} from "../dist/code/browser/ChainBeam.js";
import { BEAM_CHEST_ATTACHMENT, CAST_KIT_MS, planSpellCastStart, planSpellVisual } from "../dist/code/browser/SpellVisuals.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
let chainFile;
try {
  chainFile = dbcDirectory ? await readFile(join(dbcDirectory, "SpellChainEffects.dbc")) : undefined;
} catch {
  chainFile = undefined;
}
const withDataset = { skip: chainFile ? false : "no SpellChainEffects.dbc in the tswow dataset on this machine" };
const read = (name) => readFile(join(dbcDirectory, name));

const effect = (id = 1, extra = {}) => ({
  id, texture: "Textures\\SpellChainEffects\\Lightning.blp", width: 0.5, avgSegLen: 2.78, noiseScale: 0.04,
  texCoordScale: 1, textureLength: 2, segDuration: 1000, segDelay: 300, flags: 4, jointCount: 0,
  color: [255, 255, 255, 255], blendMode: 3, renderLayer: 0, ...extra,
});
const kit = (chains = [], shake) => ({ startAnimation: -1, animation: -1, effects: [], sound: 0, chains, ...(shake ? { shake } : {}) });

test("dataset: SpellChainEffects reads 935 rows of 177 bytes with every field in its measured range", withDataset, () => {
  const chains = parseSpellChainEffects(chainFile);
  assert.equal(chains.size, 935);
  for (const row of chains.values()) {
    assert.ok(row.width >= 0.0049 && row.width <= 5, `${row.id} width ${row.width}`);
    assert.ok(row.avgSegLen >= 0.099 && row.avgSegLen <= 100, `${row.id} seg ${row.avgSegLen}`);
    assert.ok(row.texCoordScale >= -5 && row.texCoordScale <= 20, `${row.id} tc`);
    assert.ok(row.textureLength >= 0.399 && row.textureLength <= 1000, `${row.id} texlen ${row.textureLength}`);
    assert.ok(row.blendMode >= 2 && row.blendMode <= 6, `${row.id} blend ${row.blendMode}`);
    assert.ok(row.renderLayer >= 0 && row.renderLayer <= 4, `${row.id} layer`);
    assert.ok(row.color[0] > 0, `${row.id}: the first colour byte is never 0`);
    // Mostly Textures\SpellChainEffects\, also Spells\Textures\, Weather, BloodSplats; 6 rows name a .tga.
    assert.match(row.texture, /\.(blp|tga)$/i, `${row.id} texture`);
  }
  assert.equal(chains.get(719).texture, "Textures\\SpellChainEffects\\HealBeam_Desaturated.blp");
  assert.deepEqual(chains.get(719).color, [51, 58, 247, 91]);
  assert.equal(chains.get(723).jointCount, 27);
  assert.equal(chains.get(743).texture.split("\\").pop(), "ShockLightning.blp");
});

test("a kit slot is a beam when CharProc is 0 or 12 and its CharParamZero names a chain row", () => {
  const rows = new Map([[719, effect(719)], [6, effect(6)]]);
  const chains = kitChains({ procs: [0, 12, 13, 0], param0: [719, 6, 719, 0], param1: [1, 0, 0, 0] }, rows);
  assert.deepEqual(chains.map((chain) => [chain.slot, chain.proc, chain.effect.id, chain.param1]), [[0, 0, 719, 1], [1, 12, 6, 0]]);
  assert.deepEqual(kitChains({ procs: [0, 0, 0, 0], param0: [0, 0.5, 9999, 0], param1: [0, 0, 0, 0] }, rows), [],
    "an unused slot (0 / not a whole id / no row) is not a beam");
});

test("dataset: the drain channels and Chain Lightning carry their beams; a shake-only kit is kept", withDataset, async () => {
  const kits = parseSpellVisualKits(await read("SpellVisualKit.dbc"), await read("SpellVisualEffectName.dbc"), undefined, {
    spellEffectCameraShakes: await read("SpellEffectCameraShakes.dbc"),
    cameraShakes: await read("CameraShakes.dbc"),
    spellChainEffects: chainFile,
  });
  for (const [kitId, chainId] of [[11762, 719], [11744, 750], [430, 744], [950, 723], [321, 743]]) {
    assert.ok(kits.get(kitId)?.chains?.some((chain) => chain.effect.id === chainId), `kit ${kitId} → chain ${chainId}`);
  }
  let shakeOnly = 0;
  let withShake = 0;
  let withChains = 0;
  for (const value of kits.values()) {
    if (value.shake) withShake++;
    if (value.chains) withChains++;
    if (value.shake && value.effects.length === 0 && value.animation < 0 && value.startAnimation < 0 && value.sound === 0
      && !value.chains) shakeOnly++;
  }
  // Measured 05.10: 336 kits name a shake (all resolve); 775 kits have a CharProc 0/12 slot naming a chain row.
  assert.equal(withShake, 336);
  assert.equal(withChains, 775, "kits with a beam slot");
  assert.equal(shakeOnly, 29, "kits that are a camera shake and nothing else — dropped before 05.10");
});

test("dataset: spells reach beams through their visual's kits", withDataset, async () => {
  const visuals = parseSpellVisuals(await read("Spell.dbc"), await read("SpellVisual.dbc"), await read("SpellVisualKit.dbc"),
    await read("SpellVisualEffectName.dbc"), undefined, undefined, undefined, { spellChainEffects: chainFile });
  let byProc0 = 0;
  let byProc12 = 0;
  for (const visual of visuals.values()) {
    const kits = [visual.precast, visual.cast, visual.impact, visual.state, visual.stateDone, visual.channel,
      visual.casterImpact, visual.targetImpact, visual.missileTargeting, visual.instantArea, visual.impactArea, visual.persistentArea];
    const chains = kits.flatMap((one) => one?.chains ?? []);
    if (chains.some((chain) => chain.proc === 0)) byProc0++;
    if (chains.some((chain) => chain.proc === 12)) byProc12++;
  }
  assert.equal(visuals.get(689).channel.chains[0].effect.id, 719, "Drain Life");
  assert.equal(visuals.get(421).cast.chains[0].effect.id, 743, "Chain Lightning");
  // Measured 05.10 (spells, both SpellVisualID slots merged): 1,537 reach a CharProc 0 beam (the census
  // counted 1,570 before the merge), 97 a CharProc 12 one — on the install with modules. Since 08.10
  // the expectation is counted here from Spell.dbc and SpellVisual.dbc with the tools' own reader,
  // over the kits the test above pins: per phase the first SpellVisualID slot whose visual names a
  // kit wins. The base dataset gives 1,536 and 97.
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const [spellTable, visualTable] = await Promise.all([
    openDbcFile(dbcDirectory, "Spell"), openDbcFile(dbcDirectory, "SpellVisual"),
  ]);
  const kitsById = parseSpellVisualKits(await read("SpellVisualKit.dbc"), await read("SpellVisualEffectName.dbc"),
    undefined, { spellChainEffects: chainFile });
  const KIT_FIELDS = ["PrecastKit", "CastKit", "ImpactKit", "StateKit", "StateDoneKit", "ChannelKit",
    "CasterImpactKit", "TargetImpactKit", "MissileTargetingKit", "InstantAreaKit", "ImpactAreaKit", "PersistentAreaKit"];
  let expectProc0 = 0;
  let expectProc12 = 0;
  for (const row of spellTable.rows()) {
    const visualRows = [0, 1].map((slot) => visualTable.rowOf(spellTable.int(row, "SpellVisualID", slot)))
      .filter((visualRow) => visualRow !== undefined);
    const procs = new Set();
    for (const field of KIT_FIELDS) {
      const chosen = visualRows.map((visualRow) => kitsById.get(visualTable.int(visualRow, field))).find(Boolean);
      for (const chain of chosen?.chains ?? []) procs.add(chain.proc);
    }
    if (procs.has(0)) expectProc0++;
    if (procs.has(12)) expectProc12++;
  }
  assert.ok(expectProc0 > 1000 && expectProc12 > 50, `${expectProc0} / ${expectProc12}`);
  assert.equal(byProc0, expectProc0);
  assert.equal(byProc12, expectProc12);
});

test("the planner draws a cast kit's beams caster → target → next target, and a channel's to its channel object", () => {
  const visual = { id: 421, cast: kit([{ slot: 0, proc: 0, param1: 0, effect: effect(743) }]) };
  const plan = planSpellVisual(visual, {
    caster: 1n, casterPoint: { x: 0, y: 0, z: 0 },
    targets: [{ guid: 2n, point: { x: 10, y: 0, z: 0 } }, { guid: 3n, point: { x: 20, y: 0, z: 0 } }],
  }, 1000);
  assert.deepEqual(plan.beams.map((beam) => [beam.from.guid, beam.to.guid]), [[1n, 2n], [2n, 3n]]);
  assert.ok(plan.beams.every((beam) => beam.startedAt === 1000 && beam.endsAt === 1000 + CAST_KIT_MS));
  assert.equal(plan.beams[0].to.attachment, BEAM_CHEST_ATTACHMENT);
  const channel = planSpellCastStart({ id: 689, channel: kit([{ slot: 0, proc: 0, param1: 0, effect: effect(719) }]) },
    { caster: 1n, casterPoint: { x: 0, y: 0, z: 0 }, targets: [], castTime: 5000, channel: true }, 0);
  assert.equal(channel.beams.length, 1);
  assert.equal(channel.beams[0].to.channelOf, 1n, "the channel object, read every frame");
  assert.ok(channel.beams[0].endsAt >= 5000);
  assert.equal(planSpellVisual({ id: 1, cast: kit() }, { caster: 1n, casterPoint: { x: 0, y: 0, z: 0 }, targets: [] }, 0).beams,
    undefined, "no beams, no key");
});

test("the band faces the eye, spans the two ends and repeats its texture every TextureLength yards", () => {
  const positions = new Float32Array(12);
  const uvs = new Float32Array(8);
  const length = beamQuad(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0), new THREE.Vector3(5, 0, 10), 0.5, 2, 0.25,
    positions, uvs);
  assert.equal(length, 10);
  // Seen from +Z the band's width runs along Y.
  assert.deepEqual([...positions].map((value) => Math.round(value * 1000) / 1000 + 0), [0, -0.25, 0, 0, 0.25, 0, 10, -0.25, 0, 10, 0.25, 0]);
  assert.deepEqual([...uvs], [0.25, 0, 0.25, 1, 5.25, 0, 5.25, 1]);
  assert.equal(beamQuad(new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, 1, 1), new THREE.Vector3(), 1, 1, 0, positions, uvs), 0);
});

test("colour bytes read alpha first; BlendMode maps to alpha, additive or multiplicative", () => {
  const colour = new THREE.Color();
  assert.equal(beamColour([51, 255, 0, 0], colour), 0.2);
  assert.ok(colour.r > 0.99 && colour.g === 0 && colour.b === 0);
  assert.equal(beamBlending(2), THREE.NormalBlending);
  assert.equal(beamBlending(3), THREE.AdditiveBlending);
  assert.equal(beamBlending(6), THREE.MultiplyBlending);
});

test("the channel object is UNIT_FIELD_CHANNEL_OBJECT of the caster", () => {
  const offset = UPDATE_FIELDS.UNIT_FIELD_CHANNEL_OBJECT.offset;
  const fields = new Map([[offset, 0x1234], [offset + 1, 0xf130]]);
  const state = { objects: new Map([[1n, { fields }]]) };
  assert.equal(channelObjectOf(state, 1n), 0xf130_0000_1234n);
  assert.equal(channelObjectOf(state, 2n), undefined);
  assert.equal(channelObjectOf({ objects: new Map([[1n, { fields: new Map() }]]) }, 1n), undefined);
});

test("live beams: placed each frame, hidden without a channel object, retimed, cancelled and pooled", () => {
  const group = new THREE.Group();
  let leases = 0;
  const beams = new ChainBeams(group, () => {
    leases++;
    return { texture: new THREE.Texture({ width: 1, height: 1 }) /* 05.10 review E: a landed image */, release: () => { leases--; } };
  });
  const where = new Map([[1n, { x: 0, y: 0, z: 0 }], [2n, { x: 10, y: 0, z: 0 }]]);
  const points = { point(guid, _attachment, out) { const at = where.get(guid); if (!at) return false; Object.assign(out, at); return true; } };
  const handle = {};
  const offset = UPDATE_FIELDS.UNIT_FIELD_CHANNEL_OBJECT.offset;
  const fields = new Map();
  const state = { objects: new Map([[1n, { fields }]]) };
  beams.add(handle, [{ effect: effect(719), from: { guid: 1n, attachment: 34, point: { x: 0, y: 0, z: 0 } },
    to: { channelOf: 1n, attachment: 34 }, startedAt: 0, endsAt: 1000 }]);
  const eye = new THREE.Vector3(5, 10, 0);
  beams.update(10, points, state, eye);
  assert.equal(group.children.length, 0, "no channel object yet: nothing drawn");
  fields.set(offset, 2);
  beams.update(20, points, state, eye);
  assert.equal(group.children.length, 1);
  assert.equal(group.children[0].visible, true);
  assert.equal(leases, 1);
  beams.retime(handle, 30);
  beams.update(40, points, state, eye);
  assert.equal(beams.size, 0, "a retimed end is honoured");
  assert.equal(group.children.length, 0);
  assert.equal(leases, 0, "the texture lease goes with the beam");
  beams.add(handle, Array.from({ length: BEAM_CAPACITY + 3 }, () => ({ effect: effect(1), from: { guid: 1n, attachment: 22, point: { x: 0, y: 0, z: 0 } },
    to: { guid: 2n, attachment: 34 }, startedAt: 0, endsAt: 10_000 })));
  assert.equal(beams.size, BEAM_CAPACITY, "bounded");
  beams.update(50, points, state, eye);
  beams.cancel(handle);
  assert.equal(beams.size, 0);
  assert.equal(group.children.length, 0);
  assert.equal(leases, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  MISSILE_QUEUE_LIMIT_MS, MissileLaunchHolds, missileLaunchWait, releaseAttachment, shiftCast,
} from "../dist/code/browser/MissileLaunchWait.js";
import { ModelShotEvents } from "../dist/code/browser/VehicleMuzzle.js";
import { planSpellVisual } from "../dist/code/browser/SpellVisuals.js";
import { ACTED_EVENTS, modelEventsOf } from "../tools/generate-model-events.mjs";

// 15.11 (events8, 6.12): a missile queued by an animating cast (0x00732ff0) leaves at the clip's "$CSL"/"$CSR"/"$CST"/
// "$BWR" (0x00732650 → 0x00715a50, launched by 0x00734390), else at the clip's end (0x0073bbd0 resets +0xfa4), never
// past 2 s; a kit animation that is no cast (0x0071dcc0) lets it go at once.

let archives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
} catch {
  archives = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };

const SPELL_CAST_DIRECTED = 53;
const ev = (id, keys, extra = {}) => ({ id, bone: 0, x: 0, y: 0, z: 0, keys, ...extra });

test("the wait: the first launch event of the clip, the clip's end, 2 s; unknown events wait nothing", () => {
  const sequences = [[0, 0, 1000], [SPELL_CAST_DIRECTED, 0, 1000], [54, 0, 2500]];
  const model = (events) => ({ events, sequences });
  assert.equal(missileLaunchWait(undefined, SPELL_CAST_DIRECTED), undefined, "events still on the way");
  assert.equal(missileLaunchWait({ events: [], sequences: undefined }, SPELL_CAST_DIRECTED), undefined, "a version 1 gateway");
  const csr = ev("$CSR", [[SPELL_CAST_DIRECTED, 0, [300]], [54, 0, [700]]]);
  const csl = ev("$CSL", [[SPELL_CAST_DIRECTED, 0, [200, 900]]]);
  const fired = missileLaunchWait(model([csr, csl]), SPELL_CAST_DIRECTED);
  assert.equal(fired.delay, 200);
  assert.equal(fired.event.id, "$CSL", "the earliest of the four");
  assert.equal(missileLaunchWait(model([ev("$CAH", [[SPELL_CAST_DIRECTED, 0, [100]]])]), SPELL_CAST_DIRECTED).delay, 1000,
    "no launch event in the clip: its end");
  assert.equal(missileLaunchWait(model([]), 54).delay, MISSILE_QUEUE_LIMIT_MS, "a 2.5 s clip: the 2 s limit");
  assert.equal(missileLaunchWait(model([ev("$CST", [[54, 0, [2200]]])]), 54).event, undefined, "an event past 2 s is late");
  assert.equal(missileLaunchWait(model([ev("$CSL", [[SPELL_CAST_DIRECTED, 1, [100]]])]), SPELL_CAST_DIRECTED).delay, 1000,
    "another variation's keys are not the clip's");
  assert.equal(missileLaunchWait(model([ev("$CSL", [[SPELL_CAST_DIRECTED, 0, [100]]], { globalSequence: 0 })]),
    SPELL_CAST_DIRECTED).delay, 1000, "a track on a global loop has no clip moment");
});

test("the wait: a kit animation that is no cast lets the queue go at once (0x0071dcc0)", () => {
  const model = { events: [ev("$CSL", [[0, 0, [500]]])], sequences: [[0, 0, 1000]] };
  assert.equal(missileLaunchWait(model, 0).delay, 0, "Stand");
  assert.equal(missileLaunchWait(undefined, 0).delay, 0, "known without the events");
  assert.equal(missileLaunchWait({ events: [], sequences: [[0, 0, 1000]] }, 46).delay, 0,
    "AttackBow on a model with no such clip (nor a fallback it has): no animation plays");
});

test("$BWR's point: HandArrow for the bow behaviours, Bullet for the rifle ones (0x0071da60, 0x0071daa0)", () => {
  assert.equal(releaseAttachment(46), 35, "AttackBow");
  assert.equal(releaseAttachment(105), 35, "LoadBow");
  assert.equal(releaseAttachment(49), 36, "AttackRifle");
  assert.equal(releaseAttachment(106), 36, "LoadRifle");
  assert.equal(releaseAttachment(53), undefined);
});

const kit = (animation) => ({ startAnimation: -1, animation, effects: [], sound: 0 });
const missile = { path: "Spells\\Missile.m2", scale: 1, attachment: 22, speed: 20, sound: 0 };
const cast = { caster: 4n, casterPoint: { x: 0, y: 0, z: 0 }, targets: [{ guid: 9n, point: { x: 40, y: 0, z: 0 } }] };

test("a held cast: the missile waits, and its arrival and impacts move by the wait", () => {
  const plan = planSpellVisual({ id: 1, cast: kit(SPELL_CAST_DIRECTED), missile }, cast, 1000);
  const handle = {};
  const visuals = plan.instances.map((instance) => ({ instance, handle, authoredEndsAt: instance.endsAt }));
  const flight = visuals.find((visual) => visual.instance.flight);
  // The impact kit the planner puts at the arrival, and one effect of the GO itself.
  visuals.push({ instance: { startedAt: flight.instance.endsAt, endsAt: flight.instance.endsAt + 500 }, handle });
  visuals.push({ instance: { startedAt: 1000, endsAt: 1500 }, handle });
  assert.equal(flight.instance.flight.launch.wait, SPELL_CAST_DIRECTED);
  const arrival = flight.instance.endsAt;
  const before = visuals.map((visual) => [visual.instance.startedAt, visual.instance.endsAt]);
  const holds = new MissileLaunchHolds();
  let asked = 0;
  const resolve = () => { asked++; return { delay: 300, event: ev("$CSL", []), animation: SPELL_CAST_DIRECTED }; };
  assert.equal(holds.held(flight, 1000, resolve, visuals), true);
  assert.equal(holds.held(flight, 1299, resolve, visuals), true);
  assert.equal(holds.held(flight, 1300, resolve, visuals), false, "leaves at the event");
  assert.equal(asked, 1, "decided once per cast");
  assert.equal(flight.instance.endsAt, arrival + 300, "the flight keeps its length");
  assert.equal(holds.firedEvent(flight.instance).event.id, "$CSL");
  visuals.forEach((visual, index) => {
    if (visual === flight) return;
    const [startedAt, endsAt] = before[index];
    const moved = startedAt > 1000 ? 300 : 0;
    assert.deepEqual([visual.instance.startedAt, visual.instance.endsAt], [startedAt + moved, endsAt + moved]);
  });
  assert.ok(visuals.some((visual) => !visual.instance.flight && visual.instance.startedAt === arrival + 300), "the impact");
});

test("a cast whose wait is unknown leaves at once and moves nothing", () => {
  const plan = planSpellVisual({ id: 1, cast: kit(SPELL_CAST_DIRECTED), missile }, cast, 0);
  const handle = {};
  const visuals = plan.instances.map((instance) => ({ instance, handle }));
  const flight = visuals.find((visual) => visual.instance.flight);
  const arrival = flight.instance.endsAt;
  assert.equal(new MissileLaunchHolds().held(flight, 0, () => undefined, visuals), false);
  assert.equal(flight.instance.endsAt, arrival);
  assert.equal(shiftCast(visuals, {}, 0, 100), 0, "another cast's handle moves nothing");
});

test("the route client: version 2, then version 1 from a gateway that refuses it", async () => {
  const asked = [];
  const events = new ModelShotEvents("http://gateway", async (url) => {
    asked.push(url);
    if (url.includes("v=2") && url.includes("Old")) return new Response("", { status: 400 });
    if (url.includes("v=2")) return new Response(JSON.stringify({ events: [ev("$CSL", [[53, 0, [200]]])], sequences: [[53, 0, 1000]] }));
    return new Response(JSON.stringify({ events: [{ id: "$CSL", bone: 0, x: 0, y: 0, z: 0 }] }));
  });
  assert.equal(events.model("Creature\\New.m2"), undefined);
  assert.equal(events.model("Creature\\Old.m2"), undefined);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(events.model("Creature\\New.m2").sequences, [[53, 0, 1000]]);
  assert.equal(events.model("Creature\\Old.m2").sequences, undefined, "version 1: no keys");
  assert.equal(events.of("Creature\\Old.m2").length, 1, "its positions still serve");
  assert.deepEqual(asked.filter((url) => url.includes("Old")).map((url) => /v=(\d)/.exec(url)[1]), ["2", "1"]);
  assert.equal(missileLaunchWait(events.model("Creature\\New.m2"), 53).delay, 200);
});

test("the generator: 94 ids of 0x00732650 and $AIM; keys per sequence from the .m2", () => {
  assert.equal(ACTED_EVENTS.size, 95);
  // A model with one sequence (Stand, flag 0x20, 1000 ms) and two events, `$CSL` keyed at 250 and `FSND`.
  const bytes = Buffer.alloc(0x400);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(0x1c, 1, true); // sequences
  view.setUint32(0x20, 0x200, true);
  view.setUint16(0x200, 0, true); // id 0, variation 0
  view.setUint32(0x204, 1000, true); // duration
  view.setUint32(0x20c, 0x20, true); // flags: inside the .m2
  view.setInt16(0x23c, -1, true); // variationNext
  view.setUint32(0x100, 2, true); // events
  view.setUint32(0x104, 0x300, true);
  const put = (at, id) => {
    for (let index = 0; index < 4; index++) bytes[at + index] = id.charCodeAt(index);
    view.setInt16(at + 26, -1, true);
    view.setUint32(at + 28, 1, true);
    view.setUint32(at + 32, 0x380, true);
  };
  put(0x300, "$CSL");
  put(0x324, "FSND");
  view.setUint32(0x380, 1, true); // one key
  view.setUint32(0x384, 0x390, true);
  view.setUint32(0x390, 250, true);
  const answer = modelEventsOf(bytes);
  assert.deepEqual(answer.sequences, [[0, 0, 1000]]);
  assert.deepEqual(answer.events, [{ id: "$CSL", bone: 0, x: 0, y: 0, z: 0, keys: [[0, 0, [250]]] }]);
});

test("HumanMale on the client: SpellCastDirected's $CSL at 200 ms holds its missiles 200 ms; .anim keys are read", withClient, async () => {
  const base = "Character\\Human\\Male\\HumanMale";
  const m2 = await archives.read(`${base}.m2`);
  const anims = new Map();
  for (const suffix of ["0063-00", "0138-00"]) {
    const bytes = await archives.read(`${base}${suffix}.anim`);
    if (bytes) anims.set(suffix, bytes);
  }
  const answer = modelEventsOf(m2, anims);
  const wait = missileLaunchWait(answer, SPELL_CAST_DIRECTED);
  assert.equal(wait.delay, 200);
  assert.equal(wait.event.id, "$CSL");
  const bwp = answer.events.find((event) => event.id === "$BWP");
  assert.deepEqual(bwp.keys.find((key) => key[0] === 105), [105, 0, [434]], "LoadBow's $BWP");
  const cst = answer.events.find((event) => event.id === "$CST");
  if (anims.has("0063-00")) assert.ok(cst.keys.some((key) => key[0] === 63), "a key out of an external .anim");
});

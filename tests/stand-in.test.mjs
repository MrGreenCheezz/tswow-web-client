import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  STAND_IN_REASONS, STAND_IN_SAMPLE_LIMIT, STAND_IN_SAMPLE_RESERVE, StandInLedger, standInSummary,
} from "../dist/code/browser/StandIn.js";

test("the capsule ledger counts this frame's stand-ins by reason", () => {
  const ledger = new StandInLedger();
  ledger.begin();
  ledger.note(1n, 49, "display");
  ledger.note(2n, 50, "appearance");
  ledger.note(3n, 21935, "artifact", "Creature\\Murloc\\Murloc.m2");
  ledger.note(4n, 21935, "artifact", "Creature\\Murloc\\Murloc.m2");
  ledger.note(5n, 50, "atlas", "Character\\Human\\Female\\HumanFemale.m2");

  const report = ledger.report();
  assert.equal(report.total, 5);
  assert.deepEqual(report.byReason, { display: 1, appearance: 1, artifact: 2, atlas: 1, template: 0, queued: 0 });
  // Every reason is named whether or not it happened, so a caller can print the whole set.
  assert.deepEqual(Object.keys(report.byReason).sort(), [...STAND_IN_REASONS].sort());
});

test("the capsule ledger samples one unit per display id, not one per unit", () => {
  const ledger = new StandInLedger();
  ledger.begin();
  // A wave of the same broken creature is one fact about one display id. Keyed on the guid, the
  // sample list would be forty murlocs and the second broken display would never be shown.
  for (let guid = 1; guid <= 40; guid++) ledger.note(BigInt(guid), 21935, "artifact");
  ledger.note(99n, 448, "template", "Creature\\Kobold\\Kobold.m2");

  const report = ledger.report();
  assert.equal(report.total, 41);
  assert.equal(report.byReason.artifact, 40);
  assert.deepEqual(report.samples.map((sample) => sample.displayId), [21935, 448]);
  assert.equal(report.samples[0].guid, 1n, "the first unit seen is the one kept");
  assert.equal(report.samples[1].model, "Creature\\Kobold\\Kobold.m2");
  assert.equal(report.samples[0].model, undefined, "no model is recorded when the display never named one");
});

test("the capsule ledger holds a fixed number of samples and forgets the frame before", () => {
  const ledger = new StandInLedger();
  ledger.begin();
  for (let display = 1; display <= STAND_IN_SAMPLE_LIMIT + 5; display++) {
    ledger.note(BigInt(display), display, "artifact");
  }
  const full = ledger.report();
  assert.equal(full.total, STAND_IN_SAMPLE_LIMIT + 5, "everything is counted");
  assert.equal(full.samples.length, STAND_IN_SAMPLE_LIMIT, "only the first few are named");

  // The next frame is a fresh question: the units that found their models must drop out entirely.
  ledger.begin();
  ledger.note(7n, 49, "atlas");
  const next = ledger.report();
  assert.equal(next.total, 1);
  assert.equal(next.samples.length, 1);
  assert.deepEqual(next.byReason, { display: 0, appearance: 0, artifact: 0, atlas: 1, template: 0, queued: 0 });
});

test("a frame that never reached the units is not a frame with no capsules", () => {
  const ledger = new StandInLedger();
  // `draw()` returns before the unit walk on every frame with no self object or no position yet —
  // world enter, a teleport, a loading screen. That is the moment somebody opens the window to ask
  // why everything is a pill, and it used to be answered with the last frame the player stood in.
  assert.equal(ledger.report().walked, false);
  assert.equal(standInSummary(ledger.report()), "Капсулы: кадр до юнитов не дошёл — мир ещё грузится.");

  ledger.begin();
  ledger.note(1n, 21935, "artifact", "Creature\\Murloc\\Murloc.m2");
  assert.equal(ledger.report().walked, true);
  assert.match(standInSummary(ledger.report()), /^Капсул: 1 · модель не пришла 1$/);

  ledger.idle();
  const idle = ledger.report();
  assert.equal(idle.total, 0, "the frame drew nothing, so nothing on it is a capsule");
  assert.equal(idle.samples.length, 0);
  assert.equal(idle.walked, false);
  assert.equal(standInSummary(idle), "Капсулы: кадр до юнитов не дошёл — мир ещё грузится.");
});

test("the diagnostics window has the two boxes the capsule counter writes into", async () => {
  // `Dom.ts` resolves every id while it is being evaluated and throws on a missing one, so an id
  // that never reached the markup does not break the capsule line — it breaks the whole client.
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const diagnostics = /<aside id="diagnostics-window"[\s\S]*?<\/aside>/.exec(html);
  assert.ok(diagnostics, "the diagnostics window has to exist");
  assert.ok(diagnostics[0].includes('id="capsule-status"'));
  assert.ok(diagnostics[0].includes('id="capsule-reasons"'));
});

test("П1 a unit standing in the look it has already left is counted, and counted apart", () => {
  // The ledger's guard used to be `unit.body !== undefined`, and `#clearUnitNode` drops `body` the
  // first time a real model goes in — so a unit that has ever worn a model could never be written
  // down again. That is exactly the shapeshift fault: DISPLAYID moves, the new record has not come
  // back, and the player stands there as the thing they were a moment ago. The frame reported
  // «капсул: ни одной» while the druid was still a night elf.
  const ledger = new StandInLedger();
  ledger.begin();
  ledger.note(1n, 21935, "artifact", "Creature\\Murloc\\Murloc.m2");
  ledger.note(2n, 2281, "display", "Creature\\DruidBear\\DruidBear.m2", "model");
  ledger.note(3n, 2281, "display", "Creature\\DruidBear\\DruidBear.m2", "model");

  const report = ledger.report();
  assert.equal(report.total, 1, "one pill, and the two druids are not pills");
  assert.equal(report.stale, 2);
  assert.deepEqual(report.byReason, { display: 0, appearance: 0, artifact: 1, atlas: 0, template: 0, queued: 0 },
    "the reason breakdown stays a breakdown of the capsules, so «капсул: N» keeps meaning N pills");
  // Two samples, not one: the same display failing the same way is one fact per thing worn.
  assert.deepEqual(report.samples.map((sample) => [sample.displayId, sample.wearing]),
    [[21935, "capsule"], [2281, "model"]]);
  assert.equal(standInSummary(report), "Капсул: 1 · модель не пришла 1 · в прежней модели: 2");

  // A frame whose every unit has a model but the wrong one is the case worth naming out loud.
  ledger.begin();
  ledger.note(9n, 16031, "appearance", undefined, "model");
  assert.equal(standInSummary(ledger.report()), "Капсул: ни одной, но в прежней модели: 1.");
  assert.equal(ledger.report().total, 0);

  // And the counter is cleared with everything else at the start of the next frame.
  ledger.begin();
  assert.equal(ledger.report().stale, 0);
  assert.equal(standInSummary(ledger.report()), "Капсул: ни одной — все юниты в своих моделях.");
});

test("П1 a wave of stale models cannot push the capsules out of the sample list", () => {
  // The second column shared the one sample list and the one limit, and `note` is called in unit
  // order — so a frame that met its stale models first filled all eight places with them. Measured
  // on the built `dist` before the fix: eight stale notes on eight display ids and then one
  // capsule printed «Капсул: 1 · модель не пришла 1 · в прежней модели: 8» over eight rows of
  // which none was the capsule, losing display 21935 — the one address the ledger exists to name.
  const ledger = new StandInLedger();
  ledger.begin();
  for (let i = 0; i < STAND_IN_SAMPLE_LIMIT; i++) {
    ledger.note(BigInt(i + 1), 1000 + i, "display", undefined, "model");
  }
  ledger.note(99n, 21935, "artifact", "Creature\\Murloc\\Murloc.m2");

  const report = ledger.report();
  assert.equal(report.samples.length, STAND_IN_SAMPLE_LIMIT, "the report is still the same length");
  assert.deepEqual(report.samples[0], {
    guid: 99n, displayId: 21935, reason: "artifact", model: "Creature\\Murloc\\Murloc.m2",
    wearing: "capsule",
  }, "the pill is named, and named first");
  // It took one place from the column that was over its half, and the oldest stale rows stay:
  // the first samples of a wave are the ones that describe it.
  assert.deepEqual(report.samples.filter((sample) => sample.wearing === "model")
    .map((sample) => sample.displayId), [1000, 1001, 1002, 1003, 1004, 1005, 1006]);

  // The half is a floor, not a quota: neither column is cut short while the other is not using it.
  const only = (wearing) => {
    const one = new StandInLedger();
    one.begin();
    for (let i = 0; i < STAND_IN_SAMPLE_LIMIT + 4; i++) {
      one.note(BigInt(i + 1), 1000 + i, "display", undefined, wearing);
    }
    return one.report().samples.length;
  };
  assert.equal(only("capsule"), STAND_IN_SAMPLE_LIMIT, "a frame of nothing but pills still names 8");
  assert.equal(only("model"), STAND_IN_SAMPLE_LIMIT);

  // And a column may not eat past its own half: nine pills after eight stale models leave four.
  ledger.begin();
  for (let i = 0; i < STAND_IN_SAMPLE_LIMIT; i++) {
    ledger.note(BigInt(i + 1), 1000 + i, "display", undefined, "model");
  }
  for (let i = 0; i < STAND_IN_SAMPLE_LIMIT + 1; i++) ledger.note(BigInt(i + 100), 2000 + i, "artifact");
  const both = ledger.report();
  assert.equal(both.samples.length, STAND_IN_SAMPLE_LIMIT);
  assert.equal(both.samples.filter((sample) => sample.wearing === "capsule").length, STAND_IN_SAMPLE_RESERVE);
  assert.equal(both.samples.filter((sample) => sample.wearing === "model").length, STAND_IN_SAMPLE_RESERVE);
  // Both columns are counted in full whatever the sample list had room for.
  assert.equal(both.total, STAND_IN_SAMPLE_LIMIT + 1);
  assert.equal(both.stale, STAND_IN_SAMPLE_LIMIT);
});

test("П1 the renderer writes a reason down whether or not the capsule is still there", async () => {
  // The renderer half of the same fix, and it can only be read off the source: `#drawUnit` needs a
  // WebGL context and a scene graph. The claim is narrow — the note is no longer gated on the
  // capsule mesh existing, and which of the two the unit is wearing goes out with it.
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const draw = source.indexOf("#drawUnit(");
  const note = source.indexOf("this.#standIns.note(", draw);
  assert.ok(draw >= 0 && note > draw);
  const line = source.slice(source.lastIndexOf("\n", note - 1), source.indexOf("\n", note));
  assert.match(line, /standIn && shown/);
  assert.match(line, /wearing\)/, "the ledger is told what the unit is standing in");
  assert.ok(!/unit\.body !== undefined\s*&&/.test(source.slice(draw, note)),
    "the guard that hid every unit already wearing a model is gone");
  assert.match(source.slice(draw, note),
    /const wearing: StandInWearing = unit\.body === undefined \? "model" : "capsule"/);
});

test("the capsule line says how many and why, and says so in words when there are none", () => {
  const ledger = new StandInLedger();
  ledger.begin();
  assert.equal(standInSummary(ledger.report()), "Капсул: ни одной — все юниты в своих моделях.");

  ledger.note(1n, 49, "display");
  ledger.note(2n, 50, "template");
  ledger.note(3n, 51, "template");
  const line = standInSummary(ledger.report());
  assert.equal(line, "Капсул: 3 · display id без ответа 1 · скелет не собрался 2");
  // A reason that did not happen is left out rather than printed as a zero.
  assert.ok(!line.includes("атлас"));
});

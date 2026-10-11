import assert from "node:assert/strict";
import test from "node:test";

// P2-09a (line-P-P2): the frame budget sensor. A period runs from one frame callback's start to the
// next; a limiter fires at 0.1 ms; a period stacks with two or more fired limiters over 4 ms together.
const {
  FRAME_BUDGET, FRAME_BUDGET_FIRE_MS, FRAME_BUDGET_STACK_MS, FrameBudgetProbe, frameBudgetProbe,
} = await import("../dist/code/browser/FrameBudgetProbe.js");
const { FrameBuildBudget } = await import("../dist/code/browser/FrameBuildBudget.js");

function probeWithClock() {
  const clock = { now: 1000, reads: 0 };
  const probe = new FrameBudgetProbe(() => { clock.reads++; return clock.now; });
  /** `ms` of limiter `id` measured by begin/end. */
  const spend = (id, ms) => { const at = probe.begin(); clock.now += ms; probe.end(id, at); };
  return { probe, clock, spend };
}

test("two limiters of 3 and 2 ms in one period stack; the period closes at the next frame start", () => {
  const { probe, spend } = probeWithClock();
  probe.setEnabled(true);
  probe.frameStart();
  spend(FRAME_BUDGET.environment, 3);
  spend(FRAME_BUDGET.units, 2);
  assert.equal(probe.report().frames, 0, "still open");
  probe.frameStart();
  const report = probe.report();
  assert.equal(report.frames, 1);
  assert.equal(report.twoPlusOver4Ms, 1);
  assert.equal(report.firedHistogram[2], 1);
  assert.equal(report.share, 1);
  assert.equal(report.verdict, "GO");
  assert.equal(probe.lastBudgetMs, 5);
  assert.equal(probe.lastFired, 2);
  const environment = report.perBudget.find((row) => row.id === "environment");
  assert.deepEqual(environment, { id: "environment", frames: 1, totalMs: 3, meanWhenFiredMs: 3, maxMs: 3 });
});

test("a limiter under 0.1 ms has not fired, and two that fired under 4 ms do not stack", () => {
  const { probe, spend } = probeWithClock();
  probe.setEnabled(true);
  probe.frameStart();
  spend(FRAME_BUDGET.environment, 3.95);
  spend(FRAME_BUDGET.units, 0.05);
  probe.frameStart();
  assert.equal(probe.lastFired, 1, "0.05 ms is below the fire threshold");
  spend(FRAME_BUDGET.environment, 1);
  spend(FRAME_BUDGET.warmup, 2.5);
  probe.frameStart();
  const report = probe.report();
  assert.equal(report.frames, 2);
  assert.equal(report.twoPlusOver4Ms, 0, "3.5 ms is not over 4");
  assert.deepEqual(report.firedHistogram.slice(0, 3), [0, 1, 1]);
  assert.equal(report.verdict, "NO-GO");
  // The mean is over the periods where it fired: the 0.05 ms of units is in its total, not in a mean.
  assert.deepEqual(report.perBudget.find((row) => row.id === "units"), { id: "units", frames: 0, totalMs: 0.05, meanWhenFiredMs: 0, maxMs: 0.05 });
  assert.equal(report.perBudget.find((row) => row.id === "environment")?.meanWhenFiredMs, 2.475);
  assert.equal(FRAME_BUDGET_FIRE_MS, 0.1);
  assert.equal(FRAME_BUDGET_STACK_MS, 4);
});

test("the mean when fired leaves out the periods where the limiter stayed under the threshold", () => {
  const { probe, spend } = probeWithClock();
  probe.setEnabled(true);
  probe.frameStart();
  spend(FRAME_BUDGET.terrain, 2);
  probe.frameStart();
  spend(FRAME_BUDGET.terrain, 0.05);
  probe.frameStart();
  assert.deepEqual(probe.report().perBudget.find((row) => row.id === "terrain"),
    { id: "terrain", frames: 1, totalMs: 2.05, meanWhenFiredMs: 2, maxMs: 2 });
});

test("calls of one limiter are summed, not counted as several limiters", () => {
  const { probe, spend } = probeWithClock();
  probe.setEnabled(true);
  probe.frameStart();
  for (let index = 0; index < 5; index++) spend(FRAME_BUDGET.units, 1);
  probe.frameStart();
  assert.equal(probe.lastFired, 1);
  assert.equal(probe.report().twoPlusOver4Ms, 0, "one limiter at 5 ms is no stack");
});

test("work between callbacks belongs to the period it falls in; the FrameXML step only joins the second statistic", () => {
  const { probe, spend } = probeWithClock();
  probe.setEnabled(true);
  probe.frameStart();
  spend(FRAME_BUDGET.environment, 2.5);
  // A packet and the HUD step after the callback, before the next one: still this period.
  probe.addOutside(FRAME_BUDGET.net, 2);
  probe.addOutside(FRAME_BUDGET.framexml, 3);
  probe.frameStart();
  spend(FRAME_BUDGET.environment, 2.5);
  probe.addOutside(FRAME_BUDGET.framexml, 3);
  probe.frameStart();
  const report = probe.report();
  assert.equal(report.twoPlusOver4Ms, 1, "environment and net in the first period; the second has one limiter");
  assert.equal(report.withStep.twoPlusOver4Ms, 2, "with the step the second period stacks too");
  assert.equal(report.perBudget.find((row) => row.id === "net")?.frames, 1, "the packet is not in the next period");
  assert.equal(probe.lastBudgetMs, 2.5, "the step is not limiter time");
});

test("a period that opened on an uncounted frame is closed but not counted", () => {
  const { probe, spend } = probeWithClock();
  probe.setEnabled(true);
  probe.frameStart(false);
  spend(FRAME_BUDGET.environment, 3);
  spend(FRAME_BUDGET.units, 3);
  probe.frameStart(true);
  spend(FRAME_BUDGET.environment, 1);
  probe.frameStart(true);
  const report = probe.report();
  assert.equal(report.frames, 1);
  assert.equal(report.twoPlusOver4Ms, 0);
});

test("disabled, the sensor reads no clock and keeps nothing", () => {
  const { probe, clock } = probeWithClock();
  assert.equal(probe.enabled, false);
  const at = probe.begin();
  assert.equal(at, 0);
  probe.end(FRAME_BUDGET.units, at);
  probe.end(FRAME_BUDGET.units, 900);
  probe.addOutside(FRAME_BUDGET.net, 5);
  probe.frameStart();
  probe.frameStart();
  assert.equal(clock.reads, 0, "no clock read at all");
  assert.equal(probe.report().frames, 0);
  assert.equal(probe.report().verdict, "no frames");
  // Enabling resets; disabling resets too.
  probe.setEnabled(true);
  probe.frameStart();
  probe.addOutside(FRAME_BUDGET.net, 5);
  probe.frameStart();
  assert.equal(probe.report().frames, 1);
  probe.setEnabled(false);
  assert.equal(probe.report().frames, 0);
});

test("FrameBuildBudget: take opens a build, done closes it; a missed done ends at the next take; begin forgets", () => {
  const { probe, clock } = probeWithClock();
  const budget = new FrameBuildBudget(4, 50, () => clock.now, FRAME_BUDGET.units, probe);
  probe.setEnabled(true);
  probe.frameStart();
  budget.begin();
  assert.equal(budget.take(), true);
  clock.now += 0.3;
  budget.done();
  budget.done(); // nothing open: nothing added
  clock.now += 7;
  assert.equal(budget.take(), true);
  clock.now += 0.4;
  assert.equal(budget.take(), true, "the second build's missing done is closed here");
  clock.now += 5;
  budget.begin(); // the next frame: the open build is dropped, not stretched over the frame
  clock.now += 9;
  budget.done();
  probe.frameStart();
  const units = probe.report().perBudget.find((row) => row.id === "units");
  assert.equal(units?.totalMs, 0.7, "0.3 closed by done, 0.4 closed by the next take; the rest is nobody's");
  // A budget with no probe id never touches a sensor; the shared one is off.
  const plain = new FrameBuildBudget(2, 2, () => clock.now, undefined, probe);
  plain.take();
  clock.now += 2;
  plain.done();
  probe.frameStart();
  assert.equal(probe.lastBudgetMs, 0);
  assert.equal(frameBudgetProbe.enabled, false, "the shared sensor is off unless a capture turns it on");
});

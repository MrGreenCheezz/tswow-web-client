import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.27 (03.10, L5): FrameXML's GetTime() as Wow.exe answers it (0x006081f0): whole
// milliseconds that never go back, the same clock as the frame step's pump.now().
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { createFrameXmlClock } = await import("../dist/code/browser/framexml/FrameXmlClock.js");

function bootWith(clock) {
  return new FrameXmlBoot({
    provider: createFixtureProvider({ "interface/framexml/framexml.toc": "A.lua", "interface/framexml/a.lua": "" }),
    exercise: false,
    ...(clock ? { clock } : {}),
  });
}

function getTime(boot) {
  const fn = boot.vm.compileFunction("return GetTime()", "clock-probe", []);
  try {
    return boot.vm.call(fn, [], 1)[0];
  } finally {
    boot.vm.release(fn);
  }
}

test("GetTime never goes back, counts whole milliseconds and is the frame step's clock", async () => {
  let now = 10_000_000.4;
  const boot = bootWith(() => now);
  try {
    await boot.load();
    assert.equal(getTime(boot), 10000);
    assert.equal(boot.pump.now(), 10000);
    now = 10_000_250.9;
    assert.equal(getTime(boot), 10000.25);
    assert.equal(boot.pump.now(), getTime(boot));
    // The system time set back an hour: Date.now() would go back; GetTime holds.
    now = 6_400_250;
    assert.equal(getTime(boot), 10000.25);
    assert.equal(boot.pump.now(), 10000.25);
    now = 10_000_300;
    assert.equal(getTime(boot), 10000.3);
  } finally {
    boot.close();
  }
});

test("by default GetTime is the page's monotonic clock, at Date.now()'s size", async () => {
  const boot = bootWith(undefined);
  try {
    await boot.load();
    const first = getTime(boot);
    assert.ok(Math.abs(first - Date.now() / 1000) < 5, `GetTime ${first} against Date.now ${Date.now() / 1000}`);
    assert.equal(Math.round(first * 1000), first * 1000, "whole milliseconds");
    const second = getTime(boot);
    assert.ok(second >= first);
    assert.ok(boot.pump.now() >= second);
  } finally {
    boot.close();
  }
});

test("the clock itself: monotonic over a source that jumps back", () => {
  const readings = [5000.9, 4000, 7000.2, Number.NaN, 6999];
  const clock = createFrameXmlClock(() => readings.shift());
  assert.deepEqual([clock(), clock(), clock(), clock(), clock()], [5, 5, 7, 7, 7]);
  assert.equal(createFrameXmlClock(() => Number.NaN)(), 0);
});

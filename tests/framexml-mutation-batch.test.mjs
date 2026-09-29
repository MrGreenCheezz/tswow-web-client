import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlUiBridge } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlTemplateRegistry } =
  await import("../dist/code/browser/ui/framexml_compat/FrameXmlParser.js");
const { GlueApi } = await import("../dist/code/browser/glue/GlueApi.js");

test("one mutation transaction notifies observers once, including nested transactions", () => {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const frame = bridge.CreateFrame("Frame", "BatchFrame");
  assert.ok(frame);
  let notifications = 0;
  bridge.subscribe(() => { notifications += 1; });

  bridge.runInMutationBatch(() => {
    bridge.SetText(frame, "first");
    bridge.runInMutationBatch(() => {
      bridge.SetTexture(frame, "second");
      bridge.SetPoint(frame, "CENTER");
    });
    bridge.SetText(frame, "third");
  });

  assert.equal(notifications, 1);
  assert.equal(frame.text, "third");
  assert.equal(frame.texture, "second");
});

test("one logical tick batches all visible OnUpdate mutations without changing dispatch", () => {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const frames = [1, 2, 3].map((index) => bridge.CreateFrame("Frame", `Ticker${index}`));
  assert.ok(frames.every(Boolean));
  let updates = 0;
  for (const [index, frame] of frames.entries()) {
    bridge.SetScript(frame, "OnUpdate", (self, elapsed) => {
      updates += 1;
      bridge.SetText(self, `${elapsed}:${updates}`);
      bridge.SetPoint(self, "CENTER", undefined, undefined, index, -index);
    });
  }
  let notifications = 0;
  bridge.subscribe(() => { notifications += 1; });

  assert.equal(bridge.tick(0.016), 3);
  assert.equal(updates, 3);
  assert.equal(notifications, 1);
  assert.equal(frames[0].text, "0.016:1");
  assert.equal(frames[2].points[0].x, 2);
});

test("setGlueScreen batches the whole VM call while preserving the call and release", () => {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const frame = bridge.CreateFrame("Frame", "ScreenFrame");
  assert.ok(frame);
  bridge.Hide(frame);
  let notifications = 0;
  bridge.subscribe(() => { notifications += 1; });
  const calls = [];
  const vm = {
    globalFunction(name) { return name === "SetGlueScreen" ? "set-screen" : undefined; },
    call(reference, args) {
      calls.push(["call", reference, args]);
      bridge.Show(frame);
      bridge.SetText(frame, String(args[0]));
      return [];
    },
    release(reference) { calls.push(["release", reference]); },
    globalString() { return undefined; },
  };
  const api = new GlueApi({ vm, bridge });

  assert.equal(api.setGlueScreen("charselect"), true);
  assert.deepEqual(calls, [
    ["call", "set-screen", ["charselect"]],
    ["release", "set-screen"],
  ]);
  assert.equal(notifications, 1);
  assert.equal(frame.visible, true);
  assert.equal(frame.text, "charselect");
});

test("setGlueScreen releases the Lua reference when the VM call throws and flushes once", () => {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const frame = bridge.CreateFrame("Frame", "ThrowingScreenFrame");
  assert.ok(frame);
  let notifications = 0;
  bridge.subscribe(() => { notifications += 1; });
  const released = [];
  const vm = {
    globalFunction() { return "set-screen"; },
    call(reference, args) {
      bridge.SetText(frame, String(args[0]));
      throw new Error("VM screen failure");
    },
    release(reference) { released.push(reference); },
    globalString() { return undefined; },
  };
  const api = new GlueApi({ vm, bridge });

  assert.throws(() => api.setGlueScreen("login"), /VM screen failure/);
  assert.deepEqual(released, ["set-screen"]);
  assert.equal(notifications, 1);
  assert.equal(frame.text, "login");
});

test("a throwing mutation transaction unwinds and does not wedge later notifications", () => {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const frame = bridge.CreateFrame("Frame", "ThrowingBatchFrame");
  assert.ok(frame);
  let notifications = 0;
  bridge.subscribe(() => { notifications += 1; });

  assert.throws(() => bridge.runInMutationBatch(() => {
    bridge.SetText(frame, "before throw");
    throw new Error("batch failure");
  }), /batch failure/);
  assert.equal(notifications, 1);

  bridge.SetText(frame, "after throw");
  assert.equal(notifications, 2);
  assert.equal(frame.text, "after throw");
});

test("dispatching one event preserves every handler and emits one render notification", () => {
  const bridge = new FrameXmlUiBridge(new FrameXmlTemplateRegistry());
  const frames = [1, 2].map((index) => bridge.CreateFrame("Frame", `EventFrame${index}`));
  assert.ok(frames.every(Boolean));
  const received = [];
  for (const [index, frame] of frames.entries()) {
    bridge.RegisterEvent(frame, "BATCH_EVENT");
    bridge.SetScript(frame, "OnEvent", (self, event, value) => {
      received.push([index, event, value]);
      bridge.SetText(self, `${event}:${value}`);
    });
  }
  let notifications = 0;
  bridge.subscribe(() => { notifications += 1; });

  assert.equal(bridge.dispatchEvent("BATCH_EVENT", 7), 2);
  assert.deepEqual(received, [[0, "BATCH_EVENT", 7], [1, "BATCH_EVENT", 7]]);
  assert.equal(notifications, 1);
});

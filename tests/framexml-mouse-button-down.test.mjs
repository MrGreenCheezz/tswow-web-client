import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";

// WORK_PLAN 3.60: FCFTab_OnUpdate (FloatingChatFrame.lua:1181) ends a chat frame's drag on the first
// frame `IsMouseButtonDown(self.dragButton)` is false. Unanswered, it was false always, so the frame
// moved only until the next frame: the owner's «короткие рывки».

async function booted() {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Empty.lua",
      "interface/framexml/empty.lua": "",
    }),
    exercise: false,
  });
  await boot.load();
  return boot;
}


test("3.60: the buttons the page reports answer by stock name, by number and with no argument", async () => {
  const boot = await booted();
  try {
    const { bridge } = boot;
    assert.equal(bridge.isMouseButtonDown("LeftButton"), false);
    assert.equal(bridge.isMouseButtonDown(), false);
    bridge.setMouseButtons(1);
    assert.equal(bridge.isMouseButtonDown("LeftButton"), true);
    assert.equal(bridge.isMouseButtonDown(1), true);
    assert.equal(bridge.isMouseButtonDown("RightButton"), false);
    assert.equal(bridge.isMouseButtonDown(), true, "no argument: any button");
    bridge.setMouseButtons(1 | 2 | 4 | 8 | 16);
    for (const name of ["RightButton", "MiddleButton", "Button4", "Button5"]) assert.equal(bridge.isMouseButtonDown(name), true, name);
    assert.equal(bridge.isMouseButtonDown(2), true);
    assert.equal(bridge.isMouseButtonDown(5), true);
    assert.equal(bridge.isMouseButtonDown("NotAButton"), false);
    assert.equal(bridge.isMouseButtonDown(6), false);
    bridge.setMouseButtons(0);
    assert.equal(bridge.isMouseButtonDown(), false);
  } finally { boot.close(); }
});

test("3.60: Lua's IsMouseButtonDown reads them, so a drag lives while the button is held", async () => {
  const boot = await booted();
  try {
    const ask = (argument) => {
      const fn = boot.vm.compileFunction(`return IsMouseButtonDown(${argument})`, "@probe", []);
      try { return boot.vm.call(fn, [], 1)[0]; } finally { boot.vm.release(fn); }
    };
    assert.equal(ask('"LeftButton"'), undefined);
    boot.bridge.setMouseButtons(1);
    assert.equal(ask('"LeftButton"'), 1);
    assert.equal(ask('"RightButton"'), undefined);
    assert.equal(ask(""), 1);
    boot.bridge.setMouseButtons(0);
    assert.equal(ask('"LeftButton"'), undefined);
  } finally { boot.close(); }
});

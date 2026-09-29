import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";

async function fixture(xml) {
  const boot = new FrameXmlBoot({ exercise: false, provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Animations.xml",
    "interface/framexml/animations.xml": `<Ui>${xml}</Ui>`,
  }) });
  const inventory = await boot.load();
  assert.equal(inventory.errors.length, 0, JSON.stringify(inventory.errors));
  const run = (source) => {
    const result = boot.vm.execute(source, "@animation-test");
    assert.equal(result.ok, true, result.error);
  };
  return { boot, run, frame: (name) => boot.bridge.getFrame(name), value: (name) => boot.vm.getGlobal(name),
    tick: (elapsed) => boot.bridge.tick(elapsed), close: () => boot.close() };
}

test("stock TutorialFrame named Alpha resolves through an unnamed BOUNCE group and paints both directions", async () => {
  const { run, frame, value, tick, close } = await fixture(`<Frame name="TutorialFrameCallOut">
    <Animations><AnimationGroup looping="BOUNCE"><Alpha name="$parentPulser" change="-.7" duration=".75"/></AnimationGroup></Animations>
    <Scripts><OnLoad>TutorialFrameCallOutPulser:Stop(); PulserParentOK = TutorialFrameCallOutPulser:GetRegionParent() == self</OnLoad></Scripts>
  </Frame>`);
  try {
    assert.equal(value("PulserParentOK"), true);
    run("TutorialFrameCallOutPulser:Play()");
    const callout = frame("TutorialFrameCallOut");
    tick(.375); assert.ok(Math.abs(callout.animationAlpha - .65) < 1e-8);
    tick(.375); assert.ok(Math.abs(callout.animationAlpha - .3) < 1e-8);
    tick(.375); assert.ok(Math.abs(callout.animationAlpha - .65) < 1e-8);
    tick(.375); assert.equal(callout.animationAlpha, 1);
    assert.equal(callout.alpha, 1, "animated opacity does not overwrite base SetAlpha state");
    run("TutorialFrameCallOutPulser:Stop()");
    assert.equal(callout.animationAlpha, undefined);
    tick(3); assert.equal(callout.animationAlpha, undefined);
  } finally { close(); }
});

test("original ordered fade-in and delayed OnFinished scripts keep parent keys and finish exactly once", async () => {
  const { boot, run, frame, value, tick, close } = await fixture(`<Frame name="Alert">
    <Animations>
      <AnimationGroup name="$parentAnimIn" parentKey="animIn">
        <Alpha change="-1" duration="0" order="1"/>
        <Alpha change="1" duration=".2" order="2"/>
      </AnimationGroup>
      <AnimationGroup name="$parentWaitAndAnimOut" parentKey="waitAndAnimOut">
        <Alpha startDelay=".4" change="-1" duration=".2" parentKey="animOut">
          <Scripts><OnFinished>Finished = (Finished or 0) + 1; self:GetRegionParent():Hide()</OnFinished></Scripts>
        </Alpha>
      </AnimationGroup>
    </Animations>
    <Scripts><OnLoad>ParentKeyOK = self.animIn == AlertAnimIn and self.waitAndAnimOut.animOut:GetParent() == self.waitAndAnimOut</OnLoad></Scripts>
  </Frame>`);
  try {
    assert.equal(value("ParentKeyOK"), true);
    run("Alert.animIn:Play()");
    assert.equal(frame("Alert").animationAlpha, 0);
    tick(.1); assert.equal(frame("Alert").animationAlpha, .5);
    tick(.1); assert.equal(frame("Alert").animationAlpha, undefined);
    run("Alert.waitAndAnimOut:Play()");
    tick(.4); assert.equal(frame("Alert").animationAlpha, 1);
    tick(.1); assert.ok(Math.abs(frame("Alert").animationAlpha - .5) < 1e-8);
    tick(.11); assert.equal(value("Finished"), 1);
    assert.equal(frame("Alert").visible, false);
    tick(10); assert.equal(value("Finished"), 1);
    assert.deepEqual(boot.vm.errors, []);
  } finally { close(); }
});

test("Lua-created groups support pause/resume, looping, parallel order, smoothing, and StopAnimating", async () => {
  const { run, frame, value, tick, close } = await fixture(`<Frame name="Owner" alpha=".8"/>`);
  try {
    run(`Group = Owner:CreateAnimationGroup("CreatedGroup")
      Fade = Group:CreateAnimation("Alpha", "CreatedFade")
      Fade:SetDuration(2); Fade:SetChange(-.4); Fade:SetSmoothing("IN")
      Timer = Group:CreateAnimation(); Timer:SetDuration(1)
      Group:SetLooping("REPEAT"); Group:SetScript("OnLoop", function(self, state) Loops = (Loops or 0) + 1 end)
      GroupParentOK = Group:GetParent() == Owner and Fade:GetParent() == Group
      Duration = Group:GetDuration(); FirstGroup = Owner:GetAnimationGroups() == Group
      Group:Play()`);
    assert.equal(value("GroupParentOK"), true); assert.equal(value("FirstGroup"), true);
    assert.equal(value("Duration"), 2, "same-order children run concurrently");
    tick(1); assert.ok(Math.abs(frame("Owner").animationAlpha - .7) < 1e-8);
    run("Group:Pause(); Paused = Group:IsPaused()");
    assert.equal(value("Paused"), true);
    tick(10); assert.ok(Math.abs(frame("Owner").animationAlpha - .7) < 1e-8);
    run("Group:Play()"); tick(1);
    assert.equal(value("Loops"), 1); assert.equal(frame("Owner").animationAlpha, .8);
    run("Owner:StopAnimating(); Stopped = Group:IsStopped()");
    assert.equal(value("Stopped"), true); assert.equal(frame("Owner").animationAlpha, undefined);
  } finally { close(); }
});

test("stock timer Animation OnLoad starts its group and invokes sandboxed OnFinished without a visual effect", async () => {
  const { frame, value, tick, close } = await fixture(`<Frame name="TimerOwner"><Animations>
    <AnimationGroup name="Countdown"><Animation name="Delayer" duration=".2" order="1"><Scripts>
      <OnFinished>TimerFinished = self == Delayer and this == self and requested == true</OnFinished>
    </Scripts></Animation><Scripts><OnLoad>self:Play()</OnLoad></Scripts></AnimationGroup>
  </Animations></Frame>`);
  try {
    tick(.1); assert.equal(value("TimerFinished"), undefined);
    tick(.1); assert.equal(value("TimerFinished"), true);
    assert.equal(frame("TimerOwner").animationAlpha, undefined);
  } finally { close(); }
});

let clientDirectory;
try { clientDirectory = (await import("../tools/paths.mjs")).clientDirectory(); } catch {}

test("the actual MPQ TutorialFrame exports and runs its named pulser", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { openClientArchives } = await import("../tools/mpq.mjs");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const chain = await openClientArchives(clientDirectory);
  const decoder = new TextDecoder();
  const boot = new FrameXmlBoot({ exercise: false, seam: new CannedWorldSeam(),
    subset: [...FRAMEXML_VERTICAL_TOC, "TutorialFrame.xml"],
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
  });
  try {
    await boot.load();
    const result = boot.vm.execute(`TutorialFrame_ClearTextures()
      TutorialFrameCallOutPulser:Play()
      OriginalPulserType = TutorialFrameCallOutPulser:GetObjectType()`, "@stock-tutorial-animation");
    assert.equal(result.ok, true, result.error);
    assert.equal(boot.vm.getGlobal("OriginalPulserType"), "Alpha");
    boot.bridge.tick(.375);
    assert.ok(Math.abs(boot.bridge.getFrame("TutorialFrameCallOut").animationAlpha - .65) < 1e-8);
    assert.ok(!boot.vm.errors.some((error) => error.includes("TutorialFrameCallOutPulser")));
  } finally { boot.close(); await chain.close(); }
});

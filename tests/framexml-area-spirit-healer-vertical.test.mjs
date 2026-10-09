// Plan items 5.25 and 3.14 (L3) over the real stock FrameXML of the client MPQ: the spirit guide's
// answer reaches UIParent_OnEvent (UIParent.lua:741-749), which queues with AcceptAreaSpiritHeal and
// shows AREA_SPIRIT_HEAL (StaticPopup.lua:2315-2329) counting GetAreaSpiritHealerTime down; its
// button calls CancelAreaSpiritHeal; leaving the guide hides it through AREA_SPIRIT_HEALER_OUT_OF_RANGE.
import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { FrameXmlAreaSpiritHealerModel } = await import("../dist/code/browser/framexml/FrameXmlAreaSpiritHealer.js");

const decoder = new TextDecoder("utf-8");
const GUIDE = 0xf1300033bc000101n;

function lua(boot, code, count = 1) {
  const fn = boot.vm.compileFunction(code, "area-spirit-healer-vertical", []);
  assert.ok(fn, `the probe compiles: ${code}`);
  try { return boot.vm.call(fn, [], count); } finally { boot.vm.release(fn); }
}

/** The shown AREA_SPIRIT_HEAL dialog as `text|button1|button2`, or undefined. */
function dialog(boot) {
  return lua(boot, `
    for index = 1, STATICPOPUP_NUMDIALOGS do
      local dialog = _G["StaticPopup" .. index]
      if dialog:IsShown() and dialog.which == "AREA_SPIRIT_HEAL" then
        return table.concat({ dialog.text:GetText() or "", dialog.button1:IsShown() and dialog.button1:GetText() or "-",
          dialog.button2:IsShown() and dialog.button2:GetText() or "-" }, "|"), dialog:GetName()
      end
    end
  `, 2);
}

test("stock AREA_SPIRIT_HEAL: queue on IN_RANGE, the countdown, Cancel, and OUT_OF_RANGE", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const world = {
    spiritHealerTimers: new Map(),
    sent: [],
    queryAreaSpiritHealer(guid) { this.sent.push(["query", guid]); },
    queueAreaSpiritHealer(guid) { this.sent.push(["queue", guid]); },
    cancelAura(spellId) { this.sent.push(["cancelAura", spellId]); },
  };
  const clock = { now: 1_000_000 };
  const state = { owned: false, yards: 8 };
  const model = new FrameXmlAreaSpiritHealerModel({
    world: () => world,
    now: () => clock.now,
    ghost: () => true,
    owned: () => state.owned,
    distanceSquared: () => state.yards * state.yards,
    findGuide: (limit) => (state.yards * state.yards <= limit ? GUIDE : undefined),
  });
  const seam = new CannedWorldSeam();
  Object.defineProperty(seam, "areaSpiritHealer", { value: model, configurable: true });
  const attach = seam.attach.bind(seam);
  seam.attach = (pump) => { attach(pump); model.attach(pump); };
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    await boot.load();
    const errors = boot.errorCount;
    const newErrors = () => JSON.stringify(boot.errors.slice(errors));
    assert.deepEqual(world.sent, [], "nothing is asked while stock does not own the confirmations");

    state.owned = true;
    model.tick();
    assert.deepEqual(world.sent, [["query", GUIDE]]);
    world.spiritHealerTimers.set(GUIDE, { milliseconds: 25_000, receivedAt: clock.now });
    model.tick();
    assert.deepEqual(world.sent, [["query", GUIDE], ["queue", GUIDE]], "UIParent answers IN_RANGE with AcceptAreaSpiritHeal");
    assert.equal(dialog(boot)[1] !== undefined, true, "AREA_SPIRIT_HEAL is shown");
    clock.now += 1_000;
    boot.bridge.tick(1);
    const [shown] = dialog(boot);
    assert.match(shown, /^Воскрешение через 24 с\.\|Отмена\|-$/, `the countdown from GetAreaSpiritHealerTime: ${shown}`);
    assert.equal(boot.errorCount, errors, newErrors());

    const name = dialog(boot)[1];
    assert.ok(boot.bridge.Click(boot.bridge.getFrame(`${name}Button1`), "LeftButton", false) !== false);
    assert.equal(dialog(boot)[1], undefined, "the button hides it");
    assert.deepEqual(world.sent.at(-1), ["cancelAura", 2584], "CancelAreaSpiritHeal: Waiting to Resurrect");

    world.spiritHealerTimers.set(GUIDE, { milliseconds: 18_000, receivedAt: clock.now });
    model.tick();
    assert.ok(dialog(boot)[1], "a new answer shows it again");
    state.yards = 30;
    model.tick();
    assert.equal(dialog(boot)[1], undefined, "leaving the guide: OUT_OF_RANGE → StaticPopup_Hide");
    assert.deepEqual(world.sent.at(-1), ["cancelAura", 2584]);
    assert.equal(boot.errorCount, errors, newErrors());
  } finally {
    boot.close();
    chain.close();
  }
});

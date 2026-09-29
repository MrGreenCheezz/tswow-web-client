import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the real Blizzard_BarbershopUI loaded on demand by the lazy owner the world mount
// publishes (FrameXmlBarberOwner.ts), over the vertical corpus and the canned tauren chair: the enable
// packet → load → gate → BARBER_SHOP_OPEN → the stock frame with four selectors; the price from the
// core's formula; CMSG_ALTER_APPEARANCE, the success and the close; the cancel that stands up.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { createLazyFrameXmlBarberOwner, frameXmlBarberGate } = await import("../dist/code/browser/framexml/FrameXmlBarberOwner.js");
const { FRAMEXML_CANNED_BARBER_COST } = await import("../dist/code/browser/framexml/FrameXmlBarberCanned.js");
const { FRAMEXML_BARBER_OPTIONS_VERSION } = await import("../dist/code/browser/framexml/FrameXmlBarberLive.js");
const decoder = new TextDecoder("utf-8");

async function load() {
  const seam = new CannedWorldSeam();
  const reads = [];
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        if (data) reads.push([path.toLowerCase(), data.length]);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  await boot.load();
  return { boot, seam, reads };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "barber-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

function renderer() {
  const elements = new Map();
  return {
    elementFor(frame) {
      if (!elements.has(frame)) {
        const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
        elements.set(frame, { dataset: {}, getAttribute: (name) => attributes.get(name) ?? null });
      }
      return elements.get(frame);
    },
    addRoots() {},
    sync() {},
  };
}

const newErrors = (boot, from) => JSON.stringify(boot.errors.slice(from).map((e) => `${e.file}:${e.line} ${e.message}`));
const settle = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };

async function seated() {
  const { boot, seam, reads } = await load();
  const native = [];
  const owner = createLazyFrameXmlBarberOwner(seam, boot, renderer(), {
    hide: () => native.push("hide"), show: () => native.push("show"),
  }, () => Promise.resolve());
  return { boot, seam, reads, owner, native };
}

test("the options route version is the one the creation screens cache", async () => {
  const { CHARACTER_OPTIONS_VERSION } = await import("../dist/code/browser/CharacterAtlas.js");
  assert.equal(FRAMEXML_BARBER_OPTIONS_VERSION, CHARACTER_OPTIONS_VERSION);
});

test("the chair loads Blizzard_BarbershopUI and shows the stock frame with the tauren's four selectors", withClient, async () => {
  const { boot, seam, reads, owner, native } = await seated();
  try {
    assert.equal(boot.bridge.getFrame("BarberShopFrame")?.name, undefined, "nothing at boot");
    const errors = boot.errorCount;
    const before = reads.length;
    const widgets = boot.bridge.frames.length;
    seam.barberWorld.sit();
    await owner.settled;
    await settle();
    const files = reads.slice(before);
    assert.equal(files.length, 4, JSON.stringify(files));
    assert.equal(files.reduce((sum, [, bytes]) => sum + bytes, 0), 12_710);
    // With the eight selector arrows the runtime skipped as virtual children (FrameXmlInspectCorpus.ts).
    assert.equal(boot.bridge.frames.length - widgets, 85);
    assert.equal(owner.ownsShop(), true);
    assert.deepEqual(native, ["hide"], "the native window steps aside once the stock frame shows");
    const frame = boot.bridge.getFrame("BarberShopFrame");
    assert.equal(boot.bridge.isVisible(frame), true);
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("BarberShopBannerFrame")), true);
    assert.equal(boot.bridge.getFrame("BarberShopFrameSelector4").visible, true, "CanAlterSkin: the fourth selector");
    const strings = lua(boot, "return HAIR_HORNS_STYLE, HAIR_HORNS_COLOR, FACIAL_HAIR_NORMAL, SKIN_COLOR", 4);
    assert.deepEqual(["BarberShopFrameSelector1Category", "BarberShopFrameSelector2Category",
      "BarberShopFrameSelector3Category", "BarberShopFrameSelector4Category"].map((name) => boot.bridge.getFrame(name).text), strings);
    assert.deepEqual(lua(boot, "return GetBarberShopTotalCost()"), [0]);
    assert.equal(boot.bridge.getFrame("BarberShopFrameOkayButton").enabled, false, "the current look costs nothing");
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    owner.dispose();
    boot.close();
  }
});

test("the selectors price the look with the core's formula and the haircut sends CMSG_ALTER_APPEARANCE", withClient, async () => {
  const { boot, seam, owner } = await seated();
  const world = seam.barberWorld;
  try {
    world.sit();
    await owner.settled;
    await settle();
    const errors = boot.errorCount;
    const base = FRAMEXML_CANNED_BARBER_COST;
    lua(boot, "BarberShopFrameSelector1Next:Click()", 0);
    assert.deepEqual(lua(boot, "return GetBarberShopTotalCost(), (GetBarberShopStyleInfo(1))", 2), [base, "Пробивные"]);
    assert.equal(boot.bridge.getFrame("BarberShopBannerFrameCaption").text, "Пробивные");
    assert.equal(boot.bridge.getFrame("BarberShopFrameOkayButton").enabled, true);
    lua(boot, "BarberShopFrameSelector2Next:Click()", 0);
    assert.deepEqual(lua(boot, "return GetBarberShopTotalCost()"), [base], "a colour with a new style is included");
    lua(boot, "BarberShopFrameSelector1Prev:Click()", 0);
    assert.deepEqual(lua(boot, "return GetBarberShopTotalCost()"), [Math.trunc(base * 0.5)], "a colour alone is half");
    lua(boot, "BarberShopFrameSelector3Next:Click() BarberShopFrameSelector4Prev:Click()", 0);
    assert.deepEqual(lua(boot, "return GetBarberShopTotalCost()"), [Math.trunc(base * 0.5 + base * 0.75 + base * 0.75)]);
    lua(boot, "BarberShopFrameOkayButton:Click()", 0);
    // Horns 744 (current), colour 1, facial «Коса» 757, fur 1122 (data 2).
    assert.deepEqual(world.applied, [[744, 1, 757, 1122]]);
    world.answer(0);
    seam.barber.tick();
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("BarberShopFrame")), false, "the core stands the character up");
    assert.equal(seam.barber.open, false);
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    owner.dispose();
    boot.close();
  }
});

test("Cancel stands the character up; the reset returns every selector to the current look", withClient, async () => {
  const { boot, seam, owner } = await seated();
  const world = seam.barberWorld;
  try {
    world.sit();
    await owner.settled;
    await settle();
    const errors = boot.errorCount;
    lua(boot, "BarberShopFrameSelector1Next:Click() BarberShopFrameSelector3Next:Click()", 0);
    lua(boot, "BarberShopFrameResetButton:Click()", 0);
    assert.deepEqual(lua(boot, "return GetBarberShopTotalCost(), (GetBarberShopStyleInfo(1))", 2), [0, "Бык"]);
    lua(boot, "BarberShopFrameCancelButton:Click()", 0);
    assert.equal(world.standUps, 1);
    seam.barber.tick();
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("BarberShopFrame")), false);
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("BarberShopBannerFrame")), false);
    assert.deepEqual(world.applied, []);
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    owner.dispose();
    boot.close();
  }
});

test("a failed gate leaves the chair to the native window", withClient, async () => {
  const { boot, seam } = await load();
  const native = [];
  const broken = { ...renderer(), elementFor: () => undefined };
  const owner = createLazyFrameXmlBarberOwner(seam, boot, broken, {
    hide: () => native.push("hide"), show: () => native.push("show"),
  }, () => Promise.resolve());
  try {
    seam.barberWorld.sit();
    await owner.settled;
    await settle();
    assert.equal(owner.failed, true);
    assert.deepEqual(native, ["show"]);
    assert.equal(owner.ownsShop(), false);
    assert.equal(seam.barber.onOpenRequest, undefined);
    assert.equal(frameXmlBarberGate(seam, boot, renderer()) !== undefined, true, "the same tree gates with a rendered DOM");
  } finally {
    owner.dispose();
    boot.close();
  }
});

import assert from "node:assert/strict";
import test, { after } from "node:test";

// Plan item 3.24 (L5c, 04.10): the profession, auction and guild-bank add-ons are loaded in the
// mount's loading window (FrameXmlLodPreload.ts FRAMEXML_PRELOADED_OWNER_ADDONS, through the owners'
// host preparation in FrameXmlOwnerPreload.ts), and their owners know it: the first profession opens
// with no native craft window in between, and an auction or guild-bank owner whose add-on is in passes
// its gate before any visit, so the first visit is stock's (FrameXmlAuctionMount.ts and
// FrameXmlGuildBankMount.ts call `begin` at publish then).
// L5c-review 3.24 (owner pending): only the trainer and the profession add-ons are preloaded now; the
// auction and guild-bank ones load at their first visit, as before L5c (cost in FrameXmlLodPreload.ts).
// Their host preparation (FrameXmlOwnerPreload.ts) and the owners' begin-before-a-visit stay tested
// below for the day the owner turns the preload back on.
// DEC-A 3.24: that day is 04.10 — the owner decided to preload both again, as L5c had it.
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
const { frameXmlPreloadOwnerAddon } = await import("../dist/code/browser/framexml/FrameXmlOwnerPreload.js");
const { FRAMEXML_PRELOADED_OWNER_ADDONS } = await import("../dist/code/browser/framexml/FrameXmlLodPreload.js");
const { createLazyFrameXmlAuctionOwner } = await import("../dist/code/browser/framexml/FrameXmlAuctionOwner.js");
const { createLazyFrameXmlGuildBankOwner } = await import("../dist/code/browser/framexml/FrameXmlGuildBankOwner.js");
const { createLazyFrameXmlTradeSkillOwner, FRAMEXML_TRADESKILL_ADDON } = await import("../dist/code/browser/framexml/FrameXmlTradeSkillOwner.js");
const decoder = new TextDecoder("utf-8");

/** A renderer stand-in whose element tree mirrors the frame tree, as FrameXmlDomRenderer's does. */
function treeRenderer() {
  const elements = new Map();
  const elementFor = (frame) => {
    if (!frame) return null;
    if (!elements.has(frame)) {
      const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
      elements.set(frame, { dataset: {}, get parentElement() { return elementFor(frame.parent); }, getAttribute: (name) => attributes.get(name) ?? null });
    }
    return elements.get(frame);
  };
  return { elementFor, addRoots() {}, sync() {} };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "owner-preload-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("the three owners' add-ons are preloaded after the trainer's", () => { // DEC-A 3.24: as L5c had it
  // L5c-review 3.24 (owner pending) took Blizzard_AuctionUI and Blizzard_GuildBankUI out;
  // DEC-A 3.24: the owner decided 04.10 — preload both.
  assert.deepEqual([...FRAMEXML_PRELOADED_OWNER_ADDONS],
    ["Blizzard_TrainerUI", "Blizzard_TradeSkillUI", "Blizzard_AuctionUI", "Blizzard_GuildBankUI"]);
});

test("preloaded with no window open: no Lua error, nothing shown; the vault and the house open straight into stock", withClient, async () => { // DEC-A 3.24
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  try {
    await boot.load();
    const errors = boot.errorCount;
    // DEC-A 3.24: what the mount's loading window preloads — all four, the owners' host preparation first.
    lua(boot, "__ownerPreloadTabs = GetNumGuildBankTabs; return 1");
    for (const name of FRAMEXML_PRELOADED_OWNER_ADDONS) {
      const result = await frameXmlPreloadOwnerAddon(boot, name);
      assert.equal(result.ok, true, `${name}: ${result.message}`);
      assert.equal(boot.isAddonLoaded(name), true, `${name} is in before any visit`);
    }
    // The owners' host preparation ran first, as their own `load` runs it before the add-on.
    // (The auction one, DressUpTexturePath, is the vertical DressUpFrame.lua's already: a no-op here.)
    assert.deepEqual(lua(boot, "return type(DressUpTexturePath)"), ["function"]);
    assert.deepEqual(lua(boot, "return rawequal(__ownerPreloadTabs, GetNumGuildBankTabs) and 1 or 0"), [0], "the vault preparation");
    assert.equal(boot.errorCount, errors, `no Lua error: ${boot.vm.errors.slice(-3).join(" | ")}`);
    for (const name of ["TradeSkillFrame", "AuctionFrame", "GuildBankFrame"]) {
      assert.equal(boot.bridge.isVisible(boot.bridge.getFrame(name)), false, `${name} stays hidden`);
    }

    // The auction owner at publish (the house closed): the gate passes now and stock owns the house.
    const auctionNative = { shows: 0, hides: 0 };
    const auction = createLazyFrameXmlAuctionOwner(seam, boot, treeRenderer(), {
      hide: () => { auctionNative.hides += 1; }, show: () => { auctionNative.shows += 1; },
    }, (reason) => assert.fail(reason));
    auction.begin();
    await auction.settled;
    assert.equal(auction.loaded, true);
    assert.equal(seam.auction.owned, true, "stock owns the house before the first visit");
    assert.equal(lua(boot, "return AuctionFrame:IsShown() and 1 or 0")[0], 0, "no house open: nothing shown");
    seam.auctionWorld.open();
    seam.tick(boot.pump.now() + 1);
    assert.equal(lua(boot, "return AuctionFrame:IsShown() and 1 or 0")[0], 1, "the first auctioneer opens the stock AuctionFrame");
    assert.deepEqual(auctionNative, { shows: 0, hides: 0 }, "the native window was never asked");

    // The guild vault likewise.
    const bankNative = { shows: 0, hides: 0 };
    const bank = createLazyFrameXmlGuildBankOwner(seam, boot, treeRenderer(), {
      hide: () => { bankNative.hides += 1; }, show: () => { bankNative.shows += 1; },
    }, (reason) => assert.fail(reason));
    bank.begin();
    await bank.settled;
    assert.equal(bank.loaded, true);
    assert.equal(seam.guildBank.owned, true);
    assert.deepEqual(bankNative, { shows: 0, hides: 0 });
    assert.equal(boot.errorCount, errors, `no Lua error: ${boot.vm.errors.slice(-3).join(" | ")}`);
  } finally {
    boot.close();
  }
});

test("a preloaded profession add-on opens with no native craft window in between; a failed gate still falls back", async () => {
  const run = async (preloaded) => {
    const native = [];
    const owner = createLazyFrameXmlTradeSkillOwner({
      seam: { tradeSkill: { canOpen: () => true, showing: false, skillId: 0, targeting: undefined, cancelTargeting: () => false } },
      boot: {
        isAddonLoaded: (name) => preloaded && name === FRAMEXML_TRADESKILL_ADDON,
        // The gate cannot pass over this fake: the owner demotes, which is the fallback path.
        loadAddon: async () => ({ ok: false, addon: FRAMEXML_TRADESKILL_ADDON, status: "failed", message: "x", dependencies: [], loaded: [], roots: [] }),
        vm: { executeReported() {} }, bridge: { getFrame: () => undefined, isVisible: () => false, Hide() {} }, errorCount: 0,
      },
      renderer: { elementFor: () => null, addRoots() {}, sync() {} },
      native: { open: (skillId) => { native.push(["open", skillId]); return true; }, stepAside: () => native.push(["aside"]), isOpen: () => true },
    });
    assert.equal(owner.open(164), true);
    const before = [...native];
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    return { before, after: native };
  };
  const preloaded = await run(true);
  assert.deepEqual(preloaded.before, [], "the add-on is in: no native window while the gate runs");
  assert.deepEqual(preloaded.after, [["open", 164]], "the failed gate opens it after all");
  const cold = await run(false);
  assert.deepEqual(cold.before, [["open", 164]], "not in yet: the native window answers at once, as before");
});

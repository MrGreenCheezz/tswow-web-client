import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the real Blizzard_ItemSocketingUI loaded on demand by the lazy owner the world mount
// publishes (FrameXmlSocketOwner.ts), over the vertical corpus, the active TSAddons (gem-abilities
// among them) and the canned socketing world: SocketInventoryItem → load → gate → SOCKET_INFO_UPDATE →
// the stock frame; gems staged by ClickSocketButton, a stack split first, AcceptSockets' packet, the
// server's answer, and gem-abilities' extraction button on the stock frame.
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
const { createLazyFrameXmlSocketOwner, frameXmlSocketGate } = await import("../dist/code/browser/framexml/FrameXmlSocketOwner.js");
const { TswowAddonTestTransport, doublePacket } = await import("../tools/check-tswow-addons.mjs");
const decoder = new TextDecoder("utf-8");

async function load({ tsAddons = false } = {}) {
  const seam = new CannedWorldSeam();
  const packets = new TswowAddonTestTransport();
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
    ...(tsAddons ? { includeActiveTsAddons: true, clientNetwork: packets } : {}),
  });
  await boot.load();
  return { boot, seam, packets, reads };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "socket-test", []);
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

test("nothing loads at boot; the first SocketInventoryItem loads the add-on and shows the stock frame", withClient, async () => {
  const { boot, seam, reads } = await load();
  const native = [];
  try {
    assert.equal(boot.bridge.getFrame("ItemSocketingFrame")?.name, undefined, "no socketing frame at boot");
    assert.equal(reads.some(([path]) => path.includes("blizzard_itemsocketingui")), false);
    const owner = createLazyFrameXmlSocketOwner(seam, boot, renderer(), { open: (target) => native.push(target) });
    const errors = boot.errorCount;
    const before = reads.length;
    const widgets = boot.bridge.frames.length;
    lua(boot, "SocketInventoryItem(1)", 0);
    assert.equal(seam.socket.active, true, "the stock route took the request");
    await owner.settled;
    await settle();
    const files = reads.slice(before).filter(([path]) => path.includes("blizzard_itemsocketingui"));
    assert.equal(files.length, 4, JSON.stringify(files));
    assert.equal(files.reduce((sum, [, bytes]) => sum + bytes, 0), 24_117);
    assert.equal(boot.bridge.frames.length - widgets, 111);
    assert.equal(owner.loaded, true);
    assert.deepEqual(native, [], "the native picker was not needed");
    const frame = boot.bridge.getFrame("ItemSocketingFrame");
    assert.equal(boot.bridge.isVisible(frame), true, "UIParent's SOCKET_INFO_UPDATE showed the stock frame");
    assert.deepEqual(lua(boot, "return GetNumSockets(), GetSocketTypes(1), GetSocketTypes(2), GetSocketTypes(3)", 4),
      [3, "Meta", "Red", "Yellow"]);
    assert.deepEqual(lua(boot, "return GetExistingSocketInfo(1)", 3),
      ["Хаотический алмаз небесного сияния", "Interface\\Icons\\INV_Jewelcrafting_IceDiamond_02", true]);
    assert.deepEqual(lua(boot, "return GetExistingSocketInfo(2)", 1), [undefined]);
    assert.deepEqual(lua(boot, "local name, icon, quality = GetSocketItemInfo() return name, quality", 2), ["Шлем гранильщика", 4]);
    assert.equal(boot.bridge.getFrame("ItemSocketingSocket3").visible, true);
    assert.equal(boot.bridge.getFrame("ItemSocketingSocketButton").enabled, false, "nothing staged: the accept button is off");
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
    owner.dispose();
  } finally {
    boot.close();
  }
});

test("ClickSocketButton stages the cursor gem, refuses a normal gem in the meta socket and splits a stack first", withClient, async () => {
  const { boot, seam } = await load();
  const world = seam.socketWorld;
  const owner = createLazyFrameXmlSocketOwner(seam, boot, renderer(), { open() {} });
  try {
    lua(boot, "SocketInventoryItem(1)", 0);
    await owner.settled;
    await settle();
    const errors = boot.errorCount;
    const uiErrors = [];
    boot.vm.registerGlobal("__socketTestError", (args) => { uiErrors.push(String(args[1])); return []; });
    lua(boot, `local f = CreateFrame("Frame") f:RegisterEvent("UI_ERROR_MESSAGE") f:SetScript("OnEvent", function(_, e, m) __socketTestError(e, m) end)`, 0);

    world.cursor = 0x4000_0101n; // the single ruby
    lua(boot, "ItemSocketingSocket1:Click()", 0);
    assert.equal(seam.socket.staged(0x4000_0101n), false, "a red gem never goes into the meta socket");
    assert.equal(uiErrors.length, 1);
    lua(boot, "ItemSocketingSocket2:Click()", 0);
    assert.equal(world.cursor, undefined, "the gem leaves the cursor");
    assert.deepEqual(lua(boot, "return GetNewSocketInfo(2)", 3),
      ["Рельефный багровый рубин", "Interface\\Icons\\INV_Jewelcrafting_Gem_37", true]);
    assert.match(lua(boot, "return GetNewSocketLink(2)")[0], /\|Hitem:40111:0:0:0:0:0:0:0:80\|h\[Рельефный багровый рубин\]/);
    assert.equal(boot.bridge.getFrame("ItemSocketingSocketButton").enabled, true, "a staged gem enables the accept button");

    world.cursor = 0x4000_0102n; // three amber in one stack: the server would destroy the whole stack
    lua(boot, "ItemSocketingSocket3:Click()", 0);
    assert.deepEqual(world.splits, [{ guid: 0x4000_0102n, bag: 255, slot: 25 }], "one gem is split into the first free slot");
    assert.deepEqual(lua(boot, "return GetNewSocketInfo(3)", 1), [undefined], "nothing is staged until the split lands");
    world.landSplit();
    seam.socket.tick();
    const separated = world.carried.get("255:25");
    assert.equal(separated.count, 1);
    assert.equal(seam.socket.staged(separated.guid), true, "the separated single is what is staged");
    assert.equal(lua(boot, "return (GetNewSocketInfo(3))")[0], "Мягкий царский янтарь");

    lua(boot, "ItemSocketingSocketButton:Click()", 0);
    assert.deepEqual(world.sent, [{ itemGuid: 0x4000_0100n, gems: [0n, 0x4000_0101n, separated.guid] }]);
    world.answer();
    assert.deepEqual(lua(boot, "return (GetExistingSocketInfo(2)), (GetExistingSocketInfo(3)), (GetNewSocketInfo(2))", 3),
      ["Рельефный багровый рубин", "Мягкий царский янтарь", undefined]);
    assert.equal(boot.bridge.getFrame("ItemSocketingSocketButton").enabled, false, "the staged gems were spent");
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    owner.dispose();
    boot.close();
  }
});

test("a staged gem comes back onto the cursor; the close button ends the session with SOCKET_INFO_CLOSE", withClient, async () => {
  const { boot, seam } = await load();
  const world = seam.socketWorld;
  const owner = createLazyFrameXmlSocketOwner(seam, boot, renderer(), { open() {} });
  try {
    lua(boot, "SocketInventoryItem(1)", 0);
    await owner.settled;
    await settle();
    const errors = boot.errorCount;
    world.cursor = 0x4000_0103n;
    lua(boot, "ItemSocketingSocket3:Click()", 0);
    assert.equal(seam.socket.staged(0x4000_0103n), true, "a blue gem may sit in a yellow socket, losing the bonus");
    assert.deepEqual(lua(boot, "return select(3, GetNewSocketInfo(3))"), [false]);
    lua(boot, "ItemSocketingSocket3:Click()", 0);
    assert.equal(world.cursor, 0x4000_0103n, "clicking it again with an empty cursor picks it back up");
    assert.equal(seam.socket.staged(0x4000_0103n), false);
    world.cursor = undefined;
    const frame = boot.bridge.getFrame("ItemSocketingFrame");
    lua(boot, "ItemSocketingCloseButton:Click()", 0);
    assert.equal(boot.bridge.isVisible(frame), false);
    assert.equal(seam.socket.active, false);
    assert.deepEqual(world.sent, []);
    lua(boot, "SocketInventoryItem(2)", 0);
    assert.equal(boot.bridge.isVisible(frame), false, "an empty slot opens nothing");
    assert.equal(seam.socket.active, false);
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    owner.dispose();
    boot.close();
  }
});

test("a failed gate hands the waiting item to the native picker and the legacy path answers later requests", withClient, async () => {
  const { boot, seam } = await load();
  const native = [];
  const failures = [];
  const broken = { ...renderer(), elementFor: () => undefined };
  const owner = createLazyFrameXmlSocketOwner(seam, boot, broken, { open: (target) => native.push(target) },
    (reason) => failures.push(reason));
  try {
    lua(boot, "SocketInventoryItem(1)", 0);
    await owner.settled;
    await settle();
    assert.equal(owner.failed, true);
    assert.equal(failures.length, 1);
    assert.deepEqual(native, [{ location: 0, bag: 0, slot: 1 }]);
    assert.equal(seam.socket.active, false);
    assert.equal(seam.socket.onOpenRequest, undefined, "the failed owner stops listening");
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("ItemSocketingFrame")), false);
    assert.equal(frameXmlSocketGate(boot, renderer()) !== undefined, true, "the same tree gates with a rendered DOM");
  } finally {
    owner.dispose();
    boot.close();
  }
});

test("gem-abilities adds its extraction button to the stock frame and still sends OP85 for the selected item", withClient, async () => {
  const { boot, seam, packets } = await load({ tsAddons: true });
  const owner = createLazyFrameXmlSocketOwner(seam, boot, renderer(), { open() {} });
  try {
    assert.equal(lua(boot, "return type(SlashCmdList.GEM_SOCKET)")[0], "function", "gem-abilities is loaded");
    const errors = boot.errorCount;
    // The other TSAddons announce themselves at load; only what the socketing flow sends counts here.
    const sentBefore = packets.sent.length;
    lua(boot, 'SlashCmdList.GEM_SOCKET("head")', 0);
    await owner.settled;
    await settle();
    const frame = boot.bridge.getFrame("ItemSocketingFrame");
    const button = boot.bridge.getFrame("GemAbilitiesExtractButton");
    assert.equal(boot.bridge.isVisible(frame), true);
    assert.ok(button && button.parent === frame, "the LoadUI hook put the button on the stock frame");
    assert.equal(button.enabled, true);
    const closes = [];
    boot.vm.registerGlobal("__socketTestClose", () => { closes.push(1); return []; });
    lua(boot, 'local f = CreateFrame("Frame") f:RegisterEvent("SOCKET_INFO_CLOSE") f:SetScript("OnEvent", function() __socketTestClose() end)', 0);
    lua(boot, "GemAbilitiesExtractButton:Click()", 0);
    assert.deepEqual(packets.sent.slice(sentBefore), [{ opcode: 85, body: doublePacket(0, 0, 1) }]);
    assert.equal(closes.length, 1, "one SOCKET_INFO_CLOSE, although the frame's OnHide calls CloseSocketInfo again");
    assert.equal(boot.bridge.isVisible(frame), false, "extraction closes the stock frame");
    assert.equal(seam.socket.active, false);

    // A staged replacement blocks extraction, as gem-abilities' GetNewSocketInfo check intends.
    lua(boot, "SocketInventoryItem(1)", 0);
    // The stock frame's own OnHide ran CloseSocketInfo after the session ended: the legacy close must
    // not have disabled the stock buttons (it greys every Button child of its own stand-in frame).
    for (const name of ["ItemSocketingCloseButton", "ItemSocketingSocket2", "GemAbilitiesExtractButton"]) {
      assert.equal(boot.bridge.getFrame(name).enabled, true, name);
    }
    seam.socketWorld.cursor = 0x4000_0101n;
    lua(boot, "ItemSocketingSocket2:Click() GemAbilitiesExtractButton:Click()", 0);
    assert.equal(packets.sent.length, sentBefore + 1, "no OP85 while a new gem is staged");
    assert.equal(boot.bridge.isVisible(frame), true);
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    owner.dispose();
    boot.close();
  }
});

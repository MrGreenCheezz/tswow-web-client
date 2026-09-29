import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the stock LootFrame/GroupLootFrame closure in the production vertical, driven over the
// canned loot world. Everything here runs the real 3.3.5 LootFrame.lua, UIParent.lua's loot branches
// and StaticPopup.lua against FrameXmlLoot.ts's C API.
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
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const {
  createFrameXmlLootOwner, frameXmlLootGate, installFrameXmlLootAdapters, publishFrameXmlLootMount,
} = await import("../dist/code/browser/framexml/FrameXmlLootOwner.js");
const { frameXmlLootPublished, closeFrameXmlLoot } = await import("../dist/code/browser/framexml/FrameXmlLootController.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const PARTY_MEMBER = 2n;

async function load(subset, seam = new CannedWorldSeam()) {
  const requests = new Set();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        requests.add(normalize(path));
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  const started = performance.now();
  const inventory = await boot.load();
  return { boot, seam, inventory, requests, loadMs: performance.now() - started };
}

/** Run a Lua function body and return its values; a Lua failure raises. */
function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "loot-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

/** A renderer stand-in: one element per frame carrying the renderer's identity attributes. */
function renderer() {
  const elements = new Map();
  return {
    elementFor(frame) {
      if (!elements.has(frame)) {
        const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
        elements.set(frame, { dataset: {}, parentElement: null, getAttribute: (name) => attributes.get(name) ?? null });
      }
      return elements.get(frame);
    },
  };
}

const SPIED = ["LOOT_OPENED", "LOOT_SLOT_CLEARED", "LOOT_SLOT_CHANGED", "LOOT_CLOSED", "LOOT_BIND_CONFIRM",
  "START_LOOT_ROLL", "CANCEL_LOOT_ROLL", "CONFIRM_LOOT_ROLL", "CONFIRM_DISENCHANT_ROLL",
  "OPEN_MASTER_LOOT_LIST", "UPDATE_MASTER_LOOT_LIST", "UI_ERROR_MESSAGE"];

/** Load, install the adapters, gate, publish like the world mount does, and spy the loot events. */
async function published() {
  const loaded = await load(FRAMEXML_VERTICAL_TOC);
  const { boot, seam } = loaded;
  installFrameXmlLootAdapters(boot);
  const gate = frameXmlLootGate(seam, boot, renderer());
  assert.ok(gate, "the stock loot tree passes its gate");
  const repaints = [];
  const cleanup = publishFrameXmlLootMount(createFrameXmlLootOwner(boot, seam.loot, gate.frame), seam.loot,
    (name) => boot.vm.globalString(name), () => repaints.push(frameXmlLootPublished()));
  lua(boot, `
    __lootEvents = {}
    local spy = CreateFrame("Frame")
    for _, event in ipairs({ ${SPIED.map((event) => `"${event}"`).join(", ")} }) do spy:RegisterEvent(event) end
    spy:SetScript("OnEvent", function(_, event, a, b)
      local line = event
      if a ~= nil then line = line .. ":" .. tostring(a) end
      if b ~= nil then line = line .. ":" .. tostring(b) end
      __lootEvents[#__lootEvents + 1] = line
    end)
  `, 0);
  const events = () => {
    const [joined] = lua(boot, "local r = table.concat(__lootEvents, ',') __lootEvents = {} return r");
    return joined === "" ? [] : joined.split(",");
  };
  // Only the loot model: the canned seam's own tick also scripts a target change, whose stock
  // TargetFrame_OnEvent closes every dropdown (CloseDropDownMenus), as a real target change does.
  return { ...loaded, gate, cleanup, repaints, events, tick: () => seam.loot.tick() };
}

/**
 * One published boot for the flow tests: a full vertical is ~16,700 widgets, and eleven of them in
 * one file exhausted the MPQ reader's heap (measured: «Array buffer allocation failed» on the tenth).
 */
let sharedFixture;
after(() => {
  sharedFixture?.cleanup();
  sharedFixture?.boot.close();
});

/** The shared boot with nothing open: no corpse, every roll over, no popup, dropdown or tooltip. */
async function shared() {
  sharedFixture ??= await published();
  const fixture = sharedFixture;
  const world = fixture.seam.lootWorld;
  world.loot = undefined;
  world.masterLootCandidates = [];
  for (const roll of world.lootRolls.values()) roll.passed = true;
  fixture.tick();
  lua(fixture.boot, `StaticPopup_Hide("LOOT_BIND") StaticPopup_Hide("CONFIRM_LOOT_ROLL")
    StaticPopup_Hide("CONFIRM_LOOT_DISTRIBUTION") CloseDropDownMenus() GameTooltip:Hide()
    SetCVar("lootUnderMouse", "0")`, 0);
  fixture.events();
  world.calls.length = 0;
  return fixture;
}

/** The roll ids a batch of START_LOOT_ROLL events announced, in order. */
function rollIds(started) {
  return started.map((event) => {
    const [name, id, time] = event.split(":");
    assert.equal(name, "START_LOOT_ROLL");
    assert.equal(time, "60000");
    return Number(id);
  });
}

function buttons(boot) {
  return lua(boot, `local r = {}
    for i = 1, LOOTFRAME_NUMBUTTONS do
      local b = _G["LootButton" .. i]
      if b:IsShown() then
        local count = _G["LootButton" .. i .. "Count"]
        r[#r + 1] = b.slot .. "=" .. (_G["LootButton" .. i .. "Text"]:GetText() or "")
          .. (count:IsShown() and ("x" .. count:GetText()) or "")
      end
    end
    return table.concat(r, "|")`)[0];
}

test("LootFrame.xml follows ContainerFrame.xml at its retail slot; the closure adds two files and no Lua error", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  assert.equal(toc[toc.indexOf("containerframe.xml") + 1], "lootframe.xml", "retail TOC line 97");
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  assert.equal(vertical[vertical.indexOf("containerframe.xml") + 1], "lootframe.xml", "the vertical keeps it after ContainerFrame");
  let baseline;
  let candidate;
  try {
    // This lane's own closure: the production TOC with and without LootFrame.xml, whatever else it holds.
    baseline = await load(FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) !== "lootframe.xml"));
    candidate = await load(FRAMEXML_VERTICAL_TOC);
    assert.equal(baseline.boot.bridge.getFrame("LootFrame")?.name, undefined);
    assert.ok(candidate.requests.has("interface/framexml/lootframe.lua"), "LootFrame.lua is reached through its XML");
    const metric = (inventory) => ({ files: inventory.files.total, bytes: inventory.files.bytes,
      widgets: inventory.widgets.total, errors: inventory.lua.errorsRaised, distinct: inventory.errors.length,
      luaFailed: inventory.lua.failed });
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, afterLoad[key] - before[key]]));
    assert.deepEqual(delta, { files: 2, bytes: 29279, widgets: 174, errors: 0, distinct: 0, luaFailed: 0 },
      `LootFrame closure delta ${JSON.stringify(delta)}`);
    assert.deepEqual(candidate.inventory.errors, []);
    assert.equal(candidate.boot.bridge.getFrame("LootFrame").visible, false);
    // The bridge does not carry GroupLootFrameTemplate's parent="UIParent" (LootFrame.xml:253) to the
    // four frames; the adapter puts them where the client has them.
    const { boot } = candidate;
    assert.deepEqual([1, 2, 3, 4].map((index) => boot.bridge.getFrame(`GroupLootFrame${index}`).parent?.name), [undefined, undefined, undefined, undefined]);
    // ITEM_QUALITY_COLORS[-1..6].hex (UIParent.lua:96-102) is GetItemQualityColor's 4th value, which
    // every reader prepends to a name as a colour code: the boot answers it with 3.3.5's "|c", so no
    // adapter touches the stock table any more.
    assert.deepEqual(lua(boot, "return ITEM_QUALITY_COLORS[-1].hex, ITEM_QUALITY_COLORS[0].hex, ITEM_QUALITY_COLORS[4].hex", 3),
      ["|cffffffff", "|cff9d9d9d", "|cffa335ee"], "straight from GetItemQualityColor, before any adapter");
    assert.deepEqual(installFrameXmlLootAdapters(boot), { reparented: 4 });
    assert.deepEqual([1, 2, 3, 4].map((index) => boot.bridge.getFrame(`GroupLootFrame${index}`).parent?.name), ["UIParent", "UIParent", "UIParent", "UIParent"]);
    assert.deepEqual(installFrameXmlLootAdapters(boot), { reparented: 0 }, "idempotent");
    console.log(`[loot] load ms baseline ${Math.round(baseline.loadMs)} candidate ${Math.round(candidate.loadMs)}`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
  }
});

test("the gate proves LootFrame and GroupLootFrame1 silently over a synthetic opening: no packet, no sound, ends hidden", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const sounds = [];
    const playSound = seam.playSound.bind(seam);
    seam.playSound = (name) => { sounds.push(name); playSound(name); };
    // Without the parent adapter the four roll frames are not under UIParent: the gate fails closed.
    assert.equal(frameXmlLootGate(seam, boot, renderer()), undefined);
    installFrameXmlLootAdapters(boot);
    const errors = boot.errorCount;
    const result = frameXmlLootGate(seam, boot, renderer());
    assert.ok(result, "the stock tree passes");
    assert.equal(result.frame.name, "LootFrame");
    assert.equal(result.buttons, 2, "the money and the item on LootButton1-2");
    assert.equal(result.coinText, "1 |4золотая:золотые:золотых;\n23 |4серебряная:серебряные:серебряных;\n45 |4медная монета:медные монеты:медных монет;",
      "GOLD/SILVER/COPPER_AMOUNT lines, as the client names a coin slot");
    assert.equal(result.rollName, "WebClient loot probe");
    assert.equal(result.frame.visible, false, "LootFrame ends hidden");
    assert.equal(boot.bridge.getFrame("GroupLootFrame1").visible, false, "GroupLootFrame1 ends hidden");
    assert.deepEqual(seam.lootWorld.calls, [], "LootFrame's OnHide CloseLoot is muted during the probe");
    assert.deepEqual(sounds, [], "the probe plays no sound");
    assert.equal(boot.errorCount, errors);
    // No model on the seam: nothing to own loot, the native window stays.
    assert.equal(frameXmlLootGate({}, boot, renderer()), undefined);

    // Fail closed on screen too: a fault anywhere in the probe leaves none of its frames up, whatever
    // it had shown by then (before, one raising label left LootFrame up with the probe's coins).
    const probeFrames = ["LootFrame", "GroupLootFrame1", "GroupLootFrame2", "GroupLootFrame3", "GroupLootFrame4"];
    const faults = [
      // Between LootFrame's Show and its HideUIPanel: an item label that cannot be read.
      ["LootButton2Text.GetText = function() error('loot probe fault') end", "LootButton2Text.GetText = nil"],
      // After GroupLootFrame1 showed the probe's roll: its name cannot be read.
      ["GroupLootFrame1Name.GetText = function() error('loot probe fault') end", "GroupLootFrame1Name.GetText = nil"],
      // A HideUIPanel that leaves the window up (no Lua error at all).
      ["__lootTestHide = HideUIPanel HideUIPanel = function() end", "HideUIPanel = __lootTestHide"],
      // …and a LootFrame:Hide that does nothing either: only the bridge can take it down.
      ["__lootTestHide = HideUIPanel HideUIPanel = function() end LootFrame.Hide = function() end",
        "HideUIPanel = __lootTestHide LootFrame.Hide = nil"],
    ];
    for (const [inject, undo] of faults) {
      lua(boot, inject, 0);
      try {
        assert.equal(frameXmlLootGate(seam, boot, renderer()), undefined, `fails closed: ${inject}`);
        assert.deepEqual(probeFrames.map((name) => boot.bridge.getFrame(name).visible), probeFrames.map(() => false),
          `nothing of the probe stays on screen: ${inject}`);
        assert.equal(lua(boot, "return GroupLootFrame1.rollID")[0], undefined, "the probe's roll id is cleared");
      } finally {
        lua(boot, undo, 0);
      }
    }
    assert.deepEqual(seam.lootWorld.calls, [], "no failed probe released anything");
    assert.deepEqual(sounds, [], "nor played a sound");
    assert.equal(seam.loot.owned, false, "nor handed loot to stock");
    assert.ok(frameXmlLootGate(seam, boot, renderer()), "with the faults undone the same frames pass again");
  } finally {
    boot.close();
  }
});

test("a corpse opens stock LootFrame: money, stack, pages, a click stores, bind-on-pickup asks, the roll slot is red", withClient, async () => {
  const { boot, seam, events, tick } = await shared();
  const world = seam.lootWorld;
  {
    const errors = boot.errorCount;
    world.openCorpse();
    tick();
    assert.deepEqual(events(), ["LOOT_OPENED:0"]);
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("LootFrame")), true);
    assert.deepEqual(lua(boot, "return LootFrame.numLootItems, LootFrame.page, GetLootSlotInfo(1)", 7).slice(0, 5),
      [7, 1, "Interface\\Icons\\INV_Misc_Coin_01", "1 |4золотая:золотые:золотых;\n23 |4серебряная:серебряные:серебряных;\n45 |4медная монета:медные монеты:медных монет;", 0]);
    // Seven slots: three to a page (LootFrame.lua:89-91), the down arrow shown.
    assert.equal(buttons(boot), "1=1 |4золотая:золотые:золотых;\n23 |4серебряная:серебряные:серебряных;\n45 |4медная монета:медные монеты:медных монет;|2=Руническая тканьx2|3=Демоническая руна");
    assert.deepEqual(lua(boot, "return LootFrameDownButton:IsShown() and 1 or 0, LootFrameUpButton:IsShown() and 1 or 0", 2), [1, 0]);
    // Names in their quality colour (ITEM_QUALITY_COLORS: common white, uncommon green), painted as
    // the text colour the renderer draws, not only the vertex colour stock sets.
    assert.deepEqual(lua(boot, `local r = {}
      for i = 2, 3 do local t = _G["LootButton" .. i .. "Text"] local a, b, c = t:GetTextColor() r[#r + 1] = format("%.2f,%.2f,%.2f", a, b, c) end
      return table.concat(r, " ")`)[0], "1.00,1.00,1.00 0.12,1.00,0.00");
    // The item link, as HandleModifiedItemClick and SetLootItem read it.
    assert.deepEqual(lua(boot, "return GetLootSlotLink(3), GetLootSlotLink(1)", 2),
      ["|cff1eff00|Hitem:12662:0:0:0:0:0:0:0:60|h[Демоническая руна]|h|r", undefined]);

    // A click stores the stack: CMSG_AUTOSTORE_LOOT_ITEM with the wire slot, then LOOT_SLOT_CLEARED.
    lua(boot, "LootButton2:Click()", 0);
    assert.deepEqual(world.calls, [{ kind: "take", slot: 0 }]);
    tick();
    assert.deepEqual(events(), ["LOOT_SLOT_CLEARED:2"]);
    assert.equal(buttons(boot), "1=1 |4золотая:золотые:золотых;\n23 |4серебряная:серебряные:серебряных;\n45 |4медная монета:медные монеты:медных монет;|3=Демоническая руна");

    // Page 2: the potion stack, the shard, the bind-on-pickup helm. The helm asks (LOOT_BIND).
    lua(boot, "LootFrameDownButton:Click()", 0);
    assert.equal(buttons(boot), "4=Огромный флакон с лечебным зельемx3|5=Большой сверкающий осколок|6=Ореол превосходства");
    lua(boot, "LootButton3:Click()", 0);
    assert.equal(world.calls.length, 1, "a bind-on-pickup item on an ALLOW_LOOT slot is not stored yet");
    tick();
    assert.deepEqual(events(), ["LOOT_BIND_CONFIRM:6"]);
    const [which, data, text] = lua(boot, "return StaticPopup1:IsShown() and StaticPopup1.which, StaticPopup1.data, StaticPopup1Text:GetText()", 3);
    assert.deepEqual([which, data], ["LOOT_BIND", 6]);
    // LOOT_NO_DROP with ITEM_QUALITY_COLORS[4].hex..name.."|r" (UIParent.lua:583): the name in its
    // quality colour code, never the bare hex (the adapter gives the hex its 3.3.5 "|c").
    assert.equal(text, "Предмет \"|cffa335eeОреол превосходства|r\" станет персональным, если вы его поднимете.");
    lua(boot, "StaticPopup1Button1:Click()", 0);
    assert.deepEqual(world.calls.at(-1), { kind: "take", slot: 4 }, "ConfirmLootSlot stores it");
    tick();
    assert.deepEqual(events(), ["LOOT_SLOT_CLEARED:6"]);

    // Page 3: the ring a group roll is holding is red and cannot be taken.
    lua(boot, "LootFrameDownButton:Click()", 0);
    assert.equal(buttons(boot), "7=Кольцо Аккурии");
    assert.deepEqual(lua(boot, "local _, _, _, _, locked = GetLootSlotInfo(7) return locked and 1 or 0, LootButton1IconTexture:GetVertexColor()", 3).slice(0, 2), [1, 0.9]);
    lua(boot, "LootButton1:Click()", 0);
    tick();
    assert.deepEqual(events(), ["UI_ERROR_MESSAGE:Этот предмет пока не разыграли."]);
    assert.equal(world.calls.length, 2, "nothing is sent for a slot a roll holds");

    // The money: CMSG_LOOT_MONEY, then its slot clears with the coin sound.
    const sounds = [];
    const playSound = seam.playSound.bind(seam);
    seam.playSound = (name) => { sounds.push(name); playSound(name); };
    lua(boot, "LootSlot(1)", 0);
    tick();
    assert.deepEqual(world.calls.at(-1), { kind: "money" });
    assert.deepEqual(events(), ["LOOT_SLOT_CLEARED:1"]);
    assert.deepEqual(sounds, ["LOOTWINDOWCOINSOUND"]);

    // With the roll's ring still on the corpse the window stays; Escape (the owner's hide) releases it.
    lua(boot, "LootSlot(3) LootSlot(4) LootSlot(5)", 0);
    tick();
    assert.deepEqual(events(), ["LOOT_SLOT_CLEARED:3", "LOOT_SLOT_CLEARED:4", "LOOT_SLOT_CLEARED:5"]);
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("LootFrame")), true, "a slot a roll holds keeps the window");
    assert.equal(closeFrameXmlLoot(), true);
    assert.deepEqual(world.calls.at(-1), { kind: "release" }, "HideUIPanel → OnHide → CloseLoot → CMSG_LOOT_RELEASE");
    tick();
    assert.deepEqual(events(), ["LOOT_CLOSED"]);
    assert.equal(world.calls.filter((call) => call.kind === "release").length, 1, "released once");
    assert.equal(boot.errorCount, errors, "no Lua error on the whole corpse");
  }
});

test("the last slot taken releases the corpse, a server release closes the window, a refused loot is a red error", withClient, async () => {
  const { boot, seam, events, tick } = await shared();
  const world = seam.lootWorld;
  {
    const errors = boot.errorCount;
    world.openCorpse();
    world.loot.slots.splice(1);
    tick();
    assert.deepEqual(events(), ["LOOT_OPENED:0"]);
    lua(boot, "LootSlot(1) LootSlot(2)", 0);
    tick();
    assert.deepEqual(world.calls, [{ kind: "money" }, { kind: "take", slot: 0 }, { kind: "release" }],
      "everything taken: the client lets the corpse go");
    assert.deepEqual(events(), ["LOOT_SLOT_CLEARED:1", "LOOT_SLOT_CLEARED:2"]);
    tick();
    assert.deepEqual(events(), ["LOOT_CLOSED"]);
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("LootFrame")), false);

    // SMSG_LOOT_RELEASE_RESPONSE: the server let go (logout, a disallowed item): stock hides.
    world.openCorpse();
    tick();
    world.releaseCorpse();
    tick();
    assert.deepEqual(events(), ["LOOT_OPENED:0", "LOOT_CLOSED"]);
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("LootFrame")), false);
    assert.equal(world.calls.filter((call) => call.kind === "release").length, 1, "the OnHide after a server release sends nothing");

    // SMSG_LOOT_RESPONSE with LOOT_NONE: the client's own ERR_LOOT_TOO_FAR in UIErrorsFrame, no window.
    world.loot = { guid: 1n, lootType: 0, gold: 0, slots: [], error: 4 };
    tick();
    tick();
    assert.deepEqual(events(), ["UI_ERROR_MESSAGE:Вы слишком далеко и не можете обыскать этот труп."]);
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("LootFrame")), false);
    assert.equal(boot.errorCount, errors);
  }
});

test("GroupLootFrame1-2 show the boss's rolls; bind-on-pickup need asks, greed goes straight, answered frames come down", withClient, async () => {
  const { boot, seam, events, tick } = await shared();
  const world = seam.lootWorld;
  {
    const errors = boot.errorCount;
    const [ring, crystal] = world.startRolls();
    tick();
    const [ringId, crystalId] = rollIds(events());
    assert.equal(crystalId, ringId + 1, "client roll ids count up");
    const frame = (index) => lua(boot, `local f = GroupLootFrame${index}
      return f:IsShown() and 1 or 0, f.rollID, GroupLootFrame${index}Name:GetText(),
        f.needButton:IsEnabled() == 1 and 1 or 0, f.greedButton:IsEnabled() == 1 and 1 or 0,
        f.disenchantButton:IsEnabled() == 1 and 1 or 0, f.disenchantButton.reason,
        select(2, GroupLootFrame${index}Timer:GetMinMaxValues())`, 8);
    assert.deepEqual(frame(1), [1, ringId, "Кольцо Аккурии", 1, 1, 0, "В вашей группе нет зачаровывателя с навыком 300.", 60000]);
    assert.deepEqual(frame(2), [1, crystalId, "Кристалл-источник", 1, 1, 0, "Этот предмет нельзя распылить.", 60000]);
    assert.deepEqual(lua(boot, "return GroupLootFrame1Decoration:IsShown() and 1 or 0, GroupLootFrame2Decoration:IsShown() and 1 or 0", 2),
      [1, 0], "the gold dragon marks the bind-on-pickup roll");
    assert.equal(lua(boot, `local a, b, c = GroupLootFrame2Name:GetTextColor() return format("%.2f,%.2f,%.2f", a, b, c)`)[0],
      "0.64,0.21,0.93", "the epic crystal's name is purple");
    assert.ok(lua(boot, `return GetLootRollTimeLeft(${ringId})`)[0] > 59000);

    // Need on the bind-on-pickup ring: CONFIRM_LOOT_ROLL first (UIParent.lua:842), then the vote.
    lua(boot, "GroupLootFrame1RollButton:Click()", 0);
    assert.deepEqual(world.calls, []);
    tick();
    assert.deepEqual(events(), [`CONFIRM_LOOT_ROLL:${ringId}:1`]);
    assert.deepEqual(lua(boot, "return StaticPopup1.which, StaticPopup1.data, StaticPopup1.data2", 3), ["CONFIRM_LOOT_ROLL", ringId, 1]);
    // LOOT_NO_DROP over the ring's name in its colour code (UIParent.lua:846).
    assert.equal(lua(boot, "return StaticPopup1Text:GetText()")[0],
      "Предмет \"|cffa335eeКольцо Аккурии|r\" станет персональным, если вы его поднимете.");
    lua(boot, "StaticPopup1Button1:Click()", 0);
    assert.deepEqual(world.calls, [{ kind: "roll", itemGuid: ring, rollType: 1 }]);
    // Greed on the crystal (not bind-on-pickup) goes straight to the server.
    lua(boot, "GroupLootFrame2GreedButton:Click()", 0);
    assert.deepEqual(world.calls.at(-1), { kind: "roll", itemGuid: crystal, rollType: 2 });
    tick();
    assert.deepEqual(events(), [`CANCEL_LOOT_ROLL:${ringId}`, `CANCEL_LOOT_ROLL:${crystalId}`]);
    assert.deepEqual(lua(boot, "return GroupLootFrame1:IsShown() and 1 or 0, GroupLootFrame2:IsShown() and 1 or 0", 2), [0, 0]);
    // A second answer is not sent.
    lua(boot, `RollOnLoot(${ringId}, 2) ConfirmLootRoll(${crystalId}, 1)`, 0);
    assert.equal(world.calls.length, 2);
    assert.equal(boot.errorCount, errors);
  }
});

test("a roll won by someone else, or run out, takes its frame down; pass never asks", withClient, async () => {
  const { boot, seam, events, tick } = await shared();
  const world = seam.lootWorld;
  {
    const errors = boot.errorCount;
    const [ring, crystal] = world.startRolls(Date.now() - 59990);
    tick();
    const [ringId, crystalId] = rollIds(events());
    world.winRoll(ring);
    lua(boot, "GroupLootFrame2PassButton:Click()", 0);
    assert.deepEqual(world.calls, [{ kind: "roll", itemGuid: crystal, rollType: 0 }], "pass is sent without a popup");
    tick();
    assert.deepEqual(events(), [`CANCEL_LOOT_ROLL:${ringId}`, `CANCEL_LOOT_ROLL:${crystalId}`]);
    // A fresh roll whose countdown is already over when the client sees it is never announced.
    world.lootRolls.set(0x4000000000000999n, { start: { ...world.lootRolls.get(ring).start, itemGuid: 0x4000000000000999n },
      startedAt: Date.now() - 61000, votes: [] });
    tick();
    assert.deepEqual(events(), []);
    // The same roll's frame times out: the server says nothing, the client takes it down.
    world.lootRolls.set(0x4000000000000998n, { start: { ...world.lootRolls.get(ring).start, itemGuid: 0x4000000000000998n },
      startedAt: Date.now() - 59990, votes: [] });
    tick();
    const [lateId] = rollIds(events());
    assert.equal(lateId, crystalId + 1, "the expired-before-seen roll took no id");
    await new Promise((resolve) => setTimeout(resolve, 30));
    tick();
    assert.deepEqual(events(), [`CANCEL_LOOT_ROLL:${lateId}`]);
    assert.equal(lua(boot, "return GroupLootFrame1:IsShown() and 1 or 0")[0], 0);
    assert.equal(boot.errorCount, errors);
  }
});

test("hovering a loot button or a roll icon shows the item's own tooltip through the link setters", withClient, async () => {
  const { boot, seam, tick } = await shared();
  const world = seam.lootWorld;
  {
    const errors = boot.errorCount;
    world.openCorpse();
    world.startRolls();
    tick();
    const hover = (button) => lua(boot, `local b = ${button}
      b:GetScript("OnEnter")(b)
      local name, link = GameTooltip:GetItem()
      local shown, owned = GameTooltip:IsShown() and 1 or 0, GameTooltip:IsOwned(b) and 1 or 0
      local title, r, g, bl = GameTooltipTextLeft1:GetText(), GameTooltipTextLeft1:GetTextColor()
      b:GetScript("OnLeave")(b)
      return shown, owned, link, GameTooltip:IsShown() and 1 or 0, name, title, format("%.2f,%.2f,%.2f", r, g, bl)`, 7);
    // What the item tooltip says comes from the world's item templates (FrameXmlCharacterTooltip's
    // item(entry) → itemTooltipFor over game.world), as in the live client; the canned seam has no
    // world of its own, so the loot world stands in for it here.
    const previous = game.world;
    game.world = world;
    try {
      assert.deepEqual(hover("LootButton3"), [1, 1, "|cff1eff00|Hitem:12662:0:0:0:0:0:0:0:60|h[Демоническая руна]|h|r", 0,
        "Демоническая руна", "Демоническая руна", "0.12,1.00,0.00"]);
      assert.deepEqual(hover("GroupLootFrame1IconFrame"), [1, 1, "|cffa335ee|Hitem:17063:0:0:0:0:0:0:0:60|h[Кольцо Аккурии]|h|r", 0,
        "Кольцо Аккурии", "Кольцо Аккурии", "0.64,0.21,0.93"]);
    } finally {
      game.world = previous;
    }
    assert.equal(boot.errorCount, errors);
  }
});

test("a master looter's slot opens GroupLootDropDown; a candidate gets the rare, an epic asks first", withClient, async () => {
  const { boot, seam, events, tick } = await shared();
  const world = seam.lootWorld;
  {
    const errors = boot.errorCount;
    world.openCorpse({ master: true });
    tick();
    events();
    lua(boot, "LootFrame_PageDown()", 0);
    lua(boot, "LootButton2:Click()", 0);
    tick();
    assert.deepEqual(events(), ["OPEN_MASTER_LOOT_LIST"]);
    const list = lua(boot, `local r = {}
      for i = 1, DropDownList1.numButtons do r[#r + 1] = _G["DropDownList1Button" .. i]:GetText() end
      return DropDownList1:IsShown() and 1 or 0, table.concat(r, "|")`, 2);
    assert.deepEqual(list, [1, "Тестовый|Бета"]);
    lua(boot, "DropDownList1Button2:Click()", 0);
    assert.deepEqual(world.calls, [{ kind: "give", slot: 3, target: PARTY_MEMBER }], "the shard to the second candidate");
    tick();
    assert.deepEqual(events(), ["LOOT_SLOT_CLEARED:5"]);
    // The epic helm (quality 4 >= MASTER_LOOT_THREHOLD) asks CONFIRM_LOOT_DISTRIBUTION first.
    lua(boot, "LootButton3:Click()", 0);
    tick();
    events();
    lua(boot, "DropDownList1Button2:Click()", 0);
    assert.equal(world.calls.length, 1);
    assert.deepEqual(lua(boot, "return StaticPopup1.which, StaticPopup1.data", 2), ["CONFIRM_LOOT_DISTRIBUTION", 2]);
    // The helm in its colour code (LootFrame.lua:303), never the bare hex.
    assert.ok(lua(boot, "return StaticPopup1Text:GetText()")[0].includes("|cffa335eeОреол превосходства|r"),
      lua(boot, "return StaticPopup1Text:GetText()")[0]);
    lua(boot, "StaticPopup1Button1:Click()", 0);
    assert.deepEqual(world.calls.at(-1), { kind: "give", slot: 4, target: PARTY_MEMBER });
    assert.equal(boot.errorCount, errors);
  }
});

test("lootUnderMouse places LootFrame at the cursor, as LootFrame_Show computes it", withClient, async () => {
  const { boot, seam, tick } = await shared();
  {
    lua(boot, `SetCVar("lootUnderMouse", "1")`, 0);
    boot.bridge.setMousePosition(700, 500);
    seam.lootWorld.openCorpse();
    tick();
    // Items on the corpse: x - 40, y + 55 + 40 (LootFrame.lua:174-181), at effective scale 1. The
    // bridge resolves SetPoint's nil relativeTo to the parent, UIParent, which spans the screen.
    assert.deepEqual(lua(boot, `local point, relative, relativePoint, x, y = LootFrame:GetPoint(1)
      return LootFrame:GetEffectiveScale(), point, relative and relative:GetName(), relativePoint, x, y,
        LootFrame:GetLeft(), LootFrame:GetTop()`, 8), [1, "TOPLEFT", "UIParent", "BOTTOMLEFT", 660, 595, 660, 595]);
    // Off by default, as the client's CVar is: the stock UIPanel place (left area).
    lua(boot, `SetCVar("lootUnderMouse", "0") HideUIPanel(LootFrame)`, 0);
    tick();
    seam.lootWorld.openCorpse();
    tick();
    assert.deepEqual(lua(boot, "local point, relative = LootFrame:GetPoint(1) return point, relative and relative:GetName(), LootFrame:GetTop()", 3)[0], "TOPLEFT");
    assert.notEqual(lua(boot, "return LootFrame:GetTop()")[0], 595);
  }
});

test("publication takes over an open corpse and a running roll; teardown gives both back without a release", withClient, async () => {
  const loaded = await load(FRAMEXML_VERTICAL_TOC);
  const { boot, seam } = loaded;
  const world = seam.lootWorld;
  try {
    world.openCorpse();
    world.startRolls();
    boot.tickSeam();
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("LootFrame")), false, "not owned: stock stays silent");
    installFrameXmlLootAdapters(boot);
    const gate = frameXmlLootGate(seam, boot, renderer());
    const repaints = [];
    const cleanup = publishFrameXmlLootMount(createFrameXmlLootOwner(boot, seam.loot, gate.frame), seam.loot,
      (name) => boot.vm.globalString(name), () => repaints.push(frameXmlLootPublished()));
    assert.deepEqual(repaints, [true], "the native window repaints once published (and steps aside)");
    boot.tickSeam();
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("LootFrame")), true);
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("GroupLootFrame1")), true);
    cleanup();
    assert.deepEqual(repaints, [true, false], "the native window takes the corpse back after the owner is gone");
    assert.equal(frameXmlLootPublished(), false);
    assert.equal(seam.loot.owned, false);
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("LootFrame")), false);
    assert.equal(boot.bridge.isVisible(boot.bridge.getFrame("GroupLootFrame1")), false);
    assert.deepEqual(world.calls, [], "LootFrame's OnHide during teardown releases nothing");
    assert.notEqual(world.loot, undefined, "the corpse stays open for the native window");
  } finally {
    boot.close();
  }
});

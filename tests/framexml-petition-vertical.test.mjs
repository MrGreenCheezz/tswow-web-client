import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the charter windows' stock XML (TabardFrame, GuildRegistrarFrame, PetitionFrame,
// ArenaRegistrarFrame with PVPBannerFrame) in the production vertical, driven over the canned guild
// master, arena organizer and charter — the real 3.3.5 Lua against FrameXmlTabard.ts,
// FrameXmlRegistrar.ts and FrameXmlPetition.ts.
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
const { createFrameXmlNpcWindows } = await import("../dist/code/browser/framexml/FrameXmlGossipNpcWindows.js");
const controller = await import("../dist/code/browser/framexml/FrameXmlPetitionController.js");
const canned = await import("../dist/code/browser/framexml/FrameXmlPetitionCanned.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const CHARTER_FILES = ["tabardframe.xml", "guildregistrarframe.xml", "petitionframe.xml", "arenaregistrarframe.xml"];

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
  const inventory = await boot.load();
  return { boot, seam, inventory, requests };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "petition-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

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

const newErrors = (boot, from) => JSON.stringify(boot.errors.slice(from).map((e) => `${e.file}:${e.line} ${e.message}`));
const shown = (boot, name) => lua(boot, `return ${name}:IsShown() and 1 or 0`)[0];

/** UIErrorsFrame's two events, as a Lua listener hears them. */
function listenMessages(boot) {
  lua(boot, `
    WebClientTestMessages = {}
    local listener = CreateFrame("Frame")
    listener:RegisterEvent("UI_INFO_MESSAGE")
    listener:RegisterEvent("UI_ERROR_MESSAGE")
    listener:SetScript("OnEvent", function(_, event, text)
      WebClientTestMessages[#WebClientTestMessages + 1] = event .. ":" .. tostring(text)
    end)`, 0);
  return () => lua(boot, "return table.concat(WebClientTestMessages, '\\n')")[0].split("\n").filter(Boolean);
}

async function published() {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  const escapes = [];
  const windows = createFrameXmlNpcWindows(seam, boot, renderer(), {
    registerEscapable(entry) { escapes.push(entry); return () => escapes.splice(escapes.indexOf(entry), 1); },
  });
  const release = windows.publish();
  return { boot, seam, windows, release, escapes, world: seam.npc.charters.world };
}

test("the charter frames sit at their retail TOC slots; the closure adds eight files and no Lua error", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  const combo = toc.indexOf("comboframe.xml");
  assert.deepEqual(toc.slice(combo + 1, combo + 4), CHARTER_FILES.slice(0, 3), "retail 112-114, after ComboFrame");
  assert.equal(toc[toc.indexOf("arenaframe.xml") + 1], "arenaregistrarframe.xml", "retail 129, after ArenaFrame");
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  const at = vertical.indexOf("comboframe.xml");
  assert.deepEqual(vertical.slice(at + 1, at + 5), [...CHARTER_FILES.slice(0, 3), "colorpickerframe.xml"]);
  assert.equal(vertical[vertical.indexOf("arenaframe.xml") + 1], "arenaregistrarframe.xml");
  let baseline;
  let candidate;
  try {
    baseline = await load(FRAMEXML_VERTICAL_TOC.filter((entry) => !CHARTER_FILES.includes(normalize(entry))));
    candidate = await load(FRAMEXML_VERTICAL_TOC);
    for (const file of ["tabardframe.lua", "guildregistrarframe.lua", "petitionframe.lua", "arenaregistrarframe.lua"]) {
      assert.ok(candidate.requests.has(`interface/framexml/${file}`), `${file} is reached through its XML`);
      assert.ok(!baseline.requests.has(`interface/framexml/${file}`));
    }
    const metric = (inventory) => ({ files: inventory.files.total, bytes: inventory.files.bytes,
      widgets: inventory.widgets.total, errors: inventory.lua.errorsRaised, distinct: inventory.errors.length,
      luaFailed: inventory.lua.failed });
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, afterLoad[key] - before[key]]));
    assert.deepEqual(delta, { files: 8, bytes: 89548, widgets: 450, errors: 0, distinct: 0, luaFailed: 0 },
      `charter closure delta ${JSON.stringify(delta)}`);
    for (const name of ["TabardFrame", "GuildRegistrarFrame", "PetitionFrame", "ArenaRegistrarFrame", "PVPBannerFrame"]) {
      const frame = candidate.boot.bridge.getFrame(name);
      assert.equal(frame?.parent?.name, "UIParent");
      assert.equal(frame.visible, false, `${name} is a hidden root`);
    }
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
  }
});

test("the tabard designer: the guild's emblem, the arrows, a save and its answer, the close", withClient, async () => {
  const { boot, release, world, escapes } = await published();
  try {
    const messages = listenMessages(boot);
    const errors = boot.errorCount;
    assert.equal(controller.frameXmlCharterPublished("tabard"), true);
    world.openTabard();
    assert.deepEqual(lua(boot, `return TabardFrame:IsShown() and 1 or 0, TabardFrameNameText:GetText(),
      TabardFrameEmblemTopLeft:GetTexture(), TabardFrameEmblemBottomLeft:GetTexture()`, 4),
    [1, "Распорядитель гильдий", "Textures\\GuildEmblems\\Emblem_12_03_TU_U", "Textures\\GuildEmblems\\Emblem_12_03_TL_U"],
    "OPEN_TABARD_FRAME: InitializeTabardColors starts from the guild query's emblem");
    // The same design cannot be saved (ERR_GUILDEMBLEM_SAME, said by the client itself).
    lua(boot, "TabardModel:Save()", 0);
    assert.deepEqual(world.calls, []);
    assert.equal(messages().at(-1), `UI_ERROR_MESSAGE:${lua(boot, "return ERR_GUILDEMBLEM_SAME")[0]}`);

    boot.bridge.Click(boot.bridge.getFrame("TabardFrameCustomization1RightButton"));
    boot.bridge.Click(boot.bridge.getFrame("TabardFrameCustomization5LeftButton"));
    assert.equal(lua(boot, "return TabardFrameEmblemTopRight:GetTexture()")[0], "Textures\\GuildEmblems\\Emblem_13_03_TU_U");
    assert.equal(lua(boot, "return TabardModel:CanSaveTabardNow() and 1 or 0")[0], 1);
    lua(boot, "TabardModel:Save()", 0);
    assert.deepEqual(world.calls, [{ kind: "saveEmblem", emblem: [13, 3, 1, 5, 19] }],
      "MSG_SAVE_GUILD_EMBLEM: style, colour, border style, border colour, background");
    assert.equal(lua(boot, "return TabardModel:CanSaveTabardNow() and 1 or 0")[0], 0, "TABARD_SAVE_PENDING");
    world.answerEmblem(3);
    assert.equal(messages().at(-1), `UI_ERROR_MESSAGE:${lua(boot, "return ERR_GUILDEMBLEM_NOTGUILDMASTER")[0]}`);
    assert.equal(lua(boot, "return TabardModel:CanSaveTabardNow() and 1 or 0")[0], 1, "the answer re-enables saving");
    lua(boot, "TabardModel:Save()", 0);
    world.answerEmblem(0, { emblemStyle: 13, emblemColor: 3, borderStyle: 1, borderColor: 5, backgroundColor: 19 });
    assert.equal(messages().at(-1), `UI_INFO_MESSAGE:${lua(boot, "return ERR_GUILDEMBLEM_SUCCESS")[0]}`);

    // Escape and the close button end the designer (CloseTabardCreation forgets it locally).
    assert.equal(escapes.some((entry) => entry.isOpen()), true);
    boot.bridge.Click(boot.bridge.getFrame("TabardFrameCloseButton"));
    assert.equal(shown(boot, "TabardFrame"), 0);
    assert.equal(world.tabardVendorGuid, 0n);
    // Another NPC clicked: the world forgets the designer without an event (closeNpcServices).
    world.openTabard();
    assert.equal(shown(boot, "TabardFrame"), 1);
    world.tabardVendorGuid = 0n;
    controller.notifyFrameXmlCharters();
    assert.equal(shown(boot, "TabardFrame"), 0);
    assert.equal(world.calls.length, 2);
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    release();
    boot.close();
  }
});

test("the guild registrar: buy a named charter, register a carried one", withClient, async () => {
  const { boot, release, world } = await published();
  try {
    const errors = boot.errorCount;
    world.openList(canned.FRAMEXML_CANNED_GUILD_LIST);
    assert.deepEqual(lua(boot, `return GuildRegistrarFrame:IsShown() and 1 or 0, GuildRegistrarFrameNpcNameText:GetText(),
      GuildRegistrarGreetingFrame:IsShown() and 1 or 0, ArenaRegistrarFrame:IsShown() and 1 or 0`, 4),
    [1, "Распорядитель гильдий", 1, 0], "a lone guild row is GUILD_REGISTRAR_SHOW");
    boot.bridge.Click(boot.bridge.getFrame("GuildRegistrarButton1"));
    assert.deepEqual(lua(boot, `return GuildRegistrarPurchaseFrame:IsShown() and 1 or 0, GetGuildCharterCost(),
      GuildRegistrarMoneyFrameSilverButton:GetText()`, 3), [1, 1000, "10"], "the row's price in the stock money frame");
    lua(boot, `GuildRegistrarFrameEditBox:SetText("Стражи Элвинна")`, 0);
    boot.bridge.Click(boot.bridge.getFrame("GuildRegistrarFramePurchaseButton"));
    assert.deepEqual(world.calls, [{ kind: "buy", vendorGuid: canned.FRAMEXML_CANNED_GUILD_MASTER_GUID, name: "Стражи Элвинна", index: 1 }]);
    assert.equal(shown(boot, "GuildRegistrarFrame"), 0);
    assert.equal(world.petitionVendor, undefined, "CloseGuildRegistrar forgets the list");

    world.carried = [{ guid: canned.FRAMEXML_CANNED_CHARTER_GUID, entry: 5863 }];
    world.openList(canned.FRAMEXML_CANNED_GUILD_LIST);
    boot.bridge.Click(boot.bridge.getFrame("GuildRegistrarButton2"));
    assert.deepEqual(world.calls.at(-1), { kind: "turnIn", petitionGuid: canned.FRAMEXML_CANNED_CHARTER_GUID, emblem: undefined },
      "TurnInGuildCharter names the carried charter, no emblem");
    boot.bridge.Click(boot.bridge.getFrame("GuildRegistrarFrameGoodbyeButton"));
    assert.equal(shown(boot, "GuildRegistrarFrame"), 0);
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    release();
    boot.close();
  }
});

test("the arena registrar: a price that waits for its item, a purchase, the banner and the turn-in", withClient, async () => {
  const { boot, release, world } = await published();
  try {
    const errors = boot.errorCount;
    world.uncached.add(23561);
    world.openList(canned.FRAMEXML_CANNED_ARENA_LIST);
    assert.deepEqual(lua(boot, `return ArenaRegistrarFrame:IsShown() and 1 or 0, ArenaRegistrarFrameNpcNameText:GetText(),
      ArenaRegistrarButton4:IsShown() and 1 or 0, RegistrationText:IsShown() and 1 or 0`, 4),
    [1, "Распорядитель арены", 0, 0], "no charter carried: PETITION_VENDOR_UPDATE hides the turn-in rows");
    boot.bridge.Click(boot.bridge.getFrame("ArenaRegistrarButton2"));
    assert.equal(shown(boot, "ArenaRegistrarPurchaseFrame"), 0, "GetPetitionItemInfo is nil until the item is cached");
    world.cacheItem(23561);
    assert.deepEqual(lua(boot, `return ArenaRegistrarPurchaseFrame:IsShown() and 1 or 0, ArenaRegistrarMoneyFrameGoldButton:GetText(),
      select(3, GetPetitionItemInfo(2))`, 3), [1, "120", 1200000], "PETITION_VENDOR_UPDATE shows the waiting price");
    lua(boot, `ArenaRegistrarFrameEditBox:SetText("Клинки")`, 0);
    boot.bridge.Click(boot.bridge.getFrame("ArenaRegistrarFramePurchaseButton"));
    assert.deepEqual(world.calls, [{ kind: "buy", vendorGuid: canned.FRAMEXML_CANNED_ARENA_ORGANIZER_GUID, name: "Клинки", index: 2 }]);
    assert.equal(world.petitionVendor, undefined);

    world.carried = [{ guid: 0x4000000000000777n, entry: 23560 }];
    world.openList(canned.FRAMEXML_CANNED_ARENA_LIST);
    assert.deepEqual(lua(boot, "return ArenaRegistrarButton4:IsShown() and 1 or 0, HasFilledPetition() and 1 or 0", 2), [1, 1]);
    boot.bridge.Click(boot.bridge.getFrame("ArenaRegistrarButton4"));
    assert.deepEqual(lua(boot, "return PVPBannerFrame:IsShown() and 1 or 0, ArenaRegistrarFrame:IsShown() and 1 or 0", 2), [1, 0],
      "the banner designer takes the registrar's place, the list stays open (dontClose)");
    assert.notEqual(world.petitionVendor, undefined);
    lua(boot, `
      PVPBannerFrameStandardBanner:SetVertexColor(1, 0, 0)
      PVPBannerFrameStandardEmblem:SetVertexColor(0, 1, 0)
      PVPBannerFrameStandardBorder:SetVertexColor(0, 0, 1)
      PVPBannerFrameStandardEmblem.id = 7
      PVPBannerFrameStandardBorder.id = 3`, 0);
    boot.bridge.Click(boot.bridge.getFrame("PVPBannerFrameAcceptButton"));
    assert.deepEqual(world.calls.at(-1), { kind: "turnIn", petitionGuid: 0x4000000000000777n, emblem: {
      background: 0xffff0000, icon: 7, iconColor: 0xff00ff00, border: 3, borderColor: 0xff0000ff,
    } }, "CMSG_TURN_IN_PETITION with the 2v2 charter and the banner");
    assert.deepEqual(lua(boot, "return PVPBannerFrame:IsShown() and 1 or 0, ArenaRegistrarFrame:IsShown() and 1 or 0", 2), [0, 0]);
    assert.equal(world.petitionVendor, undefined);
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    release();
    boot.close();
  }
});

test("a charter: it waits for its query, signs and closes on the answer; the owner offers and renames", withClient, async () => {
  const { boot, release, world, seam } = await published();
  try {
    const errors = boot.errorCount;
    world.showCharter(canned.FRAMEXML_CANNED_CHARTER_SIGNATURES, true);
    assert.equal(shown(boot, "PetitionFrame"), 0, "PETITION_SHOW waits for the query");
    assert.deepEqual(world.calls, [{ kind: "query", petitionGuid: canned.FRAMEXML_CANNED_CHARTER_GUID }]);
    world.answerQuery();
    assert.deepEqual(lua(boot, `return PetitionFrame:IsShown() and 1 or 0, PetitionFrameNpcNameText:GetText(),
      PetitionFrameCharterName:GetText(), PetitionFrameMasterName:GetText(), PetitionFrameMemberName1:GetText(),
      PetitionFrameMemberName2:GetText() == NOT_YET_SIGNED and 1 or 0, PetitionFrameMemberName9:IsShown() and 1 or 0,
      PetitionFrameSignButton:IsShown() and PetitionFrameSignButton:IsEnabled() and 1 or 0,
      PetitionFrameRequestButton:IsShown() and 1 or 0`, 9),
    [1, lua(boot, "return format(GUILD_CHARTER_TEMPLATE, 'Стражи Златоземья')")[0], "Стражи Златоземья", "Альдерик", "Бруна",
      1, 1, 1, 0], "nine lines for MinPetitionSigns 9, one signed; a member's view");
    boot.bridge.Click(boot.bridge.getFrame("PetitionFrameSignButton"));
    assert.deepEqual(world.calls.at(-1), { kind: "sign", petitionGuid: canned.FRAMEXML_CANNED_CHARTER_GUID });
    assert.equal(shown(boot, "PetitionFrame"), 1);
    world.answerMessage("Подпись принята");
    assert.equal(shown(boot, "PetitionFrame"), 0, "SMSG_PETITION_SIGN_RESULTS closes it at the signer's side");
    assert.equal(world.petitionSignatures, undefined);

    // The owner's own charter: Request and Rename instead of Sign.
    const own = { ...canned.FRAMEXML_CANNED_CHARTER_SIGNATURES, ownerGuid: canned.FRAMEXML_CANNED_CHARTER_SELF };
    world.petition = { ...canned.FRAMEXML_CANNED_CHARTER_INFO, ownerGuid: canned.FRAMEXML_CANNED_CHARTER_SELF };
    world.showCharter(own, true);
    assert.deepEqual(lua(boot, `return PetitionFrame:IsShown() and 1 or 0, PetitionFrameMasterName:GetText(),
      PetitionFrameRequestButton:IsShown() and PetitionFrameRequestButton:IsEnabled() and 1 or 0,
      PetitionFrameSignButton:IsShown() and 1 or 0, PetitionFrameRenameButton:IsShown() and 1 or 0`, 5),
    [1, "Тестер", 1, 0, 1]);
    world.targetGuid = 0x33n;
    world.state.objects.set(0x33n, { typeId: 4 });
    boot.bridge.Click(boot.bridge.getFrame("PetitionFrameRequestButton"));
    assert.deepEqual(world.calls.at(-1), { kind: "offer", petitionGuid: canned.FRAMEXML_CANNED_CHARTER_GUID, playerGuid: 0x33n });
    world.targetGuid = 0xF130000134000301n;
    world.state.objects.set(0xF130000134000301n, { typeId: 3 });
    boot.bridge.Click(boot.bridge.getFrame("PetitionFrameRequestButton"));
    assert.equal(world.calls.at(-1).kind, "offer", "a creature target is not offered the charter");
    assert.equal(world.calls.filter((call) => call.kind === "offer").length, 1);
    boot.bridge.Click(boot.bridge.getFrame("PetitionFrameRenameButton"));
    assert.equal(lua(boot, "return StaticPopup_Visible('RENAME_GUILD') and 1 or 0")[0], 1);
    lua(boot, `local dialog = StaticPopup_Visible("RENAME_GUILD")
      _G[dialog .. "EditBox"]:SetText("Стражи Рассвета")
      _G[dialog .. "Button1"]:Click()`, 0);
    assert.deepEqual(world.calls.at(-1), { kind: "rename", petitionGuid: canned.FRAMEXML_CANNED_CHARTER_GUID, name: "Стражи Рассвета" });
    world.answerQuery({ ...world.petition, name: "Стражи Рассвета" });
    assert.equal(lua(boot, "return PetitionFrameCharterName:GetText()")[0], "Стражи Рассвета", "the rename re-raises PETITION_SHOW");
    boot.bridge.Click(boot.bridge.getFrame("PetitionFrameCancelButton"));
    assert.equal(shown(boot, "PetitionFrame"), 0);
    assert.equal(world.petitionSignatures, undefined, "ClosePetition forgets the charter");

    // Using a charter item asks for it (ITEM_FLAG_PETITION); any other item is not the charter's.
    assert.equal(seam.petition.useItem(0x4000000000000999n, { flags: 0x2000 }), true);
    assert.deepEqual(world.calls.at(-1), { kind: "request", petitionGuid: 0x4000000000000999n });
    assert.equal(seam.petition.useItem(0x4000000000000999n, { flags: 0 }), false);
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    release();
    boot.close();
  }
});

test("unpublishing hands the charter windows back without a close command", withClient, async () => {
  const { boot, release, world } = await published();
  try {
    world.openTabard();
    world.showCharter();
    assert.equal(shown(boot, "TabardFrame") + shown(boot, "PetitionFrame"), 1, "both are left panels: the charter replaced the designer");
    release();
    for (const window of ["tabard", "registrar", "petition"]) assert.equal(controller.frameXmlCharterPublished(window), false);
    assert.equal(shown(boot, "PetitionFrame"), 0);
    assert.notEqual(world.petitionSignatures, undefined, "the charter stays for the native window");
  } finally {
    release();
    boot.close();
  }
});

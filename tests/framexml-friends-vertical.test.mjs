import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the stock FriendsFrame/RaidFrame closure in the production vertical, driven over the
// canned world. Everything here runs the real 3.3.5 Lua — the Friends, Ignore, Who, Guild, Chat and
// Raid tabs, the guild popups and the stock entry points — against FrameXmlFriends.ts's C API.
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
  createFrameXmlFriendsOwner, frameXmlFriendsGate, installFrameXmlFriendsRoutes,
} = await import("../dist/code/browser/framexml/FrameXmlFriendsOwner.js");
const { FRIEND_STATUS_OFFLINE, FRIEND_STATUS_ONLINE } = await import("../dist/code/browser/framexml/FrameXmlFriendsCanned.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const SOCIAL_FILES = ["friendsframe.xml", "raidframe.xml"];

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
  // The canned server answers a microtask later, as a packet would.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { boot, seam, inventory, requests, loadMs: performance.now() - started };
}

/** Run a Lua function body and return its values; a Lua failure raises. */
function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "friends-test", []);
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

/** Routes, gate and owner, as the world mount installs them; the routes record what reached them. */
function mount(boot, seam) {
  const routes = [];
  assert.equal(installFrameXmlFriendsRoutes(boot, {
    toggle: (tab) => routes.push(["toggle", tab ?? null]), open: (tab) => routes.push(["open", tab]),
  }), true);
  const gate = frameXmlFriendsGate(seam, boot, renderer());
  assert.ok(gate, "the canned social world and the stock tree pass the gate");
  const owner = createFrameXmlFriendsOwner(boot, gate.frame);
  seam.friends.owned = true;
  return { routes, gate, owner };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("FriendsFrame and RaidFrame follow BankFrame at retail TOC 101-102; the closure adds four files and no Lua error", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  const bank = toc.indexOf("bankframe.xml");
  assert.deepEqual(toc.slice(bank + 1, bank + 4), [...SOCIAL_FILES, "channelframe.xml"], "retail TOC 101-103");
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  const at = vertical.indexOf("bankframe.xml");
  assert.deepEqual(vertical.slice(at + 1, at + 4), [...SOCIAL_FILES, "channelframe.xml"],
    "the vertical keeps them together, before ChannelFrame.xml whose frame is FriendsFrame's Chat tab");
  let baseline;
  let candidate;
  try {
    baseline = await load(FRAMEXML_VERTICAL_TOC.filter((entry) => !SOCIAL_FILES.includes(normalize(entry))));
    candidate = await load(FRAMEXML_VERTICAL_TOC);
    assert.equal(baseline.boot.bridge.getFrame("FriendsFrame")?.name, undefined);
    for (const file of ["friendsframe.lua", "raidframe.lua"]) {
      assert.ok(candidate.requests.has(`interface/framexml/${file}`), `${file} is reached through its XML`);
    }
    const metric = (inventory) => ({ files: inventory.files.total, bytes: inventory.files.bytes,
      widgets: inventory.widgets.total, errors: inventory.lua.errorsRaised, distinct: inventory.errors.length,
      luaFailed: inventory.lua.failed });
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, afterLoad[key] - before[key]]));
    assert.deepEqual(delta, { files: 4, bytes: 330685, widgets: 2179, errors: 0, distinct: 0, luaFailed: 0 },
      `social closure delta ${JSON.stringify(delta)}`);
    assert.deepEqual(candidate.inventory.errors, []);
    const friends = candidate.boot.bridge.getFrame("FriendsFrame");
    assert.equal(friends.visible, false);
    assert.equal(friends.parent?.name, "UIParent");
    assert.equal(candidate.boot.bridge.getFrame("ChannelFrame").parent, friends, "ChannelFrame is the Chat tab");
    assert.equal(candidate.boot.bridge.getFrame("RaidFrame").parent, friends, "RaidFrame is the Raid tab");
    for (const name of ["AddFriendFrame", "FriendsFriendsFrame"]) {
      assert.equal(candidate.boot.bridge.getFrame(name).visible, false, `${name} is a hidden UIParent child`);
    }
    // FriendsMicroButton (FloatingChatFrame.xml, already loaded) counts online friends from the seam.
    assert.deepEqual(lua(candidate.boot, "return FriendsMicroButtonCount:GetText()"), ["3"]);
    console.log(`[friends] load ms baseline ${Math.round(baseline.loadMs)} candidate ${Math.round(candidate.loadMs)}`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
  }
});

test("the gate visits every tab silently: no packet, no sound, rows match the model, ends hidden", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    installFrameXmlFriendsRoutes(boot, { toggle() {}, open() {} });
    const sounds = [];
    const playSound = seam.playSound.bind(seam);
    seam.playSound = (name) => { sounds.push(name); playSound(name); };
    const calls = seam.socialWorld.calls.length;
    const errors = boot.errorCount;
    const result = frameXmlFriendsGate(seam, boot, renderer());
    assert.ok(result);
    assert.equal(result.frame.name, "FriendsFrame");
    // Two ignores plus their header; the guild shows 13 of its 15 members (GUILDMEMBERS_TO_DISPLAY).
    assert.deepEqual([result.ignoreRows, result.guildRows], [3, 13]);
    assert.equal(result.frame.visible, false, "the probe ends hidden");
    assert.deepEqual(seam.socialWorld.calls.slice(calls), [], "ShowFriends and GuildRoster are muted during the probe");
    assert.deepEqual(sounds, [], "the probe plays no open/close sound");
    assert.equal(boot.errorCount, errors);
    assert.equal(lua(boot, "return DropDownList1:IsShown() and 1 or 0")[0], 0, "the row menu it opened is closed again");
    // A row menu without UnitPopup's entries would leave no way to note or remove a friend: closed.
    lua(boot, "__savedUnitPopupMenus = UnitPopupMenus UnitPopupMenus = nil", 0);
    assert.equal(frameXmlFriendsGate(seam, boot, renderer()), undefined, "a dead friend-row menu fails the gate");
    lua(boot, "UnitPopupMenus = __savedUnitPopupMenus", 0);
    assert.ok(frameXmlFriendsGate(seam, boot, renderer()), "and passes again with the stock menus");
    // Without the routes the stock entry points are not kept, and nothing is proved.
    const bare = await load(FRAMEXML_VERTICAL_TOC);
    try {
      assert.equal(frameXmlFriendsGate(bare.seam, bare.boot, renderer()), undefined, "no kept stock toggle, no owner");
      assert.equal(frameXmlFriendsGate({}, boot, renderer()), undefined, "no social model, no owner");
    } finally {
      bare.boot.close();
    }
  } finally {
    boot.close();
  }
});

test("every stock entry point reaches the host route, never the stock frame directly", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const { routes } = mount(boot, seam);
    const frame = boot.bridge.getFrame("FriendsFrame");
    for (const [code, expected] of [
      ["ToggleFriendsFrame()", ["toggle", null]],
      ["ToggleFriendsFrame(1)", ["toggle", "friends"]],
      ["ToggleFriendsFrame(4)", ["toggle", "channel"]],
      ["ToggleFriendsFrame(5)", ["toggle", "raid"]],
      ["ToggleFriendsPanel()", ["toggle", "friends"]],
      ["ToggleIgnorePanel()", ["toggle", "ignore"]],
      ["ShowWhoPanel()", ["open", "who"]],
      ["SlashCmdList.GUILD_ROSTER('')", ["open", "guild"]],
      // The chat dock's social button (FloatingChatFrame.xml) and the stock MainMenuBar row's.
      ["FriendsMicroButton:Click('LeftButton')", ["toggle", "friends"]],
    ]) {
      routes.length = 0;
      lua(boot, code, 0);
      assert.deepEqual(routes, [expected], code);
      assert.equal(frame.visible, false, `${code} opens nothing by itself`);
    }
  } finally {
    boot.close();
  }
});

test("the stock tabs read the world: friends online first, ignores, a who answer, the guild roster", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const { owner } = mount(boot, seam);
    const errors = boot.errorCount;
    owner.show("friends");
    await tick();
    assert.equal(owner.isTabOpen("friends"), true);
    // ShowFriends asked; the canned server's SMSG_CONTACT_LIST repaints the scroll list.
    assert.ok(seam.socialWorld.calls.some((call) => call.kind === "contacts"));
    const friends = lua(boot, `local r = {}
      for i = 1, 8 do
        local b = _G["FriendsFrameFriendsScrollFrameButton" .. i]
        if b and b:IsVisible() then r[#r + 1] = (b.name:GetText() or "") .. "|" .. (b.info:GetText() or "") end
      end
      return table.concat(r, ";"), FriendsFrameOfflineHeader:IsVisible() and 1 or 0`, 2);
    assert.deepEqual(friends, [
      "Аэлинда, Маг 60-го уровня|Штормград;Бранд, Охотник 58-го уровня|Стальгорн;Вэйлин, Жрец 42-го уровня|Элвиннский лес;Гортан|;Дарэль|",
      1,
    ], "online friends first by name, then (below the shown offline header, whose row button hides) offline friends by name only");
    assert.deepEqual(lua(boot, `local _, _, _, _, _, afk = GetFriendInfo(2) local _, _, _, _, _, dnd, note = GetFriendInfo("вэйлин")
      local _, _, _, _, _, _, gnote = GetFriendInfo(4) return afk == CHAT_FLAG_AFK, dnd == CHAT_FLAG_DND, note, gnote`, 4),
    [true, true, undefined, "алхимик"], "status is the locale's CHAT_FLAG_* text; an empty note is nil");

    owner.show("ignore");
    assert.deepEqual(lua(boot, `return FriendsFrameIgnoreButton2.name:GetText(), FriendsFrameIgnoreButton3.name:GetText(),
      FriendsFrameUnsquelchButton:IsEnabled()`, 3), ["Спамер", "Шумный", 1]);

    owner.show("who");
    seam.socialWorld.answerWho();
    assert.deepEqual(lua(boot, `local visible = 0
      for i = 1, WHOS_TO_DISPLAY do if _G["WhoFrameButton" .. i]:IsVisible() then visible = visible + 1 end end
      return visible, WhoFrameTotals:GetText(), WhoFrameButton1Name:GetText(), WhoFrameButton1Level:GetText(),
        WhoFrameButton1Class:GetText(), WhoFrameButton1Variable:GetText()`, 6),
    [17, "Найдено игроков: 20  ", "Аэлинда", "60", "Маг", "Штормград"]);
    lua(boot, `SortWho("level") SortWho("level")`, 0);
    assert.deepEqual(lua(boot, "return WhoFrameButton1Level:GetText(), WhoFrameButton17Level:GetText()", 2), ["60", "56"],
      "the same column twice sorts descending");

    owner.show("guild");
    await tick();
    seam.friends.tick();
    assert.deepEqual(lua(boot, `return FriendsFrameTitleText:GetText(), GuildFrameTotals:GetText(), GuildFrameOnlineTotals:GetText(),
      GuildFrameNotesText:GetText(), GuildFrameButton1Name:GetText(), GuildFrameControlButton:IsEnabled(),
      GuildFrameAddMemberButton:IsEnabled()`, 7), [
      "Глава гильдии - Стражи Элвинна", "Членов гильдии: |cffffffff15|r", "(|cff00ff00В игре:|r |cffffffff10|r)",
      "Рейд в Наксрамас в пятницу в 20:00. Не опаздывайте!", "Аэлинда", 1, 1,
    ]);
    assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.vm.errors.slice(-2))}`);
  } finally {
    boot.close();
  }
});

test("guild popups: member detail and notes, the info text, the event log and the rank editor", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const { owner } = mount(boot, seam);
    const errors = boot.errorCount;
    owner.show("guild");
    await tick();
    seam.friends.tick();
    // Row 4 by name is Лорн (AFK): select it, the detail frame fills; notes are editable for the GM.
    lua(boot, `GuildFrameButton4:Click("LeftButton")`, 0);
    assert.deepEqual(lua(boot, `return GuildMemberDetailFrame:IsShown() and 1 or 0, GuildMemberDetailName:GetText(),
      GuildMemberDetailRankText:GetText(), GuildMemberDetailOnlineText:GetText(), GetGuildRosterSelection()`, 5),
    [1, "Лорн", "Участник", "В сети", 4]);
    lua(boot, `GuildRosterSetPublicNote(GetGuildRosterSelection(), "лекарь") GuildRosterSetOfficerNote(4, "проверить")`, 0);
    assert.deepEqual(seam.socialWorld.calls.filter((call) => call.kind === "memberNote"), [
      { kind: "memberNote", name: "Лорн", note: "лекарь", officer: false },
      { kind: "memberNote", name: "Лорн", note: "проверить", officer: true },
    ]);
    // The selection follows its member when the roster is re-sorted.
    lua(boot, `SortGuildRoster("level")`, 0);
    assert.deepEqual(lua(boot, "return (GetGuildRosterInfo(GetGuildRosterSelection()))"), ["Лорн"]);

    lua(boot, "ToggleGuildInfoFrame()", 0);
    assert.deepEqual(lua(boot, "return GuildInfoFrame:IsShown() and 1 or 0, GuildInfoEditBox:GetText()", 2),
      [1, "Стражи Элвинна — дружелюбная гильдия Альянса.\nРейды: пт и вс.\nСайт: нет."]);
    lua(boot, `GuildInfoEditBox:SetText("Новый текст") GuildInfoSaveButton:Click("LeftButton")`, 0);
    assert.ok(seam.socialWorld.calls.some((call) => call.kind === "infoText" && call.text === "Новый текст"));

    lua(boot, "ToggleGuildEventLog()", 0);
    await tick();
    seam.friends.tick();
    const log = lua(boot, "return GuildEventLogFrame:IsShown() and 1 or 0, GuildEventMessage:GetText()", 2);
    assert.equal(log[0], 1);
    // Newest first, and cut at the FontString's 255-byte field (UI.xsd's default `bytes`).
    assert.match(log[1], /^Вейд покидает гильдию\./);
    assert.ok(new TextEncoder().encode(log[1]).length <= 255, `${new TextEncoder().encode(log[1]).length} bytes`);

    lua(boot, `GuildFrameControlButton:Click("LeftButton")`, 0);
    assert.deepEqual(lua(boot, `GuildControlPopupFrameDropDownButton_OnClick({ GetID = function() return 3 end })
      return GuildControlPopupFrame:IsShown() and 1 or 0, GuildControlPopupFrameEditBox:GetText(),
        GuildControlPopupFrameCheckbox1:GetChecked(), GuildControlPopupFrameCheckbox10:GetChecked(),
        GuildControlPopupFrameCheckbox5:GetChecked(), GuildControlWithdrawGoldEditBox:GetText(),
        GuildControlTabPermissionsViewTab:GetChecked(), GuildControlTabPermissionsDepositItems:GetChecked()`, 8),
    [1, "Ветеран", 1, 1, undefined, "50", 1, 1],
    "rank 3 (Ветеран): guild chat and public notes, no promote, 50 gold a day, the first vault tab");
    lua(boot, `GuildControlPopupFrameCheckbox5:Click("LeftButton")
      GuildControlPopupFrameEditBox:SetText("Ветераны")
      GuildControlWithdrawGoldEditBox:SetText("75")
      GuildControlPopupAcceptButton_OnClick()`, 0);
    const saved = seam.socialWorld.calls.filter((call) => call.kind === "rank");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].rankId, 2);
    assert.equal(saved[0].name, "Ветераны");
    assert.equal(saved[0].gold, 75 * 10000, "the gold box is gold; the wire is copper");
    assert.equal(saved[0].flags & 0x80, 0x80, "checkbox 5 (promote) added GR_RIGHT_PROMOTE's bit");
    assert.equal(saved[0].flags & 0x2000, 0x2000, "rights the editor did not touch are kept");
    assert.equal(saved[0].tabs.length, 6);
    assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.vm.errors.slice(-2))}`);
  } finally {
    boot.close();
  }
});

test("raid tab: convert to raid, the saved instance list and RAID_ROSTER_UPDATE", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const { owner } = mount(boot, seam);
    const errors = boot.errorCount;
    owner.show("raid");
    assert.deepEqual(lua(boot, "return RaidFrame:IsVisible() and 1 or 0, RaidFrameNotInRaid:IsVisible() and 1 or 0, GetNumSavedInstances()", 3),
      [1, 1, 2]);
    lua(boot, "RaidFrameRaidInfoButton:Click('LeftButton')", 0);
    assert.deepEqual(lua(boot, `return RaidInfoFrame:IsVisible() and 1 or 0, RaidInfoScrollFrameButton1.name:GetText(),
      RaidInfoScrollFrameButton1.difficulty:GetText(), RaidInfoScrollFrameButton2.name:GetText(),
      RaidInfoScrollFrameButton2.extended:IsShown() and 1 or 0`, 5),
    [1, "Наксрамас", "10 игроков", "Крепость Утгард", 1]);
    assert.deepEqual(lua(boot, "local _, id, _, _, _, _, mostSig = GetSavedInstanceInfo(1) return id, mostSig", 2), [0x17, 1],
      "the 64-bit instance id is split into stock's two halves");
    lua(boot, "RaidInfoInstance_OnClick(RaidInfoScrollFrameButton2) RaidInfoExtendButton_OnClick(RaidInfoExtendButton)", 0);
    assert.deepEqual(seam.socialWorld.calls.filter((call) => call.kind === "extend"),
      [{ kind: "extend", mapId: 574, difficulty: 1, extend: false }], "an extended lock is un-extended");
    // A raid group list: RAID_ROSTER_UPDATE on the next poll; the listed members, then the player,
    // in GetRaidRosterInfo. RequestRaidInfo after the extend click is answered with a new lockout
    // list: UPDATE_INSTANCE_INFO.
    await tick();
    seam.friends.tick();
    lua(boot, `__raidEvents = {}
      local stock = RaidFrame:GetScript("OnEvent")
      RaidFrame:SetScript("OnEvent", function(self, event, ...)
        __raidEvents[#__raidEvents + 1] = event
        return stock(self, event, ...)
      end)
      __raidMessages = {}
      local say = message
      message = function(text, ...) __raidMessages[#__raidMessages + 1] = tostring(text) return say(text, ...) end`, 0);
    const dialog = lua(boot, "return BasicScriptErrors:IsShown() and 1 or 0, BasicScriptErrorsText:GetText()", 2);
    seam.socialWorld.groupList(true);
    seam.friends.tick();
    seam.friends.tick();
    assert.deepEqual(lua(boot, "return table.concat(__raidEvents, ',')"), ["RAID_ROSTER_UPDATE"],
      "one edge per new raid roster, through RaidFrame's stock handler (RaidFrame_LoadUI, RaidFrame_Update)");
    assert.deepEqual(lua(boot, "return table.concat(__raidMessages, '|')"), [""],
      "RaidFrame_LoadUI skips the Blizzard_RaidUI this client does not ship: no «Ошибка загрузки» dialog");
    assert.deepEqual(lua(boot, "return BasicScriptErrors:IsShown() and 1 or 0, BasicScriptErrorsText:GetText()", 2), dialog,
      "the script-error dialog is as it was");
    assert.deepEqual(lua(boot, "return LoadAddOn('Blizzard_RaidUI')", 2), [false, "MISSING"],
      "the skip rests on the add-on runtime's own answer");
    assert.deepEqual(seam.friends.raid.rosterInfo(1).slice(0, 5), ["Альфа", 1, 1, 60, "Воин"], "raid1 is the first listed member");
    assert.deepEqual(seam.friends.raid.rosterInfo(5).slice(0, 3), ["Игрок", 2, 1], "the player, after the listed members, leads in subgroup 1");
    assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.vm.errors.slice(-2))}`);
  } finally {
    boot.close();
  }
});

test("a /who answer: short to a closed tab goes to chat, long or to an open tab fills the Who tab", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const { owner } = mount(boot, seam);
    const lines = [];
    const addMessage = boot.bridge.AddMessage.bind(boot.bridge);
    boot.bridge.AddMessage = (frame, text, ...rest) => { lines.push(String(text)); return addMessage(frame, text, ...rest); };
    seam.friends.owned = false;
    seam.socialWorld.answerWho(2);
    assert.deepEqual(lines, [], "unowned: the native social panel answers /who");
    assert.equal(owner.isOpen(), false);
    seam.friends.owned = true;
    seam.socialWorld.answerWho(2);
    assert.deepEqual(lines, [
      "|Hplayer:Аэлинда|h[Аэлинда]|h: |3-6(Человек), |3-6(Маг) 60-го уровня <Стражи Элвинна> - Штормград",
      "|Hplayer:Бранд|h[Бранд]|h:  |3-6(Дворф), |3-6(Охотник) 58-го уровня – Стальгорн",
      "Всего игроков: 2",
    ], "WHO_LIST_GUILD_FORMAT / WHO_LIST_FORMAT / WHO_NUM_RESULTS, in the client's locale");
    assert.equal(owner.isOpen(), false, "a short answer does not open the frame");
    seam.socialWorld.answerWho(10);
    assert.equal(owner.isTabOpen("who"), true, "WhoList_Update opens the Who tab for a long answer");
    lines.length = 0;
    seam.socialWorld.answerWho(1);
    assert.deepEqual(lines, [], "with the Who tab open (SetWhoToUI(1)) every answer goes to the tab");
    assert.deepEqual(lua(boot, "return WhoFrameTotals:GetText()"), ["Найдено игроков: 1  "]);
  } finally {
    boot.close();
  }
});

test("the stock micro-button row: SocialsMicroButton is pushed while FriendsFrame is shown", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const { owner } = mount(boot, seam);
    const button = boot.bridge.getFrame("SocialsMicroButton");
    // HelpFrame, AchievementFrame and InterfaceOptionsFrame are still absent, so the exercise compat
    // keeps its UpdateMicroButtons adapter; it now finds a real FriendsFrame for the Socials button.
    assert.equal(boot.bridge.getFrame("AchievementFrame")?.name, undefined);
    owner.show("friends");
    lua(boot, "UpdateMicroButtons()", 0);
    assert.equal(button.buttonState, "PUSHED");
    owner.hide();
    lua(boot, "UpdateMicroButtons()", 0);
    assert.equal(button.buttonState, "NORMAL");
    // A friend coming online updates the chat dock's counter through FRIENDLIST_UPDATE.
    seam.socialWorld.friendStatus(0x104n, FRIEND_STATUS_ONLINE, 1519, 60, 9);
    assert.deepEqual(lua(boot, "return FriendsMicroButtonCount:GetText()"), ["4"]);
    seam.socialWorld.friendStatus(0x104n, FRIEND_STATUS_OFFLINE);
    assert.deepEqual(lua(boot, "return FriendsMicroButtonCount:GetText()"), ["3"]);
  } finally {
    boot.close();
  }
});

test("renderer adapters: anchorless dropdowns hide, list rows take clicks and forward the wheel to their scroll frame", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const { owner } = mount(boot, seam);
    assert.deepEqual(lua(boot, `return FriendsDropDown:IsShown() and 1 or 0, ChannelListDropDown:IsShown() and 1 or 0,
      ChannelRosterDropDown:IsShown() and 1 or 0, FriendsFrameStatusDropDown:GetNumPoints()`, 4), [0, 0, 0, 1],
    "the three anchorless menus hide; an anchored dropdown is untouched");
    for (const [scroll, row] of [["WhoListScrollFrame", "WhoFrameButton1"], ["GuildListScrollFrame", "GuildFrameButton1"],
      ["GuildListScrollFrame", "GuildFrameGuildStatusButton1"], ["ChannelRosterScrollFrame", "ChannelMemberButton1"]]) {
      assert.deepEqual(lua(boot, `return ${scroll}:IsMouseWheelEnabled() and 1 or 0, ${row}:IsMouseWheelEnabled() and 1 or 0,
        ${row}:GetScript("OnMouseWheel") ~= nil and 1 or 0`, 3), [0, 1, 1], `${row} over ${scroll}`);
    }
    owner.show("who");
    seam.socialWorld.answerWho();
    const errors = boot.errorCount;
    assert.deepEqual(lua(boot, `local before = WhoListScrollFrameScrollBar:GetValue()
      WhoFrameButton3:GetScript("OnMouseWheel")(WhoFrameButton3, -1)
      return before, WhoListScrollFrameScrollBar:GetValue() > before and 1 or 0`, 2), [0, 1],
    "the wheel over a row scrolls the 20-row answer, as the wheel over the list does in the client");
    assert.equal(boot.errorCount, errors);
    // A second install (a remount of the same VM never happens, but the adapter is idempotent).
    assert.equal(installFrameXmlFriendsRoutes(boot, { toggle() {}, open() {} }), true);
  } finally {
    boot.close();
  }
});

test("the Chat tab lists the joined channels and, once a row is chosen, the roster the server lists", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const { owner } = mount(boot, seam);
    const errors = boot.errorCount;
    owner.show("channel");
    assert.equal(owner.isTabOpen("channel"), true);
    assert.deepEqual(lua(boot, `local r = {}
      for i = 1, 4 do local b = _G["ChannelButton" .. i] r[#r + 1] = b:IsShown() and (_G["ChannelButton" .. i .. "Text"]:GetText() or "") or "-" end
      return table.concat(r, ";")`), ["|cffffffff1. Общий|r;|cffffffff2. Оборона: Элвиннский лес|r;|cffffffff3. стражи|r;-"]);
    lua(boot, `ChannelButton3:Click("LeftButton")`, 0);
    assert.deepEqual(seam.socialWorld.calls.filter((call) => call.kind === "channelList"), [{ kind: "channelList", channel: "стражи" }]);
    await tick();
    seam.friends.tick();
    assert.deepEqual(lua(boot, `local r = {}
      for i = 1, 4 do local b = _G["ChannelMemberButton" .. i] r[#r + 1] = b:IsShown() and (_G["ChannelMemberButton" .. i .. "Name"]:GetText() or "") or "-" end
      return table.concat(r, ";"), ChannelRosterChannelName:GetText(), ChannelMemberButton2Rank:IsShown() and 1 or 0`, 3),
    ["Аэлинда;Ивор;Игрок;-", "стражи", 0], "the roster by name; Аэлинда moderates, the player owns");
    assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.vm.errors.slice(-2))}`);
  } finally {
    boot.close();
  }
});

test("/roster's route: the owner selects the typed channel's Chat tab row, which asks the server, as a click does", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const { owner } = mount(boot, seam);
    const errors = boot.errorCount;
    owner.show("channel");
    const selected = () => lua(boot, "return GetSelectedDisplayChannel() or 0")[0];
    assert.equal(owner.selectChannel("СТРАЖИ"), true, "a joined channel by its name, case-insensitively");
    assert.equal(selected(), 3);
    assert.deepEqual(seam.socialWorld.calls.filter((call) => call.kind === "channelList"), [{ kind: "channelList", channel: "стражи" }]);
    await tick();
    seam.friends.tick();
    assert.deepEqual(lua(boot, "return ChannelRosterChannelName:GetText(), ChannelMemberButton1Name:GetText()", 2), ["стражи", "Аэлинда"],
      "the roster pane shows the selected row's listed roster");
    assert.equal(owner.selectChannel("Общий - Элвиннский лес"), true, "the server's full name matches the row's short one");
    assert.equal(selected(), 1);
    assert.equal(owner.selectChannel("2"), true, "a number is the row's number");
    assert.equal(selected(), 2);
    assert.equal(owner.selectChannel("Торговля"), false, "a channel the player is not in selects nothing");
    assert.equal(selected(), 2);
    assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.vm.errors.slice(-2))}`);
  } finally {
    boot.close();
  }
});

test("UnitPopup at retail TOC 66 gives the friend, who and guild rows their stock menus: note, invite, remove", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  assert.equal(toc[toc.indexOf("unitpopup.xml") + 1], "unitframe.xml", "retail TOC 66, just before UnitFrame.xml");
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  assert.equal(vertical[vertical.indexOf("unitpopup.xml") + 1], "unitframe.xml", "the vertical keeps that slot");
  let baseline;
  let candidate;
  try {
    baseline = await load(FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) !== "unitpopup.xml"));
    candidate = await load(FRAMEXML_VERTICAL_TOC);
    assert.ok(candidate.requests.has("interface/framexml/unitpopup.lua"), "UnitPopup.lua is reached through its XML");
    const metric = (inventory) => ({ files: inventory.files.total, bytes: inventory.files.bytes,
      widgets: inventory.widgets.total, errors: inventory.lua.errorsRaised, distinct: inventory.errors.length,
      luaFailed: inventory.lua.failed });
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, afterLoad[key] - before[key]]));
    assert.deepEqual(delta, { files: 2, bytes: 64100, widgets: 22, errors: 0, distinct: 0, luaFailed: 0 },
      `UnitPopup closure delta ${JSON.stringify(delta)}`);
    console.log(`[friends] UnitPopup load ms baseline ${Math.round(baseline.loadMs)} candidate ${Math.round(candidate.loadMs)}`);
    baseline.boot.close();
    baseline = undefined;

    const { boot, seam } = candidate;
    const { owner } = mount(boot, seam);
    const errors = boot.errorCount;
    /** The open menu's entries (UnitPopup's button keys; the title row is the name). */
    const menu = () => lua(boot, `local r = {}
      for i = 1, DropDownList1:IsShown() and DropDownList1.numButtons or 0 do r[#r + 1] = tostring(_G["DropDownList1Button" .. i].value) end
      return table.concat(r, ",")`)[0];
    owner.show("friends");
    await tick();
    lua(boot, `FriendsFrameFriendsScrollFrameButton1:Click("RightButton")`, 0);
    assert.equal(menu(), "Аэлинда,WHISPER,INVITE,SET_NOTE,IGNORE,REMOVE_FRIEND,CANCEL",
      "a friend row: whisper, invite, note and remove — what the native panel's row menu offered");
    // SET_NOTE opens stock's SET_FRIENDNOTE popup; accepting it is SetFriendNotes → CMSG_SET_CONTACT_NOTES.
    lua(boot, `for i = 1, DropDownList1.numButtons do local b = _G["DropDownList1Button" .. i]
      if b.value == "SET_NOTE" then b:Click() break end end`, 0);
    assert.deepEqual(lua(boot, `local popup = StaticPopup_Visible("SET_FRIENDNOTE")
      local frame = popup and _G[popup]
      if frame then frame.wideEditBox:SetText("танк") StaticPopup_OnClick(frame, 1) end
      return popup and 1 or 0, StaticPopup_Visible("SET_FRIENDNOTE") and 1 or 0`, 2), [1, 0]);
    assert.deepEqual(seam.socialWorld.calls.filter((call) => call.kind === "friendNote").map((call) => call.note), ["танк"]);
    owner.show("who");
    seam.socialWorld.answerWho();
    lua(boot, `CloseDropDownMenus() WhoFrameButton1:Click("RightButton")`, 0);
    assert.match(menu(), /^Аэлинда,WHISPER,INVITE,IGNORE,CANCEL$/, "a who row: no note or remove outside the friends list");
    owner.show("guild");
    await tick();
    seam.friends.tick();
    lua(boot, `CloseDropDownMenus() GuildFrameButton2:Click("RightButton")`, 0);
    assert.match(menu(), /,WHISPER,INVITE,.*CANCEL$/, "a guild row");
    lua(boot, "CloseDropDownMenus()", 0);
    assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.errors.slice(-2))}`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
  }
});

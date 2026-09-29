import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the stock Lua of this client's ruRU corpus is what reads each of these answers —
// ItemButtonTemplate's HandleModifiedItemClick, UIParent's ITEM_QUALITY_COLORS, UnitPopup's
// POP_OUT_CHAT into FloatingChatFrame's temporary windows, PlayerFrame's raid group indicator and
// GameTooltip's link setter. One boot, the canned seam, and a modifier tracker the test feeds.

let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { ModifierTracker } = await import("../dist/code/browser/input/Modifiers.js");
const { game } = await import("../dist/code/browser/game/Context.js");

const decoder = new TextDecoder("utf-8");
let loaded;
async function shared() {
  if (loaded) return loaded;
  const seam = new CannedWorldSeam();
  const modifiers = new ModifierTracker();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, modifiers, screen: () => ({ width: 1365, height: 768 }),
  });
  await boot.load();
  loaded = { boot, seam, modifiers };
  return loaded;
}
after(() => {
  loaded?.boot.close();
  chain?.close();
});

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "seam-residuals-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("IsModifiedClick follows the held keys and the click's button under Bindings.xml's defaults", withClient, async () => {
  const { boot, modifiers } = await shared();
  const errors = boot.errorCount;
  lua(boot, `__modifierEvents = {}
    local spy = CreateFrame("Frame")
    spy:RegisterEvent("MODIFIER_STATE_CHANGED")
    spy:SetScript("OnEvent", function(_, _, key, state) __modifierEvents[#__modifierEvents + 1] = key .. ":" .. state end)`, 0);
  const state = () => lua(boot, `local r = {}
    for _, name in ipairs({ "IsShiftKeyDown", "IsLeftShiftKeyDown", "IsRightShiftKeyDown", "IsControlKeyDown",
      "IsAltKeyDown", "IsModifierKeyDown" }) do r[#r + 1] = _G[name]() and name or nil end
    for _, action in ipairs({ "CHATLINK", "DRESSUP", "SOCKETITEM", "SPLITSTACK", "AUTOLOOTTOGGLE",
      "MAILAUTOLOOTTOGGLE", "SELFCAST", "FOCUSCAST", "STICKYCAMERA" }) do
      if IsModifiedClick(action) then r[#r + 1] = action end
    end
    if IsModifiedClick() then r[#r + 1] = "any" end
    return table.concat(r, ",")`)[0];

  assert.equal(state(), "", "nothing is held");
  assert.deepEqual(lua(boot, `return GetModifiedClick("CHATLINK"), GetModifiedClick("SOCKETITEM"), GetModifiedClick("FOCUSCAST")`, 3),
    ["SHIFT-BUTTON1", "SHIFT-BUTTON2", "NONE"]);

  // Left Shift down: the event carries the side, and the shift-only actions hold. CHATLINK also
  // names BUTTON1, so it waits for a left click.
  modifiers.key({ type: "keydown", code: "ShiftLeft", shiftKey: true, ctrlKey: false, altKey: false });
  assert.equal(state(), "IsShiftKeyDown,IsLeftShiftKeyDown,IsModifierKeyDown,SPLITSTACK,AUTOLOOTTOGGLE,MAILAUTOLOOTTOGGLE,any");
  modifiers.pointer({ button: 0, shiftKey: true, ctrlKey: false, altKey: false });
  assert.match(state(), /,CHATLINK,/, "Shift + left click is the chat link");
  modifiers.pointer({ button: 2, shiftKey: true, ctrlKey: false, altKey: false });
  assert.match(state(), /SOCKETITEM/, "Shift + right click sockets");
  assert.doesNotMatch(state(), /CHATLINK/);

  // A stock consumer: ItemButtonTemplate.lua:108's HandleModifiedItemClick links on Shift+left and
  // dresses up on Ctrl+left.
  lua(boot, `__handled = {}
    local link, dress = ChatEdit_InsertLink, DressUpItemLink
    ChatEdit_InsertLink = function(text) __handled[#__handled + 1] = "link" return true end
    DressUpItemLink = function(text) __handled[#__handled + 1] = "dressup" end
    __restoreHandled = function() ChatEdit_InsertLink, DressUpItemLink = link, dress end`, 0);
  const handle = () => lua(boot, `__handled = {}
    local done = HandleModifiedItemClick("|cffa335ee|Hitem:17063:0:0:0:0:0:0:0:60|h[Кольцо Аккурии]|h|r")
    return (done and "1" or "0") .. ":" .. table.concat(__handled, ",")`)[0];
  modifiers.pointer({ button: 0, shiftKey: true, ctrlKey: false, altKey: false });
  assert.equal(handle(), "1:link");
  // Ctrl joins: an exact chord, so Ctrl+Shift+click is neither the link nor the dress-up.
  modifiers.key({ type: "keydown", code: "ControlRight", shiftKey: true, ctrlKey: true, altKey: false });
  assert.equal(handle(), "0:");
  assert.match(state(), /IsControlKeyDown/);
  // Shift up while Ctrl stays: Ctrl+left is the dress-up.
  modifiers.key({ type: "keyup", code: "ShiftLeft", shiftKey: false, ctrlKey: true, altKey: false });
  modifiers.pointer({ button: 0, shiftKey: false, ctrlKey: true, altKey: false });
  assert.equal(handle(), "1:dressup");
  lua(boot, "__restoreHandled()", 0);

  // A rebinding holds for the session (InterfaceOptionsPanels' auto-loot key dropdown).
  lua(boot, `SetModifiedClick("AUTOLOOTTOGGLE", "CTRL")`, 0);
  assert.deepEqual(lua(boot, `return GetModifiedClick("AUTOLOOTTOGGLE"), IsModifiedClick("AUTOLOOTTOGGLE") and 1 or 0`, 2), ["CTRL", 1]);
  lua(boot, `SetModifiedClick("AUTOLOOTTOGGLE", "SHIFT")`, 0);

  // A pointer event with no modifier lets go of everything, however the keyup was lost.
  modifiers.pointer({ button: 0, shiftKey: false, ctrlKey: false, altKey: false });
  assert.equal(state(), "");
  assert.deepEqual(lua(boot, "return table.concat(__modifierEvents, ' ')"), ["LSHIFT:1 RCTRL:1 LSHIFT:0 RCTRL:0"],
    "MODIFIER_STATE_CHANGED for each side going down or up, in order");
  assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.errors.slice(-1))}`);
});

test("GetItemQualityColor answers 3.3.5's colour codes, heirloom included", withClient, async () => {
  const { boot } = await shared();
  assert.deepEqual(lua(boot, "return GetItemQualityColor(4)", 4), [0.64, 0.21, 0.93, "|cffa335ee"]);
  assert.deepEqual(lua(boot, "return GetItemQualityColor(7)", 4), [0.9, 0.8, 0.5, "|cffe6cc80"],
    "3.3.5's heirloom shares the artifact colour");
  // UIParent.lua:96-102 stores the fourth value as ITEM_QUALITY_COLORS[i].hex, and every reader
  // writes hex..name.."|r" (UIParent.lua:583, LootFrame.lua:303) — no adapter in between.
  assert.deepEqual(lua(boot, "return ITEM_QUALITY_COLORS[-1].hex, ITEM_QUALITY_COLORS[2].hex, ITEM_QUALITY_COLORS[6].hex", 3),
    ["|cffffffff", "|cff1eff00", "|cffe6cc80"]);
});

test("POP_OUT_CHAT on a whisper name opens a temporary chat window, docked and named, as the client does", withClient, async () => {
  const { boot } = await shared();
  const errors = boot.errorCount;
  // UnitPopup.lua:1209-1210 → FCF_OpenTemporaryWindow, which creates ChatFrame<N> with its ID as
  // CreateFrame's fifth argument (FloatingChatFrame.lua:701-713).
  const popped = lua(boot, `CloseDropDownMenus()
    FriendsFrame_ShowDropdown("Торвин", 1, 5, "WHISPER", ChatFrame1)
    local clicked = false
    for i = 1, DropDownList1.numButtons or 0 do
      local button = _G["DropDownList1Button" .. i]
      if button.value == "POP_OUT_CHAT" then button:Click() clicked = true break end
    end
    CloseDropDownMenus()
    local frame = _G["ChatFrame" .. (NUM_CHAT_WINDOWS + 1)]
    if not frame then return clicked and 1 or 0 end
    local tab = _G[frame:GetName() .. "Tab"]
    return clicked and 1 or 0, frame:GetID(), frame.name, frame.isTemporary and 1 or 0, frame.chatType,
      frame.isDocked and 1 or 0, tab:IsShown() and 1 or 0, tab:GetText()`, 8);
  assert.deepEqual(popped, [1, 11, "Торвин", 1, "WHISPER", 1, 1, "Торвин"]);
  assert.equal(boot.errorCount, errors, `no Lua error (was floatingchatframe.lua:804): ${JSON.stringify(boot.errors.slice(-1))}`);
  // Torvin's next whisper lands in his window and no longer in «Общий» (ChatFrame_ExcludePrivateMessageTarget).
  const counts = () => lua(boot, "return ChatFrame1:GetNumMessages(), ChatFrame11:GetNumMessages()", 2);
  const [general, whisper] = counts();
  boot.bridge.dispatchEvent("CHAT_MSG_WHISPER", "привет", "Торвин", "", "", "", "", 0, 0, "", 0, 7, "");
  assert.deepEqual(counts(), [general, whisper + 1]);
  boot.bridge.dispatchEvent("CHAT_MSG_WHISPER", "эй", "Бранд", "", "", "", "", 0, 0, "", 0, 8, "");
  assert.deepEqual(counts(), [general + 1, whisper + 1], "another sender stays in «Общий»");
  assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.errors.slice(-1))}`);
  // A second one grows the count again; the first is still in use.
  assert.deepEqual(lua(boot, `local frame = FCF_OpenTemporaryWindow("WHISPER", "Бранд", ChatFrame1, true)
    return frame:GetName(), frame:GetID(), frame.name`, 3), ["ChatFrame12", 12, "Бранд"]);
  assert.equal(boot.errorCount, errors);
});

test("in a raid GetNumRaidMembers counts the player, and PlayerFrame shows its «Группа N»", withClient, async () => {
  const { boot, seam } = await shared();
  const errors = boot.errorCount;
  assert.deepEqual(lua(boot, "return GetNumRaidMembers(), PlayerFrameGroupIndicator:IsShown() and 1 or 0", 2), [0, 0]);
  seam.socialWorld.groupList(true);
  seam.friends.tick();
  seam.friends.tick();
  const members = seam.socialWorld.group.members.length;
  assert.deepEqual(lua(boot, `local count = GetNumRaidMembers()
    local name, _, subgroup = GetRaidRosterInfo(count)
    return count, name, subgroup, UnitGUID("raid" .. count) == UnitGUID("player") and 1 or 0,
      PlayerFrameGroupIndicator:IsShown() and 1 or 0, PlayerFrameGroupIndicatorText:GetText()`, 6),
  [members + 1, "Игрок", 1, 1, 1, "Группа 1"], "RAID_ROSTER_UPDATE → PlayerFrame_UpdateGroupIndicator finds the player");
  seam.socialWorld.groupList(false);
  seam.friends.tick();
  seam.friends.tick();
  assert.deepEqual(lua(boot, "return GetNumRaidMembers()"), [0]);
  assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.errors.slice(-1))}`);
});

test("a link-shaped item tooltip with no world names the item from the seam's own fixtures", withClient, async () => {
  const { boot } = await shared();
  assert.equal(game.world, undefined, "the canned route: no WorldClient behind the tooltip");
  const tooltip = (link) => lua(boot, `GameTooltip:SetOwner(UIParent, "ANCHOR_NONE")
    GameTooltip:SetHyperlink("${link}")
    local r, g, b = GameTooltipTextLeft1:GetTextColor()
    local title, second = GameTooltipTextLeft1:GetText(), GameTooltipTextLeft2:IsShown() and GameTooltipTextLeft2:GetText() or ""
    GameTooltip:Hide()
    return title, format("%.2f,%.2f,%.2f", r, g, b), second`, 3);
  // The loot world's template: name, epic colour and its binding line.
  assert.deepEqual(tooltip("item:17063:0:0:0:0:0:0:0"), ["Кольцо Аккурии", "0.64,0.21,0.93", "Становится персональным при получении"]);
  // The mailbox's item: a name and quality, no template.
  assert.deepEqual(tooltip("item:6948:0:0:0:0:0:0:0").slice(0, 2), ["Камень возвращения", "1.00,1.00,1.00"]);
  // Nothing anywhere knows it: still the placeholder, never an invented name.
  assert.match(tooltip("item:999999:0:0:0:0:0:0:0")[0], /999999/);
});

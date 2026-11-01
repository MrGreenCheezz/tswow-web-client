import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const ADDON = "F:/CircleClean/Interface/AddOns/WowParityJournal/WowParityJournal.lua";
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { SAVED_VARIABLE_LIMITS } = await import("../dist/code/browser/framexml/FrameXmlSavedVariables.js");

const STUBS = `
  JournalHandlers = {}
  function CreateFrame()
    local frame = {}
    function frame:SetScript(name, handler) JournalHandlers[name] = handler end
    function frame:RegisterEvent() end
    return frame
  end
  function time() return 1 end
  function GetTime() return 1 end
  function UnitGUID(unit) return unit == "player" and "0x1" or nil end
  function GetUnitSpeed() return 0 end
  function GetPlayerMapPosition() return 0.5, 0.5 end
  function GetCurrentMapAreaID() return 1 end
  function UnitLevel() return 80 end
  function UnitHealth() return 1 end
  function UnitHealthMax() return 1 end
  function UnitPower() return 1 end
  function UnitPowerMax() return 1 end
  function UnitIsDeadOrGhost() return nil end
  function UnitCastingInfo() end
  function UnitChannelInfo() end
  function UnitClass() return "Rogue", "ROGUE" end
  function GetZoneText() return "Zone" end
  function GetSubZoneText() return "Sub" end
  function GetMoney() return 1 end
  function GetContainerNumSlots(bag) return bag == 0 and 16 or 20 end
  function GetContainerItemInfo() return nil, 1 end
  function GetContainerItemLink(bag, slot) return "|Hitem:" .. (bag * 100 + slot) .. ":0|h" end
  function GetInventoryItemLink(_, slot) return "|Hitem:" .. slot .. ":0|h" end
  function GetSpellInfo() return nil end
  SlashCmdList = {}
  function print() end
`;

const NODES = `
  local function count(value)
    if type(value) ~= "table" then return 1 end
    local nodes = 1
    for key, item in pairs(value) do nodes = nodes + count(key) + count(item) end
    return nodes
  end
  JournalNodeCount = count(WowParityJournalDB)
  local live = 0
  for _ in pairs(WowParityJournalDB.entries) do live = live + 1 end
  JournalLive = live
  local newest = WowParityJournalDB.entries[WowParityJournalDB.head]
  JournalNewest = newest and newest.kind or "none"
`;

test("the journal stays inside WebClient's saved-variable limit and keeps the newest entries", {
  skip: existsSync(ADDON) ? false : "F:/CircleClean is not on this machine",
}, () => {
  const vm = new GlueLuaVm();
  try {
    assert.equal(vm.execute(STUBS, "@stubs").ok, true);
    assert.equal(vm.execute(readFileSync(ADDON, "utf8"), "@journal").ok, true);
    // Inventory snapshots are the heavy entries: 5000 of them is about 3,000,000 nodes unbounded.
    const run = vm.execute(`
      for _ = 1, 5000 do JournalHandlers.OnEvent(nil, "PLAYER_MONEY") end
      ${NODES}
    `, "@drive");
    assert.equal(run.ok, true, JSON.stringify(run));
    assert.ok(vm.getGlobal("JournalNodeCount") < SAVED_VARIABLE_LIMITS.nodes,
      `journal holds ${vm.getGlobal("JournalNodeCount")} nodes`);
    assert.ok(vm.getGlobal("JournalLive") > 10, "the journal still journals");
    assert.equal(vm.getGlobal("JournalNewest"), "snapshot");
    const count = vm.execute(`assert(WowParityJournalDB.count == JournalLive, "count matches the live entries")`, "@count");
    assert.equal(count.ok, true, JSON.stringify(count));
  } finally {
    vm.close();
  }
});

test("an oversized journal restored from an earlier session is trimmed on load", {
  skip: existsSync(ADDON) ? false : "F:/CircleClean is not on this machine",
}, () => {
  const vm = new GlueLuaVm();
  try {
    assert.equal(vm.execute(STUBS, "@stubs").ok, true);
    const seeded = vm.execute(`
      WowParityJournalDB = { entries = {}, head = 2000, count = 2000 }
      for slot = 1, 2000 do
        local data = {}
        for index = 1, 40 do data[index] = index end
        WowParityJournalDB.entries[slot] = { at = { epoch = 1, clock = 1 }, kind = "old", data = data }
      end
    `, "@seed");
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    assert.equal(vm.execute(readFileSync(ADDON, "utf8"), "@journal").ok, true);
    const run = vm.execute(`
      JournalHandlers.OnEvent(nil, "ADDON_LOADED", "WowParityJournal")
      JournalHandlers.OnEvent(nil, "PLAYER_MONEY")
      ${NODES}
    `, "@drive");
    assert.equal(run.ok, true, JSON.stringify(run));
    assert.ok(vm.getGlobal("JournalNodeCount") < SAVED_VARIABLE_LIMITS.nodes);
    assert.equal(vm.getGlobal("JournalNewest"), "snapshot");
  } finally {
    vm.close();
  }
});

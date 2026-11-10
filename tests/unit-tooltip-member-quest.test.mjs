import assert from "node:assert/strict";
import test from "node:test";

// Plan item 4.04 (11.11): two tails of GameTooltip:SetUnit (Wow.exe 0x00621070): a group member out of view —
// PLAYER_OFFLINE and nothing after it, or the member's zone (0x00621b2f, 0x00621e50) — and the quest completeness
// test 0x005e0ea0 (listings .runtime/re-2026-11-11/usable/u3.lst, u4.lst): reputation, money, player kills and the
// complete bit decide whether a quest's source items still get a line.
const { frameXmlUnitQuestRows, frameXmlFarMemberTooltipFacts } = await import("../dist/code/browser/framexml/FrameXmlUnitTooltipFacts.js");
const { glueUnitRowsBeforeSkin, glueUnitRowsAfterSkin, glueUnitLevelText } = await import("../dist/code/browser/glue/GlueUnitTooltip.js");
const { formatClientTemplate } = await import("../dist/code/browser/glue/GlueWidgets.js");

const RU = {
  TOOLTIP_UNIT_LEVEL_TYPE: "Уровень %s (%s)", TOOLTIP_UNIT_LEVEL_CLASS_TYPE: "%2$s %1$s-го уровня (%3$s)",
  TOOLTIP_UNIT_LEVEL_RACE_CLASS_TYPE: "%2$s, |3-6(%3$s) %1$s-го уровня (%4$s)",
  PLAYER: "игрок", CORPSE: "Труп существа", PLAYER_OFFLINE: "Не в сети", PVP_ENABLED: "PvP", PVP_RANK_LEADER: "Лидер",
};
const host = (globals = {}) => ({
  callGlobal: (name, args) => {
    const value = globals[name];
    return typeof value === "function" ? value(...args) : value === undefined ? [] : [value];
  },
  globalString: (key) => RU[key],
  format: (template, ...values) => formatClientTemplate(template, ...values),
});

test("a member out of view: the record's level line, then PLAYER_OFFLINE and nothing else, or the zone", () => {
  const offline = frameXmlFarMemberTooltipFacts({ online: false, level: 71, health: 0, zoneName: "Даларан",
    raceName: "Ночная эльфийка", className: "Разбойница" });
  assert.deepEqual(offline.level, { level: "71", race: "Ночная эльфийка", cls: "Разбойница", typeKey: "PLAYER" },
    "offline at health 0 is no corpse (0x006217a0 asks the online bit first)");
  assert.equal(glueUnitLevelText(host(), offline.level), "Ночная эльфийка, |3-6(Разбойница) 71-го уровня (игрок)");
  assert.deepEqual(glueUnitRowsBeforeSkin(host(), offline, () => true).map((row) => row.text), ["Не в сети"],
    "PLAYER_OFFLINE, and the writer returns: no PvP line from Lua");
  assert.deepEqual(glueUnitRowsAfterSkin(host({ GetCVarBool: true }), offline), [], "no zone after it");

  const online = frameXmlFarMemberTooltipFacts({ online: true, level: 80, health: 1200, zoneName: "Даларан",
    raceName: "Человек", className: "Воин" });
  assert.deepEqual(glueUnitRowsBeforeSkin(host(), online, () => true), [], "no PvP guess for a member out of view");
  const after = glueUnitRowsAfterSkin(host({ GetCVarBool: true }), online);
  assert.deepEqual(after.map((row) => [row.text, row.color.r, row.color.g, row.color.b]), [["Даларан", 1, 1, 1]]);

  const dead = frameXmlFarMemberTooltipFacts({ online: true, level: 80, health: 0, raceName: "Человек", className: "Воин" });
  assert.deepEqual(dead.level, { level: "80", corpse: true, typeKey: "PLAYER" }, "online at 0 health: CORPSE");
  assert.equal(glueUnitLevelText(host(), dead.level), "Труп существа 80-го уровня (игрок)");
  assert.deepEqual(frameXmlFarMemberTooltipFacts({ online: true }).level, { level: "??", typeKey: "PLAYER" },
    "no level reported: ??, no race or class without the name record");
  assert.deepEqual(glueUnitRowsAfterSkin(host(), frameXmlFarMemberTooltipFacts({ online: true, level: 5 })), [],
    "no AreaTable row for the zone: no line");
});

test("threat row: its icon is UI-RaidFrame-Threat tinted by the status + 1 (0x00ad2d70)", async () => {
  const { glueUnitThreatRow } = await import("../dist/code/browser/glue/GlueUnitTooltip.js");
  const strings = { THREAT_TOOLTIP: "%d%% уровень угрозы" };
  const threat = (status) => glueUnitThreatRow({
    callGlobal: (name) => (name === "IsThreatWarningEnabled" ? [true] : [true, status, 100, 100, 5000]),
    globalString: (key) => strings[key], format: (template, ...values) => formatClientTemplate(template, ...values),
  }, "target");
  const tint = (status) => { const { r, g, b } = threat(status).icon.color; return [r, g, b].map((v) => Math.round(v * 255)); };
  assert.equal(threat(3).icon.file, "Interface\\RaidFrame\\UI-RaidFrame-Threat");
  assert.deepEqual([0, 1, 2, 3].map(tint), [[0xb0, 0xb0, 0xb0], [0xff, 0xff, 0x77], [0xff, 0x99, 0], [0xff, 0, 0]]);
  assert.deepEqual(tint(7), [0xb0, 0xb0, 0xb0], "a byte above 4 reads index 1");
  assert.equal(threat(3).text, "100% уровень угрозы");
});

test("quest completeness (0x005e0ea0): reputation, money, kills and the complete bit hide the source item", () => {
  const record = { found: true, flags: 0, classification: 0, questItems: [751] };
  const quest = (extra = {}, entry = { state: 0, counters: [0, 0, 0, 0] }, more = {}) => frameXmlUnitQuestRows(42, record, {
    rows: [{ entry, template: { title: "Клыки", objectives: [], itemObjectives: [], sourceItems: [751, 0, 0, 0], ...extra } }],
    creatureName: () => undefined, itemName: (id) => (id === 751 ? "Клык" : undefined), itemCount: () => 0, ...more,
  });
  const line = [{ title: "Клыки", lines: [{ text: "Клык" }] }];
  assert.deepEqual(quest(), line, "nothing asked at all: never done, the source item stays");
  // A minimum standing with the first faction.
  const rep = { requiredFactions: [{ faction: 72, value: 3000 }, { faction: 0, value: 0 }] };
  assert.deepEqual(quest(rep, undefined, { reputation: () => 2999 }), line, "below the minimum: not done");
  assert.deepEqual(quest(rep, undefined, { reputation: () => 3000 }), [], "at the minimum: done, no line");
  assert.deepEqual(quest(rep), [], "standing not known: that check is skipped");
  // A maximum with the second.
  const cap = { requiredFactions: [{ faction: 0, value: 0 }, { faction: 72, value: -3000 }] };
  assert.deepEqual(quest(cap, undefined, { reputation: () => 0 }), line, "above the maximum: not done");
  assert.deepEqual(quest(cap, undefined, { reputation: () => -3500 }), []);
  // Money the quest costs (a negative RewOrReqMoney).
  assert.deepEqual(quest({ rewardMoney: -500 }, undefined, { money: () => 499 }), line);
  assert.deepEqual(quest({ rewardMoney: -500 }, undefined, { money: () => 500 }), []);
  // Player kills: counter 0.
  assert.deepEqual(quest({ requiredPlayerKills: 2 }, { state: 0, counters: [1, 0, 0, 0] }), line);
  assert.deepEqual(quest({ requiredPlayerKills: 2 }, { state: 0, counters: [2, 0, 0, 0] }), []);
  // Flags 0x2/0x4 need the slot's complete bit.
  assert.deepEqual(quest({ flags: 0x4 }, { state: 0, counters: [0, 0, 0, 0] }), line);
  assert.deepEqual(quest({ flags: 0x4 }, { state: 1, counters: [0, 0, 0, 0] }), []);
  assert.deepEqual(quest({ flags: 0x4 }, { state: 3, counters: [0, 0, 0, 0] }), line, "failed");
});

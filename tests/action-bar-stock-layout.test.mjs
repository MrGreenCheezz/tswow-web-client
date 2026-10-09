// L7 4.16b + 3.32: the native extra rows on stock's multi-bar pages, the one-time copy of what
// players had placed on the old pages 7-10, and the server's toggles byte both interfaces read.
//
// Stock: MultiBarBottomLeft/BottomRight/Right/Left show pages 6, 5, 3, 4 (MultiActionBars.xml:41,
// 159, 277, 395; ActionButton.lua:6-9). The core takes CMSG_SET_ACTION_BUTTON as u8 slot + u32
// packed (action | type << 24, MiscHandler.cpp:983-994) and keeps the toggles byte as sent
// (MiscHandler.cpp:1018-1031); Wow.exe's GetActionBarToggles reads its low four bits (0x5a8790).
import assert from "node:assert/strict";
import test from "node:test";

const protocol = await import("../dist/code/world/ActionBarProtocol.js");
const layout = await import("../dist/code/browser/ui/ActionBarStockLayout.js");
const { ActionBarAccountSync } = await import("../dist/code/browser/ui/ActionBarAccountSync.js");
const { ACTION_BUTTON_ITEM, ACTION_BUTTON_MACRO, ACTION_BUTTON_SPELL } = protocol;

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const allShown = () => true;
const only = (...bars) => (bar) => bars.includes(bar);
// L7-review: a class with no stance, form or stealth bar (mage), so every old page is the native rows' own.
const MAGE = 8;

test("the native rows stand on the stock multi-bar pages, and keep their old pages only as history", () => {
  assert.deepEqual(protocol.EXTRA_ACTION_BARS.map((bar) => [bar.id, bar.base, bar.stockBase, bar.legacyBase]), [
    ["bottomLeft", 60, 60, 72], ["bottomRight", 48, 48, 84], ["right", 24, 24, 96], ["right2", 36, 36, 108],
  ]);
  // 1-based stock pages: bottom left 6, bottom right 5, right 3, left 4.
  assert.deepEqual(protocol.EXTRA_ACTION_BARS.map((bar) => protocol.actionPage(bar.base) + 1), [6, 5, 3, 4]);
});

test("the move copies a shown row's old buttons into its empty stock slots, column for column", () => {
  const buttons = [
    { slot: 72, action: 133, type: ACTION_BUTTON_SPELL },
    { slot: 83, action: 7, type: ACTION_BUTTON_MACRO },
    { slot: 85, action: 6948, type: ACTION_BUTTON_ITEM },
    { slot: 96, action: 116, type: ACTION_BUTTON_SPELL },
    { slot: 119, action: 10, type: ACTION_BUTTON_MACRO },
  ];
  assert.deepEqual(layout.planStockLayoutMigration(buttons, allShown, MAGE), [
    { slot: 60, action: 133, type: ACTION_BUTTON_SPELL, from: 72 },
    { slot: 71, action: 7, type: ACTION_BUTTON_MACRO, from: 83 },
    { slot: 49, action: 6948, type: ACTION_BUTTON_ITEM, from: 85 },
    { slot: 24, action: 116, type: ACTION_BUTTON_SPELL, from: 96 },
    { slot: 47, action: 10, type: ACTION_BUTTON_MACRO, from: 119 },
  ]);
  // The bytes each write sends: u8 slot, then the packed word little-endian.
  assert.equal(hex(protocol.buildSetActionButton(60, 133, ACTION_BUTTON_SPELL)), "3c85000000");
  assert.equal(hex(protocol.buildSetActionButton(71, 7, ACTION_BUTTON_MACRO)), "4707000040");
  assert.equal(hex(protocol.buildSetActionButton(49, 6948, ACTION_BUTTON_ITEM)), "31241b0080");
});

test("never over a stock slot already in use, never from a hidden row, never onto the old page", () => {
  const buttons = [
    { slot: 72, action: 133, type: ACTION_BUTTON_SPELL },
    { slot: 73, action: 116, type: ACTION_BUTTON_SPELL },
    // Put there by the stock UI (or Wow.exe, or main page 6): stays.
    { slot: 60, action: 9999, type: ACTION_BUTTON_SPELL },
    // A hidden row's old page is a stance bar or nothing the player placed through this client.
    { slot: 84, action: 2457, type: ACTION_BUTTON_SPELL },
  ];
  const writes = layout.planStockLayoutMigration(buttons, only("bottomLeft"), MAGE);
  assert.deepEqual(writes.map((write) => [write.slot, write.action]), [[61, 116]]);
  assert.equal(writes.some((write) => write.slot >= 72), false, "the old pages are not touched");
  assert.deepEqual(layout.planStockLayoutMigration(buttons, () => false, MAGE), []);
  // Run again over the result: nothing left to do.
  const after = [...buttons, ...writes];
  assert.deepEqual(layout.planStockLayoutMigration(after, allShown, MAGE), [
    { slot: 48, action: 2457, type: ACTION_BUTTON_SPELL, from: 84 },
  ], "only a row that was not considered before");
  assert.deepEqual(layout.planStockLayoutMigration(after, only("bottomLeft"), MAGE), []);
});

test("the record names its character, and the slot kinds", () => {
  const record = layout.encodeLayoutRecord(4242, 0b01);
  assert.equal(layout.decodeLayoutRecord(record, 4242), 1);
  assert.equal(layout.decodeLayoutRecord(record, 4243), 0, "another character's mirror value");
  assert.equal(layout.decodeLayoutRecord(0, 4242), 0);
  assert.equal(layout.talentGroupBit(1), 2);
  assert.equal(layout.talentGroupBit(undefined), 1);
  assert.equal(layout.classifyConfigSlot(undefined, () => true), "empty");
  assert.equal(layout.classifyConfigSlot("{}", () => true), "own");
  assert.equal(layout.classifyConfigSlot("SET foo \"1\"", () => false), "foreign");
});

test("the paging keys skip a page a shown extra row shows, as ActionBar_PageUp/PageDown do", () => {
  const viewable = (page0) => layout.mainPageViewable(page0, only("bottomLeft", "right"));
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(viewable), [true, true, false, true, true, false]);
  assert.equal(layout.stockPageStep(1, 1, viewable), 3, "page 2 up: page 3 is MultiBarRight's");
  assert.equal(layout.stockPageStep(4, 1, viewable), 0, "page 5 up: page 6 is taken, back to 1");
  assert.equal(layout.stockPageStep(0, -1, viewable), 4, "page 1 down: the highest viewable");
  assert.equal(layout.stockPageStep(3, -1, viewable), 1);
  assert.equal(layout.stockPageStep(5, 1, () => true), 0);
  assert.equal(layout.stockPageStep(0, -1, () => true), 5);
});

/** A world that keeps its bars as WorldClient does, and records the packets it was asked to send. */
function harness({
  buttons = [], server = 0, settings = 0, slot = { kind: "empty", record: 0 }, local = 0, group = 0, native = true,
  cls = MAGE, // L7-review: the player's class (UNIT_FIELD_BYTES_0 byte 1); null = not known yet
} = {}) {
  const sent = [];
  const toggles = [];
  const settingsWrites = [];
  const localWrites = [];
  const migrated = [];
  const state = { server, settings, group, native, local, slot, cls, redraws: 0 };
  const world = {
    actionButtons: buttons.slice(),
    setActionButton(slot, action, type) {
      sent.push(hex(protocol.buildSetActionButton(slot, action, type)));
      const kept = this.actionButtons.filter((button) => button.slot !== slot);
      if (action !== 0) kept.push({ slot, action, type });
      this.actionButtons = kept.sort((left, right) => left.slot - right.slot);
      sync.buttonsChanged(); // WorldClient raises ACTION_BUTTONS_CHANGED for its own writes too
    },
    setActionBarToggles(bits) {
      toggles.push(hex(protocol.buildSetActionBarToggles(bits)));
    },
  };
  const sync = new ActionBarAccountSync({
    world,
    serverBits: () => state.server,
    talentGroup: () => state.group,
    playerClass: () => state.cls ?? undefined, // L7-review
    nativeHud: () => state.native,
    settingsBits: () => state.settings,
    configSlot: () => state.slot,
    writeSettings: (bits, record) => {
      settingsWrites.push([bits, record]);
      if (bits !== undefined) state.settings = bits;
      sync.settingsApplied(); // applySettings runs the listeners
    },
    localRecord: () => state.local,
    writeLocalRecord: (record) => { localWrites.push(record); state.local = record; },
    onMigrated: (count) => migrated.push(count),
    redraw: () => { state.redraws += 1; },
  });
  /** The player flips row settings in a settings window. */
  const setSettings = (bits) => {
    state.settings = bits;
    sync.settingsApplied();
  };
  return { sync, world, state, sent, toggles, settingsWrites, localWrites, migrated, setSettings };
}

const OLD_BOTTOM_LEFT = [
  { slot: 72, action: 133, type: ACTION_BUTTON_SPELL },
  { slot: 73, action: 7, type: ACTION_BUTTON_MACRO },
];

test("nothing moves before the settings slot has answered and the player's toggles byte is known", () => {
  const h = harness({ buttons: OLD_BOTTOM_LEFT, settings: 0x01 });
  h.state.server = undefined; // the player's fields have not arrived
  h.sync.buttonsChanged();
  h.sync.settingsApplied();
  assert.deepEqual([h.sent, h.toggles, h.settingsWrites, h.localWrites], [[], [], [], []]);
  h.sync.configAnswered();
  assert.deepEqual(h.sent, [], "the byte is still unknown");
  assert.equal(h.sync.visibleBits(), undefined, "the settings still draw the rows");
  h.state.server = 0;
  h.sync.buttonsChanged();
  assert.deepEqual(h.sent, ["3c85000000", "3d07000040"]);
});

test("the first run copies once, records the group, and gives the byte the rows the native HUD had on", () => {
  // L7-review: the transition trusts only this client's own settings in the character's slot.
  const h = harness({ buttons: OLD_BOTTOM_LEFT, server: 0, settings: 0x01, slot: { kind: "own", record: 0 } });
  h.sync.configAnswered();
  assert.deepEqual(h.sent, ["3c85000000", "3d07000040"], "slots 60 and 61, same action and type");
  assert.deepEqual(h.migrated, [2]);
  assert.deepEqual(h.localWrites, [1]);
  assert.deepEqual(h.settingsWrites, [[undefined, 1]], "the record, the rows' settings untouched");
  assert.deepEqual(h.toggles, ["01"], "3.32 transition: a zero byte under a row the player had on");
  assert.equal(h.sync.visibleBits(), 0x01);
  assert.ok(h.state.redraws >= 1);
  // The writes come back as ACTION_BUTTONS_CHANGED; nothing runs twice.
  h.sync.buttonsChanged();
  h.sync.configAnswered();
  assert.equal(h.sent.length, 2);
  // The old page is left as it was.
  assert.deepEqual(h.world.actionButtons.filter((button) => button.slot >= 72).map((button) => button.slot), [72, 73]);
});

test("a recorded character is not moved again, from the server's record or this browser's", () => {
  for (const recorded of [{ slot: { kind: "own", record: 1 } }, { local: 1 }]) {
    const h = harness({ buttons: OLD_BOTTOM_LEFT, server: 0x01, settings: 0x01, ...recorded });
    h.sync.configAnswered();
    assert.deepEqual([h.sent, h.toggles, h.settingsWrites], [[], [], []], JSON.stringify(recorded));
  }
});

test("a byte set elsewhere wins over the settings, which follow it unless the slot is another client's", () => {
  const h = harness({ server: 0x04, settings: 0x01, slot: { kind: "own", record: 1 } });
  h.sync.configAnswered();
  assert.deepEqual(h.toggles, [], "the byte is not overwritten");
  assert.deepEqual(h.settingsWrites, [[0x04, 1]]);
  assert.equal(h.state.settings, 0x04);
  assert.equal(h.sync.visibleBits(), 0x04);

  const foreign = harness({ buttons: OLD_BOTTOM_LEFT, server: 0x04, settings: 0x01, slot: { kind: "foreign", record: 0 } });
  foreign.sync.configAnswered();
  assert.deepEqual(foreign.settingsWrites, [], "Wow.exe's config cache is never overwritten");
  assert.deepEqual(foreign.localWrites, [1], "the browser keeps the record instead");
  assert.deepEqual(foreign.sent, ["3c85000000", "3d07000040"]);
  assert.deepEqual(foreign.toggles, [], "the byte was not zero: it stays");
  assert.equal(foreign.sync.visibleBits(), 0x04, "the rows follow the byte, not the stale settings");
});

test("a settings change sends only the rows that changed, on top of what was last sent", () => {
  const h = harness({ server: 0x04, settings: 0x04, slot: { kind: "own", record: 1 } });
  h.sync.configAnswered();
  h.setSettings(0x05);
  assert.deepEqual(h.toggles, ["05"]);
  assert.equal(h.sync.visibleBits(), 0x05, "the row shows before the server's echo");
  h.setSettings(0x07);
  assert.deepEqual(h.toggles, ["05", "07"], "the second change builds on the first, not on the stale byte");
  h.setSettings(0x07);
  assert.equal(h.toggles.length, 2, "an unrelated setting sends nothing");
  // A settings slot that disagrees with the byte (another client's): only the moved row changes.
  const f = harness({ server: 0x08, settings: 0x01, slot: { kind: "foreign", record: 0 }, local: 1 });
  f.sync.configAnswered();
  f.setSettings(0x03);
  assert.deepEqual(f.toggles, ["0a"], "bottom right on, right two kept, bottom left not forced");
});

test("under the stock interface nothing is moved or sent; the stock options own the byte", () => {
  const h = harness({ buttons: OLD_BOTTOM_LEFT, server: 0, settings: 0x01, native: false });
  h.sync.configAnswered();
  h.setSettings(0x03);
  assert.deepEqual([h.sent, h.toggles, h.settingsWrites, h.localWrites], [[], [], [], []]);
  assert.equal(h.sync.visibleBits(), undefined);
  // The player switches to the native HUD mid-session: it runs then.
  h.state.native = true;
  h.sync.settingsApplied();
  assert.deepEqual(h.sent, ["3c85000000", "3d07000040"]);
});

test("L7-review: a switch to the stock interface mid-session leaves the byte to it, and back again starts from the byte", () => {
  const h = harness({ server: 0x04, settings: 0x04, slot: { kind: "own", record: 1 } });
  h.sync.configAnswered();
  h.setSettings(0x05);
  assert.deepEqual(h.toggles, ["05"]);
  // The stock options take over: their SetActionBarToggles writes the row settings and sends the
  // byte itself (FrameXmlOptions.ts); the native side sends nothing on top.
  h.state.native = false;
  h.state.server = 0x05; // the echo of the native send
  h.setSettings(0x03); // the settings move before the stock send's echo lands
  assert.deepEqual(h.toggles, ["05"], "silent under the stock interface");
  h.state.server = 0x03;
  assert.equal(h.sync.visibleBits(), undefined);
  // Back to the native HUD: nothing moved in the settings, nothing is sent; the rows are the byte's.
  h.state.native = true;
  h.sync.settingsApplied();
  assert.deepEqual(h.toggles, ["05"]);
  assert.equal(h.sync.visibleBits(), 0x03, "the byte the stock interface left, not the last native send");
});

test("a talent group swap moves the new group's bars once they arrive, not the empty gap before", () => {
  const h = harness({ buttons: OLD_BOTTOM_LEFT, server: 0x01, settings: 0x01, slot: { kind: "own", record: 0 } });
  h.sync.configAnswered();
  assert.equal(h.sent.length, 2);
  // SendActionButtons(2): the bars are cleared, then SMSG_TALENTS_INFO names group 2.
  h.world.actionButtons = [];
  h.sync.buttonsChanged();
  h.state.group = 1;
  h.sync.buttonsChanged();
  assert.equal(h.sent.length, 2, "the empty gap is not the new group's bars");
  h.world.actionButtons = [{ slot: 74, action: 116, type: ACTION_BUTTON_SPELL }];
  h.sync.buttonsChanged();
  assert.deepEqual(h.sent.slice(2), ["3e74000000"], "slot 62 of the second group");
  assert.deepEqual(h.settingsWrites.at(-1), [undefined, 0b11]);
  h.sync.buttonsChanged();
  assert.equal(h.sent.length, 3);
});

test("the stock interface sees the moved buttons on the same slots the native rows show", async () => {
  const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
  const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
  const h = harness({ buttons: OLD_BOTTOM_LEFT, server: 0, settings: 0x01 });
  h.sync.configAnswered();
  const world = Object.assign(h.world, {
    state: { selfGuid: 1n, objects: new Map([[1n, { guid: 1n, typeId: 4, fields: new Map() }]]) },
    casts: new Map(), cooldownSnapshots: new Map(), itemCooldowns: new Map(), mirrorTimers: new Map(),
    itemTemplates: new Map(), knownSpells: [{ id: 133 }],
    cooldownRemaining: () => 0, cooldownState: () => undefined, isActiveMountSpell: () => false,
    events: { on: () => () => {} },
  });
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined,
    spell: (id) => id === 133 ? { id, name: "Огненный шар", rank: "", iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt" } : undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  // MultiBarBottomLeft's first button is action 61 (page 6); the native bottom-left row's first is slot 60.
  assert.deepEqual(call("HasAction", 61), [true]);
  assert.deepEqual(call("GetActionTexture", 61), call("GetActionTexture", 73));
  assert.deepEqual(call("GetActionTexture", 61), ["Interface\\Icons\\Spell_Fire_FlameBolt"]);
  assert.deepEqual(call("HasAction", 62), [true], "the macro too");
  assert.deepEqual(call("HasAction", 73), [true], "the old slot still holds its button");
});

// L7-review 4.16b: which old rows may move, per class. SpellShapeshiftForm.dbc BonusActionBar (dataset):
// battle 1, defensive 2, berserker 3; stealth 1, shadow dance 2; shadowform 1; cat 1, tree of life 2,
// bear and dire bear 3, moonkin 4; every other form 0. Bonus bar n is 0-based page 5 + n
// (ActionButton.lua:131-153), the old row at 72 + 12 (n - 1). The old native rows drew those pages, so
// what is there may be a stance, form or stealth bar the stock UI or Wow.exe filled — the owner plays
// with the stock UI, whose row settings follow the toggles byte — and it never moves onto the multi-bars.
const MOVABLE_OLD_ROWS = new Map([
  [1, [108]], // warrior: battle 72, defensive 84, berserker 96
  [2, [72, 84, 96, 108]], [3, [72, 84, 96, 108]],
  [4, [96, 108]], // rogue: stealth 72, shadow dance 84
  [5, [84, 96, 108]], // priest: shadowform 72
  [6, [72, 84, 96, 108]], [7, [72, 84, 96, 108]], [8, [72, 84, 96, 108]], [9, [72, 84, 96, 108]],
  [11, []], // druid: cat 72, tree of life 84, bear 96, moonkin 108
  // A class outside the stock ten (TSWoW's own, such as the cross-class HERO) may learn any form.
  [10, []], [12, []], [13, []], [undefined, []],
]);

test("per class: the move never clears or overwrites a slot and never copies a stance, form or stealth page", () => {
  // Every old slot holds a button; every even stock slot is already in use.
  const full = [];
  for (let slot = 24; slot < 72; slot += 2) full.push({ slot, action: 5000 + slot, type: ACTION_BUTTON_MACRO });
  for (let slot = 72; slot < 120; slot++) full.push({ slot, action: 1000 + slot, type: ACTION_BUTTON_SPELL });
  const before = new Map(full.map((button) => [button.slot, button]));
  for (const [cls, rows] of MOVABLE_OLD_ROWS) {
    const writes = layout.planStockLayoutMigration(full, allShown, cls);
    for (const write of writes) {
      assert.notEqual(write.action, 0, `class ${cls}: never a clearing write`);
      assert.equal(before.has(write.slot), false, `class ${cls}: slot ${write.slot} was in use`);
      assert.ok(write.slot >= 24 && write.slot < 72, `class ${cls}: only the stock multi-bar pages`);
      const bar = protocol.EXTRA_ACTION_BARS.find((entry) => write.from >= entry.legacyBase && write.from < entry.legacyBase + 12);
      assert.equal(write.slot - bar.stockBase, write.from - bar.legacyBase, `class ${cls}: column for column`);
      assert.deepEqual([write.action, write.type], [before.get(write.from).action, before.get(write.from).type]);
    }
    const fromRows = [...new Set(writes.map((write) => write.from - (write.from % 12)))].sort((a, b) => a - b);
    assert.deepEqual(fromRows, rows, `class ${cls}: the old rows that move`);
    assert.equal(writes.length, rows.length * 6, `class ${cls}: the six empty columns of each moved row`);

    // The same through the account sync over a world that keeps its bars as WorldClient does.
    const h = harness({ buttons: full, server: 0x0f, settings: 0x0f, slot: { kind: "own", record: 0 }, cls: cls ?? null });
    h.sync.configAnswered();
    const after = new Map(h.world.actionButtons.map((button) => [button.slot, button]));
    for (const button of full) assert.deepEqual(after.get(button.slot), button, `class ${cls}: slot ${button.slot} kept`);
    assert.equal(h.sent.length, rows.length * 6, `class ${cls}: packets`);
    assert.equal(h.sent.some((packet) => packet.slice(2) === "00000000"), false, `class ${cls}: no clearing packet`);
    assert.deepEqual(h.toggles, [], `class ${cls}: a byte already set is never resent`);
    assert.deepEqual(h.localWrites, cls === undefined ? [] : [1], `class ${cls}: recorded once (an unknown class waits)`);
  }
});

test("an unknown class waits for the player's fields instead of recording a move that copied nothing", () => {
  const h = harness({ buttons: [{ slot: 108, action: 133, type: ACTION_BUTTON_SPELL }], server: 0x08, settings: 0x08, cls: null });
  h.sync.configAnswered();
  assert.deepEqual([h.sent, h.localWrites], [[], []]);
  h.state.cls = MAGE;
  h.sync.buttonsChanged();
  assert.deepEqual(h.sent, ["2485000000"], "slot 36, once the class is known");
  assert.deepEqual(h.localWrites, [1]);
});

test("the 3.32 transition trusts only this client's own settings in the character's slot", () => {
  // An empty slot (a fresh character, Wow.exe without config sync) or Wow.exe's config cache: the row
  // settings are this browser's, possibly another character's, and the zero byte may be the player's.
  for (const kind of ["empty", "foreign"]) {
    const h = harness({ buttons: OLD_BOTTOM_LEFT, server: 0, settings: 0x01, slot: { kind, record: 0 } });
    h.sync.configAnswered();
    assert.deepEqual(h.toggles, [], `${kind}: the byte stays`);
    assert.equal(h.sync.visibleBits(), 0, `${kind}: the rows follow the byte`);
  }
  const empty = harness({ server: 0, settings: 0x01 });
  empty.sync.configAnswered();
  assert.deepEqual(empty.settingsWrites, [[0, 1]], "an empty slot takes the byte's rows with the record");
  const own = harness({ server: 0, settings: 0x01, slot: { kind: "own", record: 0 } });
  own.sync.configAnswered();
  assert.deepEqual(own.toggles, ["01"], "this client's own settings for the character: the native rows were on");
});

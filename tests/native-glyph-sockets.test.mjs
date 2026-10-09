import assert from "node:assert/strict";
import test from "node:test";
import { isolatedUi } from "./fixtures/isolated-ui.mjs";

// L7 1.28: the native talent window's glyph sockets. Removal asks first, as stock CONFIRM_REMOVE_GLYPH
// does (Blizzard_GlyphUI.lua:243-252) — CMSG_REMOVE_GLYPH destroys the glyph. An empty socket offers the
// bag's glyph items that GlyphMatchesSocket would accept (open socket, GlyphProperties.GlyphSlotFlags ==
// GlyphSlot.Type — Spell::EffectApplyGlyph, not inscribed already — Spell::CheckCast UNIQUE_GLYPH) and
// sends the chosen item's CMSG_USE_ITEM with that socket in its glyph field (PlaceGlyphInSocket).
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const progress = await import("../dist/code/world/CharacterProgressProtocol.js");
const fields = await import("../dist/code/world/Fields.js");
const format = await import("../dist/code/browser/ui/Format.js");
const talentTree = await import("../dist/code/browser/ui/TalentTree.js");
const sockets = await import("../dist/code/browser/ui/GlyphSockets.js");
const { frameXmlGlyphCatalog } = await import("../dist/code/browser/framexml/FrameXmlGlyph.js");

const SELF = 0x42n;
const MAJOR_SLOT = 21;
const MINOR_SLOT = 22;
const catalog = frameXmlGlyphCatalog({
  version: 1,
  glyphs: [
    { id: 301, spellId: 56368, slotFlags: 0, icon: "" },
    { id: 302, spellId: 57924, slotFlags: 1, icon: "" },
    { id: 303, spellId: 56382, slotFlags: 0, icon: "" },
  ],
  slots: [{ id: MAJOR_SLOT, type: 0, order: 0 }, { id: MINOR_SLOT, type: 1, order: 1 }],
  itemSpells: [[64301, 301], [64302, 302], [64303, 303]],
}, 1);

/** Bag items: three glyphs (major, minor, major), a second copy of the first, and a potion. */
const BAG = [
  { guid: 0x4000_0001n, bag: 255, slot: 23, entry: 42734, name: "Символ огненного шара", spell: 64301 },
  { guid: 0x4000_0002n, bag: 255, slot: 24, entry: 43339, name: "Символ медленного падения", spell: 64302 },
  { guid: 0x4000_0003n, bag: 19, slot: 0, entry: 42739, name: "Символ ледяной стрелы", spell: 64303 },
  { guid: 0x4000_0004n, bag: 19, slot: 1, entry: 42734, name: "Символ огненного шара", spell: 64301 },
  { guid: 0x4000_0005n, bag: 19, slot: 2, entry: 118, name: "Зелье", spell: 2330 },
];

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

class Element {
  children = []; listeners = {}; attributes = new Map(); style = {}; dataset = {};
  disabled = false; textContent = ""; className = ""; title = "";
  classList = { toggle() {}, add() {}, remove() {} };
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  remove() {}
  click() { this.listeners.click?.({ stopPropagation() {} }); }
}

/** The native talent window of a mage with sockets 1 and 2 open (one major, one minor). */
async function glyphWindow({ inscribed = [0, 0, 0, 0, 0, 0], mask = 0b000011 } = {}) {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  const world = new WorldClient(connection);
  world.state.selfGuid = SELF;
  await world.loginCharacter(SELF);
  await settle();
  world.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  world.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 8 << 8);
  world.state.setField(SELF, UPDATE_FIELDS.PLAYER_GLYPHS_ENABLED.offset, mask);
  [MAJOR_SLOT, MINOR_SLOT, MAJOR_SLOT, MINOR_SLOT, MINOR_SLOT, MAJOR_SLOT].forEach((slotId, index) =>
    world.state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_GLYPH_SLOTS_1.offset + index, slotId));
  world.talents = { pet: false, unspentPoints: 0, activeSpec: 0, specs: [{ talents: [], glyphs: inscribed }] };
  for (const item of BAG) {
    world.itemTemplates.set(item.entry, { found: true, entry: item.entry, name: item.name, spells: [{ spellId: item.spell, trigger: 0 }] });
  }
  connection.sent.length = 0;
  const held = (item) => ({ guid: item.guid, bag: item.bag, slot: item.slot,
    item: { guid: item.guid, typeId: 1, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, item.entry]]) } });

  const original = globalThis.document;
  globalThis.document = { createElement: () => new Element(), createTextNode: (textContent) => ({ textContent }) };
  const panels = [];
  const confirms = [];
  const menus = [];
  const statuses = [];
  world.onSpellStatus = (message, error) => statuses.push([message, error]);
  class Panel {
    body = new Element(); visible = false;
    constructor() { panels.push(this); }
    toggle() { this.visible = !this.visible; }
    hide() { this.visible = false; }
  }
  const game = {
    world,
    spells: new Map([[56368, { name: "Символ огненного шара" }]]),
    talentData: {
      ready: true, tabsForClass: () => [{ id: 41, name: "Огонь", iconId: 0, orderIndex: 0 }], petTabs: () => [],
      petTalentMask: () => 0, talentsIn: () => [], glyph: (id) => catalog.glyph(id),
    },
  };
  const ui = await isolatedUi("Talents", {
    "../game/Context.js": { game },
    "../../world/CharacterProgressProtocol.js": progress,
    "../../world/Fields.js": fields,
    "../../generated/updateFields.js": { UPDATE_FIELDS },
    "./Format.js": format,
    "./TalentTree.js": talentTree,
    "../Inventory.js": { playerInventory: () => ({ backpack: BAG.slice(0, 2).map(held), bags: [{ slots: BAG.slice(2).map(held) }] }) },
    "../game/GroundTarget.js": { itemUseSpellId: (template) => template?.spells?.find((spell) => spell.trigger === 0)?.spellId },
    "./GlyphSockets.js": { ...sockets, loadNativeGlyphCatalog: async () => catalog },
    "./Strings.js": { nativeString: (_key, fallback, ...args) => fallback.replace("%s", String(args[0])) },
    "./Widgets.js": {
      Panel,
      attachTooltip: () => {},
      confirmPanel: (anchor, options) => { confirms.push(options); },
      showMenu: (anchor, title, items) => { menus.push({ title, items }); },
    },
  });
  ui.toggleTalentsWindow();
  /** The six socket buttons: the glyph row is the panel body's fourth child. */
  const socket = (index) => panels[0].body.children[3].children[index];
  const packets = (opcode) => connection.sent.filter((packet) => packet.opcode === opcode).map((packet) => [...packet.payload]);
  return {
    socket, confirms, menus, statuses, packets,
    dispose: () => { globalThis.document = original; world.close(); },
  };
}

const useItem = (bag, slot, castCount, guid, glyphIndex) =>
  [...new PacketWriter().u8(bag).u8(slot).u8(castCount).u32(0).u64(guid).u32(glyphIndex).u8(0).u32(0).toUint8Array()];

test("an empty socket offers the fitting glyph items and inscribes the chosen one into that socket", async () => {
  const window = await glyphWindow();
  try {
    window.socket(0).click();
    await settle();
    assert.equal(window.menus.length, 1);
    assert.deepEqual(window.menus[0].items.map((item) => item.label), ["Символ огненного шара", "Символ ледяной стрелы"],
      "the two major glyphs, one row per glyph; the minor glyph and the potion are not offered");
    window.menus[0].items[1].run();
    assert.deepEqual(window.packets(OPCODES.CMSG_USE_ITEM), [useItem(19, 0, 1, 0x4000_0003n, 0)],
      "the chosen item, with socket 0 in the glyph field");
    window.socket(1).click();
    await settle();
    assert.deepEqual(window.menus[1].items.map((item) => item.label), ["Символ медленного падения"], "the minor socket");
    window.menus[1].items[0].run();
    assert.deepEqual(window.packets(OPCODES.CMSG_USE_ITEM).at(-1), useItem(255, 24, 2, 0x4000_0002n, 1));
  } finally {
    window.dispose();
  }
});

test("a locked socket, an inscribed glyph and an empty bag offer nothing and say why", async () => {
  const window = await glyphWindow({ inscribed: [0, 0, 0, 0, 0, 303] });
  try {
    window.socket(2).click();
    await settle();
    assert.deepEqual(window.menus, [], "socket 3 is not open (PLAYER_GLYPHS_ENABLED)");
    assert.deepEqual(window.statuses.at(-1), ["Эта ячейка символа ещё закрыта", true]);
    window.socket(0).click();
    await settle();
    assert.deepEqual(window.menus[0].items.map((item) => item.label), ["Символ огненного шара"],
      "the ice glyph is in socket 6 already: the realm would answer UNIQUE_GLYPH");
    assert.deepEqual(window.packets(OPCODES.CMSG_USE_ITEM), [], "nothing is used before a choice");
  } finally {
    window.dispose();
  }
});

test("a filled socket asks before CMSG_REMOVE_GLYPH, which destroys the glyph", async () => {
  const window = await glyphWindow({ inscribed: [301, 0, 0, 0, 0, 0] });
  try {
    window.socket(0).click();
    assert.deepEqual(window.packets(OPCODES.CMSG_REMOVE_GLYPH), [], "asking is not removing");
    assert.equal(window.confirms.length, 1);
    assert.match(window.confirms[0].lines.join(" "), /Символ огненного шара/);
    assert.equal(window.confirms[0].danger, true);
    window.confirms[0].onConfirm();
    assert.deepEqual(window.packets(OPCODES.CMSG_REMOVE_GLYPH), [[0, 0, 0, 0]], "socket 0, u32");
  } finally {
    window.dispose();
  }
});

test("the socket rule alone", () => {
  const items = BAG.map((item) => ({ guid: item.guid, bag: item.bag, slot: item.slot, useSpellId: item.spell }));
  const ids = (choices) => choices.map((choice) => choice.glyphId);
  assert.deepEqual(ids(sockets.glyphChoicesForSocket(catalog, items, { enabled: true, slotId: MAJOR_SLOT }, [])), [301, 303]);
  assert.deepEqual(ids(sockets.glyphChoicesForSocket(catalog, items, { enabled: true, slotId: MINOR_SLOT }, [])), [302]);
  assert.deepEqual(ids(sockets.glyphChoicesForSocket(catalog, items, { enabled: false, slotId: MAJOR_SLOT }, [])), []);
  assert.deepEqual(ids(sockets.glyphChoicesForSocket(catalog, items, { enabled: true, slotId: 99 }, [])), [], "unknown slot row");
  assert.deepEqual(ids(sockets.glyphChoicesForSocket(undefined, items, { enabled: true, slotId: MAJOR_SLOT }, [])), []);
  assert.deepEqual(ids(sockets.glyphChoicesForSocket(catalog, items, { enabled: true, slotId: MAJOR_SLOT }, [301])), [303]);
  assert.equal(sockets.glyphChoicesForSocket(catalog, items, { enabled: true, slotId: MAJOR_SLOT }, [])[0].item.guid,
    0x4000_0001n, "the first copy in bag order");
});

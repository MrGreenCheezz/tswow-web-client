import assert from "node:assert/strict";
import test, { after } from "node:test";
import { isolatedUi } from "./fixtures/isolated-ui.mjs";

// 4.03 review: the native pet bar's drop handler (ui/PetBar.ts) acts only on its own two drag
// formats. A drop from anywhere else — a file, a link, text from another window, a player-bar spell —
// carries neither, and `getData` then answers "" for both: `Number("")` is 0, which used to read as
// "the slot-0 button was dragged here" and swapped slot 0 with the target (CMSG_PET_SET_ACTION).

const petProtocol = await import("../dist/code/world/PetProtocol.js");
const { ACT_COMMAND, ACT_ENABLED, ACT_REACTION, packPetAction } = petProtocol;

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); }
  children = []; listeners = {}; dataset = {}; hidden = false; className = ""; id = ""; draggable = false;
  style = { setProperty() {} };
  classList = { add() {}, remove() {}, toggle() {} };
  get isConnected() { return true; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); }
  fire(name, event) { for (const listener of this.listeners[name] ?? []) listener({ preventDefault() {}, ...event }); }
}

const realDocument = globalThis.document;
const byId = new Map();
globalThis.document = {
  createElement: (tag) => new Element(tag),
  getElementById: (id) => { if (!byId.has(id)) byId.set(id, new Element("div")); return byId.get(id); },
  documentElement: new Element("html"),
};
after(() => { globalThis.document = realDocument; });

class IconButton {
  constructor(options) { this.root = new Element("button"); this.options = options; }
  setContent() {} setCooldown() {} setUsable() {}
}

const placed = [];
const game = { world: undefined, spells: new Map(), gatewayOrigin: undefined };
const bar = await isolatedUi("PetBar", {
  "../../world/PetProtocol.js": petProtocol,
  "../../world/VehicleProtocol.js": { vehiclePassengers: () => [] },
  "../game/Context.js": { game },
  "./Widgets.js": { IconButton, attachTooltip() {}, confirmPanel() {} },
  "./IconImage.js": { spellIconUrl: () => undefined },
  "./DragGhost.js": { beginIconDrag() {} },
  "./PetSpellbook.js": {
    PET_SPELL_DRAG_FORMAT: "text/pet-spell",
    nativePetBook: () => ({ placeSpell: (index, spellId) => placed.push([index, spellId]) }),
  },
  "../GameWindows.js": { notifyHudLayout() {} },
});

const SELF = 1n;
const PET = 0xf140_0000_0000_0042n;
const swaps = [];
game.world = {
  state: { selfGuid: SELF, objects: new Map([[SELF, { guid: SELF, typeId: 4, fields: new Map() }]]), revision: 1 },
  vehicleKits: new Map(), controlledGuid: undefined,
  petSpells: {
    guid: PET, closed: false, reactState: 1, commandState: 1, spells: [],
    bar: Array.from({ length: 10 }, (_, slot) => ({
      slot,
      packed: slot < 3 ? packPetAction(2 - slot, ACT_COMMAND) : slot >= 7 ? packPetAction(9 - slot, ACT_REACTION)
        : packPetAction(17253 + slot, ACT_ENABLED),
    })),
  },
  swapPetActionSlots: (from, to) => swaps.push([from, to]),
};
bar.showPetBar();
const buttons = byId.get("bottom-hud-center").children[0].children[0].children;

/** A drop whose DataTransfer carries exactly `data`; any other format reads "", as in a browser. */
const drop = (slot, data) => buttons[slot].fire("drop", { dataTransfer: {
  getData: (format) => data[format] ?? "", types: Object.keys(data),
} });

test("a foreign drop — file, link, text, a player-bar payload — never swaps slot 0", () => {
  drop(4, {});
  drop(4, { "text/plain": "hello" });
  drop(4, { "text/uri-list": "https://example.test/" });
  drop(4, { "text/plain": "{\"action\":133,\"type\":0}" });
  drop(5, { "text/pet-slot": "" });
  drop(5, { "text/pet-slot": " " });
  drop(5, { "text/pet-slot": "1.5" });
  drop(5, { "text/pet-slot": "-1" });
  drop(5, { "text/pet-slot": "12" });
  assert.deepEqual(swaps, []);
  assert.deepEqual(placed, []);
});

test("the bar's own formats still work: a slot drag swaps, a pet book spell is placed", () => {
  drop(5, { "text/pet-slot": "3" });
  drop(0, { "text/pet-slot": "6" });
  drop(4, { "text/pet-spell": "2649" });
  assert.deepEqual(swaps, [[3, 5], [6, 0]]);
  assert.deepEqual(placed, [[5, 2649]]);
});

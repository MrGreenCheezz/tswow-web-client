import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isolatedUi } from "./fixtures/isolated-ui.mjs";

// Plan item 2.02 in the native vendor window (ui/VendorRepair.ts): the repair row under the goods,
// its three buttons over browser/Repair.ts, the repair cursor's click on a native item slot and its
// tooltip line, and the class the stylesheet draws the repair cursor for. The module is loaded on its
// own with a fake DOM (fixtures/isolated-ui.mjs); the wiring in Npc.ts and ItemSlots.ts is read off
// the source.
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { RepairSession } = await import("../dist/code/browser/Repair.js");
const { buildRepairItem } = await import("../dist/code/world/RepairProtocol.js");
const { DurabilityTables } = await import("../dist/code/world/DurabilityCost.js");
const format = await import("../dist/code/browser/ui/Format.js");

const offset = (name) => UPDATE_FIELDS[name].offset;
const PLAYER = 0x10n;
const VENDOR = 0xf130_0000_1a54_0001n;
const HEAD = 0x201n;

function fakeNode(tag) {
  const listeners = [];
  const node = {
    tagName: String(tag).toUpperCase(), children: [], attributes: {}, hidden: false, textContent: "", className: "",
    listeners,
    append(...children) { node.children.push(...children); },
    replaceChildren(...children) { node.children = [...children]; },
    after(sibling) { node.nextSibling = sibling; },
    addEventListener(type, listener) { listeners.push([type, listener]); },
    setAttribute(name, value) { node.attributes[name] = String(value); },
    click() { for (const [type, listener] of listeners) if (type === "click") listener({}); },
    classList: {
      names: new Set(),
      toggle(name, enabled) { if (enabled) this.names.add(name); else this.names.delete(name); },
      contains(name) { return this.names.has(name); },
    },
  };
  return node;
}

/** A player with a worn plate helm (lost 10: 10 × 0.8 × 204 = 1632) before a repair merchant. */
function fixture(money) {
  const sent = [];
  const world = new WorldClient({ send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload: [...payload] }); }, close() {} });
  world.state = new WorldState();
  const object = (guid, typeId, entries) => ({ guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined, fields: new Map(entries) });
  world.state.objects.set(PLAYER, object(PLAYER, 4, [
    [offset("PLAYER_FIELD_COINAGE"), money],
    [offset("PLAYER_FIELD_INV_SLOT_HEAD"), Number(HEAD)], [offset("PLAYER_FIELD_INV_SLOT_HEAD") + 1, 0],
  ]));
  world.state.objects.set(HEAD, object(HEAD, 1, [
    [offset("OBJECT_FIELD_ENTRY"), 1001], [offset("ITEM_FIELD_DURABILITY"), 90], [offset("ITEM_FIELD_MAXDURABILITY"), 100],
  ]));
  world.state.objects.set(VENDOR, object(VENDOR, 3, [[offset("UNIT_NPC_FLAGS"), 0x1080]]));
  world.state.selfGuid = PLAYER;
  world.itemTemplates.set(1001, { entry: 1001, found: true, name: "Шлем", quality: 1, itemClass: 4, subClass: 4, itemLevel: 10 });
  world.vendor = { guid: VENDOR, items: [] };
  const row10 = [10, ...Array.from({ length: 21 }, (_, index) => 100 + index), ...Array.from({ length: 8 }, (_, index) => 200 + index)];
  const quality = Array.from({ length: 16 }, (_, index) => [index + 1, index === 3 ? 0.8 : 1]);
  const tables = new DurabilityTables({ version: 1, costs: [row10], quality });
  const session = new RepairSession({ world: () => world, tables: () => tables });
  const repairs = () => sent.filter((packet) => packet.opcode === OPCODES.CMSG_REPAIR_ITEM).map((packet) => packet.payload);
  return { world, session, repairs };
}

async function load(session, world) {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: fakeNode, body: fakeNode("body"), documentElement: { style: { setProperty() {} } } };
  const vendorItems = fakeNode("div");
  const vendorWindow = fakeNode("aside");
  const statuses = [];
  world.onSpellStatus = (message, error) => statuses.push([message, error]);
  const module = await isolatedUi("VendorRepair", {
    "../../generated/globalStrings.js": { globalString: () => undefined },
    "../game/Context.js": { game: { world, gatewayOrigin: undefined } },
    "../Repair.js": { repair: session },
    "./Dom.js": { vendorItems, vendorWindow },
    "./Format.js": format,
    "./Notices.js": { notice: () => {} },
    "./Widgets.js": { attachTooltip: () => {} },
  });
  return {
    module, vendorItems, vendorWindow, statuses, body: globalThis.document.body,
    restore: () => {
      vendorWindow.hidden = true;
      module.renderVendorRepair();
      globalThis.document = previousDocument;
    },
  };
}

test("2.02 native: the repair row under the goods — repair all, the cursor toggle, the refusal line", async () => {
  const { world, session, repairs } = fixture(1000);
  const ui = await load(session, world);
  try {
    ui.module.renderVendorRepair();
    const row = ui.vendorItems.nextSibling;
    assert.equal(row?.className, "vendor-repair", "placed right after #vendor-items");
    assert.equal(row.hidden, false);
    assert.deepEqual(row.children.map((button) => button.textContent),
      [`Починить всё · ${format.formatMoney(1632)}`, "Починить предмет"]);
    // 1632 with 1000 in the purse: the client's own refusal, and nothing on the wire.
    row.children[0].click();
    assert.equal(repairs().length, 0);
    assert.equal(ui.statuses.length, 1);
    assert.equal(ui.statuses[0][1], true);
    // The toggle arms the repair cursor: the body class and a native slot's click.
    row.children[1].click();
    assert.equal(session.active, true);
    assert.equal(ui.body.classList.contains("repair-cursor"), true);
    const head = world.state.objects.get(HEAD);
    assert.equal(ui.module.repairTooltipLine(head), `Стоимость ремонта: ${format.formatMoney(1632)}`);
    assert.equal(ui.module.clickRepairSlot(head, HEAD), true, "taken by the repair cursor");
    assert.equal(repairs().length, 0, "still short of money");
    world.state.objects.get(PLAYER).fields.set(offset("PLAYER_FIELD_COINAGE"), 5000);
    assert.equal(ui.module.clickRepairSlot(head, HEAD), true);
    assert.deepEqual(repairs(), [[...buildRepairItem(VENDOR, HEAD, false)]]);
    ui.vendorItems.nextSibling.children[1].click();
    assert.equal(session.active, false);
    assert.equal(ui.body.classList.contains("repair-cursor"), false);
    assert.equal(ui.module.clickRepairSlot(head, HEAD), false, "out of the mode the slot's own click runs");
    assert.equal(ui.module.repairTooltipLine(head), undefined);
    ui.vendorItems.nextSibling.children[0].click();
    assert.deepEqual(repairs()[1], [...buildRepairItem(VENDOR, 0n, false)]);
    // Nothing worn: the button is disabled, as the stock one is, and a click sends nothing.
    head.fields.set(offset("ITEM_FIELD_DURABILITY"), 100);
    ui.module.renderVendorRepair();
    assert.equal(row.children[0].attributes["aria-disabled"], "true");
    row.children[0].click();
    assert.equal(repairs().length, 2);
    // A merchant who does not repair: the row is hidden and empty.
    world.state.objects.get(VENDOR).fields.set(offset("UNIT_NPC_FLAGS"), 0x80);
    ui.module.renderVendorRepair();
    assert.equal(row.hidden, true);
    assert.equal(row.children.length, 0);
  } finally {
    ui.restore();
  }
});

test("2.02 native wiring: showVendor renders the row open or closed; an item slot asks the repair cursor first", async () => {
  const npc = await readFile(new URL("../src/browser/ui/Npc.ts", import.meta.url), "utf8");
  const show = npc.slice(npc.indexOf("export function showVendor(): void {"), npc.indexOf("function showBuyback("));
  assert.equal(show.match(/renderVendorRepair\(\);/g)?.length, 2, "the closed branch and the open one");
  const slots = await readFile(new URL("../src/browser/ui/ItemSlots.ts", import.meta.url), "utf8");
  const repairAt = slots.indexOf("clickRepairSlot(slot.item, slot.guid)");
  assert.ok(repairAt > 0);
  assert.ok(repairAt < slots.indexOf("clickFrameXmlNativeBankSlot(slot)"), "before the bank's capture handler");
  assert.ok(slots.slice(repairAt, repairAt + 400).includes("{ capture: true }"));
  const css = await readFile(new URL("../src/browser/style.css", import.meta.url), "utf8");
  assert.match(css, /body\.repair-cursor #world-canvas \{ cursor: var\(--repair-cursor, crosshair\); \}/);
});

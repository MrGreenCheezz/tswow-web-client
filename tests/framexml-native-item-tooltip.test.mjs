import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { interfaceDirectory } from "../tools/paths.mjs";
import { TswowAddonTestTransport, doublePacket } from "../tools/check-tswow-addons.mjs";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { CannedWorldSeam } from "../dist/code/browser/framexml/CannedWorldSeam.js";
import { LiveWorldSeam } from "../dist/code/browser/framexml/LiveWorldSeam.js";
import { FRAMEXML_VERTICAL_TOC, frameXmlTsAddonBlocks } from "../dist/code/browser/framexml/FrameXmlCorpus.js";
import { frameXmlItemTooltipTarget, installFrameXmlNativeItemTooltip } from "../dist/code/browser/framexml/FrameXmlNativeItemTooltip.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { attachTooltip, hideTooltip, refreshTooltip } from "../dist/code/browser/ui/Widgets.js";

function fakeNode(tag) {
  const listeners = new Map();
  return {
    tagName: tag.toUpperCase(), children: [], style: {}, dataset: {}, hidden: false, textContent: "",
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute() {}, removeAttribute() {},
    querySelector() { return fakeNode("button"); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(name, callback) { const values = listeners.get(name) ?? []; values.push(callback); listeners.set(name, values); },
    dispatch(name) { for (const callback of listeners.get(name) ?? []) callback({}); },
    getBoundingClientRect() { return { left: 20, right: 58, top: 20, bottom: 58, width: 200, height: 120 }; },
    remove() {},
  };
}

function textOf(node) { return node.textContent + node.children.map(textOf).join(""); }
const object = (guid, pairs) => ({ guid, fields: new Map(pairs) });
const slot = (bag, index, entry, guid) => ({ bag, slot: index, index, guid,
  item: object(guid, [[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry], [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 1]]) });

test("native inventory positions map to Lua equipment, backpack, carried/bank bags and keyring", () => {
  const cases = [
    [255, 0, "equipment", 0, 1], [255, 22, "equipment", 0, 23],
    [255, 23, "bag", 0, 1], [255, 38, "bag", 0, 16], [19, 0, "bag", 1, 1], [22, 7, "bag", 4, 8],
    [255, 39, "bag", -1, 1], [67, 0, "bag", 5, 1], [73, 3, "bag", 11, 4],
    [255, 86, "bag", -2, 1],
  ];
  for (const [bag, slot, kind, luaBag, luaSlot] of cases) {
    assert.deepEqual(frameXmlItemTooltipTarget({ bag, slot }), { kind, bag: luaBag, slot: luaSlot });
  }
  for (const value of [{ bag: 255, slot: 74 }, { bag: 255, slot: 67 }, { bag: -9, slot: 0 }, { bag: 19, slot: -1 }]) {
    assert.equal(frameXmlItemTooltipTarget(value), undefined);
  }
});

test("live item links retain actual enchantments, signed random property, suffix and owner level", () => {
  const equipment = slot(255, 0, 99001, 2n).item;
  const backpack = slot(255, 23, 99002, 3n).item;
  [11, 0, 22, 33, 44, 55].forEach((value, index) => equipment.fields.set(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + index * 3, value));
  equipment.fields.set(UPDATE_FIELDS.ITEM_FIELD_RANDOM_PROPERTIES_ID.offset, 0xfffffff9);
  equipment.fields.set(UPDATE_FIELDS.ITEM_FIELD_PROPERTY_SEED.offset, 678);
  const player = object(1n, [[UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset, 2],
    [UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, 3], [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 80]]);
  const world = { state: { selfGuid: 1n, objects: new Map([[1n, player], [2n, equipment], [3n, backpack]]) },
    itemTemplate: () => undefined };
  const seam = new LiveWorldSeam({ world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell() {},
    itemInfo: (entry) => ({ name: `Item ${entry}`, quality: 4 }),
  });
  assert.match(seam.inventoryItemLink("player", 1), /item:99001:11:22:33:44:55:-7:678:80\|h\[Item 99001\]/);
  assert.match(seam.containerItemLink(0, 1), /item:99002:0:0:0:0:0:0:0:80\|h/);
  assert.equal(seam.inventoryItemLink("target", 1), undefined);
  assert.equal(seam.containerItemLink(0, 2), undefined);
});

let corpus;
try {
  const root = dirname(interfaceDirectory());
  const toc = await readFile(join(root, "Interface/FrameXML/FrameXML.toc"), "utf8");
  const blocks = frameXmlTsAddonBlocks(toc).filter((block) => block.name === "__lib__" || block.name === "custom-stats");
  if (blocks.some((block) => block.name === "custom-stats")) {
    const selected = blocks.flatMap((block) => block.name === "__lib__"
      ? ["## tsaddon-begin-lib", ...block.lines, "## tsaddon-end-lib"]
      : [`## tsaddon-begin: ${block.name}`, ...block.lines, `## tsaddon-end: ${block.name}`]).join("\n");
    corpus = { async read(path) {
      if (path.toLowerCase() === "interface/framexml/framexml.toc") return selected;
      try { return await readFile(join(root, path), "utf8"); }
      catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    } };
  }
} catch { /* The generated integration fixture is optional on a clean standalone checkout. */ }

test("native inventory hover executes generated custom-stats requests and renders asynchronous affixes once", {
  skip: corpus ? false : "generated custom-stats dataset is unavailable",
}, async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousLocation = globalThis.location;
  const previousStorage = globalThis.localStorage;
  const body = fakeNode("body");
  const ids = new Map();
  globalThis.document = { body, createElement: fakeNode, addEventListener() {}, querySelectorAll() { return []; },
    getElementById(id) { if (!ids.has(id)) ids.set(id, fakeNode("div")); return ids.get(id); } };
  globalThis.window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };
  globalThis.location = { protocol: "http:", hostname: "127.0.0.1", host: "127.0.0.1:5173", search: "" };
  globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  const { itemSlot } = await import("../dist/code/browser/ui/ItemSlots.js");
  const seam = new CannedWorldSeam();
  const item = { entry: 99001, name: "Test Helm", quality: 4, link: "|Hitem:99001:0|h[Test Helm]|h" };
  seam.setInventoryItem(1, item);
  seam.setContainerItem(0, 1, { ...item, entry: 99002, link: "|Hitem:99002:0|h[Test Bag Item]|h" });
  const packets = new TswowAddonTestTransport();
  const boot = new FrameXmlBoot({ provider: corpus, subset: FRAMEXML_VERTICAL_TOC,
    includeActiveTsAddons: true, seam, locale: "ruRU", clientNetwork: packets,
    gameTooltipAdapter: {
      inventoryItem: () => ({ title: item.name, lines: Array.from({ length: 12 }, (_, i) => `Stock line ${i}`) }),
      containerItem: () => ({ title: "Test Bag Item", lines: [] }),
    },
  });
  let cleanup;
  const activeChanges = [];
  try {
    await boot.load();
    assert.equal(boot.isAddonLoaded("custom-stats"), true);
    cleanup = installFrameXmlNativeItemTooltip(boot, (active) => activeChanges.push(active));
    const equipmentNode = itemSlot(slot(255, 0, 99001, 2n));
    equipmentNode.dispatch("pointerenter");
    const requests = () => packets.sent.filter((packet) => packet.opcode === 97);
    assert.equal(requests().length, 1, "the native slot must call the module's Lua tooltip hook");
    assert.deepEqual(requests()[0].body, doublePacket(1, 0, 1, 1));
    assert.equal(boot.bridge.getFrame("GameTooltipTextLeft13").text, "Stock line 11", "stock lines no longer stop at eight");
    packets.receive(98, doublePacket(1, 0, 1, 1, 99001, 2, 1, 1, 321, 1, 123, 0, 0, 0, 0, 0, 0, 0));
    await Promise.resolve();
    const tooltip = body.children.find((node) => node.className === "ui-tooltip");
    assert.match(textOf(tooltip), /Вампиризм \+123/);
    assert.equal(tooltip.hidden, false);
    assert.equal(tooltip.children.filter((node) => textOf(node).includes("Вампиризм +123")).length, 1);
    assert.ok(tooltip.children.flatMap((node) => node.children).some((run) => /^#[0-9a-f]{8}$/.test(run.style.color)));
    assert.doesNotMatch(textOf(tooltip), /\|c[0-9a-f]{8}/i, "Lua colour escapes must not appear as visible text");
    refreshTooltip();
    assert.equal(requests().length, 1, "refreshing an already visible tooltip must not resend or duplicate");
    equipmentNode.dispatch("pointerleave");
    assert.equal(boot.bridge.getFrame("GameTooltip").visible, false);
    equipmentNode.dispatch("pointerenter");
    assert.equal(requests().length, 1, "the original module's property cache survives hiding");
    assert.match(textOf(tooltip), /Вампиризм \+123/, "OnTooltipCleared lets the cached addon line be added again");
    const bagNode = itemSlot(slot(255, 23, 99002, 3n));
    bagNode.dispatch("pointerenter");
    assert.deepEqual(requests()[1].body, doublePacket(0, 0, 1, 2));
    assert.doesNotMatch(textOf(tooltip), /Вампиризм/);
    packets.receive(98, doublePacket(1, 0, 1, 1, 99001, 2, 1, 1, 321, 1, 123, 0, 0, 0, 0, 0, 0, 0));
    await Promise.resolve();
    assert.doesNotMatch(textOf(tooltip), /Вампиризм/, "a late equipment reply must not contaminate the bag item");
    const other = fakeNode("button");
    attachTooltip(other, () => ({ title: "Spell" }));
    other.dispatch("pointerenter");
    assert.equal(boot.bridge.getFrame("GameTooltip").visible, false, "an unrelated native tooltip ends Lua item hover");
    assert.deepEqual(activeChanges, [true, false, true, false, true, false]);
    bagNode.dispatch("pointerenter");
    const changeCount = activeChanges.length;
    cleanup(); cleanup = undefined;
    assert.equal(activeChanges.length, changeCount, "cleanup cannot call an already-disposed presentation owner");
    assert.deepEqual(boot.errors, []);
  } finally {
    hideTooltip(); cleanup?.(); boot.close();
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.location = previousLocation;
    globalThis.localStorage = previousStorage;
  }
  assert.equal(packets.handlers.size, 0);
});

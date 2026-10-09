import assert from "node:assert/strict";
import test, { after } from "node:test";
import { isolatedUi } from "./fixtures/isolated-ui.mjs";

// 4.03: the native character sheet's controls and new sections (ui/CharacterSheet.ts) over a fake
// DOM. The sheet is redrawn every frame while open; its helm/cloak toggles and title picker are not,
// and they are rewritten only when the fields they show change — a click is never overwritten by the
// old value before the realm answers.
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const fields = await import("../dist/code/world/Fields.js");
const statFields = await import("../dist/code/world/CharacterStatFields.js");
const statData = await import("../dist/code/world/CharacterStatData.js");
const model = await import("../dist/code/browser/ui/CharacterSheetModel.js");
const skills = await import("../dist/code/browser/ui/Skills.js");
const strings = await import("../dist/code/browser/ui/Strings.js");
const titlesLive = await import("../dist/code/browser/framexml/FrameXmlTitlesLive.js");
const currencyLive = await import("../dist/code/browser/framexml/FrameXmlCurrencyLive.js");
const relic = await import("../dist/code/browser/framexml/FrameXmlRelicSlot.js");

strings.setStringSource(() => undefined);

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); }
  children = []; listeners = {}; dataset = {}; hidden = false; className = ""; textContent = "";
  value = ""; checked = false; type = ""; classes = new Set();
  classList = { add: (name) => this.classes.add(name), remove: (name) => this.classes.delete(name), toggle() {} };
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); }
  setAttribute(name, value) { this[name] = value; }
  fire(name) { for (const listener of this.listeners[name] ?? []) listener({ target: this }); }
}

const realDocument = globalThis.document;
const realFetch = globalThis.fetch;
globalThis.document = { createElement: (tag) => new Element(tag) };
after(() => { globalThis.document = realDocument; globalThis.fetch = realFetch; });

const fetched = [];
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  const path = new URL(url).pathname;
  const body = path === "/dbc/char-titles" ? { version: 1, titles: [
    { id: 1, maskId: 1, name: "Рядовой %s", nameFemale: "" },
    { id: 2, maskId: 5, name: "%s, Чемпион Наару", nameFemale: "" },
    { id: 3, maskId: 9, name: "Анти-герой %s", nameFemale: "" },
  ] } : path === "/dbc/currencies" ? { version: 1,
    categories: [{ id: 1, flags: 0, name: "Разное" }, { id: 2, flags: 0, name: "Игрок против игрока" }],
    types: [{ id: 61, itemId: 43308, categoryId: 2, bitIndex: 0 }, { id: 81, itemId: 44990, categoryId: 1, bitIndex: 3 }] }
    : undefined;
  return body ? { ok: true, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
};

const dom = new Proxy({}, { get: (cache, name) => (cache[name] ??= new Element("div")) });
const game = { world: undefined, gatewayOrigin: "http://gw.test", spells: new Map(), factions: undefined };
const tips = new Map();
const modelCalls = { count: 0 };
const sheet = await isolatedUi("CharacterSheet", {
  "../../generated/updateFields.js": { UPDATE_FIELDS },
  "../../world/Fields.js": fields,
  "../game/Context.js": { game },
  "./Dom.js": dom,
  "./Widgets.js": {
    setTip: (element, tip) => tips.set(element, tip),
    textLine: (label, value) => { const line = new Element("div"); line.label = label; line.value = value; return line; },
  },
  "./Slots.js": {
    slotElement: () => new Element("div"), skinnable() {},
    slotSiblings: (container) => (children) => { container.drawn = children; },
  },
  "../../world/CharacterStatFields.js": statFields,
  "../../world/CharacterStatData.js": statData,
  "./CharacterSheetModel.js": { ...model, characterStatSections: (...args) => { modelCalls.count++; return model.characterStatSections(...args); } },
  "./Skills.js": skills,
  "./Strings.js": strings,
  "../framexml/FrameXmlTitlesLive.js": titlesLive,
  "../framexml/FrameXmlCurrencyLive.js": currencyLive,
  "../framexml/FrameXmlRelicSlot.js": relic,
  "./Format.js": { formatMoney: () => "", formatPlayed: () => "", reputationRank: () => "" },
});

const settle = async () => { for (let round = 0; round < 8; round++) await new Promise((resolve) => setImmediate(resolve)); };
const SELF = 1n;

function makeWorld() {
  const object = { guid: SELF, typeId: 4, fields: new Map() };
  const set = (name, value, index = 0) => object.fields.set(UPDATE_FIELDS[name].offset + index, value >>> 0);
  set("UNIT_FIELD_BYTES_0", 1 | (2 << 8));
  set("UNIT_FIELD_LEVEL", 80);
  set("PLAYER_FIELD_HONOR_CURRENCY", 1234);
  set("PLAYER_FIELD_KNOWN_CURRENCIES", 1); // bit index 0 is not a bit: only bitIndex 1..64 count
  const sent = [];
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, object]]) },
    titles: new Set(), achievements: new Map(), factions: new Map(), itemTemplates: new Map(),
    itemTemplate: (entry) => { sent.push(["item", entry]); },
    setTitle: (index) => sent.push(["title", index]),
    setShowingHelm: (show) => sent.push(["helm", show]),
    setShowingCloak: (show) => sent.push(["cloak", show]),
  };
  return { world, object, set, sent };
}

function controls() {
  const pane = dom.characterSheetPane;
  const section = pane.children.find((child) => child.className.includes("sheet-controls"));
  const [helmRow, cloakRow, titleRow] = section.children;
  return { section, helm: helmRow.children[0], cloak: cloakRow.children[0], titleRow, select: titleRow.children[1] };
}

test("the controls sit outside the redrawn box, before the footer, hidden without a character", () => {
  dom.characterWindow.hidden = false;
  dom.characterCollectionsPane.hidden = true;
  game.world = undefined;
  sheet.showCharacterSheet();
  const pane = dom.characterSheetPane;
  const at = pane.children.findIndex((child) => child.className.includes("sheet-controls"));
  assert.ok(at >= 0 && at === pane.children.length - 2, "controls, then the module footer slot");
  assert.equal(controls().section.hidden, true);
});

test("helm and cloak follow PLAYER_FLAGS, send on change, and are not reverted before the answer", async () => {
  const { world, set, sent } = makeWorld();
  set("PLAYER_FLAGS", statFields.PLAYER_FLAGS_HIDE_CLOAK);
  game.world = world;
  sheet.showCharacterSheet();
  const { section, helm, cloak } = controls();
  assert.equal(section.hidden, false);
  assert.equal(helm.checked, true);
  assert.equal(cloak.checked, false);
  // The player unticks the helm: one packet, and the next frames keep the tick off.
  helm.checked = false;
  helm.fire("change");
  assert.deepEqual(sent.filter(([kind]) => kind === "helm"), [["helm", false]]);
  sheet.showCharacterSheet();
  sheet.showCharacterSheet();
  assert.equal(helm.checked, false, "the old field value does not overwrite the click");
  // The realm answers with the flag set; a later change elsewhere (cloak shown) is followed.
  set("PLAYER_FLAGS", statFields.PLAYER_FLAGS_HIDE_HELM);
  sheet.showCharacterSheet();
  assert.equal(helm.checked, false);
  assert.equal(cloak.checked, true);
  cloak.checked = false;
  cloak.fire("change");
  assert.deepEqual(sent.filter(([kind]) => kind === "cloak"), [["cloak", false]]);
  await settle();
});

test("title picker: hidden until a title is known and named; «Нет» first; a choice sends CMSG_SET_TITLE", async () => {
  const { world, set, sent } = makeWorld();
  game.world = world;
  sheet.showCharacterSheet();
  await settle();
  sheet.showCharacterSheet();
  assert.equal(controls().titleRow.hidden, true, "no known title: no picker");
  set("PLAYER__FIELD_KNOWN_TITLES", (1 << 1) | (1 << 5) | (1 << 9));
  set("PLAYER_CHOSEN_TITLE", 5);
  sheet.showCharacterSheet();
  const { titleRow, select } = controls();
  assert.equal(titleRow.hidden, false);
  assert.deepEqual(select.children.map((option) => [option.value, option.textContent]),
    [["-1", "Нет"], ["5", ", Чемпион Наару"], ["9", "Анти-герой"], ["1", "Рядовой"]],
    "byte order, as PlayerTitleSort's Lua `<`: the comma of a suffix title sorts before any letter");
  assert.equal(select.value, "5");
  const options = select.children;
  sheet.showCharacterSheet();
  assert.equal(select.children, options, "an unchanged picker is not rebuilt");
  assert.equal(sent.some(([kind]) => kind === "title"), false, "drawing never sends");
  select.value = "-1";
  select.fire("change");
  select.value = "9";
  select.fire("change");
  assert.deepEqual(sent.filter(([kind]) => kind === "title"), [["title", -1], ["title", 9]]);
});

test("the stat categories and the known currencies are drawn; a missing rating table is not a zero", async () => {
  const { world, set } = makeWorld();
  set("PLAYER_FIELD_KNOWN_CURRENCIES", 1 << 2); // CurrencyTypes 81: bit index 3
  set("UNIT_FIELD_ATTACK_POWER", 900);
  game.world = world;
  sheet.showCharacterSheet();
  await settle();
  sheet.showCharacterSheet();
  const drawn = dom.characterStats.drawn;
  const keys = drawn.map((block) => block.dataset.sheetSection).filter(Boolean);
  assert.deepEqual(keys, ["base", "melee", "ranged", "spell", "defenses", "currency"]);
  const melee = drawn.find((block) => block.dataset.sheetSection === "melee");
  assert.equal(melee.children.find((line) => line.label === "Сила атаки").value, "900");
  const defenses = drawn.find((block) => block.dataset.sheetSection === "defenses");
  assert.equal(defenses.children.some((line) => line.label === "Защита"), false,
    "the stats route answered 404: no defence row rather than a guess");
  const currency = drawn.find((block) => block.dataset.sheetSection === "currency");
  assert.deepEqual(currency.children.slice(1).map((line) => line.label ?? line.textContent), ["Разное", "…"]);
  assert.ok(fetched.some((url) => url.includes("/dbc/character-stats?version=2")));
  assert.equal(fetched.filter((url) => url.includes("/dbc/char-titles")).length, 1, "the title catalog is fetched once");
});

test("the box is rebuilt only when what it shows changed: a hovered row keeps its element and tooltip", async () => {
  const { world, set } = makeWorld();
  set("UNIT_FIELD_ATTACK_POWER", 900);
  game.world = world;
  sheet.showCharacterSheet();
  await settle();
  sheet.showCharacterSheet();
  const first = dom.characterStats.drawn;
  sheet.showCharacterSheet();
  sheet.showCharacterSheet();
  assert.equal(dom.characterStats.drawn, first, "same rows: the frame's call draws nothing");
  set("UNIT_FIELD_ATTACK_POWER", 950);
  sheet.showCharacterSheet();
  assert.notEqual(dom.characterStats.drawn, first);
  const melee = dom.characterStats.drawn.find((block) => block.dataset.sheetSection === "melee");
  assert.equal(melee.children.find((line) => line.label === "Сила атаки").value, "950");
  assert.ok(tips.get(melee.children.find((line) => line.label === "Сила атаки")).startsWith("Сила атаки ближнего боя: 950"));
});

test("review: helm/cloak send only what differs from the flag (Wow.exe ShowHelm 0x006e0e00/0x006dd0f0)", () => {
  const { world, set, sent } = makeWorld();
  game.world = world;
  sheet.showCharacterSheet();
  const { helm } = controls();
  assert.equal(helm.checked, true);
  // Off, then on again before the realm answers: the flag still says «shown», so the second is not sent.
  helm.checked = false;
  helm.fire("change");
  helm.checked = true;
  helm.fire("change");
  assert.deepEqual(sent.filter(([kind]) => kind === "helm"), [["helm", false]]);
});

test("review: an unrelated PLAYER_FLAGS change (AFK, resting) does not undo a click awaiting its answer", () => {
  const { world, set } = makeWorld();
  game.world = world;
  sheet.showCharacterSheet();
  const { helm } = controls();
  helm.checked = false;
  helm.fire("change");
  set("PLAYER_FLAGS", 0x02 | 0x20); // PLAYER_FLAGS_AFK | PLAYER_FLAGS_RESTING, helm bit still clear
  sheet.showCharacterSheet();
  assert.equal(helm.checked, false);
});

test("review: the mana row follows UnitHasMana — a druid in bear form (rage displayed) says «НЕТ»", async () => {
  const { world, set } = makeWorld();
  set("UNIT_FIELD_MAXPOWER1", 5000);
  set("UNIT_FIELD_BYTES_0", 1 | (11 << 8) | (1 << 24));
  game.world = world;
  sheet.showCharacterSheet();
  const spell = dom.characterStats.drawn.find((block) => block.dataset.sheetSection === "spell");
  assert.equal(spell.children.find((line) => line.label === "Восп. маны").value, "НЕТ");
  set("UNIT_FIELD_BYTES_0", 1 | (11 << 8));
  sheet.showCharacterSheet();
  const caster = dom.characterStats.drawn.find((block) => block.dataset.sheetSection === "spell");
  assert.equal(caster.children.find((line) => line.label === "Восп. маны").value, "0");
  await settle();
});

test("review: with nothing changed the frame's call builds no model — not once a frame while packets arrive", async () => {
  const { world, set } = makeWorld();
  game.world = world;
  sheet.showCharacterSheet();
  await settle();
  sheet.showCharacterSheet();
  const before = modelCalls.count;
  for (let frame = 0; frame < 30; frame++) sheet.showCharacterSheet();
  assert.equal(modelCalls.count, before, "no field moved: no model build");
  set("UNIT_FIELD_ATTACK_POWER", 77);
  sheet.showCharacterSheet();
  assert.equal(modelCalls.count, before + 1, "a field moved: one build");
  world.playedTime = { total: 10, atLevel: 5 };
  sheet.showCharacterSheet();
  assert.equal(modelCalls.count, before + 2, "a packet-held input (played time) moved: one build");
});

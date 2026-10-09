import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 6.01 / 6.02 (line A7a, slice B, 05.10): what an NPC wears on its head and shoulders
// (CreatureDisplayInfoExtra.NPCItemDisplay) and what it holds (UNIT_VIRTUAL_ITEM_SLOT_ID, three item
// entries read through Item.dbc). Fixtures were picked by a DBC census of 05.10: extra row 156 is a
// dwarf male with hair style 1, helmet 15919 (Helm_Leather_B_01, HelmetGeosetVisID 265 hides his
// hair) and pauldrons 4593; extra row 3941 is a human male with hair style 1 under helmet 15676,
// which names no model but whose HelmetGeosetVisID 248 would hide the hair.

// `ui/Frames.ts` resolves its DOM handles at import: the fake document of `helm-cloak.test.mjs`.
function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      title: "", hidden: false, disabled: false, onerror: null, src: "", id: "", value: "", options: [],
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: {
        add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
        remove(...names) { node.className = node.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
        toggle(name, on) { if (on) this.add(name); else this.remove(name); },
        contains(name) { return node.className.split(" ").includes(name); },
      },
      append(...nodes) { node.children.push(...nodes); },
      prepend(...nodes) { node.children.unshift(...nodes); },
      appendChild(child) { node.children.push(child); return child; },
      replaceChildren(...nodes) { node.children = [...nodes]; },
      remove() {}, focus() {}, blur() {},
      addEventListener() {}, removeEventListener() {},
      setAttribute(name, value) { node[name] = value; },
      getAttribute(name) { return node[name] ?? null; },
      removeAttribute(name) { delete node[name]; },
      querySelector() { return make("div"); }, querySelectorAll() { return []; }, closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }; },
      getContext() { return null; },
    };
    return node;
  };
  return {
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }), createDocumentFragment: () => make("fragment"),
    body: make("body"), documentElement: make("html"), head: make("head"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) {
        node = make("div");
        node.id = id;
        byId.set(id, node);
      }
      return node;
    },
    querySelector() { return make("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

globalThis.document = fakeDocument();
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const { CharacterAppearanceIndex } = await import("../dist/code/gateway/CharacterAppearance.js");
const { CharacterTextureIndex } = await import("../dist/code/gateway/CharacterTextures.js");
const { openDbcFile } = await import("../dist/code/gateway/Dbc.js");
const { npcWeaponsFor, parseNpcWeaponEntries, serveNpcWeaponsRoute } = await import("../dist/code/gateway/NpcWeapons.js");
const {
  NpcWeaponClient, attachedOf, heldWeapons, virtualItemEntry, weaponMetadataPending, withVirtualWeapons,
} = await import("../dist/code/browser/NpcWeapons.js");
const { CREATURE_MODEL_VERSION } = await import("../dist/code/browser/CharacterAtlas.js");
const { unitModelFor } = await import("../dist/code/browser/ui/Frames.js");
const { actionAnimation, weaponPose } = await import("../dist/code/browser/AnimatedModel.js");
const { ANIMATION_IDS } = await import("../dist/code/generated/animations.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

let index;
async function appearances() {
  index ??= await CharacterAppearanceIndex.load(dbcDirectory, undefined, dbcDirectory, false);
  return index;
}

const DWARF_HELMED = 156;
const HUMAN_MODELLESS_HELM = 3941;
/** Family 0 is the hairstyle: geosets 1..99. */
const hairOf = (geosets) => geosets.filter((id) => id > 0 && id < 100);
const describe = (attached) => attached.map((item) => `${item.slot}/${item.side}:${item.model.split("\\").pop()}`);

// ---- 6.01: helmet and pauldrons --------------------------------------------------------------------

test("6.01 an NPC's helmet and two pauldrons are attached, and the helmet hides what it covers", withDataset, async () => {
  const appearances_ = await appearances();
  const dwarf = appearances_.forNpc(DWARF_HELMED);
  assert.ok(dwarf, "extra row 156 resolves");
  const head = dwarf.attached.filter((item) => item.slot === 0);
  assert.equal(head.length, 1, `one helmet: ${describe(dwarf.attached)}`);
  assert.match(head[0].model, /^Item\\ObjectComponents\\Head\\Helm_Leather_B_01_DwM\.m2$/i,
    "the race/sex file of the wearer, `<name>_<ClientPrefix><M|F>`");
  const shoulders = dwarf.attached.filter((item) => item.slot === 2);
  assert.deepEqual(shoulders.map((item) => item.side).sort(), ["left", "right"], "two separate pauldrons");
  assert.ok(shoulders.every((item) => /\\Shoulder\\/i.test(item.model)), describe(shoulders).join(" "));
  const bare = appearances_.forPlayer(3, 0, 0, 0, 1, 0, 0);
  assert.ok(hairOf(bare.geosets).length > 0, "hair style 1 of a dwarf male is drawn without a helmet");
  assert.deepEqual(hairOf(dwarf.geosets), [], "HelmetGeosetVisData 265 hides the hair under a drawn helmet");
});

test("6.01 a helmet with no model hides nothing and hangs nothing", withDataset, async () => {
  const human = (await appearances()).forNpc(HUMAN_MODELLESS_HELM);
  assert.ok(human, "extra row 3941 resolves");
  assert.deepEqual(human.attached.filter((item) => item.slot === 0), [], "no file, no helmet");
  const bare = (await appearances()).forPlayer(1, 0, 0, 0, 1, 0, 0);
  assert.ok(hairOf(bare.geosets).length > 0);
  assert.deepEqual(hairOf(human.geosets), hairOf(bare.geosets),
    "census 05.10: 565 displays wear such a helmet — they keep their hair until a frame of Wow.exe says otherwise");
});

test("6.01 with a listing of the Head shelf, a helmet missing for this race/sex is left out whole", withDataset, async () => {
  const listing = (paths) => CharacterAppearanceIndex.load(dbcDirectory,
    Promise.resolve(CharacterTextureIndex.from(paths)), dbcDirectory, false);
  const missing = (await listing(["Item\\ObjectComponents\\Head\\Helm_Leather_B_01_HuM.m2"])).forNpc(DWARF_HELMED);
  assert.deepEqual(missing.attached.filter((item) => item.slot === 0), [], "the dwarf file is not in the listing");
  assert.ok(hairOf(missing.geosets).length > 0, "and its hide rule is not applied");
  assert.equal(missing.attached.filter((item) => item.slot === 2).length, 2, "the pauldrons do not depend on it");
  const present = (await listing(["item\\objectcomponents\\head\\helm_leather_b_01_dwm.m2"])).forNpc(DWARF_HELMED);
  assert.equal(present.attached.filter((item) => item.slot === 0).length, 1, "case- and slash-insensitive");
  assert.deepEqual(hairOf(present.geosets), []);
});

test("6.01 the creature-model payload version is the one slice A raised, not raised again", () => {
  assert.equal(CREATURE_MODEL_VERSION, 14, "14 is shared by 6.11а and 6.01 (no release in between)");
});

// ---- 6.02 gateway: Item.dbc entries → held models ------------------------------------------------

async function itemRows() {
  const items = await openDbcFile(dbcDirectory, "Item");
  const find = (predicate) => {
    for (const row of items.rows()) if (predicate(row)) return items.id(row);
    return undefined;
  };
  return { items, find };
}

test("6.02 the route answers an entry through Item.dbc: type, weapon subclass and the Weapon/Shield model", withDataset, async () => {
  const { items, find } = await itemRows();
  const appearances_ = await appearances();
  const twoHander = find((row) => items.int(row, "ClassID") === 2 && items.int(row, "InventoryType") === 17
    && npcWeaponsFor(items, appearances_, [items.id(row)])[0]?.model);
  const shield = find((row) => items.int(row, "InventoryType") === 14
    && npcWeaponsFor(items, appearances_, [items.id(row)])[0]?.model);
  assert.ok(twoHander && shield, "the dataset has a drawn two-hander and a drawn shield");
  const answer = npcWeaponsFor(items, appearances_, [twoHander, 999_999_999, shield]);
  assert.equal(answer.length, 2, "an entry Item.dbc does not carry is left out");
  const [sword, board] = answer;
  assert.equal(sword.entry, twoHander);
  assert.equal(sword.inventoryType, 17);
  assert.equal(typeof sword.subClass, "number", "class 2 carries its weapon subclass");
  assert.match(sword.model, /^Item\\ObjectComponents\\Weapon\\.+\.m2$/i);
  assert.equal(board.inventoryType, 14);
  assert.equal(board.subClass, undefined, "a shield is class 4: its subclass is not a kind of weapon");
  assert.match(board.model, /^Item\\ObjectComponents\\Shield\\.+\.m2$/i);
  const raw = appearances_.weaponModels([{ slot: 0, inventoryType: 1, displayId: 15919 }]);
  assert.deepEqual(raw, [], "weaponModels hangs nothing outside slots 15–17");
});

test("6.02 parseNpcWeaponEntries takes 1–200 positive uint32 entries", () => {
  assert.deepEqual(parseNpcWeaponEntries("12,7,12"), [12, 7]);
  assert.equal(parseNpcWeaponEntries(""), undefined);
  assert.equal(parseNpcWeaponEntries(null), undefined);
  assert.equal(parseNpcWeaponEntries("0"), undefined);
  assert.equal(parseNpcWeaponEntries("-1"), undefined);
  assert.equal(parseNpcWeaponEntries("4294967296"), undefined);
  assert.equal(parseNpcWeaponEntries("1,a"), undefined);
  assert.equal(parseNpcWeaponEntries(Array.from({ length: 201 }, (_, i) => i + 1).join(",")), undefined);
});

function fakeResponse() {
  return {
    status: 0, headers: {}, body: undefined,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this; },
    end(body) { this.body = body; return this; },
  };
}

test("6.02 GET /dbc/npc-weapons: origin, version, list, no-store", withDataset, async () => {
  const options = { dbcDirectory, allowedOrigins: ["http://127.0.0.1:5173"] };
  const cache = new Map();
  const ask = async (query, origin = "http://127.0.0.1:5173", pathname = "/dbc/npc-weapons") => {
    const response = fakeResponse();
    const handled = await serveNpcWeaponsRoute({ method: "GET", headers: { origin } }, response,
      new URL(`http://127.0.0.1:8090${pathname}?${query}`), cache, options, appearances);
    return { handled, response };
  };
  assert.equal((await ask("v=1&entries=1", undefined, "/dbc/other")).handled, false, "another path falls through");
  assert.equal((await ask("v=1&entries=1", "http://evil.example")).response.status, 403);
  assert.equal((await ask("v=2&entries=1")).response.status, 400, "another version");
  assert.equal((await ask("v=1&entries=x")).response.status, 400, "a bad list");
  const { items, find } = await itemRows();
  const entry = find((row) => items.int(row, "ClassID") === 2 && items.int(row, "InventoryType") === 13
    && npcWeaponsFor(items, index, [items.id(row)])[0]?.model);
  const { response } = await ask(`v=1&entries=${entry}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["access-control-allow-origin"], "http://127.0.0.1:5173");
  const body = JSON.parse(response.body);
  assert.equal(body.length, 1);
  assert.equal(body[0].entry, entry);
  assert.equal(body[0].inventoryType, 13);
});

// ---- 6.02 browser: words → slots → held → pose ---------------------------------------------------

const VIRTUAL = UPDATE_FIELDS.UNIT_VIRTUAL_ITEM_SLOT_ID.offset;
const SWORD = { entry: 1001, inventoryType: 17, subClass: 8, model: "Item\\ObjectComponents\\Weapon\\Sword_2H_A_01.m2", texture: "t1.blp" };
const BOW = { entry: 1003, inventoryType: 15, subClass: 2, model: "Item\\ObjectComponents\\Weapon\\Bow_A_01.m2", texture: "t3.blp" };
const STAFF_NO_MODEL = { entry: 1004, inventoryType: 17, subClass: 10, model: "", texture: "" };

function creature(main, off, ranged, typeId = 3) {
  return { typeId, guid: 77n, fields: new Map([[VIRTUAL, main], [VIRTUAL + 1, off], [VIRTUAL + 2, ranged],
    [UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, 5]]) };
}

/** A gateway that knows SWORD, BOW and STAFF_NO_MODEL; `status` overrides the answer. */
function gateway(status = 200) {
  const asked = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const entries = new URL(String(url)).searchParams.get("entries").split(",").map(Number);
    const known = [SWORD, BOW, STAFF_NO_MODEL].filter((weapon) => entries.includes(weapon.entry));
    return { ok: status === 200, status, json: async () => known };
  };
  return { asked, restore: () => { globalThis.fetch = previous; } };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("6.02 the three words are item entries for slots 15, 16 and 17, asked for in one batch", async () => {
  const server = gateway();
  try {
    const client = new NpcWeaponClient("http://127.0.0.1:8090", () => 0);
    const object = creature(1001, 0, 1003);
    assert.deepEqual([0, 1, 2].map((word) => virtualItemEntry(object, word)), [1001, 0, 1003], "fields 56, 57, 58");
    const first = heldWeapons([1001, 0, 1003], client);
    assert.deepEqual(first.held, []);
    assert.equal(first.pending, true, "unresolved entries are pending, not empty hands");
    await settle();
    assert.equal(server.asked.length, 1, "one request for the frame");
    assert.match(server.asked[0], /\/dbc\/npc-weapons\?v=1&entries=1001,1003$/);
    const second = heldWeapons([1001, 0, 1003], client);
    assert.equal(second.pending, false);
    assert.deepEqual(second.held.map((item) => [item.slot, item.inventoryType, item.subClass, item.model]),
      [[15, 17, 8, SWORD.model], [17, 15, 2, BOW.model]], "the zero word is an empty hand");
    heldWeapons([1001, 0, 1003], client);
    await settle();
    assert.equal(server.asked.length, 1, "a known entry is never asked again");
    const blank = heldWeapons([0, 1004, 0], client);
    await settle();
    assert.deepEqual(heldWeapons([0, 1004, 0], client).held, [], "an item that names no model hangs nothing");
    assert.equal(blank.pending, true);
  } finally {
    server.restore();
  }
});

test("6.02 unitModelFor puts a creature's weapons in `held`, beside an untouched appearance, and memoises", async () => {
  const server = gateway();
  try {
    const npcWeapons = new NpcWeaponClient("http://127.0.0.1:8090", () => 0);
    const appearance = { body: [], geosets: [], hair: "", cloak: "", attached: [{ slot: 0, inventoryType: 1, side: "left", model: "Item\\ObjectComponents\\Head\\H_HuM.m2", texture: "" }] };
    const record = { id: 5, model: "Character\\Human\\Male\\HumanMale.m2", scale: 1, textures: "", collisionHeight: 2, mountHeight: 0, appearance };
    const creatureModels = { get: () => record, generation: 0, npcWeapons };
    const object = creature(1001, 0, 0);
    const pending = unitModelFor(object, creatureModels, undefined);
    assert.equal(pending.heldPending, true);
    await settle();
    const armed = unitModelFor(object, creatureModels, undefined);
    assert.equal(armed.heldPending, undefined);
    assert.deepEqual(armed.held.map((item) => item.slot), [15]);
    assert.equal(armed.appearance, appearance, "the appearance is the display's own object");
    assert.deepEqual(appearance.attached.map((item) => item.slot), [0], "and is not written into");
    assert.equal(unitModelFor(object, creatureModels, undefined), armed, "same words, same record: no allocation");
    assert.deepEqual(attachedOf(armed).map((item) => item.slot), [0, 15], "helmet and sword together");
    assert.equal(attachedOf(armed), attachedOf(armed), "merged once per record");
    assert.equal(weaponPose(attachedOf(armed), "melee"), "twoHand");
    assert.equal(actionAnimation("attack", weaponPose(attachedOf(armed), "melee"))[0], ANIMATION_IDS.Attack2H,
      "the NPC swings a two-hander, not AttackUnarmed");
    object.fields.set(VIRTUAL, 0);
    assert.equal(unitModelFor(object, creatureModels, undefined), record, "an unarmed creature keeps its record");
    const player = creature(1001, 0, 0, 4);
    assert.equal(unitModelFor(player, { get: () => undefined, generation: 0, npcWeapons }, undefined), undefined,
      "players are not read through the virtual words");
  } finally {
    server.restore();
  }
});

test("6.02 an old gateway without the route: no more asking, unarmed and not pending", async () => {
  const server = gateway(404);
  try {
    const client = new NpcWeaponClient("http://127.0.0.1:8090", () => 0);
    const record = { id: 5, model: "Creature\\Ogre\\Ogre.m2", scale: 1, textures: "", collisionHeight: 2, mountHeight: 0 };
    const object = creature(1001, 0, 1003);
    assert.equal(withVirtualWeapons(record, object, client).heldPending, true);
    await settle();
    const settled = withVirtualWeapons(record, object, client);
    assert.deepEqual(settled.held, []);
    assert.equal(settled.heldPending, undefined);
    assert.equal(weaponMetadataPending(settled), false, "a shot is not held for an answer that is not coming");
    withVirtualWeapons(record, creature(1004, 0, 0), client);
    await settle();
    assert.equal(server.asked.length, 1, "after the 404 nothing more is asked until a reload");
  } finally {
    server.restore();
  }
});

test("6.02 a failed batch is retried after its wait, not every frame", async () => {
  const server = gateway(500);
  let now = 0;
  try {
    const client = new NpcWeaponClient("http://127.0.0.1:8090", () => now);
    const record = { id: 5, model: "Creature\\Ogre\\Ogre.m2", scale: 1, textures: "", collisionHeight: 2, mountHeight: 0 };
    const object = creature(1001, 0, 0);
    withVirtualWeapons(record, object, client);
    await settle();
    assert.equal(withVirtualWeapons(record, object, client).heldPending, true, "still coming");
    await settle();
    assert.equal(server.asked.length, 1, "waiting out the backoff");
    now = 60_000;
    withVirtualWeapons(record, object, client);
    await settle();
    assert.equal(server.asked.length, 2, "asked again once the wait is over");
  } finally {
    server.restore();
  }
});

test("6.02 weaponMetadataPending: what a shot waits for", () => {
  assert.equal(weaponMetadataPending(undefined), true);
  assert.equal(weaponMetadataPending({ appearance: { attached: [] } }), false, "a settled player");
  assert.equal(weaponMetadataPending({ appearance: { attached: [] }, appearancePending: true }), true);
  assert.equal(weaponMetadataPending({}), true, "a creature with nothing to read waits, as before 6.02");
  assert.equal(weaponMetadataPending({ held: [] }), false, "a creature whose hands are known");
  assert.equal(weaponMetadataPending({ held: [], heldPending: true }), true);
  assert.equal(weaponMetadataPending({ appearance: { attached: [] }, held: [], heldPending: true }), true,
    "a character-model NPC waits for its bow");
});

test("6.02 attachedOf allocates nothing when one side is empty", () => {
  const worn = [{ slot: 0 }];
  const held = [{ slot: 15 }];
  assert.equal(attachedOf({ appearance: { attached: worn } }), worn);
  assert.equal(attachedOf({ appearance: { attached: worn }, held: [] }), worn);
  assert.equal(attachedOf({ held }), held);
  assert.equal(attachedOf({ appearance: { attached: [] }, held }), held);
  assert.equal(attachedOf(undefined), undefined);
});

test("6.02 the renderer hangs and swings the merged list (WorldRenderer3D hook lines)", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const body = (name) => {
    const start = source.indexOf(`  ${name}(`);
    assert.ok(start > 0, name);
    return source.slice(start, source.indexOf("\n  }\n", start));
  };
  assert.match(body("#updateAttachments"), /const attached = attachedOf\(metadata\);/);
  const entry = body("#entryAnimation");
  assert.match(entry, /weaponPose\(attachedOf\(metadata\), /);
  assert.match(entry, /&& weaponMetadataPending\(metadata\);/);
});

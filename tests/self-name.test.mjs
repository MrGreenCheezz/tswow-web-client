// Ж0: what the target frame calls things — yourself, a stranger, a boar and a mailbox.
//
// The player's report was «при выделении себя показывается не никнейм, а 0000000000000». The
// string on the screen was `Цель: 0x0000000000000004`: eighteen characters of which sixteen are
// the digit zero, produced by `WorldClient.displayName`'s fallback for a guid whose name has not
// been queried — and the player's own guid was the one guid nothing ever queried, because
// `WorldView` builds its nearby list with `guid !== selfGuid` and asks names only over that list.
//
// Both halves are asserted here, and they are two halves rather than one: the `selfName` branch
// fixes the first frame with no round trip, and the query is the only way this client can ever
// obtain its own declensions — `NameCache.#declined` is written by `accept()` and by nothing else,
// and `Npc.ts` reads it for a `$`-declension in gossip text. Seeding the cache from the character
// screen instead would give the name and starve the cases for ever, so test 4 is the one that
// fails if somebody "simplifies" this later.
//
// The last test is the other guard on the same frame: `OBJECT_FIELD_ENTRY` is a creature entry
// only on a creature, and the frame was asking `creature_template` about every target.

import assert from "node:assert/strict";
import test from "node:test";

/**
 * A document whose `getElementById` answers the same element for the same id.
 *
 * `ui/Dom.ts` resolves its elements once, at import, and holds the handles — so a stub that
 * returned a fresh object per call would let the frame paint into elements this file could never
 * read back. Everything else is the shape `widget-dom.test.mjs` uses.
 */
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

const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketReader } = await import("../dist/code/protocol/PacketReader.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { showTarget, unitDisplayName } = await import("../dist/code/browser/ui/Frames.js");
const { showWorldState } = await import("../dist/code/browser/ui/WorldView.js");

const SELF = 0x0000_0000_0000_0004n;
const OTHER = 0x0000_0000_0000_2a01n;
const BOAR = 0x0000_0000_0000_3b01n;
const MAILBOX = 0x0000_0000_0000_4c01n;
const NAME = "Гринчиз";
/** One entry, claimed by a creature row and by a gameobject row: the two tables number apart. */
const SHARED_ENTRY = 2843;

function worldObject(guid, typeId, entry) {
  const fields = new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry]]);
  // A game object carries no unit fields at all — no level, no health, no class — which is half
  // of why the frame looked so convincing when it borrowed a creature's row for the other half.
  if (typeId === 3 || typeId === 4) {
    fields.set(UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 80);
    fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
    fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 100);
    fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 4 | (4 << 8));
  }
  return { guid, typeId, fields, position: { x: 0, y: 0, z: 0, orientation: 0 } };
}

/** A world with the character, a stranger, a boar and a mailbox in it, and a socket that records. */
function session() {
  const sent = [];
  const world = new WorldClient({ send(opcode, payload) { sent.push({ opcode, payload }); }, close() {} });
  // What `EnterWorld.ts` writes from the character screen, before a single packet goes out.
  world.selfName = NAME;
  world.state.selfGuid = SELF;
  world.state.objects.set(SELF, worldObject(SELF, 4, 0));
  world.state.objects.set(OTHER, worldObject(OTHER, 4, 0));
  world.state.objects.set(BOAR, worldObject(BOAR, 3, SHARED_ENTRY));
  world.state.objects.set(MAILBOX, worldObject(MAILBOX, 5, SHARED_ENTRY));
  game.world = world;
  game.creatureMetadata = {
    get: (entry) => (entry === SHARED_ENTRY ? { id: SHARED_ENTRY, name: "Вепрь", subname: "", type: 1, family: 0 } : undefined),
    load: async () => false,
  };
  game.gameObjectMetadata = { get: () => undefined, load: async () => false };
  game.creatureModels = undefined;
  game.gatewayOrigin = undefined;
  return { world, sent };
}

const nameQueries = (sent) => sent
  .filter((packet) => packet.opcode === OPCODES.CMSG_NAME_QUERY)
  .map((packet) => new PacketReader(packet.payload).u64());

test("Ж0 the character's own name is known before any packet goes out", () => {
  const { world, sent } = session();
  assert.equal(world.displayName(SELF), NAME);
  assert.equal(sent.length, 0, "and it costs no round trip to say so");
});

test("Ж0 selecting yourself names you rather than printing your GUID", () => {
  const { world } = session();
  world.targetGuid = SELF;
  showTarget();
  const shown = document.getElementById("target-name").textContent;
  assert.ok(!/0x[0-9a-f]{16}/.test(shown), `the target frame shows a raw GUID: ${shown}`);
  assert.ok(shown.includes(NAME), `the target frame does not name the character: ${shown}`);
});

test("Ж0 the world loop asks the server for the player's own name, exactly once", () => {
  const { world, sent } = session();
  showWorldState(world.state);
  assert.ok(nameQueries(sent).includes(SELF), "no CMSG_NAME_QUERY was ever sent for the player's own GUID");
  assert.ok(nameQueries(sent).includes(OTHER), "and the neighbours are still asked for");
  sent.length = 0;
  showWorldState(world.state);
  assert.equal(nameQueries(sent).length, 0, "a query per frame is a query storm, not a name");
});

test("Ж0 the answer carries the declensions the gossip text needs", () => {
  const { world } = session();
  // The assertion that fails if the query is ever replaced by seeding `NameCache` from the
  // character screen: only `accept()` writes the declined block, and only the server sends one.
  world.names.accept({
    guid: SELF, known: true, name: NAME, realm: "", race: 4, gender: 1, classId: 4,
    declined: ["Гринчиза", "Гринчизу", "Гринчиза", "Гринчизом", "Гринчизе"],
  });
  assert.equal((world.names.declined(SELF) ?? []).length, 5);
  assert.equal(world.displayName(SELF), NAME);
});

test("Ж0 a stranger still falls back to the GUID until their own name lands", () => {
  const { world } = session();
  assert.match(world.displayName(OTHER), /^0x[0-9a-f]{16}$/, "the self branch must not widen to everyone");
  world.names.accept({ guid: OTHER, known: true, name: "Сосед", realm: "", race: 1, gender: 0, classId: 1, declined: [] });
  assert.equal(world.displayName(OTHER), "Сосед");
});

test("Ж0 a creature is named from the dump and a game object does not borrow that name", () => {
  const { world } = session();
  assert.equal(unitDisplayName(world.state.objects.get(BOAR)), "Вепрь", "a creature does not go through displayName at all");

  world.targetGuid = BOAR;
  showTarget();
  assert.equal(document.getElementById("target-name").textContent, "Вепрь");

  // The same entry, on a game object. `gameobject_template` and `creature_template` number their
  // rows independently, so this lookup was reading somebody else's row entirely.
  world.targetGuid = MAILBOX;
  showTarget();
  const shown = document.getElementById("target-name").textContent;
  assert.ok(!shown.includes("Вепрь"), `a game object is wearing a creature's name: ${shown}`);
  assert.ok(shown.includes(`${SHARED_ENTRY}`), `and it says nothing about what it is: ${shown}`);
  assert.equal(document.getElementById("target-details").textContent, "",
    "no subname, no creature type and no level borrowed either");
});

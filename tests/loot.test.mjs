import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import {
  UNIT_DYNFLAG_DEAD,
  UNIT_DYNFLAG_LOOTABLE,
  UNIT_DYNFLAG_TAPPED,
  UNIT_DYNFLAG_TAPPED_BY_PLAYER,
  isLootable,
  isTappedByOther,
  unit,
} from "../dist/code/world/Fields.js";
import {
  LOOT_CORPSE,
  LOOT_NONE,
  LOOT_SLOT_ALLOW_LOOT,
  LOOT_SLOT_LOCKED,
  LOOT_SLOT_OWNER,
  buildAutostoreLootItem,
  buildLootRelease,
  buildLootRequest,
  isLootSlotTakeable,
  lootErrorText,
  parseLootMoneyNotify,
  parseLootReleaseResponse,
  parseLootRemoved,
  parseLootResponse,
} from "../dist/code/world/LootProtocol.js";

// Л1: `UNIT_DYNAMIC_FLAGS`, which was declared three times in this client and read nowhere.
//
// The field is the whole of «which of these bodies still holds something», and until this slice
// nothing on the screen was built from it: the plates, the minimap and the target frame all
// answered from `UNIT_FIELD_HEALTH === 0`, which says a unit is dead and nothing about its loot.
const withDynamicFlags = (flags) => ({
  guid: 1n,
  typeId: 3,
  fields: new Map([[UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset, flags]]),
});

test("Л1 the loot bit and the tap pair are read out of UNIT_DYNAMIC_FLAGS", () => {
  // 0x05 — LOOTABLE|TAPPED: a body with loot on it that somebody else claimed. Both answers are
  // yes, and they are separate answers: the bag is drawn, and the bar is grey.
  const other = withDynamicFlags(UNIT_DYNFLAG_LOOTABLE | UNIT_DYNFLAG_TAPPED);
  assert.equal(isLootable(other), true);
  assert.equal(isTappedByOther(other), true);

  // 0x0d — the same plus TAPPED_BY_PLAYER, which the core adds only for the viewer whose kill it
  // is (`Unit.cpp:14747-14751`). Reading TAPPED alone would grey the player's own kill.
  const mine = withDynamicFlags(UNIT_DYNFLAG_LOOTABLE | UNIT_DYNFLAG_TAPPED | UNIT_DYNFLAG_TAPPED_BY_PLAYER);
  assert.equal(isLootable(mine), true);
  assert.equal(isTappedByOther(mine), false);

  // 0x04 — tapped and empty: somebody else's kill with nothing left on it.
  const spent = withDynamicFlags(UNIT_DYNFLAG_TAPPED);
  assert.equal(isLootable(spent), false);
  assert.equal(isTappedByOther(spent), true);

  // A unit whose flags have never been sent is neither, rather than throwing or reading as zero
  // from some other slot.
  const silent = { guid: 2n, typeId: 3, fields: new Map() };
  assert.equal(unit.dynamicFlags(silent), undefined);
  assert.equal(isLootable(silent), false);
  assert.equal(isTappedByOther(silent), false);
});

test("Л1 UNIT_DYNAMIC_FLAGS is slot 79, which is the trap the reference client fell into", () => {
  // `OBJECT_END(6) + 0x0049`. The reference client read the flags from field 147 —
  // `UNIT_FIELD_PADDING` — for long enough to write the mistake down in a comment
  // (`wowee/src/game/combat_handler.cpp:1287-1293`), and every bit it decided anything on was a
  // bit the server never wrote. This is the assertion that keeps the generator honest about it.
  assert.equal(UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.offset, 79);
  assert.equal(UPDATE_FIELDS.UNIT_DYNAMIC_FLAGS.size, 1);
  // Read through the offset the accessor uses, not through the name, so a shifted table shows up.
  const object = { guid: 3n, typeId: 3, fields: new Map([[79, UNIT_DYNFLAG_LOOTABLE | UNIT_DYNFLAG_DEAD]]) };
  assert.equal(unit.dynamicFlags(object), 0x21);
  assert.equal(isLootable(object), true);
});

// Mirrors Player::SendLoot plus operator<<(ByteBuffer&, LootView const&) and LootItem const&:
// each entry is index, itemid, count, displayid, randomSuffix, randomPropertyId, slot type.
function lootResponse(guid, lootType, gold, items) {
  const size = 8 + 1 + 4 + 1 + items.length * 22;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, guid, true);
  view.setUint8(8, lootType);
  view.setUint32(9, gold, true);
  view.setUint8(13, items.length);
  let offset = 14;
  for (const item of items) {
    view.setUint8(offset, item.index);
    view.setUint32(offset + 1, item.itemId, true);
    view.setUint32(offset + 5, item.count, true);
    view.setUint32(offset + 9, item.displayId, true);
    view.setUint32(offset + 13, item.randomSuffix, true);
    view.setUint32(offset + 17, item.randomPropertyId, true);
    view.setUint8(offset + 21, item.slotType);
    offset += 22;
  }
  return bytes;
}

test("loot response decodes the TrinityCore twenty two byte item layout", () => {
  const payload = lootResponse(0x1234_5678_9abc_def0n, LOOT_CORPSE, 1234, [
    { index: 0, itemId: 2589, count: 3, displayId: 6303, randomSuffix: 0, randomPropertyId: 0, slotType: LOOT_SLOT_ALLOW_LOOT },
    { index: 1, itemId: 25, count: 1, displayId: 1542, randomSuffix: 7, randomPropertyId: 11, slotType: LOOT_SLOT_LOCKED },
  ]);

  const loot = parseLootResponse(payload);
  assert.equal(loot.guid, 0x1234_5678_9abc_def0n);
  assert.equal(loot.lootType, LOOT_CORPSE);
  assert.equal(loot.gold, 1234);
  assert.equal(loot.error, undefined);
  assert.equal(loot.slots.length, 2);
  assert.deepEqual(loot.slots[0], {
    index: 0, itemId: 2589, count: 3, displayId: 6303, randomSuffix: 0, randomPropertyId: 0,
    slotType: LOOT_SLOT_ALLOW_LOOT, taken: false,
  });
  assert.equal(loot.slots[1].randomSuffix, 7);
  assert.equal(loot.slots[1].randomPropertyId, 11);
});

test("a LOOT_NONE response carries an error code instead of a loot list", () => {
  // Player::SendLootError writes guid, LOOT_NONE and the LootError.
  const bytes = new Uint8Array(10);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, 42n, true);
  view.setUint8(8, LOOT_NONE);
  view.setUint8(9, 6);

  const loot = parseLootResponse(bytes);
  assert.equal(loot.lootType, LOOT_NONE);
  assert.equal(loot.error, 6);
  assert.deepEqual(loot.slots, []);
  assert.equal(loot.gold, 0);
  assert.match(lootErrorText(6), /обыскива/i);
  assert.match(lootErrorText(99), /99/);
});

test("only allow-loot and owner slots may be taken, and never twice", () => {
  const allowed = { slotType: LOOT_SLOT_ALLOW_LOOT, taken: false };
  const owner = { slotType: LOOT_SLOT_OWNER, taken: false };
  assert.equal(isLootSlotTakeable(allowed), true);
  assert.equal(isLootSlotTakeable(owner), true);
  assert.equal(isLootSlotTakeable({ slotType: LOOT_SLOT_LOCKED, taken: false }), false);
  assert.equal(isLootSlotTakeable({ ...allowed, taken: true }), false);
});

test("the small loot packets round trip", () => {
  assert.equal(parseLootRemoved(Uint8Array.from([5])), 5);

  const money = new Uint8Array(5);
  new DataView(money.buffer).setUint32(0, 4321, true);
  money[4] = 1;
  assert.deepEqual(parseLootMoneyNotify(money), { amount: 4321, alone: true });

  const release = new Uint8Array(9);
  new DataView(release.buffer).setBigUint64(0, 0xdead_beefn, true);
  release[8] = 1;
  assert.equal(parseLootReleaseResponse(release), 0xdead_beefn);
});

test("client loot packets match the opcodes' expected bodies", () => {
  const request = buildLootRequest(0x0102_0304_0506_0708n);
  assert.equal(request.length, 8);
  assert.equal(new DataView(request.buffer, request.byteOffset).getBigUint64(0, true), 0x0102_0304_0506_0708n);
  assert.equal(buildLootRelease(1n).length, 8);
  assert.deepEqual([...buildAutostoreLootItem(3)], [3]);
});

test("a truncated loot response is rejected rather than silently short", () => {
  const payload = lootResponse(1n, LOOT_CORPSE, 0, [
    { index: 0, itemId: 1, count: 1, displayId: 1, randomSuffix: 0, randomPropertyId: 0, slotType: 0 },
  ]);
  assert.throws(() => parseLootResponse(payload.subarray(0, payload.length - 4)), RangeError);
});

// Ж0: the loot chime, and the three places that played it for nothing.
//
// `showLoot` is not only the loot window's painter. `EnterWorld.ts:635` and `Login.ts:274,365` call
// it to paint the empty window on the way into the world and on the way out, and `playUiSound`
// stood on its first line — so the sound of a full bag was the sound of entering the game. The
// other half is the refusal: the server answers a search it will not allow with a `LootError`, and
// the client played the same chime over the sentence saying no.
//
// The interface is exercised rather than read: `ui/Npc.ts` is imported for real, over the same
// document stub `self-name.test.mjs` uses, and the sound is caught at `game.sound.play`.
function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      title: "", hidden: false, disabled: false, id: "", value: "", type: "",
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
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
// `playUiSound` refuses to repeat itself inside 120 ms, so the clock is the test's to move.
const clock = { now: 1_000 };
globalThis.performance = { now: () => clock.now };

const { game } = await import("../dist/code/browser/game/Context.js");
const { showLoot } = await import("../dist/code/browser/ui/Npc.js");

/** Everything `playUiSound` needs to reach `sound.play`, plus the list of what it played. */
function listen() {
  const played = [];
  game.sound = { play: (kit) => played.push(kit.name) };
  game.soundKits = { named: (name) => (name === "LOOTWINDOWOPENEMPTY" ? 1234 : undefined), kit: (id) => ({ id, name: "LOOTWINDOWOPENEMPTY" }) };
  // `displayIconUrl` because a loot slot now draws its icon from the `displayId` in the loot packet
  // itself, without asking the gateway for a row at all.
  game.itemMetadata = { get: () => undefined, load: async () => false, displayIconUrl: (id) => `/item-icon/${id}` };
  return played;
}

/**
 * A world whose only interesting property is the loot state the window is painted from.
 *
 * `itemTemplate` is here because slice Л2 made the loot window read the template itself — one call
 * per slot, which both orders the row and returns it — so a stub without it is a stub of a
 * `WorldClient` that does not exist. `undefined` is the true answer before the query comes back,
 * which is the state a freshly opened corpse is always in.
 */
const worldWith = (loot) => ({
  loot, takeLootSlot() {}, itemTemplate: () => undefined,
  state: { selfGuid: undefined, objects: new Map() },
});

test("Ж0 the loot chime plays for loot, and not for entering the world or for a refusal", () => {
  const played = listen();
  try {
    // 1. The way into the world: `game.world` is set and its `loot` is undefined, which is the
    //    state `EnterWorld.ts:635` and `Login.ts:274,365` paint from.
    game.world = worldWith(undefined);
    showLoot();
    assert.deepEqual(played, [], "entering the game is not a loot window opening");

    // 2. A refused search. `LootError` 10 is «здесь нечего обыскивать»; the window opens to say so.
    clock.now += 1_000;
    game.world = worldWith({ guid: 1n, lootType: LOOT_NONE, gold: 0, slots: [], error: 10 });
    showLoot();
    assert.deepEqual(played, [], "the client does not answer «нельзя» with the sound of a full bag");

    // 3. And the corpse that did open: gold and one item, no error.
    clock.now += 1_000;
    game.world = worldWith({
      guid: 1n,
      lootType: LOOT_CORPSE,
      gold: 1234,
      slots: [{ index: 0, itemId: 2589, count: 3, displayId: 6303, randomSuffix: 0, randomPropertyId: 0, slotType: LOOT_SLOT_ALLOW_LOOT, taken: false }],
      error: undefined,
    });
    showLoot();
    assert.deepEqual(played, ["LOOTWINDOWOPENEMPTY"]);

    // An empty corpse is still a corpse that opened — «Пусто» in the window, and the chime with it.
    clock.now += 1_000;
    const second = { guid: 1n, lootType: LOOT_CORPSE, gold: 0, slots: [], error: undefined };
    game.world = worldWith(second);
    showLoot();
    assert.deepEqual(played, ["LOOTWINDOWOPENEMPTY", "LOOTWINDOWOPENEMPTY"]);

    // Л2. Repainting the window that is already open is not a window opening. It is repainted when
    // a slot is taken, and — since Л2 — whenever an item query answers while the corpse is open,
    // so a corpse of five unknown items would have chimed six times.
    clock.now += 1_000;
    showLoot();
    clock.now += 1_000;
    showLoot();
    assert.deepEqual(played, ["LOOTWINDOWOPENEMPTY", "LOOTWINDOWOPENEMPTY"], "a repaint is not an opening");

    // Closing and opening the same corpse again is: `WorldClient` builds a fresh `LootWindow` for
    // every `SMSG_LOOT_RESPONSE`, so the guid repeating means nothing.
    clock.now += 1_000;
    game.world = worldWith(undefined);
    showLoot();
    clock.now += 1_000;
    game.world = worldWith({ ...second });
    showLoot();
    assert.equal(played.length, 3, "the same corpse opened twice is two openings");
  } finally {
    game.world = undefined;
    game.sound = undefined;
    game.soundKits = undefined;
    game.itemMetadata = undefined;
  }
});

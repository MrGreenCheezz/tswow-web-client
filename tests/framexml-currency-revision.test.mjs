import assert from "node:assert/strict";
import test from "node:test";

// P1-17 (UI-7): the currency model rebuilds its list when its source's revision, its view state or its
// catalog moved, not on every tick and every C-API read; a source without a revision keeps the old
// rebuild-on-read behaviour. The live revision (CurrencyRevision) moves with the store's field edges.
const { FrameXmlCurrencyModel } = await import("../dist/code/browser/framexml/FrameXmlCurrency.js");
const { FRAMEXML_CANNED_CURRENCY_CATALOG, FRAMEXML_CANNED_CURRENCY_ITEMS, FRAMEXML_CANNED_CURRENCY_KNOWN } =
  await import("../dist/code/browser/framexml/FrameXmlCurrencyCanned.js");
const { CurrencyRevision, createLiveFrameXmlCurrency, FRAMEXML_CURRENCY_TOKEN_SLOTS } =
  await import("../dist/code/browser/framexml/FrameXmlCurrencyLive.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");

/** A source over a plain world object, counting its reads; `revision` only when asked for. */
function countedSource({ withRevision = true, catalog = () => FRAMEXML_CANNED_CURRENCY_CATALOG } = {}) {
  const world = { knownMask: FRAMEXML_CANNED_CURRENCY_KNOWN, honor: 1500, arena: 0, held: new Map([[40752, 12]]) };
  const counts = { snapshot: 0, item: 0 };
  const state = { revision: 0 };
  const source = {
    catalog,
    snapshot: () => { counts.snapshot += 1; return { ...world, held: new Map(world.held) }; },
    item: (entry) => { counts.item += 1; return FRAMEXML_CANNED_CURRENCY_ITEMS.get(entry); },
    ...(withRevision ? { revision: () => state.revision } : {}),
  };
  return { source, world, counts, state };
}

function released(model) {
  const fired = [];
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  model.release();
  return fired;
}

test("1000 ticks at one revision read the snapshot once; a moved revision rebuilds and fires", () => {
  const { source, world, counts, state } = countedSource();
  const model = new FrameXmlCurrencyModel(source);
  const fired = released(model);
  assert.deepEqual(fired, [["KNOWN_CURRENCY_TYPES_UPDATE"]]);
  counts.snapshot = 0;
  counts.item = 0;
  for (let index = 0; index < 1000; index++) model.tick();
  assert.equal(counts.snapshot, 0, "the release tick's build still stands");
  assert.equal(counts.item, 0);
  assert.equal(fired.length, 1);
  world.held.set(40752, 13);
  state.revision += 1;
  for (let index = 0; index < 1000; index++) model.tick();
  assert.equal(counts.snapshot, 1, "one rebuild for one edit");
  assert.deepEqual(fired.at(-1), ["CURRENCY_DISPLAY_UPDATE"]);
  assert.equal(fired.length, 2);
  assert.equal(model.listInfo(5)[5], 13);
});

test("20 GetCurrencyListInfo reads are one snapshot, not one per index", () => {
  const { source, counts, state } = countedSource();
  const model = new FrameXmlCurrencyModel(source);
  released(model);
  state.revision += 1;
  counts.snapshot = 0;
  const size = model.listSize();
  for (let index = 1; index <= 20; index++) model.listInfo(index);
  model.backpackInfo(1);
  assert.equal(model.hasCurrencies(), true);
  assert.equal(size, 6);
  assert.equal(counts.snapshot, 1);
});

test("ExpandCurrencyList, SetCurrencyUnused and SetCurrencyBackpack rebuild at an unchanged revision", () => {
  const { source } = countedSource();
  const reference = countedSource({ withRevision: false });
  const model = new FrameXmlCurrencyModel(source);
  const plain = new FrameXmlCurrencyModel(reference.source);
  const both = (name, ...args) => { model[name](...args); plain[name](...args); };
  released(model);
  assert.equal(model.listSize(), 6);
  both("expand", 1, 0);
  assert.equal(model.listSize(), 4, "collapse");
  assert.deepEqual(model.rows(), plain.rows());
  both("expand", 1, 1);
  both("setUnused", 6, 1);
  assert.equal(model.listSize(), 7, "unused heading");
  assert.deepEqual(model.rows(), plain.rows());
  both("setUnused", 7, 0);
  both("setBackpack", 5, 1);
  assert.equal(model.listInfo(5)[4], true, "watched");
  assert.deepEqual(model.backpackInfo(1), plain.backpackInfo(1));
  assert.deepEqual(model.rows(), plain.rows());
});

test("a catalog that arrives later is noticed without a revision change", () => {
  let catalog;
  const { source, counts } = countedSource({ catalog: undefined });
  delete source.catalog;
  const model = new FrameXmlCurrencyModel(source);
  let loads = 0;
  model.catalogSource = { get current() { return catalog; }, load: () => { loads += 1; } };
  const fired = released(model);
  assert.equal(loads, 1, "the player knows currencies: the one fetch starts");
  assert.equal(model.listSize(), 0);
  counts.snapshot = 0;
  for (let index = 0; index < 100; index++) model.tick();
  assert.equal(counts.snapshot, 0, "the catalog gate reads the kept snapshot");
  fired.length = 0;
  catalog = FRAMEXML_CANNED_CURRENCY_CATALOG;
  model.tick();
  assert.deepEqual(fired, [["KNOWN_CURRENCY_TYPES_UPDATE"]]);
  assert.equal(model.listSize(), 6);
});

test("a prefetch reporting names repaints with the new names at an unchanged revision", () => {
  const { source } = countedSource();
  const names = new Map();
  let report;
  source.item = (entry) => names.get(entry);
  source.prefetch = (_entries, onChanged) => { report = onChanged; };
  const model = new FrameXmlCurrencyModel(source);
  const fired = released(model);
  assert.equal(model.listInfo(5)[0], undefined);
  names.set(40752, { name: "Эмблема героизма" });
  report();
  model.tick();
  assert.deepEqual(fired.at(-1), ["CURRENCY_DISPLAY_UPDATE"]);
  assert.equal(model.listInfo(5)[0], "Эмблема героизма");
});

test("a source without revision rebuilds on every tick and read, as before", () => {
  const { source, counts } = countedSource({ withRevision: false });
  const model = new FrameXmlCurrencyModel(source);
  released(model);
  counts.snapshot = 0;
  for (let index = 0; index < 1000; index++) model.tick();
  assert.equal(counts.snapshot, 1000);
  counts.snapshot = 0;
  for (let index = 1; index <= 20; index++) model.listInfo(index);
  assert.equal(counts.snapshot, 20);
});

test("attach and release start the comparison again, so their first tick fires", () => {
  const { source } = countedSource();
  const model = new FrameXmlCurrencyModel(source);
  const fired = [];
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } });
  model.tick();
  model.tick();
  assert.deepEqual(fired, [], "held until release");
  model.release();
  assert.deepEqual(fired, [["KNOWN_CURRENCY_TYPES_UPDATE"]], "release fires though the build is the held one");
  model.tick();
  model.detach();
  const again = [];
  model.attach({ fire: (event) => { again.push(event); return 1; } });
  model.tick();
  assert.deepEqual(again, ["KNOWN_CURRENCY_TYPES_UPDATE"], "a reattached pump hears the known set");
  const direct = [];
  model.attach({ fire: (event) => { direct.push(event); return 1; } });
  model.tick();
  assert.deepEqual(direct, ["KNOWN_CURRENCY_TYPES_UPDATE"], "an attach without a detach before it, too");
  assert.equal(fired.length, 1);
});

test("rows() with the revision equal rows() without it over random edits", () => {
  const kept = countedSource();
  const plain = countedSource({ withRevision: false });
  const model = new FrameXmlCurrencyModel(kept.source);
  const reference = new FrameXmlCurrencyModel(plain.source);
  released(model);
  released(reference);
  let seed = 7;
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const bits = [0n, 9n, 10n, 11n, 12n];
  for (let step = 0; step < 300; step++) {
    const kind = random(6);
    const edit = (world) => {
      if (kind === 0) world.held.set(random(2) ? 40752 : 40753, random(50));
      else if (kind === 1) world.honor = random(5000);
      else if (kind === 2) world.arena = random(500);
      else if (kind === 3) world.knownMask ^= 1n << bits[random(bits.length)];
    };
    if (kind <= 3) {
      edit(kept.world);
      kept.state.revision += 1;
      // The same world on the reference side.
      Object.assign(plain.world, { ...kept.world, held: new Map(kept.world.held) });
    } else if (kind === 4) {
      const index = 1 + random(8);
      const flag = random(2);
      model.expand(index, flag);
      reference.expand(index, flag);
    } else {
      const index = 1 + random(8);
      const flag = random(2);
      const call = random(2) ? "setUnused" : "setBackpack";
      model[call](index, flag);
      reference[call](index, flag);
    }
    model.tick();
    reference.tick();
    assert.deepEqual(model.rows(), reference.rows(), `step ${step}`);
  }
});

// ---- the live revision -------------------------------------------------------------------

const ITEM = (n) => (0x4000n << 48n) | BigInt(n);
const lo = (guid) => Number(guid & 0xffffffffn);
const hi = (guid) => Number(guid >> 32n);

function liveWorld() {
  const state = new WorldState();
  const store = new WorldStore(state);
  state.selfGuid = 1n;
  const slot = UPDATE_FIELDS.PLAYER_FIELD_CURRENCYTOKEN_SLOT_1.offset;
  state.setField(1n, UPDATE_FIELDS.PLAYER_FIELD_KNOWN_CURRENCIES.offset, 1 << 9);
  state.setField(1n, slot, lo(ITEM(7)));
  state.setField(1n, slot + 1, hi(ITEM(7)));
  state.setField(ITEM(7), UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 40752);
  state.setField(ITEM(7), UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 4);
  store.flush();
  // Count the subscriptions the revision holds on the store.
  const active = { count: 0 };
  for (const name of ["field", "fieldRange"]) {
    const original = store[name].bind(store);
    store[name] = (...args) => {
      const off = original(...args);
      active.count += 1;
      return () => { active.count -= 1; off(); };
    };
  }
  return { state, store, active, slot };
}

test("CurrencyRevision moves with the token slots, the known bits, honor, arena and the token items", () => {
  const live = liveWorld();
  const { state, store } = live;
  const clock = { now: 1_000 };
  const revision = new CurrencyRevision({ world: () => ({ state }), store: () => store, monotonic: () => clock.now });
  assert.equal(revision.revision(), undefined, "not attached: no revision");
  revision.attach();
  assert.equal(live.active.count, 0, "subscriptions are taken on the first read");
  let last = revision.revision();
  const held = live.active.count;
  assert.equal(typeof last, "number");
  assert.equal(revision.revision(), last, "nothing moved");
  const moved = (label, change) => {
    change();
    store.flush();
    const next = revision.revision();
    assert.notEqual(next, last, label);
    assert.ok(next > last, `${label}: monotonic`);
    last = next;
  };
  moved("token slot", () => state.setField(1n, live.slot + 2 * (FRAMEXML_CURRENCY_TOKEN_SLOTS - 1), 5));
  moved("known bits, high word", () => state.setField(1n, UPDATE_FIELDS.PLAYER_FIELD_KNOWN_CURRENCIES.offset + 1, 1));
  moved("honor", () => state.setField(1n, UPDATE_FIELDS.PLAYER_FIELD_HONOR_CURRENCY.offset, 900));
  moved("arena", () => state.setField(1n, UPDATE_FIELDS.PLAYER_FIELD_ARENA_CURRENCY.offset, 30));
  moved("token stack", () => state.setField(ITEM(7), UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 5));
  moved("a new item object", () => state.setField(ITEM(8), UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 40753));
  state.setField(1n, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 1234);
  store.flush();
  assert.equal(revision.revision(), last, "a field the list does not read");
  moved("the item cache's 60 ms poll", () => { clock.now += 60; });
  assert.ok(revision.subscriptions > 0);
  revision.detach();
  assert.equal(revision.revision(), undefined);
  assert.equal(revision.subscriptions, 0);
  assert.equal(live.active.count, held - 4, "the four currency subscriptions are gone");
});

test("with an item revision the clock does not move it; a store double without primitives has none", () => {
  const { state, store } = liveWorld();
  const clock = { now: 1_000 };
  let items = 3;
  const revision = new CurrencyRevision({
    world: () => ({ state }), store: () => store, monotonic: () => clock.now, itemRevision: () => items,
  });
  revision.attach();
  const first = revision.revision();
  clock.now += 10_000;
  assert.equal(revision.revision(), first);
  items += 1;
  assert.notEqual(revision.revision(), first);
  revision.detach();

  const double = { state, events: store.events };
  const none = new CurrencyRevision({ world: () => ({ state }), store: () => double, monotonic: () => clock.now });
  none.attach();
  assert.equal(none.revision(), undefined);
});

test("the live model keeps its rows between ticks and rebuilds on a flushed field edge", () => {
  const { state, store } = liveWorld();
  const clock = { now: 1_000 };
  const model = createLiveFrameXmlCurrency({
    world: () => ({ state }), store: () => store, monotonic: () => clock.now,
  });
  model.catalogSource = { current: FRAMEXML_CANNED_CURRENCY_CATALOG, load() {} };
  const fired = released(model);
  assert.deepEqual(fired, [["KNOWN_CURRENCY_TYPES_UPDATE"]]);
  const rows = model.rows();
  assert.equal(rows.find((row) => row.type?.itemId === 40752)?.count, 4);
  for (let index = 0; index < 50; index++) model.tick();
  assert.equal(model.rows(), rows, "the same build");
  state.setField(ITEM(7), UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 9);
  store.flush();
  model.tick();
  assert.deepEqual(fired.at(-1), ["CURRENCY_DISPLAY_UPDATE"]);
  assert.equal(model.rows().find((row) => row.type?.itemId === 40752)?.count, 9);
  model.detach();
});

import assert from "node:assert/strict";
import test from "node:test";

// 11.02-input: a right click from a vehicle seat without VehicleSeat ALLOWS_INTERACTION 0x80000000 loots
// and talks to nothing — it only swings (world/SeatInteraction.ts, browser/game/SeatClick.ts, the hook in
// ui/Npc.ts `interactWithGuid`). Wow.exe 3.3.5a 12340 (Ghidra read-only, .runtime/re-2026-10-03/l1102input/
// r1.c): 0x00731260 asks 0x006d7aa0 before its corpse and service branches; 0x006d7aa0 is "not seated in a
// vehicle, or the vehicle is out of view, or its kit's seat in the character's slot has 0x80000000".

// ---- a DOM just deep enough for ui/Npc.ts and its windows (as right-click-ordinary-npc.test.mjs) ----

class FakeNode {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.attributes = new Map();
    this.hidden = true;
    this.value = "";
    this.className = "";
    this.textContent = "";
    this.classList = { add() {}, remove() {}, contains: () => false, toggle: () => false };
  }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  remove() {}
  addEventListener() {}
  removeEventListener() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector(selector) { return selector === 'button[type="submit"]' ? new FakeNode("button") : null; }
  querySelectorAll() { return []; }
  contains() { return false; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  getContext() { return {}; }
  focus() {}
  blur() {}
}
globalThis.HTMLElement = FakeNode;
globalThis.HTMLInputElement = class extends FakeNode {};
globalThis.HTMLSelectElement = class extends FakeNode {};
globalThis.HTMLTextAreaElement = class extends FakeNode {};
globalThis.HTMLButtonElement = class extends FakeNode {};
const elements = new Map();
globalThis.document = {
  activeElement: null,
  head: new FakeNode("head"),
  body: new FakeNode("body"),
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_namespace, tag) => new FakeNode(tag),
  createTextNode: (text) => ({ textContent: text }),
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, new FakeNode());
    return elements.get(id);
  },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
};
globalThis.window = {
  innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {}, removeEventListener() {},
};
globalThis.location = window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const { interactWithGuid, closeNpcServiceWindow } = await import("../dist/code/browser/ui/Npc.js");
const { reactionBetween } = await import("../dist/code/world/FactionRules.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { seatAllowsInteraction } = await import("../dist/code/world/SeatInteraction.js");
const { seatClickRefused } = await import("../dist/code/browser/game/SeatClick.js");
const { startVehicleData, vehicleCatalog } = await import("../dist/code/browser/VehicleClient.js");
const {
  VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_COLUMN, VEHICLE_SEAT_FORMAT, vehicleCatalogFrom,
} = await import("../dist/code/world/VehicleDbc.js");

// ---- vehicle tables: a mammoth-like kit (passenger seats with 0x80000000) and a siege-like one ----

const MAMMOTH = 9312;
const SIEGE = 9117;
const SEAT_MAMMOTH = 92764; // 0xde00800b, as Vehicle 312's seats 2764/2765
const SEAT_DRIVER = 91648; // 0x67108a0b, as Vehicle 117's driver 1648
const SEAT_GUNNER = 91649; // 0x4710820b, as its gunners

function vehicleRow(id, seatIds) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  seatIds.forEach((seat, slot) => { row[VEHICLE_COLUMN.SeatID + slot] = seat; });
  return row;
}
function seatRow(id, flags) {
  const row = [...VEHICLE_SEAT_FORMAT].map(() => 0);
  row[VEHICLE_SEAT_COLUMN.ID] = id;
  row[VEHICLE_SEAT_COLUMN.Flags] = flags >>> 0;
  return row;
}
const ANSWER = {
  version: VEHICLE_CATALOG_VERSION,
  vehicles: [vehicleRow(MAMMOTH, [0, SEAT_MAMMOTH, SEAT_MAMMOTH]), vehicleRow(SIEGE, [SEAT_DRIVER, SEAT_GUNNER, 0, 0, 0, 0, 0, 77777])],
  seats: [seatRow(SEAT_MAMMOTH, 0xde00800b), seatRow(SEAT_DRIVER, 0x67108a0b), seatRow(SEAT_GUNNER, 0x4710820b)],
  indicators: [],
  indicatorSeats: [],
};
const CATALOG = vehicleCatalogFrom(JSON.parse(JSON.stringify(ANSWER)));

let gatewayCount = 0;
async function useTables(answer) {
  gatewayCount++;
  const fetch = answer === undefined
    ? () => new Promise(() => {})
    : async () => new Response(JSON.stringify(answer), { status: 200 });
  const client = startVehicleData(`ws://127.0.0.${gatewayCount}:18090`, { fetch });
  if (answer !== undefined) await client.load();
  return vehicleCatalog();
}

// ---- factions (FactionTemplate rows of the dataset, as right-click-ordinary-npc.test.mjs) ----------

const ROWS = {
  1: [1, 3, 2, 12, [], []], // PLAYER, Human
  7: [7, 0, 0, 0, [], []], // Creature (neutral beast)
  12: [72, 2, 2, 4, [], [72]], // Stormwind
  14: [14, 8, 0, 1, [], []], // Monster
  120: [21, 0, 0, 0, [], [21]], // Booty Bay
};
const DATA = { templates: {} };
for (const [id, [faction, factionGroup, friendGroup, enemyGroup, enemies, friends]] of Object.entries(ROWS)) {
  DATA.templates[id] = { faction, factionGroup, friendGroup, enemyGroup, enemies, friends };
}
const FACTIONS = {
  ready: true,
  reaction: (mine, theirs) => reactionBetween(DATA, mine, theirs),
  factionOf: (template) => DATA.templates[template]?.faction,
  factionGroupOf: (template) => DATA.templates[template]?.factionGroup,
  get reputationCatalog() { return { version: 1, factions: { 1: { factionId: 21 }, 19: { factionId: 72 } } }; },
};

const GOSSIP = 0x1;
const VENDOR = 0x80;
const SPELLCLICK = 0x0100_0000;

const SELF = 1n;
const VEHICLE = 0xf150_7d9a_0000_0042n; // HighGuid::Vehicle
const OTHER_PLAYER_VEHICLE = 0x0000_0000_0000_0777n; // a player carrying a kit (a mammoth's owner)
const SHIP = 0x1fc0_0000_0000_0010n;
let nextGuid = 100n;

function unitObject(guid, { typeId = 3, template = 7, npc = 0, health = 100, vehicleId } = {}) {
  return {
    guid, typeId, vehicleId,
    fields: new Map([
      [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health],
      [UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset, template],
      [UPDATE_FIELDS.UNIT_NPC_FLAGS.offset, npc],
    ]),
    position: { x: 0, y: 0, z: 0, orientation: 0 },
  };
}

/** The player seated (or not) and one target unit; every request the click makes is recorded. */
function worldWith(target, { seat, carrier } = {}) {
  const calls = [];
  const record = (kind) => (guid) => { calls.push(kind); assert.equal(guid, target.guid); };
  const self = unitObject(SELF, { typeId: 4, template: 1 });
  self.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x8);
  if (seat) self.transport = { x: 0, y: 0, z: 2, orientation: 0, ...seat };
  const objects = new Map([[SELF, self], [target.guid, target]]);
  if (carrier) objects.set(carrier.guid, carrier);
  return {
    calls,
    state: { selfGuid: SELF, objects },
    targetGuid: undefined, chatLog: [], forcedReactions: new Map(), creatureTemplates: new Map(),
    questGiverStatus: new Map(), group: undefined,
    // L15-review: the server's SMSG_INITIALIZE_FACTIONS row for Booty Bay (list 1, at peace); without a row
    // the click keeps the template masks (game/Targeting.ts `reputationListFor`).
    factions: new Map([[1, { listId: 1, flags: 0x40, standing: 0 }]]), // L15-review
    selectTarget(guid) { this.targetGuid = guid; },
    startAttack() { calls.push("attack"); assert.equal(this.targetGuid, target.guid); },
    openGossip: record("gossip"), openQuestList: record("quests"), openVendor: record("vendor"),
    openTrainer: record("trainer"), openBank: record("bank"), requestTaxiMenu: record("taxi"),
    openAuctionHouse: record("auction"), battlemasterHello: record("battlemaster"), openLoot: record("loot"),
    spellClick: record("spellclick"), enterPlayerVehicle: record("vehicle"),
    closeNpcServices() {}, closeAuctionHouse() {}, cancelTrade() {}, closeBank() {}, closeLoot() {},
    aurasFor: () => [], displayName: () => "",
  };
}

/** What one right click on a unit asks of the world while the player sits where `place` says. */
function click(spec, place = {}) {
  const guid = nextGuid++;
  const target = unitObject(guid, spec);
  const world = worldWith(target, place);
  const previousWorld = game.world;
  const previousFactions = game.factions;
  game.world = world;
  game.factions = FACTIONS;
  try {
    interactWithGuid(guid);
    closeNpcServiceWindow();
    return world.calls;
  } finally {
    game.world = previousWorld;
    game.factions = previousFactions;
  }
}

const siege = () => unitObject(VEHICLE, { vehicleId: SIEGE });
const mammoth = () => unitObject(OTHER_PLAYER_VEHICLE, { typeId: 4, vehicleId: MAMMOTH });
const DRIVER = { seat: { guid: VEHICLE, seat: 0 }, carrier: siege() };
const PASSENGER = { seat: { guid: OTHER_PLAYER_VEHICLE, seat: 1 }, carrier: mammoth() };

const TARGETS = [
  ["a Stormwind vendor", { template: 12, npc: GOSSIP | VENDOR }],
  ["the neutral Booty Bay innkeeper", { template: 120, npc: GOSSIP | VENDOR }],
  ["a monster", { template: 14 }],
  ["a neutral beast", { template: 7 }],
  ["a monster's corpse", { template: 14, health: 0 }],
  ["a vehicle with a spell click", { template: 12, npc: SPELLCLICK }],
];

test("11.02-input: 0x006d7aa0 — the seat's ALLOWS_INTERACTION, and yes wherever no seat row is in the way", () => {
  const objects = (self, carrier) => new Map([[SELF, self], ...(carrier ? [[carrier.guid, carrier]] : [])]);
  const seated = (seat) => ({ ...unitObject(SELF, { typeId: 4 }), transport: { x: 0, y: 0, z: 0, orientation: 0, ...seat } });
  // Not seated, or no tables: yes.
  assert.equal(seatAllowsInteraction(CATALOG, objects(unitObject(SELF, { typeId: 4 })), SELF), true);
  assert.equal(seatAllowsInteraction(undefined, objects(seated({ guid: VEHICLE, seat: 0 }), siege()), SELF), true, "no tables");
  assert.equal(seatAllowsInteraction(CATALOG, objects(seated({ guid: VEHICLE, seat: 0 }), siege()), undefined), true);
  // The siege engine's driver (0x67108a0b) and gunner (0x4710820b): no. A mammoth's passenger (0xde00800b): yes.
  assert.equal(seatAllowsInteraction(CATALOG, objects(seated({ guid: VEHICLE, seat: 0 }), siege()), SELF), false);
  assert.equal(seatAllowsInteraction(CATALOG, objects(seated({ guid: VEHICLE, seat: 1 }), siege()), SELF), false);
  assert.equal(seatAllowsInteraction(CATALOG, objects(seated({ guid: OTHER_PLAYER_VEHICLE, seat: 1 }), mammoth()), SELF), true);
  // The kit has no seat row in that slot (an empty slot, a seat id the table lacks), or there is no kit: no.
  assert.equal(seatAllowsInteraction(CATALOG, objects(seated({ guid: VEHICLE, seat: 2 }), siege()), SELF), false);
  assert.equal(seatAllowsInteraction(CATALOG, objects(seated({ guid: VEHICLE, seat: 7 }), siege()), SELF), false);
  assert.equal(seatAllowsInteraction(CATALOG, objects(seated({ guid: VEHICLE, seat: 0 }), unitObject(VEHICLE)), SELF), false,
    "a carrier in view without a vehicle kit");
  // The vehicle out of view, a ship, a HighGuid::Unit creature: 0x0074b8b0 / 0x004d4db0 say yes.
  assert.equal(seatAllowsInteraction(CATALOG, objects(seated({ guid: VEHICLE, seat: 0 })), SELF), true, "out of view");
  assert.equal(seatAllowsInteraction(CATALOG, objects(seated({ guid: SHIP, seat: 0 }), unitObject(SHIP)), SELF), true, "a ship");
  const creature = 0xf130_0000_0000_0042n;
  assert.equal(seatAllowsInteraction(CATALOG, objects(seated({ guid: creature, seat: 0 }),
    unitObject(creature, { vehicleId: SIEGE })), SELF), true, "HighGuid::Unit is not a vehicle carrier (0x0074b8b0)");
});

test("11.02-input: from the siege engine's seats a right click only swings — no talk, no loot, no seat", async () => {
  await useTables(ANSWER);
  try {
    const expected = new Map([
      ["a Stormwind vendor", []],
      // L15 5.05: Booty Bay keeps a reputation, and a player at peace with it is its friend for CanAttack
      // (0x007251c0, branch 0x007253ca; game/Targeting.ts `attackReactionTo`): no swing either (was ["attack"]).
      ["the neutral Booty Bay innkeeper", []],
      ["a monster", ["attack"]],
      ["a neutral beast", ["attack"]],
      ["a monster's corpse", []],
      ["a vehicle with a spell click", []],
    ]);
    for (const [name, spec] of TARGETS) assert.deepEqual(click(spec, DRIVER), expected.get(name), `driver: ${name}`);
    // The gunner's seat (no CAN_CONTROL, no ALLOWS_INTERACTION) is gated the same way.
    assert.deepEqual(click({ template: 12, npc: GOSSIP | VENDOR }, { seat: { guid: VEHICLE, seat: 1 }, carrier: siege() }), []);
  } finally {
    await useTables(undefined);
  }
});

test("11.02-input: a mammoth's passenger, a character on foot and a page without tables click as before", async () => {
  const ordinary = new Map([
    ["a Stormwind vendor", ["gossip"]],
    ["the neutral Booty Bay innkeeper", ["gossip"]],
    ["a monster", ["attack"]],
    ["a neutral beast", ["attack"]],
    ["a monster's corpse", ["loot"]],
    ["a vehicle with a spell click", ["spellclick"]],
  ]);
  await useTables(ANSWER);
  try {
    for (const [name, spec] of TARGETS) assert.deepEqual(click(spec, PASSENGER), ordinary.get(name), `mammoth passenger: ${name}`);
    for (const [name, spec] of TARGETS) assert.deepEqual(click(spec), ordinary.get(name), `on foot: ${name}`);
  } finally {
    await useTables(undefined);
  }
  assert.equal(vehicleCatalog(), undefined);
  for (const [name, spec] of TARGETS) assert.deepEqual(click(spec, DRIVER), ordinary.get(name), `no tables: ${name}`);
});

test("11.02-input: the gate leaves game objects alone and a ghost never swings from a seat", () => {
  const world = worldWith(unitObject(nextGuid++, { template: 14 }), DRIVER);
  const chest = { guid: 5n, typeId: 5, fields: new Map(), position: { x: 0, y: 0, z: 0, orientation: 0 } };
  assert.equal(seatClickRefused(world, chest, CATALOG), false, "0x00731260 is the unit's click");
  const previous = game.factions;
  game.factions = FACTIONS;
  try {
    const monster = world.state.objects.get(nextGuid - 1n);
    world.state.objects.get(SELF).fields.set(UPDATE_FIELDS.PLAYER_FLAGS.offset, 0x10);
    assert.equal(seatClickRefused(world, monster, CATALOG), true);
    assert.deepEqual(world.calls, [], "a ghost's click is spent and swings at nothing");
    world.state.objects.get(SELF).fields.set(UPDATE_FIELDS.PLAYER_FLAGS.offset, 0);
    assert.equal(seatClickRefused(world, monster, CATALOG), true);
    assert.deepEqual(world.calls, ["attack"]);
  } finally {
    game.factions = previous;
  }
});

test("11.02-input review: a player is a unit too — from the siege seat a group member's vehicle is not boarded", async () => {
  // 0x00731260 is the click on any unit, a player included; its service branch (0x00729530 → 0x006ddbb0)
  // is where a group member's vehicle (UNIT_NPC_FLAG_PLAYER_VEHICLE 0x02000000) is entered, and a seat
  // without ALLOWS_INTERACTION skips it. On foot the same click boards.
  const rideOn = (place) => {
    const guid = nextGuid++;
    const owner = unitObject(guid, { typeId: 4, template: 1, npc: 0x0200_0000, vehicleId: MAMMOTH });
    const world = worldWith(owner, place);
    world.group = { members: [{ guid }] };
    const previousWorld = game.world;
    const previousFactions = game.factions;
    game.world = world;
    game.factions = FACTIONS;
    try {
      interactWithGuid(guid);
      return world.calls;
    } finally {
      game.world = previousWorld;
      game.factions = previousFactions;
    }
  };
  await useTables(ANSWER);
  try {
    assert.deepEqual(rideOn({}), ["vehicle"], "on foot: the group member's vehicle");
    assert.deepEqual(rideOn(DRIVER), [], "from the siege engine's driving seat: nothing (a friend is no swing)");
  } finally {
    await useTables(undefined);
  }
});

test("11.02-input: the hook stands in ui/Npc.ts before the corpse branch, after the game objects", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/browser/ui/Npc.ts", import.meta.url), "utf8");
  const hook = source.indexOf("seatClickRefused(world, target)");
  assert.ok(hook > 0, "the hook is there");
  assert.ok(hook > source.indexOf("if (target.typeId === 5) {"), "after the game objects");
  assert.ok(hook < source.indexOf("isWorldObjectDead(target)"), "before the corpse branch");
});

test("11.02-input: the dataset — mammoth passengers interact, the siege engine's crew does not", async (t) => {
  const { existsSync } = await import("node:fs");
  const DATASET_DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
  if (!existsSync(DATASET_DBC)) {
    t.skip("no dataset");
    return;
  }
  const { loadVehicles } = await import("../dist/code/gateway/VehicleMetadata.js");
  const real = vehicleCatalogFrom(JSON.parse(JSON.stringify(await loadVehicles(DATASET_DBC))));
  const seated = (vehicleId, guid, slot) => {
    const carrier = unitObject(guid, { typeId: guid === VEHICLE ? 3 : 4, vehicleId });
    const self = { ...unitObject(SELF, { typeId: 4 }), transport: { guid, x: 0, y: 0, z: 0, orientation: 0, seat: slot } };
    return seatAllowsInteraction(real, new Map([[SELF, self], [guid, carrier]]), SELF);
  };
  assert.equal(seated(312, OTHER_PLAYER_VEHICLE, 1), true, "Vehicle 312, seat 2764");
  assert.equal(seated(313, OTHER_PLAYER_VEHICLE, 2), true, "Vehicle 313, seat 2768");
  assert.equal(seated(318, OTHER_PLAYER_VEHICLE, 1), true, "the chopper's sidecar 2804");
  assert.equal(seated(117, VEHICLE, 0), false, "the siege engine's driver 1648");
  assert.equal(seated(117, VEHICLE, 1), false, "its gunner 1649");
  assert.equal(seated(116, VEHICLE, 0), false, "the turret's gunner 1643");
});

import assert from "node:assert/strict";
import test from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";
import { isolatedModule, isolatedUi } from "./fixtures/isolated-ui.mjs";

// 11.02-F2: keys 1–= and the native main row while the character drives a vehicle — Wow.exe 3.3.5a's
// 0x005d4ad0 puts the vehicle's bar (VehicleSpellInitialize, slot words 8…15) on the main bar when the
// rider's seat has VehicleAbilityDisplay 1, GetBonusBarOffset is then 5 and stock ActionButtonDown/Up
// (ActionButton.lua:15-42) send keys 1–6 to VehicleMenuBarActionButton1–6 (VEHICLE_MAX_ACTIONBUTTONS, the
// buttons are alwaysBonus: page 6 + 5, slots 121–126) and 7–= to BonusActionButton7–12 (127–132) — the
// possess page, which the native bar already answers (ui/PossessActionBar.ts). Without the vehicle tables
// the keys stay the character's own; and with them, play without a vehicle is unchanged (a differential).
// Also the review's open point: the native model holds the world it read only weakly.

installFakeUiDocument();

const protocol = await import("../dist/code/world/ActionBarProtocol.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");
const spellMetadata = await import("../dist/code/browser/SpellMetadata.js");
const context = await import("../dist/code/browser/game/Context.js");
const bonusBar = await import("../dist/code/browser/game/BonusBar.js");
const possessBar = await import("../dist/code/world/PossessBar.js");
const petProtocol = await import("../dist/code/world/PetProtocol.js");
const possessModel = await import("../dist/code/browser/framexml/FrameXmlPossess.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const {
  VEHICLE_CATALOG_VERSION, VEHICLE_COLUMN, VEHICLE_FORMAT, VEHICLE_SEAT_COLUMN, VEHICLE_SEAT_FORMAT, vehicleCatalogFrom,
} = await import("../dist/code/world/VehicleDbc.js");
const { ACTION_BUTTON_SPELL } = protocol;
const { ACT_COMMAND, ACT_PASSIVE, COMMAND_ATTACK, COMMAND_FOLLOW, REACT_DEFENSIVE, packPetAction } = petProtocol;
const { game } = context;

const SELF = 0x10n;
const ENGINE = 0xf150_0074_9800_0101n;
const CART = 0xf150_0385_0000_0103n;
const MOB = 0xf130_0000_0004_d2a0n;
const OWN = [100, 101, 102, 103, 104, 105, 106];
const RAM = 62345;
const F = (name) => UPDATE_FIELDS[name].offset;

function vehicleRow({ id, seats }) {
  const row = [...VEHICLE_FORMAT].map((kind) => (kind === "s" ? "" : 0));
  row[VEHICLE_COLUMN.ID] = id;
  seats.forEach((seat, slot) => { row[VEHICLE_COLUMN.SeatID + slot] = seat; });
  return row;
}
function seatRow({ id, flags, ability }) {
  const row = [...VEHICLE_SEAT_FORMAT].map(() => 0);
  row[VEHICLE_SEAT_COLUMN.ID] = id;
  row[VEHICLE_SEAT_COLUMN.Flags] = flags;
  row[VEHICLE_SEAT_COLUMN.VehicleAbilityDisplay] = ability;
  return row;
}
// Siege engine 117's driver seat 1648 (VehicleAbilityDisplay 1) and a cart whose driver keeps its abilities
// on the pet bar (VehicleAbilityDisplay 0, 18 such seats in the dataset).
const catalog = vehicleCatalogFrom({
  version: VEHICLE_CATALOG_VERSION,
  vehicles: [vehicleRow({ id: 117, seats: [1648] }), vehicleRow({ id: 901, seats: [9010] })],
  seats: [seatRow({ id: 1648, flags: 0x67108a0b, ability: 1 }), seatRow({ id: 9010, flags: 0x20000800, ability: 0 })],
  indicators: [],
  indicatorSeats: [],
});

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    let set = this.#listeners.get(name);
    if (!set) { set = new Set(); this.#listeners.set(name, set); }
    set.add(listener);
    // As world/EventBus.ts: the unsubscribe reaches the whole bus (`this`), not only this name's set.
    return () => { this.#listeners.get(name)?.delete(listener); };
  }
  emit(name, payload) { for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload); }
  count(name) { return this.#listeners.get(name)?.size ?? 0; }
}

function setGuid(object, offset, guid) {
  object.fields.set(offset, Number(guid & 0xffff_ffffn));
  object.fields.set(offset + 1, Number(guid >> 32n));
}

function object(guid, typeId, fields, extra = {}) {
  return { guid, typeId, position: { x: 0, y: 0, z: 0, orientation: 0 }, movementFlags: 0, updateFlags: 0, fields: new Map(fields), transport: undefined, ...extra };
}

/** `VehicleSpellInitialize`: spells in slots 0…7 with the slot + 8 as the state byte. */
function vehicleBar(guid, spells) {
  return {
    guid, closed: false, creatureFamily: 0, duration: 0, reactState: REACT_DEFENSIVE, commandState: COMMAND_FOLLOW, flags: 0,
    spells: [], cooldowns: [],
    bar: Array.from({ length: 10 }, (_, slot) => {
      const packed = packPetAction(spells[slot] ?? 0, slot + 8);
      return { slot, packed, action: packed & 0xffffff, type: packed >>> 24 };
    }),
  };
}

function worldFixture() {
  const player = object(SELF, 4, [[F("UNIT_FIELD_FLAGS"), 0x08], [F("UNIT_FIELD_HEALTH"), 100], [F("UNIT_FIELD_BYTES_0"), 1 << 8]]);
  const engine = object(ENGINE, 3, [[F("UNIT_FIELD_HEALTH"), 500]], { vehicleId: 117 });
  const cart = object(CART, 3, [[F("UNIT_FIELD_HEALTH"), 500]], { vehicleId: 901 });
  const mob = object(MOB, 3, [[F("UNIT_FIELD_HEALTH"), 500]]);
  const used = [];
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, player], [ENGINE, engine], [CART, cart], [MOB, mob]]), revision: 1 },
    events: new FakeEvents(),
    knownSpells: [],
    actionButtons: OWN.map((action, slot) => ({ slot, action, type: ACTION_BUTTON_SPELL })),
    petSpells: undefined,
    controlledGuid: SELF,
    targetGuid: undefined,
    creatureTemplates: new Map(),
    aurasFor: () => [],
    cooldownRemaining: () => 0,
    cooldownState: () => undefined,
    petCooldownRemaining: () => 0,
    isActiveMountSpell: () => false,
    setActionButton: () => {},
    usePetSlot(slot, target) { used.push([slot, target]); },
    casts: new Map(),
    names: new Map(),
    partyStats: new Map(),
    totems: new Map(),
    petCooldowns: new Map(),
  };
  const bump = () => { world.state.revision += 1; };
  // As in the client, the world's own bus holds listeners that know the world (WorldClient's handlers,
  // the panels' closures): whatever keeps the bus keeps the world.
  world.events.on("WORLD_ECHO", () => world.state);
  return {
    world, player, used, bump,
    /** Unit::SetCharmedBy(VEHICLE) and the seat: control, the bar, far sight and charm, the transport. */
    drive(vehicle = ENGINE) {
      world.controlledGuid = vehicle;
      world.petSpells = vehicleBar(vehicle, [RAM, RAM + 1, 0, RAM + 3, RAM + 4, RAM + 5, RAM + 6, RAM + 7]);
      world.events.emit("PET_BAR_CHANGED", { guid: vehicle });
      setGuid(player, F("UNIT_FIELD_CHARM"), vehicle);
      setGuid(player, F("PLAYER_FARSIGHT"), vehicle);
      player.transport = { guid: vehicle, x: 0, y: 0, z: 0, orientation: 0, seat: 0 };
      bump();
    },
    leave() {
      world.controlledGuid = SELF;
      world.petSpells = undefined;
      world.events.emit("PET_BAR_CHANGED", { guid: 0n });
      setGuid(player, F("UNIT_FIELD_CHARM"), 0n);
      setGuid(player, F("PLAYER_FARSIGHT"), 0n);
      player.transport = undefined;
      bump();
    },
  };
}

const SPELL_ROWS = new Map([
  ...OWN.map((id) => [id, { id, name: `Своё ${id}`, iconId: id }]),
  [RAM, { id: RAM, name: "Таран", iconId: 7 }],
]);

/** `fixture` may be a holder `{ fixture }` the test can empty (the GC test must not keep the world here). */
async function nativeBar(given, tables) {
  const holder = given && "fixture" in given ? given : { fixture: given };
  const casts = [];
  const actionBar = document.createElement("div");
  class IconButton {
    constructor(options) {
      this.options = options;
      this.listeners = {};
      this.root = document.createElement("button");
      this.root.addEventListener = (name, listener) => { this.listeners[name] = listener; };
    }
    setContent(content) { this.content = content; }
    setCooldown(fraction) { this.cooldown = fraction; }
    setUsable(usable) { this.usable = usable; }
  }
  game.world = holder.fixture?.world;
  game.spells.clear();
  for (const [id, row] of SPELL_ROWS) game.spells.set(id, { passive: false, startRecoveryTime: 0, effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], ...row });
  const possessUi = await isolatedUi("PossessActionBar", {
    "../../world/PetProtocol.js": petProtocol,
    "../../world/PossessBar.js": possessBar,
    "../framexml/FrameXmlPossess.js": possessModel,
    "../game/Context.js": context,
    "../VehicleClient.js": { vehicleCatalog: () => tables },
    "./Format.js": { unknownLabel: (kind, id) => `${kind} ${id}` },
    "./IconImage.js": { spellIconUrl: (iconId) => `icon ${iconId}` },
    "./SpellNames.js": { ensureSpellNames: () => {} },
  });
  const bar = await isolatedUi("ActionBar", {
    "../../world/ActionBarProtocol.js": protocol,
    "./ActionDrag.js": await import("../dist/code/browser/ui/ActionDrag.js"),
    "../input/Bindings.js": bindings,
    "../game/Context.js": context,
    "../game/BonusBar.js": bonusBar,
    "./PossessActionBar.js": possessUi,
    "../SpellMetadata.js": spellMetadata,
    "../SpellCastGuard.js": { spellPowerAvailable: () => true },
    "../../world/WorldClient.js": { MELEE_AUTO_ATTACK_SPELL_ID: 6603 },
    "./Spellbook.js": { castSpell: (id) => { casts.push(id); return true; }, highestKnownRank: (id) => id, spellTooltip: (id) => ({ title: `spell ${id}` }) },
    "./Dom.js": { actionBar },
    "./Widgets.js": { IconButton, attachTooltip: () => {}, cooldownDuration: () => 0, cooldownLabel: () => "", cooldownView: () => ({ fraction: 0, remaining: 0 }) },
    "./IconImage.js": { spellIconUrl: (iconId) => `icon ${iconId}` },
    "./SpellNames.js": { ensureSpellNames: () => {} },
  });
  const actions = await isolatedModule("browser/input/Actions", {
    "../ui/ActionBar.js": bar,
    "./Bindings.js": bindings,
    "../../world/ActionBarProtocol.js": protocol,
    "../game/Context.js": context,
  });
  return {
    bar, possessUi,
    /** Keys 1–= one after another: what the character cast and which vehicle/pet slots were pressed. */
    keys() {
      const result = [];
      for (let key = 1; key <= 12; key++) {
        casts.length = 0;
        const fixture = holder.fixture;
        if (fixture) fixture.used.length = 0;
        actions.runAction(`action${key}`);
        result.push({ casts: casts.slice(), pet: fixture ? fixture.used.map(([slot]) => slot) : [] });
      }
      return result;
    },
    row: () => actionBar.children.map((root) => root.textContent),
    dispose() {
      game.world = undefined;
      game.spells.clear();
    },
  };
}

const ownKeys = () => Array.from({ length: 12 }, (_, index) => ({ casts: index < OWN.length ? [OWN[index]] : [], pet: [] }));

test("11.02-F2: the driver's keys 1–6 fire the vehicle's spells (CMSG_PET_CAST_SPELL), 7–= its later slots; home again after", async () => {
  const fixture = worldFixture();
  const native = await nativeBar(fixture, catalog);
  try {
    native.bar.showActionBar();
    assert.deepEqual(native.keys(), ownKeys(), "on foot: the character's own slots");
    fixture.drive();
    native.bar.updateActionBar(1_000);
    assert.equal(native.possessUi.possessKeyPage(), 10, "page 11 (0-based 10): the vehicle's bar on the main bar");
    const keys = native.keys();
    assert.deepEqual(keys.slice(0, 6).map((key) => key.pet), [[0], [1], [2], [3], [4], [5]],
      "VehicleMenuBarActionButton1-6: slots 0-5 of the vehicle bar (WorldClient sends nothing for the empty slot 2)");
    assert.deepEqual(keys.slice(6).map((key) => key.pet), [[6], [7], [8], [9], [], []],
      "BonusActionButton7-12: slots 6-9 (8-9 empty words), 131-132 no slot");
    assert.ok(keys.every((key) => key.casts.length === 0), "no character cast");
    fixture.leave();
    native.bar.updateActionBar(2_000);
    assert.deepEqual(native.keys(), ownKeys(), "home");
  } finally {
    native.dispose();
  }
});

test("11.02-F2: VehicleAbilityDisplay 0, and no vehicle tables, leave the keys the character's own", async () => {
  const fixture = worldFixture();
  const cart = await nativeBar(fixture, catalog);
  try {
    cart.bar.showActionBar();
    fixture.drive(CART);
    cart.bar.updateActionBar(1_000);
    assert.equal(cart.possessUi.possessKeyPage(), undefined, "seat 9010 keeps the abilities on the pet bar");
    assert.deepEqual(cart.keys(), ownKeys());
  } finally {
    cart.dispose();
  }
  const other = worldFixture();
  const without = await nativeBar(other, undefined);
  try {
    without.bar.showActionBar();
    other.drive();
    without.bar.updateActionBar(1_000);
    assert.equal(without.possessUi.possessKeyPage(), undefined, "no tables: as before F2");
    assert.deepEqual(without.keys(), ownKeys());
  } finally {
    without.dispose();
  }
});

test("11.02-F2: no vehicle — the keys and the row are the same with and without the vehicle tables (differential)", async () => {
  const states = [
    ["on foot", () => {}],
    ["a hunter's pet bar", (fixture) => {
      fixture.world.petSpells = { ...vehicleBar(MOB, []), bar: [packPetAction(COMMAND_ATTACK, ACT_COMMAND), packPetAction(RAM, ACT_PASSIVE)]
        .map((packed, slot) => ({ slot, packed, action: packed & 0xffffff, type: packed >>> 24 })) };
      fixture.world.events.emit("PET_BAR_CHANGED", { guid: MOB });
      fixture.bump();
    }],
    ["possession", (fixture) => {
      fixture.world.controlledGuid = MOB;
      fixture.world.petSpells = { ...vehicleBar(MOB, []), bar: [packPetAction(COMMAND_ATTACK, ACT_COMMAND), packPetAction(RAM, ACT_PASSIVE)]
        .map((packed, slot) => ({ slot, packed, action: packed & 0xffffff, type: packed >>> 24 })) };
      fixture.world.events.emit("PET_BAR_CHANGED", { guid: MOB });
      setGuid(fixture.player, F("PLAYER_FARSIGHT"), MOB);
      fixture.bump();
    }],
    ["on a ship", (fixture) => {
      fixture.player.transport = { guid: 0x1fc0_0000_0000_0104n, x: 0, y: 0, z: 0, orientation: 0, seat: 0 };
      fixture.bump();
    }],
  ];
  for (const [name, apply] of states) {
    const outcomes = [];
    for (const tables of [undefined, catalog]) {
      const fixture = worldFixture();
      const native = await nativeBar(fixture, tables);
      try {
        native.bar.showActionBar();
        apply(fixture);
        native.bar.updateActionBar(1_000);
        outcomes.push({ page: native.possessUi.possessKeyPage(), keys: native.keys() });
      } finally {
        native.dispose();
      }
    }
    assert.deepEqual(outcomes[1], outcomes[0], `${name}: the same with the tables`);
  }
});

test("11.02-F2: the native model holds the last world only weakly — gone after a logout (PossessActionBar.ts)", async () => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc");
  const holder = { fixture: worldFixture() };
  let fixture = holder.fixture;
  const native = await nativeBar(holder, catalog);
  native.bar.showActionBar();
  fixture.drive();
  native.bar.updateActionBar(1_000);
  assert.equal(native.possessUi.possessKeyPage(), 10, "the model read this world");
  assert.equal(fixture.world.events.count("PET_BAR_CHANGED"), 1, "it follows the world's bar packets");
  const gone = new WeakRef(fixture.world);
  // Logout: clearWorldContext drops game.world and the character list asks the bar nothing.
  game.world = undefined;
  fixture = undefined;
  holder.fixture = undefined;
  for (let round = 0; round < 6 && gone.deref() !== undefined; round++) {
    await new Promise((resolve) => setImmediate(resolve));
    gc();
  }
  assert.equal(gone.deref(), undefined, "the last WorldClient was collected");
  native.dispose();
});

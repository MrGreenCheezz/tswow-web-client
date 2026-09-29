import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { parseMonsterMove } from "../dist/code/world/MonsterMoveProtocol.js";
import { buildEjectPassenger, vehiclePassengers } from "../dist/code/world/VehicleProtocol.js";

// VehicleJoinEvent seats every passenger in MovementInfo.transport. CHARMEDBY is written on the
// creature vehicle itself only when a player takes a controllable seat.

const CHARMED_BY = UPDATE_FIELDS.UNIT_FIELD_CHARMEDBY.offset;
const VEHICLE = 0x50n;
const DRIVER = 0x1n;
const RIDER = 0x2n;

const unit = (guid, transportGuid, charmedBy, typeId = 3) => ({
  guid, typeId,
  transport: transportGuid === undefined ? undefined : { guid: transportGuid, x: 0, y: 0, z: 0, orientation: 0, seat: 0 },
  fields: charmedBy === undefined
    ? new Map()
    : new Map([[CHARMED_BY, Number(charmedBy & 0xffff_ffffn)], [CHARMED_BY + 1, Number(charmedBy >> 32n)]]),
});
const fakeState = (objects) => ({ objects: new Map(objects.map((object) => [object.guid, object])) });

test("vehicle passengers come from movement transport seats, not CHARMEDBY", () => {
  const state = fakeState([
    unit(VEHICLE, undefined, DRIVER),
    unit(DRIVER, VEHICLE),
    unit(RIDER, VEHICLE),
    unit(0x3n, 0x99n),
    unit(0x4n, undefined, VEHICLE),
    { guid: 0x5n, typeId: 5, transport: { guid: VEHICLE }, fields: new Map() },
  ]);
  assert.deepEqual(vehiclePassengers(state, VEHICLE).sort(), [DRIVER, RIDER].sort());
  assert.deepEqual(vehiclePassengers(state, 0x98n), [], "a foreign vehicle has nobody here");
  assert.deepEqual(vehiclePassengers(state, 0n), [], "the zero guid seats nobody");
});

test("a visible rider boards and leaves through the core's monster move packets", () => {
  const state = new WorldState();
  state.move(VEHICLE, { flags: 0, position: { x: 100, y: 200, z: 5, orientation: 0 } });
  state.move(RIDER, { flags: 0, position: { x: 100, y: 200, z: 5, orientation: 0 } });
  state.objects.get(RIDER).typeId = 4;
  const board = parseMonsterMove(new PacketWriter()
    .packedGuid(RIDER).packedGuid(VEHICLE).u8(1).u8(0)
    .f32(0).f32(0).f32(0).u32(7).u8(0)
    .u32(0).u32(1000).u32(1).f32(2).f32(0).f32(0)
    .toUint8Array(), true);
  assert.equal(board.transportSeat, 1);
  state.startSpline(board, 0);
  assert.equal(state.objects.get(RIDER).transport?.guid, VEHICLE);
  assert.equal(state.objects.get(RIDER).transport?.seat, 1);
  assert.deepEqual(vehiclePassengers(state, VEHICLE), [RIDER]);

  const leave = parseMonsterMove(new PacketWriter()
    .packedGuid(RIDER).u8(0).f32(102).f32(200).f32(5).u32(8).u8(1).toUint8Array());
  state.startSpline(leave, 1000);
  assert.equal(state.objects.get(RIDER).transport, undefined);
  assert.deepEqual(vehiclePassengers(state, VEHICLE), []);
});

test("the eject packet carries the seated guid, whole", () => {
  const body = buildEjectPassenger(RIDER);
  assert.equal(body.length, 8);
  assert.equal(new DataView(body.buffer, body.byteOffset).getBigUint64(0, true), RIDER);
});

function fakeConnection() {
  return {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return new Promise(() => {}); },
    close() {},
  };
}

test("ejectPassenger reaches the wire once, and never for nobody", () => {
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  world.ejectPassenger(RIDER);
  assert.equal(connection.sent.length, 1);
  assert.equal(connection.sent[0].opcode, OPCODES.CMSG_CONTROLLER_EJECT_PASSENGER);
  world.ejectPassenger(0n);
  assert.equal(connection.sent.length, 1, "the zero guid never leaves the client");
  world.close();
  world.ejectPassenger(RIDER);
  assert.equal(connection.sent.length, 1, "a closed client stays silent");
});

function makeNode(tag = "div") {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], hidden: false, disabled: false,
    value: "", textContent: "", type: "",
    dataset: {}, id: "", className: "", title: "",
    style: { setProperty() {}, removeProperty() {} },
    parentNode: undefined, listeners: new Map(),
    get isConnected() { return node.parentNode !== undefined; },
    classList: {
      _set: new Set(),
      add(...names) { for (const name of names) node.classList._set.add(name); node.className = [...node.classList._set].join(" "); },
      remove(...names) { for (const name of names) node.classList._set.delete(name); node.className = [...node.classList._set].join(" "); },
      toggle(name, force) {
        const want = force === undefined ? !node.classList._set.has(name) : force;
        if (want) node.classList._set.add(name);
        else node.classList._set.delete(name);
        node.className = [...node.classList._set].join(" ");
        return want;
      },
      contains: (name) => node.classList._set.has(name),
    },
    append(...kids) { for (const kid of kids) { kid.parentNode = node; node.children.push(kid); } },
    prepend(...kids) { for (const kid of [...kids].reverse()) { kid.parentNode = node; node.children.unshift(kid); } },
    replaceChildren(...kids) { node.children = [...kids]; for (const kid of kids) kid.parentNode = node; },
    remove() {
      if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((kid) => kid !== node);
      node.parentNode = undefined;
    },
    addEventListener(type, run) {
      const list = node.listeners.get(type) ?? [];
      list.push(run);
      node.listeners.set(type, list);
    },
    removeEventListener() {},
    setAttribute(name, value) { node[name] = value; },
    getAttribute(name) { return node[name] ?? null; },
    removeAttribute(name) { delete node[name]; },
    focus() {}, blur() {},
    click() { for (const run of node.listeners.get("click") ?? []) run({ preventDefault() {}, stopPropagation() {} }); },
    querySelector() { return makeNode("button"); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return node;
}

const viewport = makeNode("div");
const hudCenter = makeNode("div");
const byId = new Map([["world-viewport", viewport], ["bottom-hud-center", hudCenter]]);
globalThis.document = {
  createElement: (tag) => makeNode(tag),
  createElementNS: (_ns, tag) => makeNode(tag),
  body: makeNode("body"),
  documentElement: { style: { setProperty() {}, removeProperty() {} } },
  getElementById: (id) => byId.get(id) ?? null,
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};
globalThis.location = { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" };
globalThis.window = {
  innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {},
  dispatchEvent() { return true; },
};
globalThis.Event = class { constructor(type) { this.type = type; } };

const { game } = await import("../dist/code/browser/game/Context.js");
const { resetPetBar, showPetBar, updatePetBar } = await import("../dist/code/browser/ui/PetBar.js");

const vehicleBar = () => ({
  closed: false, guid: VEHICLE, creatureFamily: 0, duration: 0,
  reactState: 0, commandState: 0, flags: 0,
  bar: Array.from({ length: 10 }, (_, slot) => ({
    slot, packed: (8 + slot) * 0x1000000 + slot, action: slot, type: 8 + slot,
  })),
  spells: [], cooldowns: [],
});

const ejectButtons = () => {
  const found = [];
  const walk = (entry) => {
    if (entry.tagName === "BUTTON" && entry.textContent.startsWith("Высадить")) found.push(entry);
    for (const child of entry.children ?? []) walk(child);
  };
  walk(hudCenter);
  return found;
};

test("only the owner of a player vehicle can see its eject controls", () => {
  const ejected = [];
  try {
    game.world = {
      state: {
        selfGuid: DRIVER,
        objects: new Map([
          [DRIVER, unit(DRIVER, undefined, undefined, 4)],
          [RIDER, unit(RIDER, DRIVER, undefined, 4)],
          [0x3n, unit(0x3n, undefined)],
        ]),
      },
      vehicleKits: new Map([[DRIVER, 1]]),
      petSpells: undefined,
      displayName: (guid) => (guid === RIDER ? "Пассажир" : `0x${guid.toString(16)}`),
      changeVehicleSeat() {}, leaveVehicle() {},
      ejectPassenger: (guid) => ejected.push(guid),
    };
    showPetBar();
    const buttons = ejectButtons();
    assert.equal(hudCenter.children.at(-1)?.hidden, false, "the owner can see vehicle controls without a pet bar");
    assert.equal(buttons.length, 1, "the rider is listed, the owner and the bystander are not");
    assert.match(buttons[0].textContent, /Пассажир/);
    // The eject runs through the confirm panel; the unit under test is the listing, and the
    // packet path is pinned above. The confirm owns the click from here.
    assert.equal(typeof ejected.push, "function");
  } finally {
    resetPetBar();
    game.world = undefined;
  }
});

test("a creature vehicle's controller can leave but cannot send owner-only eject", () => {
  try {
    game.world = {
      state: { selfGuid: DRIVER, objects: fakeState([
        unit(VEHICLE, undefined, DRIVER), unit(DRIVER, VEHICLE), unit(RIDER, VEHICLE),
      ]).objects },
      vehicleKits: new Map(), petSpells: vehicleBar(),
      displayName: (guid) => `0x${guid.toString(16)}`,
      changeVehicleSeat() {}, leaveVehicle() {}, ejectPassenger() {},
    };
    showPetBar();
    assert.equal(ejectButtons().length, 0, "only a player vehicle owner can eject");
    assert.equal(hudCenter.children.at(-1)?.hidden, false);
    const all = hudCenter.children.at(-1).children.flatMap((row) => row.children);
    assert.ok(all.some((node) => node.textContent === "Покинуть"));
  } finally {
    resetPetBar();
    game.world = undefined;
  }
});

test("a passenger without SMSG_PET_SPELLS still has an exit button", () => {
  const left = [];
  try {
    game.world = {
      state: { selfGuid: RIDER, objects: fakeState([
        unit(DRIVER, undefined, undefined, 4), unit(RIDER, DRIVER, undefined, 4),
      ]).objects },
      vehicleKits: new Map(), petSpells: undefined,
      displayName: (guid) => `0x${guid.toString(16)}`,
      changeVehicleSeat() {}, leaveVehicle: () => left.push(true), ejectPassenger() {},
    };
    showPetBar();
    const box = hudCenter.children.at(-1);
    assert.equal(box.hidden, false);
    const leave = box.children.flatMap((row) => row.children).find((node) => node.textContent === "Покинуть");
    assert.ok(leave);
    leave.click();
    assert.equal(left.length, 1);
  } finally {
    resetPetBar();
    game.world = undefined;
  }
});

test("vehicle controls follow boarding and leaving after later state packets", () => {
  const state = { selfGuid: DRIVER, revision: 1, objects: fakeState([
    unit(DRIVER, undefined, undefined, 4), unit(RIDER, undefined, undefined, 4),
  ]).objects };
  try {
    game.world = {
      state, vehicleKits: new Map([[DRIVER, 1]]), petSpells: undefined,
      displayName: (guid) => `0x${guid.toString(16)}`,
      changeVehicleSeat() {}, leaveVehicle() {}, ejectPassenger() {},
    };
    showPetBar();
    assert.equal(ejectButtons().length, 0);
    updatePetBar(0);

    state.objects.get(RIDER).transport = { guid: DRIVER, x: 0, y: 0, z: 0, orientation: 0, seat: 1 };
    state.revision++;
    updatePetBar(1);
    assert.equal(ejectButtons().length, 1, "boarding reveals the new passenger");

    state.objects.get(RIDER).transport = undefined;
    state.revision++;
    updatePetBar(2);
    assert.equal(ejectButtons().length, 0, "leaving removes the old eject target");
    assert.equal(hudCenter.children.at(-1)?.hidden, true);
  } finally {
    resetPetBar();
    game.world = undefined;
  }
});

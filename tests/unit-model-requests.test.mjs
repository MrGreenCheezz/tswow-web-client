import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { installCountingUiDocument } from "./fixtures/counting-ui-document.mjs";

// P1-20c: unit models are asked for from the store's events (a new object, a new display id, a new
// mount) in the flush that delivers them, and the walk of every object moved from every world refresh
// to the 250 ms prefetch throttle, where it stays as the net for what the events cannot see.

installCountingUiDocument();

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { bindUnitModelRequests, sweepUnitModels } = await import("../dist/code/browser/UnitModelRequests.js");

const DISPLAY = UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset;
const MOUNT = UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset;
const CORPSE_DISPLAY = UPDATE_FIELDS.CORPSE_FIELD_DISPLAY_ID.offset;

/** What the create block of `WorldState.applyUpdate` does: the object, then its fields, both observed. */
function create(state, guid, typeId, fields) {
  state.objects.set(guid, {
    guid, typeId, position: { x: 0, y: 0, z: 0, orientation: 0 }, movementFlags: 0, updateFlags: 0,
    fields: new Map(),
  });
  state.observer?.objectCreated(guid, typeId);
  const object = state.objects.get(guid);
  for (const [index, value] of fields) object.fields.set(index, value);
  state.observer?.fieldsChanged(guid, [...fields.keys()]);
}

function models() {
  const asked = [];
  return { asked, request(displayId) { asked.push(displayId); } };
}

test("300 new units are asked for, display id and mount, in the flush that delivers them", () => {
  const state = new WorldState();
  const store = new WorldStore(state);
  const client = models();
  bindUnitModelRequests(store, state, client);
  assert.deepEqual(client.asked, [], "an empty state sweeps nothing");
  for (let index = 0; index < 300; index++) {
    create(state, 0xF1300000000000n + BigInt(index), index % 2 === 0 ? 3 : 4,
      [[DISPLAY, 1000 + index], [MOUNT, index === 7 ? 2404 : 0]]);
  }
  assert.deepEqual(client.asked, [], "nothing before the flush");
  store.flush();
  for (let index = 0; index < 300; index++) assert.ok(client.asked.includes(1000 + index), `unit ${index}'s display id`);
  assert.ok(client.asked.includes(2404), "and the mounted one's mount");
});

test("a corpse is asked for by its creation alone: its display field has no event", () => {
  const state = new WorldState();
  const store = new WorldStore(state);
  const client = models();
  bindUnitModelRequests(store, state, client);
  create(state, 0xF1000000000777n, 7, [[CORPSE_DISPLAY, 49]]);
  store.flush();
  assert.ok(client.asked.includes(49));
});

test("an implicitly created guid is asked for by the type its object holds at the flush", () => {
  const state = new WorldState();
  const store = new WorldStore(state);
  const client = models();
  bindUnitModelRequests(store, state, client);
  const guid = 0x55n;
  state.setField(guid, DISPLAY, 3167); // values before any create block: typeId undefined
  state.objects.get(guid).typeId = 3; // the create block that follows in the same packet
  store.objectCreated(guid, 3);
  store.flush();
  assert.ok(client.asked.includes(3167));
});

test("a mount changing on a unit already in view is an event of its own, and a request", () => {
  const state = new WorldState();
  const store = new WorldStore(state);
  const client = models();
  const guid = 0x77n;
  create(state, guid, 4, [[DISPLAY, 50], [MOUNT, 0]]);
  store.flush();
  bindUnitModelRequests(store, state, client);
  assert.deepEqual(client.asked, [50, 0], "the binding's own sweep covers what the state held");
  const mounts = [];
  const displays = [];
  store.events.on("UNIT_MOUNT_DISPLAY_ID", ({ guid: who }) => mounts.push(who));
  store.events.on("UNIT_DISPLAY_ID", ({ guid: who }) => displays.push(who));
  client.asked.length = 0;
  state.setField(guid, MOUNT, 14338);
  store.flush();
  assert.deepEqual(mounts, [guid], "UNIT_FIELD_MOUNTDISPLAYID announces UNIT_MOUNT_DISPLAY_ID");
  assert.deepEqual(displays, [], "and does not wake UNIT_DISPLAY_ID listeners");
  assert.ok(client.asked.includes(14338));
});

test("a sweep asks again for an id it asked before: the client's retry ladder needs the new call", () => {
  const state = new WorldState();
  const client = models();
  create(state, 0x91n, 3, [[DISPLAY, 666]]);
  sweepUnitModels(state, client);
  sweepUnitModels(state, client);
  assert.equal(client.asked.filter((id) => id === 666).length, 2);
});

test("a binding whose client is no longer current asks for nothing, and unbinds cleanly", () => {
  const state = new WorldState();
  const store = new WorldStore(state);
  const client = models();
  let current = true;
  const stops = bindUnitModelRequests(store, state, client, () => current);
  current = false;
  create(state, 0x99n, 3, [[DISPLAY, 12]]);
  store.flush();
  assert.deepEqual(client.asked, []);
  current = true;
  for (const stop of stops) stop();
  create(state, 0x9An, 3, [[DISPLAY, 13]]);
  store.flush();
  assert.deepEqual(client.asked, [], "unsubscribed");
});

test("100 world refreshes in a row add at most one sweep (before P1-20c: one per refresh)", async () => {
  const { game } = await import("../dist/code/browser/game/Context.js");
  const { showWorldState } = await import("../dist/code/browser/ui/WorldView.js");
  const { diagnosticsWindow } = await import("../dist/code/browser/ui/Dom.js");
  diagnosticsWindow.hidden = true;
  const world = new WorldClient({ send() {}, close() {} });
  for (let index = 0; index < 300; index++) create(world.state, 0x1000n + BigInt(index), 3, [[DISPLAY, 500 + index]]);
  const client = models();
  game.world = world;
  game.creatureModels = client;
  try {
    for (let refresh = 0; refresh < 100; refresh++) showWorldState(world.state);
    assert.ok(client.asked.length > 0, "the first refresh sweeps (the prefetch block runs at once)");
    assert.ok(client.asked.length <= 2 * 300, `${client.asked.length} requests: more than one sweep of 300 units`);
  } finally {
    game.world = undefined;
    game.creatureModels = undefined;
  }
});

test("EnterWorld binds the requests to the session's model client", async () => {
  const source = await readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  assert.match(source, /bindUnitModelRequests\(game\.store, world\.state, creatureModels,/);
});

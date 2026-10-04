import assert from "node:assert/strict";
import test from "node:test";

// A loading screen in Wow.exe 3.3.5a 12340 is one PLAYER_LEAVING_WORLD (the active player's
// destruction, 0x006e6020 → 0x00528c30) and one PLAYER_ENTERING_WORLD (its creation on the new map,
// 0x006e8280 → 0x006e7f50 → 0x00528010); PLAYER_LOGIN is not raised again. FrameXmlWorldEntry.ts takes
// them from SMSG_NEW_WORLD (WORLD_TRANSFER) and the next creation of the character's own object.
const { createFrameXmlWorldEntry } = await import("../dist/code/browser/framexml/FrameXmlWorldEntry.js");
const { EventBus } = await import("../dist/code/world/EventBus.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");

const SELF = 0x10n;

function harness() {
  const world = new EventBus();
  const store = new EventBus();
  const fired = [];
  const entry = createFrameXmlWorldEntry();
  entry.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 },
    { world, store, selfGuid: () => SELF });
  return { world, store, fired, entry };
}

test("a worldport is one leave and, on the character's creation there, one entry", () => {
  const { world, store, fired, entry } = harness();
  store.emit("OBJECT_CREATED", { guid: SELF, typeId: 4 });
  assert.deepEqual(fired, [], "attached in the world: the boot's exercise raised the first entry");
  world.emit("WORLD_TRANSFER", { mapId: 571 });
  // L5c 3.18: the leave is the whole world exit (0x00528c30): INSTANCE_LOCK_STOP comes first.
  assert.deepEqual(fired, [["INSTANCE_LOCK_STOP"], ["PLAYER_LEAVING_WORLD"]]);
  assert.equal(entry.transferring, true);
  world.emit("WORLD_TRANSFER", { mapId: 571 });
  store.emit("OBJECT_CREATED", { guid: 0x20n, typeId: 3 });
  assert.deepEqual(fired, [["INSTANCE_LOCK_STOP"], ["PLAYER_LEAVING_WORLD"]], "no second leave; another object is no entry");
  store.emit("OBJECT_CREATED", { guid: SELF, typeId: 4 });
  assert.deepEqual(fired, [["INSTANCE_LOCK_STOP"], ["PLAYER_LEAVING_WORLD"], ["PLAYER_ENTERING_WORLD"]]);
  store.emit("OBJECT_CREATED", { guid: SELF, typeId: 4 });
  assert.equal(fired.length, 3, "a later update of the character is no entry");
});

test("detach stops both edges", () => {
  const { world, store, fired, entry } = harness();
  entry.detach();
  world.emit("WORLD_TRANSFER", { mapId: 0 });
  store.emit("OBJECT_CREATED", { guid: SELF, typeId: 4 });
  assert.deepEqual(fired, []);
});

function connection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload) {
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume({ opcode, payload });
      } else queue.push({ opcode, payload });
    },
    read() { return queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => { wake = resolve; }); },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    close() {},
  };
}

async function settle() {
  for (let index = 0; index < 6; index++) await new Promise(setImmediate);
}

test("LiveWorldSeam over a real WorldClient: SMSG_NEW_WORLD, then the realm's re-creation of the character", async () => {
  const transport = connection();
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(transport);
  world.state.selfGuid = SELF;
  world.state.move(SELF, { flags: 0, position: { x: 1, y: 2, z: 3, orientation: 0 } });
  const store = new WorldStore(world.state);
  store.flush();
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store, spell: () => undefined, monotonic: () => 0,
    globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const fired = [];
  const edges = () => fired.filter((event) => event === "PLAYER_LEAVING_WORLD" || event === "PLAYER_ENTERING_WORLD");
  try {
    await world.loginCharacter(SELF);
    seam.attach({ fire: (event) => { fired.push(event); return 1; }, now: () => 0 });
    transport.push(OPCODES.SMSG_NEW_WORLD, new PacketWriter().u32(571).f32(80).f32(90).f32(100).f32(0).toUint8Array());
    await settle();
    assert.ok(transport.sent.some((packet) => packet.opcode === OPCODES.MSG_MOVE_WORLDPORT_ACK), "the ACK went out");
    assert.deepEqual(edges(), ["PLAYER_LEAVING_WORLD"]);
    // The realm creates the character again on the new map; the store's flush delivers it.
    store.objectCreated(SELF, 4);
    store.flush();
    assert.deepEqual(edges(), ["PLAYER_LEAVING_WORLD", "PLAYER_ENTERING_WORLD"]);
  } finally {
    seam.detach();
    world.close();
  }
});

// The stock vertical over a loading screen: MainMenuBar's second PLAYER_ENTERING_WORLD runs
// MainMenuBar_ToPlayerArt (MainMenuBar.lua:109-138) — `sin` in degrees (FrameXmlLuaCompat.ts) and
// VehicleMenuBar/VehicleSeatIndicator (stand-ins until 11.02, FrameXmlDurabilityFrame.ts).
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
const { after } = await import("node:test");
after(() => chain?.close());

test("the stock vertical takes a loading screen's leave and entry without a Lua error", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false,
}, async () => {
  const { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const decoder = new TextDecoder("utf-8");
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam: new CannedWorldSeam(),
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS, screen: () => ({ width: 1365, height: 768 }),
  });
  try {
    await boot.load();
    const errors = boot.errors.length;
    boot.pump.fire("PLAYER_LEAVING_WORLD");
    boot.pump.fire("PLAYER_ENTERING_WORLD");
    assert.deepEqual(boot.errors.slice(errors).map((failure) => `${failure.file}:${failure.line}: ${failure.message}`), []);
    assert.equal(boot.bridge.getFrame("MainMenuBar")?.visible, true, "MainMenuBar_ToPlayerArt showed the bar");
    assert.equal(boot.bridge.getFrame("VehicleMenuBar")?.visible, false, "the stand-in stays hidden");
  } finally {
    boot.close();
  }
});

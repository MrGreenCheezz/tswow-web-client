import assert from "node:assert/strict";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import { stablePetRows } from "../dist/code/browser/ui/StableControls.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";

function node(tag) {
  const handlers = new Map();
  return {
    tagName: tag.toUpperCase(), children: [], style: {}, dataset: {}, hidden: false, textContent: "", disabled: false,
    append(...children) { for (const child of children) child.parentNode = this; this.children.push(...children); },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    addEventListener(type, callback) { handlers.set(type, callback); }, setAttribute() {},
    remove() { this.parentNode.children = this.parentNode.children.filter((child) => child !== this); },
    click() { if (!this.disabled) handlers.get("click")?.({ stopPropagation() {} }); },
    classList: { add() {}, remove() {}, toggle() {} },
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, width: 100, height: 100 }; },
  };
}
const body = node("body");
globalThis.document = { createElement: node, body, addEventListener() {}, removeEventListener() {} };
globalThis.window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {}, setTimeout };
const all = (root) => [root, ...root.children.flatMap(all)];
const text = (root) => root.textContent + root.children.map(text).join(" ");
const button = (root, label) => {
  const found = all(root).find((item) => item.tagName === "BUTTON" && item.textContent === label);
  assert.ok(found, `Missing button: ${label}`);
  return found;
};
function setup({ active = true, slots = 2 } = {}) {
  const calls = [];
  const world = {
    stableMasterGuid: 77n,
    state: { selfGuid: 1n, objects: new Map() },
    stable: { npcGuid: 77n, stableSlots: slots, pets: [
      ...(active ? [{ name: "Волк", petNumber: 999, flags: 1, level: 80 }] : []),
      { name: "Кошка", petNumber: 34567, flags: 2, level: 79 },
    ] },
  };
  for (const method of ["stablePet", "unstablePet", "swapStabledPet", "buyStableSlot", "requestStable"])
    world[method] = (...args) => calls.push([method, ...args]);
  const root = node("div");
  const redraw = () => root.replaceChildren(...stablePetRows(world, redraw));
  game.world = world;
  redraw();
  return { world, calls, root, redraw };
}

test("stable actions use the selected pet's number and block repeated sends until a reply", () => {
  const { world, calls, root, redraw } = setup();
  button(root, "Заменить активного").click();
  assert.deepEqual(calls, [["swapStabledPet", 34567]]);
  button(root, "Заменить активного").click();
  assert.equal(calls.length, 1);
  world.stableMessage = { text: "Не удалось", error: true };
  redraw();
  assert.match(text(root), /Не удалось/);
  button(root, "Отправить в стойло").click();
  assert.deepEqual(calls.at(-1), ["stablePet"]);
});

test("unstabling is available without an active pet and full capacity blocks stabling", () => {
  const empty = setup({ active: false });
  button(empty.root, "Призвать").click();
  assert.deepEqual(empty.calls, [["unstablePet", 34567]]);
  const full = setup({ slots: 1 });
  assert.equal(button(full.root, "Отправить в стойло").disabled, true);
  assert.equal(button(full.root, "Заменить активного").disabled, false);
});

test("buying a stable slot requires a confirmation and rechecks stale session and capacity", () => {
  const { root, calls, world, redraw } = setup();
  button(root, "Купить место 3").click();
  assert.equal(calls.length, 0);
  button(body, "Купить").click();
  assert.deepEqual(calls, [["buyStableSlot"]]);
  world.stable = { ...world.stable, stableSlots: 4 };
  redraw();
  assert.equal(all(root).some((item) => item.textContent.startsWith("Купить место")), false);
  const other = setup();
  const old = button(other.root, "Заменить активного");
  game.world = {};
  old.click();
  assert.equal(other.calls.length, 0);
});

test("real stable results refresh the roster before controls unlock and service close disables old rows", async () => {
  const queue = [];
  let wake;
  const transport = {
    sent: [], send(opcode, payload) { this.sent.push({ opcode, payload }); }, close() {},
    read() { return queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => { wake = resolve; }); },
    push(opcode, payload) {
      const packet = { opcode, payload };
      if (wake) { const deliver = wake; wake = undefined; deliver(packet); } else queue.push(packet);
    },
  };
  const settle = async () => { for (let index = 0; index < 6; index++) await new Promise(setImmediate); };
  const world = new WorldClient(transport);
  const errors = [];
  world.onWorldError = (error) => errors.push(error.message);
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  await world.loginCharacter(1n);
  game.world = world;
  const root = node("div");
  const redraw = () => root.replaceChildren(...stablePetRows(world, redraw));
  world.events.on("STABLE_CHANGED", redraw);
  const roster = (flags) => new PacketWriter().u64(77n).u8(1).u8(2)
    .u32(34567).u32(100).u32(79).cString("Кошка").u8(flags).toUint8Array();
  try {
    world.requestStable(77n);
    transport.push(OPCODES.MSG_LIST_STABLED_PETS, roster(2));
    await settle();
    button(root, "Призвать").click();
    const packet = transport.sent.find(({ opcode }) => opcode === OPCODES.CMSG_UNSTABLE_PET);
    assert.ok(packet);
    const view = new DataView(packet.payload.buffer, packet.payload.byteOffset, packet.payload.byteLength);
    assert.equal(view.getBigUint64(0, true), 77n);
    assert.equal(view.getUint32(8, true), 34567);
    transport.push(OPCODES.SMSG_STABLE_RESULT, Uint8Array.of(0x09));
    await settle();
    assert.equal(button(root, "Призвать").disabled, true, "success waits for the authoritative refreshed roster");
    assert.equal(transport.sent.filter(({ opcode }) => opcode === OPCODES.MSG_LIST_STABLED_PETS).length, 2);
    transport.push(OPCODES.MSG_LIST_STABLED_PETS, roster(1));
    await settle();
    assert.equal(button(root, "Отправить в стойло").disabled, false);
    world.closeNpcServices();
    redraw();
    assert.equal(button(root, "Отправить в стойло").disabled, true);
    assert.deepEqual(errors, []);
  } finally { world.close(); game.world = undefined; }
});

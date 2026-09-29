import assert from "node:assert/strict";
import test from "node:test";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { PacketReader } from "../dist/code/protocol/PacketReader.js";

function node(tag = "div") {
  const listeners = new Map();
  return {
    tagName: tag.toUpperCase(), children: [], hidden: false, disabled: false, value: "", textContent: "", dataset: {},
    style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, remove() {}, focus() {},
    addEventListener(type, run) { listeners.set(type, run); }, removeEventListener() {},
    click() { if (!this.disabled) listeners.get("click")?.({ preventDefault() {} }); },
    input(value) { this.value = value; listeners.get("input")?.(); },
    querySelector() { return node(); }, querySelectorAll() { return []; },
  };
}
globalThis.document = { createElement: node, body: node(), documentElement: node(), getElementById: node, querySelectorAll: () => [] };
globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900 };
globalThis.location = { origin: "http://localhost:5173", protocol: "http:", hostname: "localhost" };
const { game } = await import("../dist/code/browser/game/Context.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
usePanelHost({ viewport: document.body, attach() {} });
const { toggleGmTickets, resetGmTickets } = await import("../dist/code/browser/ui/GmTickets.js");
const all = (root) => [root, ...root.children.flatMap(all)];
const at = (id) => all(document.body).find((entry) => entry.id === id);
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
function connection() {
  const queue = []; let wake;
  return {
    sent: [], send(opcode, payload) { this.sent.push({ opcode, payload }); }, close() {},
    read() { return queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => { wake = resolve; }); },
    push(opcode, payload) { const packet = { opcode, payload }; if (wake) { const done = wake; wake = undefined; done(packet); } else queue.push(packet); },
  };
}
const response = (value) => new PacketWriter().u32(value).toUint8Array();
const ticket = (message) => new PacketWriter().u32(6).u32(42).cString(message).u8(0).f32(0).f32(0).f32(0).u8(0).u8(0).toUint8Array();

test("GM ticket form waits for replies, preserves failed drafts, and does not create a request loop", async () => {
  const transport = connection();
  const world = new WorldClient(transport);
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(1).f32(10).f32(20).f32(30).f32(0).toUint8Array());
  await world.loginCharacter(1n);
  game.world = world;
  world.state.selfGuid = 1n;
  world.state.objects.set(1n, { guid: 1n, typeId: 4, fields: new Map(), position: { x: 10, y: 20, z: 30, orientation: 0 } });
  try {
    toggleGmTickets();
    assert.equal(at("gm-ticket-send").disabled, true);
    transport.push(OPCODES.SMSG_GMTICKET_GETTICKET, response(10));
    transport.push(OPCODES.SMSG_GMTICKET_SYSTEMSTATUS, response(1));
    await settle();
    at("gm-ticket-text").input("Нужна помощь");
    at("gm-ticket-send").click(); at("gm-ticket-send").click();
    await settle();
    const creates = transport.sent.filter(p => p.opcode === OPCODES.CMSG_GMTICKET_CREATE);
    assert.equal(creates.length, 1);
    const reader = new PacketReader(creates[0].payload);
    assert.equal(reader.u32(), 1);
    assert.deepEqual([reader.f32(), reader.f32(), reader.f32()], [10, 20, 30]);
    assert.equal(reader.cString(), "Нужна помощь");
    transport.push(OPCODES.SMSG_GMTICKET_CREATE, response(3));
    await settle();
    assert.equal(at("gm-ticket-text").value, "Нужна помощь");
    assert.equal(at("gm-ticket-send").disabled, false);
    at("gm-ticket-send").click(); await settle();
    transport.push(OPCODES.SMSG_GMTICKET_CREATE, response(2));
    await settle();
    const before = transport.sent.length;
    transport.push(OPCODES.SMSG_GMTICKET_GETTICKET, ticket("Нужна помощь"));
    await settle();
    assert.equal(transport.sent.length, before, "a snapshot reply never requests itself");
    at("gm-ticket-text").input("Уточнение"); at("gm-ticket-send").click();
    assert.equal(transport.sent.at(-1).opcode, OPCODES.CMSG_GMTICKET_UPDATETEXT);
    transport.push(OPCODES.SMSG_GMTICKET_UPDATETEXT, response(5)); await settle();
    assert.equal(at("gm-ticket-text").value, "Уточнение");
    transport.push(OPCODES.SMSG_GMTICKET_DELETETICKET, response(5)); await settle();
    assert.equal(world.gmTicket?.message, "Нужна помощь", "a failed delete preserves the server ticket");
    resetGmTickets();
    assert.equal(at("gm-ticket-text").value, "", "a new character never inherits the draft");
  } finally { resetGmTickets(); world.close(); game.world = undefined; }
});

test("a completed GM response is itself the answer to GETTICKET", async () => {
  const transport = connection();
  const world = new WorldClient(transport);
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  await world.loginCharacter(1n);
  game.world = world;
  try {
    toggleGmTickets();
    transport.push(OPCODES.SMSG_GMRESPONSE_RECEIVED, new PacketWriter().u32(1).u32(42)
      .cString("Исходное обращение").cString("Ответ готов").cString("").cString("").cString("").toUint8Array());
    await settle();
    assert.equal(at("gm-ticket-text").value, "Исходное обращение");
    assert.ok(all(at("gm-ticket-window")).some(entry => entry.textContent === "Получен ответ игрового мастера."));
    assert.equal(at("gm-ticket-resolve").hidden, false);
    at("gm-ticket-resolve").click();
    assert.equal(transport.sent.at(-1).opcode, OPCODES.CMSG_GMRESPONSE_RESOLVE);
    transport.push(OPCODES.SMSG_GMRESPONSE_STATUS_UPDATE, new PacketWriter().u8(0).toUint8Array());
    await settle();
    assert.equal(transport.sent.at(-1).opcode, OPCODES.CMSG_GMTICKET_GETTICKET);
  } finally { resetGmTickets(); world.close(); game.world = undefined; }
});

test("ticket serialization cannot send after its world connection has closed", async () => {
  let closed = false;
  const afterClose = [];
  const world = new WorldClient({ close() { closed = true; }, send(opcode) { if (closed) afterClose.push(opcode); } });
  const pending = world.createTicket({ mapId: 0, x: 0, y: 0, z: 0, message: "Черновик", needResponse: true, needMoreHelp: false });
  world.close();
  await pending;
  assert.deepEqual(afterClose, []);
});

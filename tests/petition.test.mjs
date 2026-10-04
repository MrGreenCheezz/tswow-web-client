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
    id: "", className: "", title: "",
    style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, remove() {}, focus() {},
    addEventListener(type, run) { listeners.set(type, run); }, removeEventListener() {},
    click() { if (!this.disabled) listeners.get("click")?.({ preventDefault() {}, stopPropagation() {} }); },
    querySelector() { return node(); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
}
globalThis.document = { createElement: node, body: node(), documentElement: node(), getElementById: node, querySelectorAll: () => [] };
globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900,
  setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args) };
globalThis.location = { origin: "http://localhost:5173", protocol: "http:", hostname: "localhost" };
const { game } = await import("../dist/code/browser/game/Context.js");
const { getTip, usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
usePanelHost({ viewport: document.body, attach() {} });
const { showPetition, petitionOpen, closePetition, resetPetition } = await import("../dist/code/browser/ui/Petition.js");
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
const OWNER = 0x1001n;
const SIGNER = 0x1002n;
const CHARTER = 0x2001n;
function queryResponse({ owner = OWNER, name = "Тестовая", min = 9, max = 9, arena = 0 } = {}) {
  const writer = new PacketWriter().u32(7).u64(owner).cString(name).cString("");
  writer.u32(min).u32(max).u32(0);
  for (let i = 0; i < 4; i++) writer.u32(0);
  writer.u16(0);
  for (let i = 0; i < 3; i++) writer.u32(0);
  for (let i = 0; i < 10; i++) writer.cString("");
  return writer.u32(0).u32(arena).toUint8Array();
}
function signatures({ guid = CHARTER, owner = OWNER, signers = [] } = {}) {
  const writer = new PacketWriter().u64(guid).u64(owner).u32(7).u8(signers.length);
  for (const signer of signers) writer.u64(signer).u32(0);
  return writer.toUint8Array();
}
async function loggedIn() {
  const transport = connection();
  const world = new WorldClient(transport);
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  await world.loginCharacter(1n);
  game.world = world;
  world.state.selfGuid = 1n;
  return { world, transport };
}

test("a guild charter shows progress, renames and turns in for its owner", async () => {
  const { world, transport } = await loggedIn();
  world.state.selfGuid = OWNER;
  try {
    showPetition();
    assert.equal(petitionOpen(), false, "no server data means no window");
    transport.push(OPCODES.SMSG_PETITION_QUERY_RESPONSE, queryResponse());
    transport.push(OPCODES.SMSG_PETITION_SHOW_SIGNATURES, signatures({ signers: [SIGNER] }));
    await settle();
    showPetition();
    assert.equal(petitionOpen(), true);
    assert.match(at("petition-title").textContent, /Хартия гильдии/);
    assert.match(at("petition-info").textContent, /Подписей: 1 из 9/);
    at("petition-name").value = "Новая гильдия";
    at("petition-rename").click();
    const renames = transport.sent.filter((p) => p.opcode === OPCODES.MSG_PETITION_RENAME);
    assert.equal(renames.length, 1);
    const renamed = new PacketReader(renames[0].payload);
    assert.equal(renamed.u64(), CHARTER);
    assert.equal(renamed.cString(), "Новая гильдия");
    at("petition-turn-in").click();
    const before = transport.sent.length;
    assert.equal(transport.sent.length, before, "turn-in asks first: the charter is gone afterwards");
    const accept = all(document.body).find((entry) => entry.textContent === "Сдать");
    assert.ok(accept, "a confirm dialog names the action");
    accept.click();
    const turnIns = transport.sent.filter((p) => p.opcode === OPCODES.CMSG_TURN_IN_PETITION);
    assert.equal(turnIns.length, 1);
    assert.equal(new PacketReader(turnIns[0].payload).u64(), CHARTER);
    closePetition();
    assert.equal(petitionOpen(), false);
  } finally { resetPetition(); game.world = undefined; world.close(); }
});

test("a stranger signs or declines, and an arena charter cannot turn in without an emblem", async () => {
  const { world, transport } = await loggedIn();
  world.state.selfGuid = SIGNER;
  try {
    transport.push(OPCODES.SMSG_PETITION_QUERY_RESPONSE, queryResponse({ arena: 1 }));
    transport.push(OPCODES.SMSG_PETITION_SHOW_SIGNATURES, signatures());
    await settle();
    showPetition();
    assert.equal(at("petition-sign").hidden, false);
    assert.equal(at("petition-turn-in").hidden, true, "only the owner turns in");
    at("petition-sign").click();
    assert.deepEqual(
      transport.sent.filter((p) => p.opcode === OPCODES.CMSG_PETITION_SIGN).map((p) => [...p.payload]),
      [[...new PacketWriter().u64(CHARTER).u8(0).toUint8Array()]]);
    at("petition-decline").click();
    assert.deepEqual(
      transport.sent.filter((p) => p.opcode === OPCODES.MSG_PETITION_DECLINE).map((p) => [...p.payload]),
      [[...new PacketWriter().u64(CHARTER).toUint8Array()]]);
  } finally { resetPetition(); game.world = undefined; world.close(); }
  const owned = await loggedIn();
  owned.world.state.selfGuid = OWNER;
  try {
    owned.transport.push(OPCODES.SMSG_PETITION_QUERY_RESPONSE, queryResponse({ arena: 1 }));
    owned.transport.push(OPCODES.SMSG_PETITION_SHOW_SIGNATURES, signatures());
    await settle();
    showPetition();
    assert.equal(at("petition-turn-in").disabled, true,
      "an arena turn-in without an emblem would destroy the charter server-side");
    assert.match(getTip(at("petition-turn-in")) ?? "", /эмблем/);
  } finally { resetPetition(); game.world = undefined; owned.world.close(); }
});

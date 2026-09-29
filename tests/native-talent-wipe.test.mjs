import assert from "node:assert/strict";
import test from "node:test";
import { isolatedUi } from "./fixtures/isolated-ui.mjs";

// 2.04 (г) / 1.28 part 1: the native talent window's «Сбросить». The core's MSG_TALENT_WIPE_CONFIRM
// handler keeps no pending state (SkillHandler.cpp:61-93): an answer naming a trainer in range resets
// the talents and takes the money at once. So the button never sends on its own — it asks with the
// quote the trainer sent (`WorldClient.talentWipeConfirm`), and only that question's «Принять» answers.
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const progress = await import("../dist/code/world/CharacterProgressProtocol.js");
const fields = await import("../dist/code/world/Fields.js");
const format = await import("../dist/code/browser/ui/Format.js");

const SELF = 0x42n;
const TRAINER = 0xf130_0000_1568_0002n;

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

class Element {
  children = []; listeners = {}; attributes = new Map(); style = {}; dataset = {};
  disabled = false; textContent = ""; className = ""; title = "";
  classList = { toggle() {}, add() {}, remove() {} };
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  remove() {}
  click() { this.listeners.click?.({ stopPropagation() {} }); }
}

/** The native talent window over a real WorldClient: the trainer three yards away, 100 gold. */
async function talentWindow() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  const world = new WorldClient(connection);
  world.state.selfGuid = SELF;
  await world.loginCharacter(SELF);
  await settle();
  world.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  world.state.move(TRAINER, { flags: 0, position: { x: 3, y: 0, z: 0, orientation: 0 } });
  world.state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_COINAGE.offset, 1_000_000);
  connection.sent.length = 0;

  const original = globalThis.document;
  globalThis.document = { createElement: () => new Element(), createTextNode: (textContent) => ({ textContent }) };
  const panels = [];
  const confirms = [];
  const tooltips = new Map();
  class Panel {
    body = new Element(); visible = false;
    constructor() { panels.push(this); }
    toggle() { this.visible = !this.visible; }
    hide() { this.visible = false; }
  }
  const game = {
    world,
    talentData: { ready: true, tabsForClass: () => [], petTabs: () => [], petTalentMask: () => 0 },
  };
  const ui = await isolatedUi("Talents", {
    "../game/Context.js": { game },
    "../../world/CharacterProgressProtocol.js": progress,
    "../../world/Fields.js": fields,
    "./Format.js": format,
    "./Widgets.js": {
      Panel,
      attachTooltip: (target, content) => { tooltips.set(target, content); },
      confirmPanel: (anchor, options) => { confirms.push({ anchor, options }); },
    },
  });
  ui.toggleTalentsWindow();
  /** The header's «Сбросить»: the header is the panel body's first child. */
  const reset = () => panels[0].body.children[0].children
    .find((button) => button.children.some((part) => part.textContent === "Сбросить"));
  const sent = () => connection.sent.filter((packet) => packet.opcode === OPCODES.MSG_TALENT_WIPE_CONFIRM);
  const push = async (payload) => { connection.push(OPCODES.MSG_TALENT_WIPE_CONFIRM, payload); await settle(); };
  return {
    ui, world, confirms, tooltips, reset, sent, push,
    dispose: () => { globalThis.document = original; world.close(); },
  };
}

test("without the trainer's quote «Сбросить» sends nothing, even with the trainer targeted and its gossip open", async () => {
  const window = await talentWindow();
  try {
    window.world.targetGuid = TRAINER;
    window.world.gossip = { guid: TRAINER, menuId: 0, textId: 0, options: [], quests: [] };
    const button = window.reset();
    assert.ok(button, "the button is there");
    assert.equal(button.getAttribute("aria-disabled"), "true");
    button.click();
    assert.deepEqual(window.sent(), [], "no blind MSG_TALENT_WIPE_CONFIRM: the core would reset and charge at once");
    assert.deepEqual(window.confirms, [], "and nothing to confirm");
    const hint = window.tooltips.get(button)();
    assert.match(hint.footer.join(" "), /у тренера своего класса.*Забыть таланты/);
  } finally {
    window.dispose();
  }
});

test("with the quote «Сбросить» asks with the price; only «Принять» answers, once, with the quote's guid and 8 bytes", async () => {
  const window = await talentWindow();
  try {
    await window.push(new PacketWriter().u64(TRAINER).u32(50_000).toUint8Array());
    const button = window.reset();
    const hint = window.tooltips.get(button)();
    assert.equal(button.getAttribute("aria-disabled"), null, "a quote is waiting: the tooltip look refreshes the state");
    assert.match(hint.footer.join(" "), /Стоимость: 5з/);
    button.click();
    assert.equal(window.confirms.length, 1);
    assert.deepEqual(window.sent(), [], "asking is not answering");
    const { options } = window.confirms[0];
    assert.match(options.lines.join(" "), /Стоимость: 5з/);
    assert.match([options.title, ...options.lines].join(" "), /отказаться от всех своих талантов/i);
    options.onConfirm();
    options.onConfirm();
    assert.deepEqual(window.sent().map((packet) => [...packet.payload]),
      [[...new PacketWriter().u64(TRAINER).toUint8Array()]], "ConfirmRespecWipe: the guid alone, once");
    assert.equal(window.world.talentWipeConfirm, undefined);
    // A confirmation left open while another quote came answers nothing blind.
    await window.push(new PacketWriter().u64(TRAINER).u32(70_000).toUint8Array());
    window.reset().click();
    const stale = window.confirms.at(-1).options;
    await window.push(new PacketWriter().u64(TRAINER).u32(90_000).toUint8Array());
    stale.onConfirm();
    assert.equal(window.sent().length, 1, "the 7-gold question went; the 9-gold one was never confirmed");
    // Short of money the core stays silent: the refusal is said.
    const statuses = [];
    window.world.onSpellStatus = (message, error) => statuses.push([message, error]);
    window.world.state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_COINAGE.offset, 100);
    window.reset().click();
    window.confirms.at(-1).options.onConfirm();
    assert.deepEqual(statuses, [["У вас недостаточно денег.", true]]);
    assert.equal(window.sent().length, 1);
  } finally {
    window.dispose();
  }
});

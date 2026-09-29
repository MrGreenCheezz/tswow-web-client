import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import * as actionProtocol from "../dist/code/world/ActionBarProtocol.js";
import { cooldownDuration, cooldownLabel, cooldownView } from "../dist/code/browser/ui/Widgets.js";

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
    send(opcode, payload) { this.sent.push({ opcode, payload }); },
    close() {},
  };
}

async function settle() {
  for (let index = 0; index < 6; index++) await new Promise(setImmediate);
}

async function loggedIn() {
  const transport = connection();
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(transport);
  await world.loginCharacter(1n);
  await settle();
  return { world, transport };
}

async function actionBarFor(world) {
  const source = await readFile(new URL("../src/browser/ui/ActionBar.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const exports = {};
  const slot = { bag: 255, slot: 23, guid: 88n, item: { entry: 6948 } };
  const buttons = [];
  const actionBar = { children: [], append(...children) { this.children.push(...children); },
    parentElement: { insertBefore() {} }, closest: () => null };
  class IconButton {
    root = { dataset: {}, classList: { add() {} }, addEventListener() {} };
    constructor() { buttons.push(this); }
    setContent() {}
    setCooldown(fraction, label) { this.fraction = fraction; this.label = label; }
    setUsable(usable) { this.usable = usable; }
  }
  const game = { world, spells: new Map() };
  new Function("require", "exports", js)((name) => ({
    "../../world/ActionBarProtocol.js": actionProtocol,
    "../game/Context.js": { game },
    "../Inventory.js": { playerInventory: () => ({ backpack: [slot], bags: [], keyring: [] }), stackCount: () => 1 },
    "../game/GroundTarget.js": {
      itemUseSpellId: (template) => template?.spells?.find((spell) => [0, 4, 5, 6].includes(spell.trigger))?.spellId,
      requestInventoryItemUse: (_slot, send) => send(),
    },
    "../../world/ItemProtocol.js": { ITEM_EQUIP_COOLDOWN_MS: 30_000 },
    "../../world/Fields.js": { worldObject: { entry: (item) => item.entry } },
    "../../world/WorldClient.js": { MELEE_AUTO_ATTACK_SPELL_ID: 6603 },
    "./Dom.js": { actionBar },
    "./Widgets.js": { IconButton, attachTooltip() {}, cooldownDuration, cooldownLabel, cooldownView },
  })[name] ?? new Proxy({}, { get: () => () => {} }), exports);
  const originalDocument = globalThis.document;
  const element = () => ({ dataset: {}, hidden: false, children: [],
    append(...children) { this.children.push(...children); } });
  return { ...exports,
    mainButton: () => buttons.find((button) => button.root === actionBar.children[0]),
    render() {
      globalThis.document = { createElement: element,
        getElementById: () => null, documentElement: { style: { setProperty() {} } } };
      exports.showActionBar();
    },
    dispose() { globalThis.document = originalDocument; },
  };
}

test("SMSG_ITEM_COOLDOWN from ApplyEquipCooldown lasts the core's 30 seconds", async () => {
  const { world, transport } = await loggedIn();
  try {
    transport.push(OPCODES.SMSG_ITEM_COOLDOWN, new PacketWriter().u64(88n).u32(133).toUint8Array());
    await settle();
    const now = performance.now();
    assert.ok(world.itemCooldownRemaining(133, now) > 29_000);
    assert.equal(world.itemCooldownRemaining(133, now + 30_001), 0);
    transport.push(OPCODES.SMSG_CLEAR_COOLDOWN, new PacketWriter().u32(133).u64(1n).toUint8Array());
    await settle();
    assert.equal(world.itemCooldownRemaining(133), 0, "the server's explicit clear ends the item lockout");
  } finally { world.close(); }
});

test("an item action waits for its equip cooldown before sending the use", async () => {
  const { world, transport } = await loggedIn();
  try {
    const uses = [];
    world.actionButtons = [{ slot: 0, action: 6948, type: actionProtocol.ACTION_BUTTON_ITEM }];
    world.itemTemplate = () => ({ spells: [{ spellId: 133, trigger: 0 }] });
    world.useItem = (...args) => uses.push(args);
    const bar = await actionBarFor(world);

    transport.push(OPCODES.SMSG_ITEM_COOLDOWN, new PacketWriter().u64(88n).u32(133).toUint8Array());
    await settle();
    bar.useSlot(0, 0);
    assert.deepEqual(uses, [], "the visible item button cannot send during the server's equip lockout");

    world.itemCooldowns.set(133, performance.now() - 1);
    world.cooldowns.set(133, performance.now() + 10_000);
    bar.useSlot(0, 0);
    assert.deepEqual(uses, [], "the spell's own server cooldown also blocks the item button");
    world.cooldowns.delete(133);
    bar.useSlot(0, 0);
    assert.deepEqual(uses, [[255, 23, 88n]], "the same button works when the lockout expires");
  } finally { world.close(); }
});

test("the item action sweep follows the 30-second equip timer and marks the button unavailable", async () => {
  const { world, transport } = await loggedIn();
  const bar = await actionBarFor(world);
  try {
    world.actionButtons = [{ slot: 0, action: 6948, type: actionProtocol.ACTION_BUTTON_ITEM }];
    world.itemTemplate = () => ({ spells: [{ spellId: 133, trigger: 0 }] });
    transport.push(OPCODES.SMSG_ITEM_COOLDOWN, new PacketWriter().u64(88n).u32(133).toUint8Array());
    await settle();

    bar.render();
    const now = performance.now();
    bar.updateActionBar(now);
    assert.ok(bar.mainButton().fraction > 0.95, "the equip sweep starts almost full");
    assert.equal(bar.mainButton().usable, false);
    bar.updateActionBar(now + 15_000);
    assert.ok(bar.mainButton().fraction > 0.45 && bar.mainButton().fraction < 0.55,
      "the sweep is halfway after 15 seconds, instead of staying a full disc");
    assert.equal(bar.mainButton().usable, false);
    bar.updateActionBar(now + 30_001);
    assert.equal(bar.mainButton().fraction, 0);
    assert.equal(bar.mainButton().usable, true);
  } finally { bar.dispose(); world.close(); }
});

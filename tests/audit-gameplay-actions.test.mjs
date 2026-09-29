import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { PacketReader } from "../dist/code/protocol/PacketReader.js";
import { parseQuestPushResult } from "../dist/code/world/QuestProtocol.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { UNIT_FLAG_IN_COMBAT } from "../dist/code/world/FactionRules.js";
import * as pvp from "../dist/code/world/PvpProtocol.js";
import * as lfg from "../dist/code/world/LfgProtocol.js";
import * as macroModel from "../dist/code/browser/ui/MacroModel.js";
import { buildCastSpell } from "../dist/code/world/SpellProtocol.js";
import { TARGET_FLAG_DEST_LOCATION, TARGET_FLAG_UNIT } from "../dist/code/world/SpellProtocol.js";
import { casterGuid, targetingContext } from "../dist/code/world/TargetingContext.js";
import { noteDrApplication, drFactor, resetDr } from "../dist/code/world/DiminishingReturns.js";
import { spellModifierText } from "../dist/code/world/SpellModifiers.js";
import { objectiveHeaders } from "../dist/code/browser/ui/ScoreboardModel.js";
import { ACTION_BUTTON_SPELL } from "../dist/code/world/ActionBarProtocol.js";

async function isolatedUi(file, modules) {
  const source = await readFile(new URL(`../src/browser/ui/${file}.ts`, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const exports = {};
  new Function("require", "exports", js)((name) => modules[name] ?? new Proxy({}, {
    get: () => () => {},
  }), exports);
  return exports;
}

test("/cast and /use execute combat actions rather than unknown chat commands", async () => {
  const casts = [], uses = [], messages = [];
  const world = { pushLocalMessage: (m) => messages.push(m.text) };
  const chat = await isolatedUi("Chat", {
    "../game/Context.js": { game: { world } },
    "./CombatCommands.js": {
      runCastCommand: (arg) => casts.push(arg), runUseCommand: (arg) => uses.push(arg),
    },
  });
  chat.submitChat("/cast 133");
  chat.submitChat("/use 6948");
  assert.deepEqual(casts, ["133"]);
  assert.deepEqual(uses, ["6948"]);
  assert.deepEqual(messages, []);
});

function connection() {
  const packets = []; let wake;
  return {
    sent: [],
    push(opcode, payload) { if (wake) { const resume = wake; wake = undefined; resume({ opcode, payload }); }
      else packets.push({ opcode, payload }); },
    read() { return packets.length ? Promise.resolve(packets.shift()) : new Promise((resolve) => { wake = resolve; }); },
    send(opcode, payload) { this.sent.push({ opcode, payload }); }, close() {},
  };
}
async function settle() { for (let i = 0; i < 6; i++) await new Promise(setImmediate); }
async function loggedIn() {
  const transport = connection();
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(transport);
  await world.loginCharacter(1n); await settle(); transport.sent.length = 0;
  return { world, transport };
}

test("an expired summon cannot be accepted, including a click before the next UI tick", async () => {
  const { world, transport } = await loggedIn();
  transport.push(OPCODES.SMSG_SUMMON_REQUEST, new PacketWriter().u64(99n).u32(12).u32(0).toUint8Array());
  await settle();
  world.answerSummon(true);
  assert.equal(transport.sent.some((p) => p.opcode === OPCODES.CMSG_SUMMON_RESPONSE), false);
  assert.equal(world.summonRequest, undefined);
  world.close();
});

test("BG enter is refused while only queued, and after the invite deadline", async () => {
  const { world, transport } = await loggedIn();
  world.battlefieldQueues.set(0, { queueSlot: 0, status: 1, arenaType: 0, bgTypeId: 2 });
  world.portToBattleground(0, true);
  assert.equal(transport.sent.some((p) => p.opcode === OPCODES.CMSG_BATTLEFIELD_PORT), false);
  world.battlefieldQueues.set(0, { queueSlot: 0, status: 2, arenaType: 0, bgTypeId: 2 });
  world.battlefieldInviteDeadlines.set(0, performance.now() - 1);
  world.portToBattleground(0, true);
  assert.equal(transport.sent.some((p) => p.opcode === OPCODES.CMSG_BATTLEFIELD_PORT), false);
  world.close();
});

class Element {
  children = []; listeners = {}; disabled = false; hidden = false; textContent = "";
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  click() { if (!this.disabled) this.listeners.click?.(); }
}
async function prompts(world) {
  const panels = [];
  const original = globalThis.document;
  globalThis.document = { createElement: () => new Element(), createTextNode: (textContent) => ({ textContent }) };
  class Panel {
    body = new Element(); visible = false;
    constructor() { panels.push(this); }
    show() { this.visible = true; } hide() { this.visible = false; }
  }
  const game = { world };
  const ui = await isolatedUi("InteractionPrompts", {
    "../game/Context.js": { game }, "./Widgets.js": { Panel },
    "../../world/PvpProtocol.js": pvp, "../../world/LfgProtocol.js": lfg,
  });
  const nodes = () => panels.flatMap((p) => p.body.children.flatMap((row) => row.children));
  return { ...ui, game, panels, nodes,
    button: (text) => nodes().find((node) => node.textContent === text),
    dispose: () => { globalThis.document = original; world.close(); },
  };
}
const onlyPackets = (transport, opcode) => transport.sent.filter((p) => p.opcode === opcode);
function bgStatus(state, timeout = 60_000) {
  const writer = new PacketWriter().u32(0).u8(0).u8(0).u32(2).u16(0x1f90).u8(10).u8(80).u32(0).u8(0).u32(state);
  if (state === 1) writer.u32(1_000).u32(500);
  if (state === 2) writer.u32(489).u64(0n).u32(timeout);
  if (state === 3) writer.u32(489).u64(0n).u32(0).u32(10_000).u8(1);
  return writer.toUint8Array();
}

test("summon buttons send one accept/decline and disappear on expiry", async () => {
  const { world, transport } = await loggedIn(); const ui = await prompts(world);
  try {
    for (const accept of [true, false]) {
      transport.push(OPCODES.SMSG_SUMMON_REQUEST, new PacketWriter().u64(99n).u32(12).u32(60_000).toUint8Array());
      await settle(); ui.showInteractionPrompts();
      const button = ui.button(accept ? "Принять призыв" : "Отклонить призыв");
      assert.ok(button); button.click(); button.click();
      assert.equal(ui.panels[0].visible, false);
      assert.deepEqual(onlyPackets(transport, OPCODES.CMSG_SUMMON_RESPONSE).at(-1).payload,
        new PacketWriter().u64(99n).u8(accept ? 1 : 0).toUint8Array());
    }
    assert.equal(onlyPackets(transport, OPCODES.CMSG_SUMMON_RESPONSE).length, 2);
    transport.push(OPCODES.SMSG_SUMMON_REQUEST, new PacketWriter().u64(99n).u32(12).u32(60_000).toUint8Array());
    await settle(); ui.showInteractionPrompts();
    ui.showInteractionPrompts(world.summonExpiresAt + 1);
    assert.equal(ui.panels[0].visible, false);
    assert.equal(world.summonRequest, undefined);
  } finally { ui.dispose(); }
});

test("shared quest dialog answers both branches with the correct IDs and rejects stale buttons", async () => {
  const { world, transport } = await loggedIn(); const ui = await prompts(world);
  try {
    for (const accept of [true, false]) {
      transport.push(OPCODES.SMSG_QUEST_CONFIRM_ACCEPT, new PacketWriter().u32(42).cString("Задание").u64(99n).toUint8Array());
      await settle(); ui.showInteractionPrompts();
      const button = ui.button(accept ? "Принять задание" : "Отклонить задание");
      assert.ok(button); button.click(); button.click();
      assert.equal(world.sharedQuest, undefined);
      assert.equal(ui.panels[0].visible, false);
    }
    assert.equal(onlyPackets(transport, OPCODES.CMSG_QUEST_CONFIRM_ACCEPT).length, 1);
    assert.deepEqual(onlyPackets(transport, OPCODES.CMSG_QUEST_CONFIRM_ACCEPT)[0].payload, new PacketWriter().u32(42).toUint8Array());
    assert.equal(onlyPackets(transport, OPCODES.MSG_QUEST_PUSH_RESULT).length, 1);
    // QuestHandler::HandleQuestPushResult reads guid >> questId >> msg; QuestDef.h decline is 3.
    const declined = onlyPackets(transport, OPCODES.MSG_QUEST_PUSH_RESULT)[0].payload;
    assert.equal(declined.byteLength, 13);
    const reader = new PacketReader(declined);
    assert.equal(reader.u64(), 99n); assert.equal(reader.u32(), 42); assert.equal(reader.u8(), 3);
    reader.assertFinished();
    // The server-to-client packet on the same MSG opcode deliberately omits questId.
    assert.deepEqual(parseQuestPushResult(new PacketWriter().u64(1n).u8(3).toUint8Array()), { guid: 1n, result: 3 });
  } finally { ui.dispose(); }
});

test("BG queue -> invite -> enter -> playing -> leave waits for server state; cancel and timeout work", async () => {
  const { world, transport } = await loggedIn(); const ui = await prompts(world);
  try {
    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS, bgStatus(1)); await settle(); ui.showInteractionPrompts();
    assert.equal(ui.button("Войти в бой"), undefined);
    ui.button("Покинуть очередь").click();
    assert.deepEqual(onlyPackets(transport, OPCODES.CMSG_BATTLEFIELD_PORT).at(-1).payload, pvp.buildBattlefieldPort(0, 2, false));
    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS, bgStatus(2)); await settle(); ui.showInteractionPrompts();
    const enter = ui.button("Войти в бой"); enter.click(); enter.click();
    assert.equal(onlyPackets(transport, OPCODES.CMSG_BATTLEFIELD_PORT).length, 2);
    assert.equal(world.battlefieldQueues.get(0).status, 2, "sending enter must not invent a successful port");
    assert.deepEqual(onlyPackets(transport, OPCODES.CMSG_BATTLEFIELD_PORT).at(-1).payload, pvp.buildBattlefieldPort(0, 2, true));
    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS, bgStatus(3)); await settle(); ui.showInteractionPrompts();
    ui.button("Покинуть поле боя").click();
    assert.deepEqual(onlyPackets(transport, OPCODES.CMSG_LEAVE_BATTLEFIELD).at(-1).payload, pvp.buildLeaveBattlefield(0, 2));
    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS, new PacketWriter().u32(0).u64(0n).toUint8Array()); await settle(); ui.showInteractionPrompts();
    assert.equal(ui.panels[0].visible, false);
    transport.push(OPCODES.SMSG_BATTLEFIELD_STATUS, bgStatus(2, 0)); await settle(); ui.showInteractionPrompts();
    assert.equal(ui.button("Войти в бой").disabled, true);
    ui.button("Войти в бой").click();
    assert.equal(onlyPackets(transport, OPCODES.CMSG_BATTLEFIELD_PORT).length, 2);
  } finally { ui.dispose(); }
});

test("macros reject conditions and multiple combat actions before executing any line", async () => {
  const executions = [], notices = [];
  class AccountStore { value = []; }
  const macros = await isolatedUi("Macros", {
    "../AccountStore.js": { AccountStore }, "./MacroModel.js": macroModel,
    "./Chat.js": { submitChat: (line) => executions.push(line) }, "./Notices.js": { notice: (message) => notices.push(message) },
  });
  // `[combat]`/`[mod:...]`/`[@unknown]` are still conditions and refuse; only a single
  // `[@target|focus|self|pet]` prefix is allowed. Two combat lines or a `;` chain refuse.
  for (const body of ["/say hello\n/cast [combat] 133", "/cast 133\n/use 6948", "/cast 133; /cast 116",
    "/cast [mod:shift] 133", "/cast [@unknown] 133"]) {
    macros.macroStores[0].value = [{ index: 1, name: "test", body }];
    macros.runMacro(1);
    assert.deepEqual(executions, []);
  }
  assert.equal(notices.length, 5);
  macros.macroStores[0].value = [{ index: 1, name: "test", body: "/say hello\n/cast 133" }];
  macros.runMacro(1);
  assert.deepEqual(executions, ["/say hello", "/cast 133"]);
  // Names, a single [@unit] and #showtooltip lines now execute instead of refusing.
  macros.macroStores[0].value = [{ index: 1, name: "named", body: "/cast Fireball" }];
  macros.runMacro(1);
  assert.equal(executions.at(-1), "/cast Fireball");
  macros.macroStores[0].value = [{ index: 1, name: "targeted", body: "/cast [@target] 133" }];
  macros.runMacro(1);
  assert.equal(executions.at(-1), "/cast [@target] 133");
  macros.macroStores[0].value = [{ index: 1, name: "tip", body: "#showtooltip Fireball\n/cast 133" }];
  macros.runMacro(1);
  assert.equal(executions.at(-1), "/cast 133");
  const text = "/say [Группа] Готов |Hitem:6948|h[Камень возвращения]|h";
  macros.macroStores[0].value = [{ index: 1, name: "chat", body: text }];
  macros.runMacro(1);
  assert.equal(executions.at(-1), text, "chat brackets and item links are text, not macro conditions");
});

test("combat commands use the existing cast guard and find an item in the current inventory", async () => {
  const casts = [], uses = [], messages = [];
  const world = { state: {}, useItem: (...args) => uses.push(args) };
  const spells = new Map([[133, { name: "Fireball" }]]);
  const commands = await isolatedUi("CombatCommands", {
    "../game/Context.js": { game: { world, spells } },
    "./MacroModel.js": macroModel,
    "./Spellbook.js": { castSpell: (id) => { casts.push(id); return false; } },
    "./Chat.js": { systemLine: (message) => messages.push(message) },
    "../Inventory.js": { playerInventory: () => ({ equipment: [], backpack: [], bags: [{ slots: [{ bag: 2, slot: 4, guid: 88n, item: { entry: 6948 } }] }] }) },
    "../../world/Fields.js": { worldObject: { entry: (item) => item.entry } },
    "../game/GroundTarget.js": { requestInventoryItemUse: (slot, send) => send() },
  });
  commands.runCastCommand("133"); assert.deepEqual(casts, [133]); assert.equal(messages.length, 1);
  // Names resolve against the spellbook; unknown names and conditions still refuse.
  commands.runCastCommand("Fireball"); assert.deepEqual(casts, [133, 133]);
  for (const invalid of ["[combat] 133", "133; /cast 116", "-1", "4294967296", "0", "Frostbolt"]) commands.runCastCommand(invalid);
  assert.deepEqual(casts, [133, 133]);
  commands.runUseCommand("6948"); assert.deepEqual(uses, [[2, 4, 88n]]);
  commands.runUseCommand("99999"); assert.equal(uses.length, 1);
});

test("LFG role check requires a selection and sends it; finished checks remove the prompt", async () => {
  const { world, transport } = await loggedIn(); const ui = await prompts(world);
  try {
    const rolePacket = (state, ready) => new PacketWriter().u32(state).u8(1).u8(1).u32(258).u8(1)
      .u64(1n).u8(ready ? 1 : 0).u32(0).u8(80).toUint8Array();
    transport.push(OPCODES.SMSG_LFG_ROLE_CHECK_UPDATE, rolePacket(2, false)); await settle(); ui.showInteractionPrompts();
    assert.equal(ui.button("Подтвердить роль").disabled, true);
    const tank = ui.nodes().find((node) => node.children?.some((child) => child.textContent === "Танк")).children[0];
    tank.checked = true; tank.listeners.change();
    assert.ok(ui.nodes().some((node) => node.children?.includes(tank)), "choosing a role preserves the focused checkbox for keyboard input");
    const confirm = ui.button("Подтвердить роль"); confirm.click(); confirm.click();
    assert.equal(onlyPackets(transport, OPCODES.CMSG_LFG_SET_ROLES).length, 1);
    assert.deepEqual(onlyPackets(transport, OPCODES.CMSG_LFG_SET_ROLES)[0].payload, lfg.buildLfgSetRoles(lfg.LFG_ROLE_TANK));
    transport.push(OPCODES.SMSG_LFG_ROLE_CHECK_UPDATE, rolePacket(1, true)); await settle(); ui.showInteractionPrompts();
    assert.equal(ui.panels[0].visible, false);
  } finally { ui.dispose(); }
});

test("LFG vote buttons send one yes/no; server finish and local timeout remove the prompt", async () => {
  const { world, transport } = await loggedIn(); const ui = await prompts(world);
  const votePacket = (active, guid = 99n) => new PacketWriter().u8(active ? 1 : 0).u8(0).u8(0).u64(guid)
    .u32(0).u32(0).u32(0).u32(3).cString("Не участвует").toUint8Array();
  try {
    for (const yes of [true, false]) {
      transport.push(OPCODES.SMSG_LFG_BOOT_PROPOSAL_UPDATE, votePacket(true)); await settle(); ui.showInteractionPrompts();
      const button = ui.button(yes ? "За исключение" : "Против исключения"); button.click(); button.click();
      world.voteToRemove(!yes);
      assert.deepEqual(onlyPackets(transport, OPCODES.CMSG_LFG_SET_BOOT_VOTE).at(-1).payload, lfg.buildLfgBootVote(yes));
      transport.push(OPCODES.SMSG_LFG_BOOT_PROPOSAL_UPDATE, votePacket(false)); await settle(); ui.showInteractionPrompts();
      assert.equal(ui.panels[0].visible, false);
    }
    assert.equal(onlyPackets(transport, OPCODES.CMSG_LFG_SET_BOOT_VOTE).length, 2);
    transport.push(OPCODES.SMSG_LFG_BOOT_PROPOSAL_UPDATE, votePacket(true)); await settle(); ui.showInteractionPrompts();
    const deadline = world.lfgBootExpiresAt;
    transport.push(OPCODES.SMSG_LFG_BOOT_PROPOSAL_UPDATE, votePacket(true)); await settle();
    assert.equal(world.lfgBootExpiresAt, deadline, "progress update must not restart the vote timer");
    const stale = ui.button("За исключение");
    ui.showInteractionPrompts(deadline + 1); stale.click();
    assert.equal(world.lfgBoot, undefined);
    assert.equal(ui.panels[0].visible, false);
    assert.equal(onlyPackets(transport, OPCODES.CMSG_LFG_SET_BOOT_VOTE).length, 2);
  } finally { ui.dispose(); }
});

test("outdoor entry uses server time and refuses expired invitations", async () => {
  const { world, transport } = await loggedIn();
  try {
    transport.push(OPCODES.SMSG_WORLD_STATE_UI_TIMER_UPDATE, new PacketWriter().u32(1000).toUint8Array());
    transport.push(OPCODES.SMSG_BATTLEFIELD_MGR_ENTRY_INVITE, new PacketWriter().u32(1).u32(4197).u32(999).toUint8Array());
    await settle(); world.answerBattlefieldWarInvite(1, true);
    assert.equal(onlyPackets(transport, OPCODES.CMSG_BATTLEFIELD_MGR_ENTRY_INVITE_RESPONSE).length, 0);
  } finally { world.close(); }
});

test("outdoor accepted queue is retained until cancel and active leave uses the zone-exit opcode", async () => {
  const { world, transport } = await loggedIn();
  try {
    transport.push(OPCODES.SMSG_BATTLEFIELD_MGR_QUEUE_REQUEST_RESPONSE, new PacketWriter().u32(1).u32(4197).u8(1).u8(1).u8(1).toUint8Array());
    await settle(); assert.equal(world.battlefieldQueuedId, 1);
    world.leaveBattlefieldQueue(1);
    assert.equal(world.battlefieldQueuedId, 0);
    assert.deepEqual(onlyPackets(transport, OPCODES.CMSG_BATTLEFIELD_MGR_EXIT_REQUEST)[0].payload, new PacketWriter().u32(1).toUint8Array());
    transport.push(OPCODES.SMSG_BATTLEFIELD_MGR_ENTERED, new PacketWriter().u32(1).u8(1).u8(1).u8(0).toUint8Array());
    await settle(); world.leaveBattlefield();
    assert.equal(onlyPackets(transport, OPCODES.CMSG_HEARTH_AND_RESURRECT).length, 1);
    assert.equal(onlyPackets(transport, OPCODES.CMSG_HEARTH_AND_RESURRECT)[0].payload.length, 0);
    assert.equal(world.battlefieldBattleId, 1, "wait for the server's ejected notification");
  } finally { world.close(); }
});

test("outdoor dialogs handle queue accept/decline, war accept/decline, expiry and active departure", async () => {
  const { world, transport } = await loggedIn(); const ui = await prompts(world);
  const queueInvite = () => transport.push(OPCODES.SMSG_BATTLEFIELD_MGR_QUEUE_INVITE,
    new PacketWriter().u32(1).u8(1).toUint8Array());
  const warInvite = (expiresAt) => transport.push(OPCODES.SMSG_BATTLEFIELD_MGR_ENTRY_INVITE,
    new PacketWriter().u32(1).u32(4197).u32(expiresAt).toUint8Array());
  try {
    for (const accepted of [true, false]) {
      queueInvite(); await settle(); ui.showInteractionPrompts();
      const button = ui.button(accepted ? "Встать в очередь на битву" : "Отклонить очередь на битву");
      button.click(); button.click();
      assert.deepEqual(onlyPackets(transport, OPCODES.CMSG_BATTLEFIELD_MGR_QUEUE_INVITE_RESPONSE).at(-1).payload,
        new PacketWriter().u32(1).u8(accepted ? 1 : 0).toUint8Array());
    }
    assert.equal(onlyPackets(transport, OPCODES.CMSG_BATTLEFIELD_MGR_QUEUE_INVITE_RESPONSE).length, 2);
    warInvite(1060); await settle(); ui.showInteractionPrompts();
    assert.equal(ui.button("Вступить в битву").disabled, true, "wait for server time instead of comparing to the local wall clock");
    assert.ok(onlyPackets(transport, OPCODES.CMSG_WORLD_STATE_UI_TIMER_UPDATE).length > 0);
    transport.push(OPCODES.SMSG_WORLD_STATE_UI_TIMER_UPDATE, new PacketWriter().u32(1000).toUint8Array()); await settle(); ui.showInteractionPrompts();
    ui.button("Вступить в битву").click();
    assert.deepEqual(onlyPackets(transport, OPCODES.CMSG_BATTLEFIELD_MGR_ENTRY_INVITE_RESPONSE).at(-1).payload, new PacketWriter().u32(1).u8(1).toUint8Array());
    warInvite(1060); await settle(); ui.showInteractionPrompts(); ui.button("Отклонить битву").click();
    assert.deepEqual(onlyPackets(transport, OPCODES.CMSG_BATTLEFIELD_MGR_ENTRY_INVITE_RESPONSE).at(-1).payload, new PacketWriter().u32(1).u8(0).toUint8Array());
    warInvite(1001); await settle(); ui.showInteractionPrompts();
    const stale = ui.button("Вступить в битву");
    ui.updateInteractionPrompts(performance.now() + 2000); stale.click();
    assert.equal(world.battlefieldWarInvite, undefined);
    assert.equal(onlyPackets(transport, OPCODES.CMSG_BATTLEFIELD_MGR_ENTRY_INVITE_RESPONSE).length, 2);
    transport.push(OPCODES.SMSG_BATTLEFIELD_MGR_QUEUE_REQUEST_RESPONSE, new PacketWriter().u32(1).u32(4197).u8(1).u8(1).u8(1).toUint8Array());
    await settle(); ui.showInteractionPrompts(); ui.button("Выйти из очереди на битву").click();
    assert.equal(world.battlefieldQueuedId, 0);
    transport.push(OPCODES.SMSG_BATTLEFIELD_MGR_ENTERED, new PacketWriter().u32(1).u8(1).u8(1).u8(0).toUint8Array());
    await settle(); ui.showInteractionPrompts(); ui.button("Покинуть зону битвы").click();
    assert.equal(onlyPackets(transport, OPCODES.CMSG_HEARTH_AND_RESURRECT).length, 1);
    transport.push(OPCODES.SMSG_BATTLEFIELD_MGR_EJECTED, new PacketWriter().u32(1).u8(8).u8(2).u8(1).toUint8Array());
    await settle(); ui.showInteractionPrompts(); assert.equal(ui.panels[0].visible, false);
  } finally { ui.dispose(); }
});

test("a countdown tick preserves focused controls and logout clears all response state", async () => {
  const { world, transport } = await loggedIn(); const ui = await prompts(world);
  try {
    transport.push(OPCODES.SMSG_SUMMON_REQUEST, new PacketWriter().u64(99n).u32(12).u32(60_000).toUint8Array());
    await settle(); ui.showInteractionPrompts();
    const originalButton = ui.button("Принять призыв");
    ui.updateInteractionPrompts(performance.now() + 1000);
    assert.equal(ui.button("Принять призыв"), originalButton, "ticking must not detach the keyboard focused control");
    world.close(); ui.updateInteractionPrompts(performance.now() + 2500); originalButton.click();
    assert.equal(ui.panels[0].visible, false);
    assert.equal(onlyPackets(transport, OPCODES.CMSG_SUMMON_RESPONSE).length, 0);
  } finally { ui.dispose(); }
});

test("summon acceptance preserves a request during combat/death and retries after fields recover", async () => {
  const { world, transport } = await loggedIn(); const ui = await prompts(world);
  const fields = new Map();
  world.state.selfGuid = 1n;
  world.state.objects.set(1n, { guid: 1n, typeId: 4, fields });
  try {
    for (const blocked of ["combat", "dead"]) {
      fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, blocked === "dead" ? 0 : 100);
      fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, blocked === "combat" ? UNIT_FLAG_IN_COMBAT : 0);
      transport.push(OPCODES.SMSG_SUMMON_REQUEST, new PacketWriter().u64(99n).u32(12).u32(60_000).toUint8Array());
      await settle(); ui.showInteractionPrompts();
      const request = world.summonRequest;
      const before = onlyPackets(transport, OPCODES.CMSG_SUMMON_RESPONSE).length;
      world.answerSummon(true);
      assert.equal(onlyPackets(transport, OPCODES.CMSG_SUMMON_RESPONSE).length, before);
      assert.equal(world.summonRequest, request);
      assert.equal(ui.button("Принять призыв").disabled, true);
      fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
      fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0);
      ui.updateInteractionPrompts(performance.now() + (blocked === "combat" ? 2000 : 4000));
      assert.equal(ui.button("Принять призыв").disabled, false);
      ui.button("Принять призыв").click();
      assert.equal(onlyPackets(transport, OPCODES.CMSG_SUMMON_RESPONSE).length, before + 1);
      assert.equal(world.summonRequest, undefined);
    }
  } finally { ui.dispose(); }
});

test("sharing a quest sends CMSG_PUSHQUESTTOPARTY and rejects bad ids", async () => {
  const { world, transport } = await loggedIn();
  try {
    world.shareQuest(42);
    const sent = onlyPackets(transport, OPCODES.CMSG_PUSHQUESTTOPARTY);
    assert.equal(sent.length, 1);
    assert.equal(new PacketReader(sent[0].payload).u32(), 42);
    world.shareQuest(0);
    world.shareQuest(-3);
    assert.equal(onlyPackets(transport, OPCODES.CMSG_PUSHQUESTTOPARTY).length, 1);
  } finally { world.close(); }
});

test("a duel challenge casts the Duel spell at the selection", async () => {
  const { world, transport } = await loggedIn();
  try {
    world.state.selfGuid = 1n;
    assert.equal(world.challengeDuelToSelection(), false, "no selection challenges nothing");
    world.targetGuid = 5n;
    assert.equal(world.challengeDuelToSelection(), true);
    const sent = onlyPackets(transport, OPCODES.CMSG_CAST_SPELL);
    assert.equal(sent.length, 1);
    const reader = new PacketReader(sent[0].payload);
    reader.u8();
    assert.equal(reader.u32(), 7266);
    reader.u8();
    assert.equal(reader.u32(), TARGET_FLAG_UNIT);
    assert.equal(reader.packedGuid(), 5n);
    reader.assertFinished();
  } finally { world.close(); }
});

test("channel moderation sends the matching opcodes with channel and name", async () => {
  const { world, transport } = await loggedIn();
  try {
    world.kickChannelMember("Торговля", "Маг");
    world.banChannelMember("Торговля", "Маг");
    world.muteChannelMember("Торговля", "Маг");
    world.unmuteChannelMember("Торговля", "Маг");
    world.setChannelModerator("Торговля", "Маг");
    world.unsetChannelModerator("Торговля", "Маг");
    world.requestChannelList("Торговля");
    world.toggleChannelAnnounce("Торговля");
    const codes = [
      OPCODES.CMSG_CHANNEL_KICK, OPCODES.CMSG_CHANNEL_BAN, OPCODES.CMSG_CHANNEL_MUTE,
      OPCODES.CMSG_CHANNEL_UNMUTE, OPCODES.CMSG_CHANNEL_MODERATOR, OPCODES.CMSG_CHANNEL_UNMODERATOR,
      OPCODES.CMSG_CHANNEL_LIST, OPCODES.CMSG_CHANNEL_ANNOUNCEMENTS,
    ];
    for (const opcode of codes) assert.equal(onlyPackets(transport, opcode).length, 1, `opcode ${opcode}`);
    const kick = new PacketReader(onlyPackets(transport, OPCODES.CMSG_CHANNEL_KICK)[0].payload);
    assert.equal(kick.cString(), "Торговля");
    assert.equal(kick.cString(), "Маг");
    kick.assertFinished();
  } finally { world.close(); }
});

test("calendar moderation and guild rank senders reach the wire", async () => {
  const { world, transport } = await loggedIn();
  try {
    world.removeCalendarInvite(1n, 2n, 3n, 4n);
    world.setCalendarModerator(1n, 3n, 2n, 1, 4n);
    world.complainAboutCalendarInvite(1n, 3n, 2n);
    assert.equal(onlyPackets(transport, OPCODES.CMSG_CALENDAR_EVENT_REMOVE_INVITE).length, 1);
    assert.equal(onlyPackets(transport, OPCODES.CMSG_CALENDAR_EVENT_MODERATOR_STATUS).length, 1);
    assert.equal(onlyPackets(transport, OPCODES.CMSG_CALENDAR_COMPLAIN).length, 1);
    world.setGuildRank(0, 0xFFFFFFFF, "Глава", -1,
      Array.from({ length: 6 }, (_, index) => ({ rights: index + 1, slots: 10 + index })));
    world.addGuildRank("Новобранец");
    world.removeLowestGuildRank();
    world.setGuildInfoText("Информация");
    world.disbandGuild();
    for (const opcode of [OPCODES.CMSG_GUILD_RANK, OPCODES.CMSG_GUILD_ADD_RANK,
      OPCODES.CMSG_GUILD_DEL_RANK, OPCODES.CMSG_GUILD_INFO_TEXT, OPCODES.CMSG_GUILD_DISBAND]) {
      assert.equal(onlyPackets(transport, opcode).length, 1, `opcode ${opcode}`);
    }
  } finally { world.close(); }
});

test("LFG proposal, reward and continue flow through the prompts", async () => {
  const { world, transport } = await loggedIn(); const ui = await prompts(world);
  try {
    const proposal = (id) => new PacketWriter().u32(258).u8(0).u32(id).u32(0).u8(1).u8(0).toUint8Array();
    transport.push(OPCODES.SMSG_LFG_PROPOSAL_UPDATE, proposal(77)); await settle(); ui.showInteractionPrompts();
    const accept = ui.button("Принять вход");
    assert.ok(accept); accept.click();
    assert.deepEqual(onlyPackets(transport, OPCODES.CMSG_LFG_PROPOSAL_RESULT)[0].payload,
      lfg.buildLfgProposalResult(77, true));
    assert.equal(world.lfgProposal, undefined);

    transport.push(OPCODES.SMSG_LFG_PLAYER_REWARD,
      new PacketWriter().u32(1).u32(258).u8(0).u32(0).u32(100).u32(0).u32(0).u32(0).u8(0).toUint8Array());
    await settle(); ui.showInteractionPrompts();
    assert.ok(ui.button("Понятно"));
    ui.button("Понятно").click();
    assert.equal(world.lfgReward, undefined);

    transport.push(OPCODES.SMSG_LFG_OFFER_CONTINUE, new PacketWriter().u32(258).toUint8Array());
    await settle(); ui.showInteractionPrompts();
    assert.equal(world.lfgOfferContinue, 258);
    assert.ok(ui.button("Остаться в группе"));
    ui.button("Остаться в группе").click();
    assert.equal(world.lfgOfferContinue, undefined);
    assert.equal(onlyPackets(transport, OPCODES.CMSG_LFG_LEAVE).length, 0, "staying sends nothing");
  } finally { ui.dispose(); }
});

test("role choices and search state are kept for the LFG window", async () => {
  const { world, transport } = await loggedIn();
  try {
    transport.push(OPCODES.SMSG_LFG_ROLE_CHOSEN, new PacketWriter().u64(9n).u8(1).u32(4).toUint8Array());
    transport.push(OPCODES.SMSG_LFG_UPDATE_SEARCH, new PacketWriter().u8(1).toUint8Array());
    await settle();
    assert.deepEqual(world.lfgRolesChosen.get(9n), { guid: 9n, ready: true, roles: 4 });
    assert.equal(world.lfgSearching, true);
    world.leaveLfg();
    assert.equal(world.lfgRolesChosen.size, 0);
    assert.equal(world.lfgSearching, false);
    assert.equal(onlyPackets(transport, OPCODES.CMSG_LFG_LEAVE).length, 1);
  } finally { world.close(); }
});

test("category cooldowns are shared and item cooldowns leave a marker", async () => {
  const { world, transport } = await loggedIn();
  try {
    transport.push(OPCODES.SMSG_INITIAL_SPELLS, new PacketWriter().u8(0).u16(0).u16(1)
      .u32(133).u16(0).u16(7).u32(0).u32(5000).toUint8Array());
    await settle();
    assert.equal(world.spellCategories.get(133), 7);
    assert.ok(world.cooldownRemaining(133) > 0);
    world.spellCategories.set(116, 7);
    assert.ok(world.cooldownRemaining(116) > 0, "a sibling in the category shares the lockout");

    transport.push(OPCODES.SMSG_ITEM_COOLDOWN, new PacketWriter().u64(88n).u32(6948).toUint8Array());
    await settle();
    assert.ok(world.itemCooldownRemaining(6948) > 0);
  } finally { world.close(); }
});

test("spell modifiers, totems and projectiles land in state instead of being dropped", async () => {
  const { world, transport } = await loggedIn();
  try {
    transport.push(OPCODES.SMSG_SET_FLAT_SPELL_MODIFIER,
      new PacketWriter().u8(3).u8(0).i32(15).toUint8Array());
    transport.push(OPCODES.SMSG_TOTEM_CREATED,
      new PacketWriter().u8(1).u64(77n).u32(60000).u32(8071).toUint8Array());
    transport.push(OPCODES.SMSG_SET_PROJECTILE_POSITION,
      new PacketWriter().u64(5n).u8(2).f32(1).f32(2).f32(3).toUint8Array());
    await settle();
    assert.deepEqual(world.spellModifiers.get("3:0:flat"), { effectIndex: 3, op: 0, value: 15, pct: false });
    assert.equal(world.totems.get(1).guid, 77n);
    assert.equal(world.totems.get(1).spellId, 8071);
    assert.deepEqual(world.projectiles.get(5n), { castCount: 2, x: 1, y: 2, z: 3 });
  } finally { world.close(); }
});

test("duel bounds update state and queue exactly one chat line", async () => {
  const { world, transport } = await loggedIn();
  try {
    transport.push(OPCODES.SMSG_DUEL_OUTOFBOUNDS, new Uint8Array(0)); await settle();
    assert.equal(world.duelInBounds, false);
    assert.ok(world.takeDuelBoundsMessage());
    assert.equal(world.takeDuelBoundsMessage(), undefined, "the line is said once");
    transport.push(OPCODES.SMSG_DUEL_INBOUNDS, new Uint8Array(0)); await settle();
    assert.equal(world.duelInBounds, true);
    assert.equal(world.takeDuelBoundsMessage(), undefined);
  } finally { world.close(); }
});

test("unit+destination packets can encode explicit transport-relative coordinates", () => {
  const packet = buildCastSpell(133, 4, { x: 1, y: 2, z: 3 }, { unitTarget: 9n, transportGuid: 11n });
  const reader = new PacketReader(packet);
  assert.equal(reader.u8(), 4);
  assert.equal(reader.u32(), 133);
  reader.u8();
  assert.equal(reader.u32(), TARGET_FLAG_UNIT | TARGET_FLAG_DEST_LOCATION);
  assert.equal(reader.packedGuid(), 9n);
  assert.equal(reader.packedGuid(), 11n);
  assert.ok(Math.abs(reader.f32() - 1) < 0.001);
  assert.ok(Math.abs(reader.f32() - 2) < 0.001);
  assert.ok(Math.abs(reader.f32() - 3) < 0.001);
  reader.assertFinished();
});

test("the targeting context acts through the controlled unit", async () => {
  const { world } = await loggedIn();
  try {
    world.state.selfGuid = 1n;
    assert.equal(casterGuid(world), 1n);
    world.controlledGuid = 9n;
    assert.equal(casterGuid(world), 9n);
    const context = targetingContext(world);
    assert.equal(context.casterGuid, 9n);
    assert.equal(context.transportGuid, 0n);
  } finally { world.close(); }
});

test("diminishing returns decay 1, 1/2, 1/4, immune inside the window", () => {
  resetDr();
  const guid = 21n;
  assert.equal(noteDrApplication(guid, "stun", 1000), 1);
  assert.equal(drFactor(guid, "stun", 2000), 0.5);
  assert.equal(noteDrApplication(guid, "stun", 2000), 0.5);
  assert.equal(drFactor(guid, "stun", 3000), 0.25);
  assert.equal(noteDrApplication(guid, "stun", 3000), 0.25);
  assert.equal(drFactor(guid, "stun", 4000), 0);
  assert.equal(drFactor(guid, "root", 4000), 1, "categories are independent");
  assert.equal(drFactor(guid, "stun", 3000 + 18_001), 1, "the window expires");
  resetDr();
});

test("spell modifiers word themselves and scoreboard headers name the battleground", () => {
  assert.equal(spellModifierText({ effectIndex: 3, op: 0, value: 15, pct: true }), "урон (семейство 3): +15%");
  assert.equal(spellModifierText({ effectIndex: 1, op: 14, value: -100, pct: false }), "стоимость (семейство 1): -100");
  assert.deepEqual(objectiveHeaders(5, 30),
    ["Кладб. штурм", "Кладб. оборона", "Башни штурм", "Башни оборона", "Рудники"]);
  assert.deepEqual(objectiveHeaders(2, 489), ["Захваты флага", "Возвраты флага"]);
  assert.deepEqual(objectiveHeaders(2, 529), ["Штурмы баз", "Оборона баз"]);
  assert.deepEqual(objectiveHeaders(1), ["Захваты флага"]);
  assert.deepEqual(objectiveHeaders(0), []);
});

test("macros allow one [@unit], names and #showtooltip, and refuse the rest", async () => {
  assert.deepEqual(macroModel.macroTargetUnit("/cast [@target] Fireball"),
    { unit: "target", rest: "/cast Fireball" });
  assert.deepEqual(macroModel.macroTargetTokens("/use [@focus] 6948"), ["focus"]);
  const problems = (body) => macroModel.macroProblems("test", body);
  assert.equal(problems("/cast [@target] 133").length, 0);
  assert.equal(problems("#showtooltip Fireball\n/cast 133").length, 0);
  assert.ok(problems("/cast [combat] 133").length > 0);
  assert.ok(problems("/cast [@unknown] 133").length > 0);
  assert.ok(problems("/cast [@target] [@focus] 133").length > 0);
});

test("learning a top rank promotes bar slots holding its lower ranks", async () => {
  const actions = [];
  const world = {
    actionButtons: [
      { slot: 12, action: 2, type: ACTION_BUTTON_SPELL },
      { slot: 13, action: 9, type: ACTION_BUTTON_SPELL },
    ],
    knownSpells: [{ id: 1 }, { id: 2 }, { id: 9 }],
    setActionButton(slot, action, type) {
      actions.push([slot, action, type]);
      this.actionButtons = this.actionButtons.map((button) =>
        button.slot === slot ? { slot, action, type } : button);
    },
  };
  const bar = await isolatedUi("ActionBar", {
    "../game/Context.js": { game: { world } },
    "../Inventory.js": { playerInventory: () => undefined },
    "./Spellbook.js": {
      castSpell: () => false,
      spellTooltip: () => ({}),
      highestKnownRank: (id) => (id === 2 ? 1 : id),
    },
    "./Macros.js": { macroAt: () => undefined, runMacro: () => {} },
    "./MacroModel.js": macroModel,
    "./EquipmentSets.js": { wearEquipmentSetByIndex: () => false },
    "../../world/ActionBarProtocol.js": await import("../dist/code/world/ActionBarProtocol.js"),
  });
  bar.upgradeActionBarRanks();
  assert.deepEqual(actions, [[12, 1, ACTION_BUTTON_SPELL]], "only the lower-rank slot moves");
});

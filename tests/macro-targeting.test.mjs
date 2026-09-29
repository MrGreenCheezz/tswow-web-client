import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { buildAutoRepeatCastSpell, buildCastSpell } from "../dist/code/world/SpellProtocol.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { hoveredUnitGuid, setHoveredTarget } from "../dist/code/browser/game/HoverTarget.js";
import * as macroModel from "../dist/code/browser/ui/MacroModel.js";

async function combatCommands(game, casts, messages) {
  const source = await readFile(new URL("../src/browser/ui/CombatCommands.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const modules = {
    "../game/Context.js": { game },
    "../game/HoverTarget.js": { hoveredUnitGuid },
    "./MacroModel.js": macroModel,
    "./Spellbook.js": { castSpell: (...args) => { casts.push(args); return true; } },
    "./Chat.js": { systemLine: (line) => messages.push(line) },
  };
  const exports = {};
  new Function("require", "exports", js)((name) => modules[name] ?? {}, exports);
  return exports;
}

function unit(guid, typeId = 3, x = 1) {
  return { guid, typeId, position: { x, y: 2, z: 3, orientation: 0 }, fields: new Map() };
}

test("addressed macro casts keep selection and refuse a missing or unsupported unit", async () => {
  const self = unit(1n, 4);
  const selected = unit(2n, 3);
  const focus = unit(3n, 3);
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, self], [2n, selected], [3n, focus]]) },
    targetGuid: 2n,
    selectTarget() { throw new Error("a macro must never retarget the world"); },
  };
  const game = { world, focusGuid: 3n, spells: new Map([[133, {
    name: "Fireball", unitTargetContractVersion: 1, supportsExplicitUnitTarget: true,
  }], [10, { name: "Blizzard", unitTargetContractVersion: 1, supportsExplicitUnitTarget: false }]]) };
  const casts = [], messages = [];
  const commands = await combatCommands(game, casts, messages);

  commands.runCastCommand("[@focus] Fireball");
  commands.runCastCommand("[@self] 133");
  commands.runCastCommand("[@target] 133");
  assert.deepEqual(casts, [[133, 3n], [133, 1n], [133, undefined]]);
  assert.equal(world.targetGuid, 2n);

  game.focusGuid = undefined;
  commands.runCastCommand("[@focus] 133");
  commands.runCastCommand("[@focus] 10");
  assert.deepEqual(casts, [[133, 3n], [133, 1n], [133, undefined]]);
  assert.match(messages[0], /Нет цели/);
  game.focusGuid = 3n;
  commands.runCastCommand("[@focus] 10");
  assert.match(messages.at(-1), /не поддерживает/);
  assert.equal(casts.length, 3);

  commands.runUseCommand("[@focus] 6948");
  assert.match(messages.at(-1), /\/use пока не поддерживается/);
  assert.ok(macroModel.macroProblems("test", "/use [@focus] 6948").length > 0);
});

test("mouseover names the current visible unit and never falls back to selection", async () => {
  const selected = unit(2n);
  const hovered = unit(3n);
  const world = { state: { selfGuid: 1n, objects: new Map([[2n, selected], [3n, hovered]]) }, targetGuid: 2n };
  const game = { world, spells: new Map([[133, {
    name: "Fireball", unitTargetContractVersion: 1, supportsExplicitUnitTarget: true,
  }]]) };
  const casts = [], messages = [];
  const commands = await combatCommands(game, casts, messages);
  setHoveredTarget(world, hovered);
  commands.runCastCommand("[@mouseover] 133");
  assert.deepEqual(casts, [[133, 3n]]);
  world.state.objects.set(3n, unit(3n));
  assert.equal(hoveredUnitGuid(world), undefined, "reused GUID does not inherit a hover");
  commands.runCastCommand("[@mouseover] 133");
  assert.equal(casts.length, 1);
  assert.match(messages.at(-1), /Нет цели для \[@mouseover\]/);
  setHoveredTarget(world, unit(4n, 5));
  assert.equal(hoveredUnitGuid(world), undefined, "game objects are not unit targets");
  setHoveredTarget(undefined, undefined);
});

function worldHarness() {
  const connection = {
    sent: [], send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return new Promise(() => {}); }, close() {},
  };
  const world = new WorldClient(connection);
  world.state.selfGuid = 1n;
  for (const [guid, typeId, x] of [[1n, 4, 1], [2n, 3, 5], [3n, 3, 8]]) {
    world.state.move(guid, { flags: 0, position: { x, y: 2, z: 3, orientation: 0 } });
    world.state.objects.get(guid).typeId = typeId;
  }
  world.knownSpells = [{ id: 133, slot: 0 }, { id: 75, slot: 1 }];
  world.selectTarget(2n);
  connection.sent.length = 0;
  return { world, connection };
}

test("direct unit cast writes Trinity's unit GUID without stopping attack or changing selection", () => {
  const { world, connection } = worldHarness();
  try {
    world.attacking = true;
    world.castSpell(133, 0, false, 3n);
    assert.equal(world.targetGuid, 2n);
    assert.equal(world.attacking, true);
    assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [OPCODES.CMSG_CAST_SPELL]);
    assert.deepEqual(connection.sent[0].payload,
      buildCastSpell(133, 1, { x: 8, y: 2, z: 3, orientation: 0 }, { unitTarget: 3n }));
    world.state.objects.delete(3n);
    world.castSpell(133, 0, false, 3n);
    assert.equal(connection.sent.length, 1, "stale target is blocked before any wire action");
  } finally { world.close(); }
});

test("explicit ranged auto-repeat names and faces its macro target", () => {
  const { world, connection } = worldHarness();
  try {
    world.setAutoRepeatSpellIds([75]);
    world.castSpell(75, 0, false, 3n);
    assert.equal(world.targetGuid, 2n);
    assert.deepEqual(connection.sent.at(-1), {
      opcode: OPCODES.CMSG_CAST_SPELL,
      payload: buildAutoRepeatCastSpell(75, 1, 3n),
    });
    assert.equal(connection.sent.some(({ opcode }) => opcode === OPCODES.CMSG_SET_SELECTION), false);
  } finally { world.close(); }
});

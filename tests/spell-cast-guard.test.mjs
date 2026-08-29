import assert from "node:assert/strict";
import test from "node:test";

const { game } = await import("../dist/code/browser/game/Context.js");
const { spellCastBlockReason } = await import("../dist/code/browser/SpellCastGuard.js");
const { WINDOW_COMMAND_TABLE } = await import("../dist/code/browser/ui/WindowActions.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

function harness(spellId, metadata) {
  const guid = 1n;
  const connection = {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return new Promise(() => {}); },
    close() {},
  };
  const world = new WorldClient(connection);
  world.state.selfGuid = guid;
  world.state.move(guid, { flags: 0, position: { x: 1, y: 2, z: 3, orientation: 0 } });
  const player = world.state.objects.get(guid);
  player.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x08000000);
  world.knownSpells = [{ id: spellId, slot: 0 }];
  game.world = world;
  game.spells = new Map([[spellId, metadata]]);
  return { world, connection, player };
}

function metadata(id, extra = {}) {
  return {
    id, name: "Заклинание", rank: "", description: "", iconId: 0, iconPath: "", passive: false,
    powerType: 0, powerCost: 0, powerCostPercent: 0, recoveryTime: 0, categoryRecoveryTime: 0,
    startRecoveryTime: 0, cooldownStartedOnEvent: false, effectAura: [], effectMiscValue: [],
    effectBasePoints: [], effectDieSides: [], effectPeriod: [], duration: 0, procChance: 0,
    spellLevel: 0, spellClassSet: 3, spellClassMask: [1, 0, 0], ...extra,
  };
}

test("direct module spell actions reject locally known blockers before auto-dismount", () => {
  const spellId = 133;
  const cases = [
    ["passive", metadata(spellId, { passive: true })],
    ["cooldown", metadata(spellId, { recoveryTime: 10_000 })],
    ["global-cooldown", metadata(spellId, { startRecoveryTime: 1_500 })],
    ["power", metadata(spellId, { powerCost: 100 })],
  ];
  try {
    for (const [reason, row] of cases) {
      game.globalCooldownUntil = 0;
      const { world, connection, player } = harness(spellId, row);
      if (reason === "cooldown") world.cooldowns.set(spellId, performance.now() + 10_000);
      if (reason === "global-cooldown") game.globalCooldownUntil = performance.now() + 10_000;
      if (reason === "power") {
        player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 0);
        player.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 0);
      }
      assert.equal(spellCastBlockReason(world, spellId), reason);
      WINDOW_COMMAND_TABLE.castSpell.run({ number: () => spellId }, {}, world);
      assert.deepEqual(connection.sent, [], `${reason} must not send a mount cancel`);
      world.close();
    }
  } finally {
    game.world = undefined;
    game.spells = new Map();
    game.globalCooldownUntil = 0;
  }
});

test("power preflight uses the spell's resource and percent base before auto-dismount", () => {
  const spellId = 133;
  const manaPercent = metadata(spellId, { powerCostPercent: 50 });
  const differentResource = metadata(spellId, { powerType: 3, powerCost: 20 });
  const missingFields = metadata(spellId, { powerCostPercent: 50 });
  const runePercent = metadata(spellId, { powerType: 5, powerCostPercent: 50 });
  try {
    const insufficient = harness(spellId, manaPercent);
    insufficient.player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BASE_MANA.offset, 100);
    insufficient.player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 0);
    insufficient.player.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 0);
    assert.equal(spellCastBlockReason(insufficient.world, spellId), "power");
    WINDOW_COMMAND_TABLE.castSpell.run({ number: () => spellId }, {}, insufficient.world);
    assert.deepEqual(insufficient.connection.sent, [], "insufficient percent mana does not dismount");
    insufficient.world.close();

    const energy = harness(spellId, differentResource);
    // The active display resource is mana, but the spell explicitly consumes energy slot 3.
    energy.player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 0);
    energy.player.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 3, 30);
    assert.equal(spellCastBlockReason(energy.world, spellId), undefined);
    WINDOW_COMMAND_TABLE.castSpell.run({ number: () => spellId }, {}, energy.world);
    assert.equal(energy.connection.sent.length, 2, "the matching resource permits cancel then cast");
    energy.world.close();

    const unknown = harness(spellId, missingFields);
    assert.equal(spellCastBlockReason(unknown.world, spellId), undefined);
    WINDOW_COMMAND_TABLE.castSpell.run({ number: () => spellId }, {}, unknown.world);
    assert.equal(unknown.connection.sent.length, 2, "missing resource fields defer to the server");
    unknown.world.close();

    const rune = harness(spellId, runePercent);
    // Rune percentage costs have no trustworthy max-power base in the client fields; do not
    // manufacture one, even if a stale max-power slot happens to be present.
    rune.player.fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset + 5, 1000);
    rune.player.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 5, 0);
    assert.equal(spellCastBlockReason(rune.world, spellId), undefined);
    WINDOW_COMMAND_TABLE.castSpell.run({ number: () => spellId }, {}, rune.world);
    assert.equal(rune.connection.sent.length, 2, "unsupported rune percent base defers to the server");
    rune.world.close();
  } finally {
    game.world = undefined;
    game.spells = new Map();
  }
});

test("active mount toggle bypasses power preflight and remains cancel-only", () => {
  const spellId = 23214;
  try {
    const { world, connection, player } = harness(spellId, metadata(spellId, {
      powerType: 0, powerCostPercent: 100, effectAura: [78, 0, 0],
    }));
    player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BASE_MANA.offset, 100);
    player.fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 0);
    player.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 0);
    world.setMountSpellIds([spellId]);
    world.auras.set(1n, new Map([[0, {
      slot: 0, spellId, flags: 0, casterLevel: 80, applications: 1,
    }]]));
    assert.equal(spellCastBlockReason(world, spellId), undefined);
    WINDOW_COMMAND_TABLE.castSpell.run({ number: () => spellId }, {}, world);
    assert.equal(connection.sent.length, 1, "an active mount sends only the cancel request");
    world.close();
  } finally {
    game.world = undefined;
    game.spells = new Map();
  }
});

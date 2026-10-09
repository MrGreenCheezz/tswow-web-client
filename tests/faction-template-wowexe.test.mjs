import assert from "node:assert/strict";
import test from "node:test";
import {
  FACTION_MASK_ALLIANCE, FACTION_MASK_HORDE, FACTION_MASK_MONSTER, FACTION_MASK_PLAYER,
  REACTION_FRIENDLY, REACTION_HOSTILE, REACTION_NEUTRAL, isFriendlyTo, isHostileTo, reactionBetween,
} from "../dist/code/world/FactionRules.js";
import {
  FACTION_TEMPLATE_FLAG_HOSTILE_BY_DEFAULT, TEMPLATE_RANK_FRIENDLY, TEMPLATE_RANK_HOSTILE, TEMPLATE_RANK_NEUTRAL,
  factionTemplateRank,
} from "../dist/code/world/FactionTemplateReaction.js";
import { loadFactionData } from "../dist/code/gateway/FactionMetadata.js";
import { FactionClient } from "../dist/code/browser/FactionClient.js";
import { game } from "../dist/code/browser/game/Context.js";
import { canAttackUnit, reactionBetween as unitReaction, reactionTo } from "../dist/code/browser/game/Targeting.js";
import { LiveWorldSeam } from "../dist/code/browser/framexml/LiveWorldSeam.js";
import { FRAMEXML_SEAM_BINDINGS } from "../dist/code/browser/framexml/FrameXmlWorldSeam.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

/*
 * D3 (04.10, the owner's decision on 5.05): the FactionTemplate comparison follows Wow.exe 3.3.5a 12340
 * 0x00715440(viewer template, target template) (Ghidra read-only, .runtime/re-2026-10-04/l18-wiring/h1.c;
 * callers .runtime/re-2026-10-04/d3-factions/g1.c-g3.c). It answers a rank — 1 hostile, 3 neutral, 4
 * friendly — in this order:
 *   the viewer's EnemyGroup against the target's FactionGroup → hostile (before any list);
 *   the viewer's Enemies naming the target's faction → hostile;
 *   the viewer's FriendGroup against the target's FactionGroup → friendly;
 *   the viewer's Friend list naming the target's faction → friendly;
 *   the target's FriendGroup against the viewer's FactionGroup → friendly;
 *   the target's Friend list naming the viewer's faction → friendly;
 *   otherwise hostile when the VIEWER's template has HOSTILE_BY_DEFAULT 0x2000, else neutral.
 * Each list is walked from its first slot and stops at the first empty one. The target's Enemies are never
 * read. TrinityCore (Object.cpp:2967-2976, DBCStructure.h:702-727) differs in the first step: there an explicit
 * Friend cancels the EnemyGroup hostility; the old FactionRules read TrinityCore's IsHostileTo/IsFriendlyTo
 * alone (no target Friend list, no HOSTILE_BY_DEFAULT).
 *
 * Who reads it: 0x007251c0(viewer, target) → 0x0071f770(viewer template, target) → 0x00715440 when the target
 * is no player (or nothing earlier decided) — UnitReaction 0x0060d280 (a's view of b), UnitIsEnemy 0x0060d330,
 * UnitIsFriend 0x0060d3d0 → 0x00514050, CanAttack 0x00729740 → 0x00514050 (the player's view of the unit);
 * the selection colour 0x00521bf0 and 0x0098ee30 read the unit's view of the player.
 *
 * The dataset table (scratchpad d3-affected.md): for the ten race templates against all 841 templates,
 * either way round, nothing changes — no Friend list names a playable faction, the race templates have no
 * lists, and the seven HOSTILE_BY_DEFAULT templates already hate every player by EnemyGroup. It shows
 * between two non-player templates (3261 of 841² ordered pairs).
 */

const template = (overrides = {}) => ({
  faction: 0, factionGroup: 0, friendGroup: 0, enemyGroup: 0, enemies: [], friends: [], ...overrides,
});
const HBD = FACTION_TEMPLATE_FLAG_HOSTILE_BY_DEFAULT;

/** The pre-D3 FactionRules reading (TrinityCore's predicates, the viewer's side only). */
const realmPair = (self, other) => (isHostileTo(self, other) ? REACTION_HOSTILE
  : isFriendlyTo(self, other) ? REACTION_FRIENDLY : REACTION_NEUTRAL);
const wowPair = (self, other) => reactionBetween({ templates: { 1: self, 2: other } }, 1, 2);

test("D3: the constants are Wow.exe's and the core's", () => {
  assert.equal(HBD, 0x2000, "DBCEnums.h:323 FACTION_TEMPLATE_FLAG_HOSTILE_BY_DEFAULT; Wow.exe reads bit 13 of row +8");
  assert.deepEqual([TEMPLATE_RANK_HOSTILE, TEMPLATE_RANK_NEUTRAL, TEMPLATE_RANK_FRIENDLY], [1, 3, 4],
    "0x00715440 answers ReputationRank values (SharedDefines.h REP_HOSTILE/REP_NEUTRAL/REP_FRIENDLY)");
});

// [label, viewer, target, Wow.exe 0x00715440, the pre-D3 reading]
const horde67 = template({ faction: 67, factionGroup: FACTION_MASK_HORDE });
const monster5 = template({ faction: 5, factionGroup: FACTION_MASK_MONSTER });
const TABLE = [
  // Rule 1: the EnemyGroup mask first.
  ["1: a named friend does not cancel the EnemyGroup", template({ faction: 10, friends: [67], enemyGroup: FACTION_MASK_HORDE }),
    horde67, REACTION_HOSTILE, REACTION_FRIENDLY],
  ["1: EnemyGroup beats FriendGroup on the same mask", template({ enemyGroup: FACTION_MASK_HORDE, friendGroup: FACTION_MASK_HORDE }),
    horde67, REACTION_HOSTILE, REACTION_HOSTILE],
  ["1: an explicit enemy beats an explicit friend", template({ enemies: [67], friends: [67] }), horde67, REACTION_HOSTILE, REACTION_HOSTILE],
  ["1: an explicit enemy beats the FriendGroup", template({ enemies: [67], friendGroup: FACTION_MASK_HORDE }), horde67, REACTION_HOSTILE, REACTION_HOSTILE],
  ["1: the target's FriendGroup does not cancel the viewer's EnemyGroup",
    template({ factionGroup: FACTION_MASK_PLAYER, enemyGroup: FACTION_MASK_HORDE }),
    template({ faction: 67, factionGroup: FACTION_MASK_HORDE, friendGroup: FACTION_MASK_PLAYER }), REACTION_HOSTILE, REACTION_HOSTILE],
  // Rule 2: the target's Friend list.
  ["2: the target's Friend list naming my faction", monster5, template({ faction: 9, friends: [5] }), REACTION_FRIENDLY, REACTION_NEUTRAL],
  ["2: any slot of the target's Friend list", monster5,
    template({ faction: 9, friends: [7, 5] }), REACTION_FRIENDLY, REACTION_NEUTRAL],
  ["2: the target's Enemies are never read", monster5, template({ faction: 9, friends: [5], enemies: [5] }), REACTION_FRIENDLY, REACTION_NEUTRAL],
  ["2: my own Enemies beat the target's Friend list", template({ faction: 5, enemies: [9] }),
    template({ faction: 9, friends: [5] }), REACTION_HOSTILE, REACTION_HOSTILE],
  ["2: my EnemyGroup beats the target's Friend list", template({ faction: 5, enemyGroup: FACTION_MASK_ALLIANCE }),
    template({ faction: 9, factionGroup: FACTION_MASK_ALLIANCE, friends: [5] }), REACTION_HOSTILE, REACTION_HOSTILE],
  ["2: a viewer with no faction is named by nobody", template({ faction: 0 }), template({ faction: 9, friends: [5] }), REACTION_NEUTRAL, REACTION_NEUTRAL],
  ["2: the target's FriendGroup reads my FactionGroup", monster5,
    template({ faction: 9, friendGroup: FACTION_MASK_MONSTER }), REACTION_FRIENDLY, REACTION_FRIENDLY],
  // Rule 3: the viewer's HOSTILE_BY_DEFAULT, only when nothing matched.
  ["3: nothing matched, the viewer hates by default", template({ faction: 928, flags: 0x2025 }), template({ faction: 7 }), REACTION_HOSTILE, REACTION_NEUTRAL],
  ["3: the flag alone", template({ faction: 928, flags: HBD }), template({ faction: 7 }), REACTION_HOSTILE, REACTION_NEUTRAL],
  ["3: the target's flag does not count", template({ faction: 7 }), template({ faction: 928, flags: HBD }), REACTION_NEUTRAL, REACTION_NEUTRAL],
  ["3: the viewer's Friend list comes first", template({ faction: 1145, flags: HBD, friends: [7] }), template({ faction: 7 }), REACTION_FRIENDLY, REACTION_FRIENDLY],
  ["3: the target's Friend list comes first", template({ faction: 928, flags: HBD }), template({ faction: 20, friends: [928] }), REACTION_FRIENDLY, REACTION_NEUTRAL],
  ["3: the FriendGroup comes first", template({ faction: 928, flags: HBD, friendGroup: FACTION_MASK_MONSTER }), monster5, REACTION_FRIENDLY, REACTION_FRIENDLY],
  ["3: CONTESTED_GUARD 0x1000 is not it", template({ faction: 21, flags: 0x1821 }), template({ faction: 7 }), REACTION_NEUTRAL, REACTION_NEUTRAL],
  ["3: flags 0", template({ faction: 928, flags: 0 }), template({ faction: 7 }), REACTION_NEUTRAL, REACTION_NEUTRAL],
  ["3: flags unknown (a gateway before /dbc/factions v=3) read as before", template({ faction: 928 }), template({ faction: 7 }), REACTION_NEUTRAL, REACTION_NEUTRAL],
  // The lists stop at the first empty slot (the gateway drops zeros; raw rows keep the reading exact).
  ["lists: an empty slot ends the viewer's Enemies", template({ enemies: [0, 67] }), horde67, REACTION_NEUTRAL, REACTION_HOSTILE],
  ["lists: an empty slot ends the viewer's Friend list", template({ friends: [0, 67] }), horde67, REACTION_NEUTRAL, REACTION_FRIENDLY],
  ["lists: an empty slot ends the target's Friend list", monster5, template({ faction: 9, friends: [0, 5] }), REACTION_NEUTRAL, REACTION_NEUTRAL],
  ["lists: a target with no faction matches no list", template({ enemies: [67], friends: [67] }), template({ faction: 0 }), REACTION_NEUTRAL, REACTION_NEUTRAL],
  ["lists: four slots are read", template({ enemies: [61, 62, 63, 67] }), horde67, REACTION_HOSTILE, REACTION_HOSTILE],
];

test("D3: the three rules of 0x00715440 on synthetic templates (and the pre-D3 reading for contrast)", () => {
  for (const [label, self, other, wow, before] of TABLE) {
    assert.equal(wowPair(self, other), wow, label);
    assert.equal(realmPair(self, other), before, `${label} (pre-D3)`);
    const rank = factionTemplateRank(self, other);
    assert.equal(rank, wow === REACTION_HOSTILE ? 1 : wow === REACTION_FRIENDLY ? 4 : 3, `${label} (rank)`);
  }
});

test("D3: an unknown template is still neutral either way", () => {
  const data = { templates: { 1: template({ faction: 928, flags: HBD }), 2: template({ faction: 9, friends: [928] }) } };
  assert.equal(reactionBetween(data, 1, 999), REACTION_NEUTRAL, "not hostile by default against a template never seen");
  assert.equal(reactionBetween(data, 999, 2), REACTION_NEUTRAL);
  assert.equal(reactionBetween(data, 1, 2), REACTION_FRIENDLY);
});

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

/** ChrRaces.dbc FactionID of the dataset: human, orc, dwarf, night elf, undead, tauren, gnome, troll, blood elf, draenei. */
const RACE_TEMPLATES = [1, 2, 3, 4, 5, 6, 115, 116, 1610, 1629];

test("D3: the dataset — no playable race sees any template differently, either way round", withDataset, async () => {
  const data = await loadFactionData(dbcDirectory);
  const ids = Object.keys(data.templates).map(Number);
  assert.ok(ids.length > 800);
  const changed = [];
  for (const player of RACE_TEMPLATES) {
    const self = data.templates[player];
    assert.ok(self, `race template ${player}`);
    for (const id of ids) {
      const other = data.templates[id];
      if (reactionBetween(data, player, id) !== realmPair(self, other)) changed.push(`${player}→${id}`);
      if (reactionBetween(data, id, player) !== realmPair(other, self)) changed.push(`${id}→${player}`);
    }
  }
  assert.deepEqual(changed, [], "the affected-creature list for players is empty (d3-affected.md §1)");
});

test("D3: the dataset — where it shows: between two non-player templates", withDataset, async () => {
  const data = await loadFactionData(dbcDirectory);
  // Rule 1: Scourge 2100 (a Volatile Ghoul) lists Scourge 20 as a friend and hates its group: hostile to 21
  // (a Decomposed Ghoul) in Wow.exe; TrinityCore's IsHostileTo lets the friend cancel it.
  assert.equal(reactionBetween(data, 2100, 21), REACTION_HOSTILE);
  assert.equal(isHostileTo(data.templates[2100], data.templates[21]), false, "the realm reads friendly");
  // Rule 2: Fauna 190 (a Snake) and 188 (a Wild Turkey), whose Friend list names Fauna 148.
  assert.equal(reactionBetween(data, 190, 188), REACTION_FRIENDLY);
  assert.equal(realmPair(data.templates[190], data.templates[188]), REACTION_NEUTRAL);
  // Rule 3: Scourge Invaders 1630 (HOSTILE_BY_DEFAULT) against Creature 7 (a Talbuk Thorngrazer) and back.
  assert.equal(data.templates[1630].flags & HBD, HBD);
  assert.equal(reactionBetween(data, 1630, 7), REACTION_HOSTILE);
  assert.equal(reactionBetween(data, 7, 1630), REACTION_NEUTRAL, "the viewer's flag, not the target's");
  // Every HOSTILE_BY_DEFAULT template already hates every race by EnemyGroup — why players see no change.
  const hbd = Object.entries(data.templates).filter(([, row]) => (row.flags & HBD) !== 0).map(([id]) => Number(id));
  assert.deepEqual(hbd.sort((a, b) => a - b), [1630, 2023, 2145, 2150, 2189, 2190, 2191]);
  for (const id of hbd) for (const player of RACE_TEMPLATES) {
    assert.ok((data.templates[id].enemyGroup & data.templates[player].factionGroup) !== 0, `${id} vs ${player}`);
  }
  // A gateway before v=3: rows without flags — rule 3 stays off.
  const { flags: _flags, ...bare } = data.templates[1630];
  assert.equal(reactionBetween({ templates: { 1630: bare, 7: data.templates[7] } }, 1630, 7), REACTION_NEUTRAL);
});

// ---- through the browser: FactionClient, Targeting (plates, ring, frames, Tab, CanAttack) and the stock UI seam ----

/** Synthetic rows standing in for templates the server can give units (escort, quest, charm). */
const BODY = {
  templates: {
    1: { faction: 1, flags: 72, factionGroup: 3, friendGroup: 2, enemyGroup: 12, enemies: [], friends: [] }, // PLAYER, Human
    500: { faction: 501, flags: 0, factionGroup: 0, friendGroup: 0, enemyGroup: 0, enemies: [], friends: [1] }, // names the human faction a friend
    600: { faction: 601, flags: HBD, factionGroup: 0, friendGroup: 0, enemyGroup: 0, enemies: [], friends: [] }, // hostile by default
    700: { faction: 701, flags: 0, factionGroup: 0, friendGroup: 0, enemyGroup: 1, enemies: [], friends: [1] }, // hates players, names humans
  },
};
const withoutFlags = () => ({
  templates: Object.fromEntries(Object.entries(BODY.templates).map(([id, { flags: _flags, ...row }]) => [id, row])),
});

async function loadedClient(body) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body });
  try {
    const client = new FactionClient("ws://127.0.0.1:8090/");
    client.load();
    for (let round = 0; round < 5; round++) await Promise.resolve();
    assert.equal(client.ready, true);
    return client;
  } finally {
    globalThis.fetch = realFetch;
  }
}

const SELF = 1n;
const UNIT = 0x100n;
function unitObject(guid, typeId, factionTemplate) {
  return {
    guid, typeId, position: { x: guid === SELF ? 0 : 3, y: 0, z: 0, orientation: 0 },
    fields: new Map([
      [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100],
      [UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 100],
      [UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset, factionTemplate],
      [UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, guid === SELF ? 0x8 : 0],
    ]),
  };
}

/** The player (human template 1) and one unit on `unitTemplate`, as the world and as the stock UI's seam. */
function inWorld(client, unitTemplate, run) {
  const self = unitObject(SELF, 4, 1);
  const unit = unitObject(UNIT, 3, unitTemplate);
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, self], [UNIT, unit]]) },
    targetGuid: UNIT, controlledGuid: undefined, forcedReactions: new Map(), creatureTemplates: new Map(),
    factions: new Map(), group: undefined, selectionClears: 0, partyStats: new Map(), auras: new Map(),
    aurasFor: () => [], names: new Map(), casts: new Map(), totems: new Map(), actionButtons: [],
    cooldownRemaining: () => 0,
  };
  const previousWorld = game.world;
  const previousFactions = game.factions;
  game.world = world;
  game.factions = client;
  try {
    // FrameXmlWorldMount hands the seam `reactionBetween(self, target, game.factions)` the same way.
    const seam = new LiveWorldSeam({
      world: () => world, store: () => ({ field: () => () => {} }), spell: () => undefined,
      monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
      reaction: (left, right) => unitReaction(left, right, game.factions),
    });
    const lua = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
    return run({ self, unit, lua });
  } finally {
    game.world = previousWorld;
    game.factions = previousFactions;
  }
}

test("D3: rule 2 through the browser — the unit's Friend list names the player: friendly, not attackable", async () => {
  const client = await loadedClient(BODY);
  assert.equal(client.reaction(1, 500), REACTION_FRIENDLY);
  inWorld(client, 500, ({ self, unit, lua }) => {
    assert.equal(reactionTo(unit), REACTION_FRIENDLY, "the player's view (plates, frames, Tab)");
    assert.equal(canAttackUnit(unit), false, "CanAttack refuses a friend (it was neutral and attackable)");
    assert.deepEqual(lua("UnitSelectionColor", "target"), [0, 1, 0], "green (this client paints the player's view)");
    assert.deepEqual(lua("UnitReaction", "player", "target"), [5], "0x0060d280: rank 4 + 1");
    assert.deepEqual(lua("UnitIsFriend", "player", "target"), [true]);
    assert.deepEqual(lua("UnitIsEnemy", "player", "target"), [false]);
    assert.deepEqual(lua("UnitCanAttack", "player", "target"), [false]);
    // The unit's own view reads its own Friend list (step 4) — friendly before D3 as well.
    assert.equal(unitReaction(unit, self, client), REACTION_FRIENDLY);
    assert.deepEqual(lua("UnitReaction", "target", "player"), [5]);
  });
});

test("D3: rule 3 through the browser — a HOSTILE_BY_DEFAULT unit's view of the player; off without the flags", async () => {
  const client = await loadedClient(BODY);
  inWorld(client, 600, ({ self, unit, lua }) => {
    assert.equal(unitReaction(unit, self, client), REACTION_HOSTILE, "the unit's view");
    assert.deepEqual(lua("UnitReaction", "target", "player"), [2]);
    assert.deepEqual(lua("UnitIsEnemy", "target", "player"), [true]);
    assert.equal(reactionTo(unit), REACTION_NEUTRAL, "the player's view reads the player's own flags");
    assert.deepEqual(lua("UnitReaction", "player", "target"), [4]);
    assert.equal(canAttackUnit(unit), true);
  });
  const old = await loadedClient(withoutFlags());
  assert.equal(old.templateFlagsOf(600), undefined);
  inWorld(old, 600, ({ self, unit, lua }) => {
    assert.equal(unitReaction(unit, self, old), REACTION_NEUTRAL, "a gateway before v=3: as before");
    assert.deepEqual(lua("UnitReaction", "target", "player"), [4]);
  });
});

test("D3: rule 1 through the browser — the unit hates players by mask although it names humans a friend", async () => {
  const client = await loadedClient(BODY);
  inWorld(client, 700, ({ self, unit, lua }) => {
    assert.equal(unitReaction(unit, self, client), REACTION_HOSTILE, "EnemyGroup Player first (the realm: friendly)");
    assert.deepEqual(lua("UnitIsEnemy", "target", "player"), [true]);
    assert.equal(reactionTo(unit), REACTION_FRIENDLY, "the player's view: the unit's Friend list (rule 2)");
    assert.deepEqual(lua("UnitIsFriend", "player", "target"), [true]);
    assert.equal(canAttackUnit(unit), false);
  });
});

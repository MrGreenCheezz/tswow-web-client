import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { reactionBetween as maskReaction } from "../dist/code/world/FactionRules.js";
import { isAttackableUnit } from "../dist/code/world/TargetSearch.js";
import { game } from "../dist/code/browser/game/Context.js";
import { canAttackUnit, enemyCandidates, reactionTo } from "../dist/code/browser/game/Targeting.js";

/*
 * L15-review (04.10, 5.05): who the player may attack and Tab to (`canAttackUnit`, `enemyCandidates`)
 * once a faction that keeps a reputation is read as Wow.exe 3.3.5a 12340 reads it — CanAttack 0x00729740
 * → 0x00514050 → 0x007251c0, the branch at 0x007253ca: hostile while the player is at war with the
 * faction (0x005d04b0), friendly otherwise (.runtime/re-2026-09-30/gw-data/r2.c; the rows as
 * SMSG_INITIALIZE_FACTIONS 0x005d2e30 stores them, .runtime/re-2026-10-04/l15-combat/g1.c).
 *
 * The flags in the rows are what TrinityCore sends (ReputationMgr.cpp): the first login of a character
 * copies Faction.dbc's ReputationFlags for its race and class (Initialize, :267-298, GetDefaultStateFlags
 * :151-169); from the second login on, the saved rows come back with AT_WAR added for every faction at
 * Hostile or below (LoadFromDB :569-571; SetAtWar refuses PEACE_FORCED without RIVAL, :481).
 *
 * The rows below are the dataset's (FactionTemplate.dbc, Faction.dbc), each with a creature the TDB
 * world (335.24081) spawns on that template. A table over all 76 reputation factions that spawned
 * creatures use was run for every race (L15-review scratch, faction-table.mjs): no faction that is
 * hostile on the masks and at Hostile or below loses the attack after the first save; the attack is
 * lost only where Wow.exe takes it — a neutral-on-the-masks faction the player is not at war with
 * (Booty Bay, Ravenholdt, Sporeggar, Kirin Tor…), and during a character's first session the seven
 * factions whose Faction.dbc flags lack AT_WAR at a Hated start (Honor Hold, Kurenai, Thrallmar, Hand of
 * Vengeance, Horde Expedition, Sons of Hodir, Brood of Nozdormu) — Wow.exe gets the same packet.
 */

/** FactionTemplate.dbc: `[faction, flags, factionGroup, friendGroup, enemyGroup, enemies, friends]`. */
const TEMPLATES = {
  1: [1, 72, 3, 2, 12, [], []], // PLAYER, Human
  2: [2, 72, 5, 4, 10, [], []], // PLAYER, Orc
  12: [72, 0, 2, 2, 4, [], [72]], // Stormwind (a Stormwind City Guard)
  14: [14, 0, 8, 0, 1, [], []], // Monster (no reputation)
  68: [68, 0, 4, 4, 2, [], []], // Undercity (a Deathguard)
  87: [70, 1, 8, 0, 1, [], [70]], // Syndicate (a Syndicate Thief)
  119: [87, 1, 8, 0, 1, [], [87]], // Bloodsail Buccaneers (a Bloodsail Raider)
  120: [21, 0, 0, 0, 0, [], [21]], // Booty Bay (Krazek)
  121: [21, 6177, 1, 0, 8, [], [21]], // Booty Bay, CONTESTED_GUARD 0x1000 (a Booty Bay Bruiser)
  132: [92, 1, 8, 0, 1, [], [92]], // Gelkis Clan Centaur (a Gelkis Rumbler)
  414: [576, 1, 8, 0, 1, [65], [576]], // Timbermaw Hold (a Deadwood Warrior)
  473: [349, 65, 0, 0, 0, [70], [349]], // Ravenholdt (a Ravenholdt Guard)
  776: [910, 0, 0, 0, 0, [249, 80], [910, 531]], // Brood of Nozdormu (Anachronos)
  1666: [946, 2081, 3, 2, 12, [], []], // Honor Hold (an Honor Hold Defender)
  1668: [947, 2081, 5, 4, 10, [], []], // Thrallmar (a Thrallmar Grunt)
  1708: [970, 1, 1, 0, 8, [], [970]], // Sporeggar (Gzhun'tt)
  1721: [978, 2081, 3, 2, 12, [], [978]], // Kurenai (a Telaari Watcher)
  1824: [1015, 33, 0, 0, 0, [], [1015]], // Netherwing
  2107: [1119, 33, 8, 0, 0, [1120, 1121], [1119]], // Sons of Hodir (a Son of Hodir)
};
/** Faction.dbc reputation rows: `[listId, raceMasks, classMasks, bases, flags]`. */
const FACTIONS = {
  21: [1, [1791, 0, 0, 0], [0, 0, 0, 0], [500, 0, 0, 0], [0x40, 0, 0, 0]],
  68: [17, [162, 1101, 16, 512], [0, 0, 0, 0], [500, -42_000, 4000, 3100], [0x111, 0x6, 0x11, 0x11]],
  70: [6, [1791, 0, 0, 0], [0, 0, 0, 0], [-10_000, 0, 0, 0], [0x2, 0, 0, 0]],
  72: [19, [1100, 690, 1, 0], [0, 0, 0, 0], [3100, -42_000, 4000, 0], [0x111, 0x6, 0x11, 0]],
  87: [0, [1791, 0, 0, 0], [0, 0, 0, 0], [-6500, 0, 0, 0], [0x2, 0, 0, 0]],
  92: [2, [1791, 0, 0, 0], [0, 0, 0, 0], [2000, 0, 0, 0], [0x2, 0, 0, 0]],
  349: [5, [1791, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
  576: [35, [1791, 0, 0, 0], [0, 0, 0, 0], [-3500, 0, 0, 0], [0x2, 0, 0, 0]],
  910: [54, [1791, 0, 0, 0], [0, 0, 0, 0], [-42_000, 0, 0, 0], [0, 0, 0, 0]],
  946: [38, [1101, 690, 0, 0], [0, 0, 0, 0], [0, -42_000, 0, 0], [0x10, 0, 0, 0]],
  947: [37, [690, 1101, 0, 0], [0, 0, 0, 0], [0, -42_000, 0, 0], [0x10, 0, 0, 0]],
  970: [65, [2047, 0, 0, 0], [0, 0, 0, 0], [-2500, 0, 0, 0], [0, 0, 0, 0]],
  978: [66, [1101, 690, 0, 0], [0, 0, 0, 0], [-1200, -42_000, 0, 0], [0x10, 0, 0, 0]],
  1015: [71, [1791, 0, 0, 0], [1535, 0, 0, 0], [-42_000, 0, 0, 0], [0x2, 0, 0, 0]],
  1119: [97, [1791, 0, 0, 0], [0, 0, 0, 0], [-42_000, 0, 0, 0], [0, 0, 0, 0]],
};

const DATA = { templates: {} };
for (const [id, [faction, , factionGroup, friendGroup, enemyGroup, enemies, friends]] of Object.entries(TEMPLATES)) {
  DATA.templates[id] = { faction, factionGroup, friendGroup, enemyGroup, enemies, friends };
}
const CATALOG = { version: 1, factions: {} };
for (const [factionId, [listId, raceMasks, classMasks, bases, flags]] of Object.entries(FACTIONS)) {
  CATALOG.factions[listId] = { factionId: Number(factionId), raceMasks, classMasks, bases, flags };
}
function factionClient({ catalog = CATALOG, flags = false } = {}) { // L18 5.05: flags
  return {
    ready: true,
    reaction: (mine, theirs) => maskReaction(DATA, mine, theirs),
    factionOf: (template) => DATA.templates[template]?.faction,
    factionGroupOf: (template) => DATA.templates[template]?.factionGroup,
    get reputationCatalog() { return catalog ?? undefined; },
    // L18 5.05: FactionTemplate.Flags from /dbc/factions v=3; a gateway before it has no such answer.
    templateFlagsOf: flags ? (template) => TEMPLATES[template]?.[1] : undefined,
  };
}

const AT_WAR = 0x2;
const PEACE_FORCED = 0x10;
const RIVAL = 0x40;
const rankOf = (total) => (total >= 42_000 ? 7 : total >= 21_000 ? 6 : total >= 9000 ? 5 : total >= 3000 ? 4
  : total >= 0 ? 3 : total >= -3000 ? 2 : total >= -6000 ? 1 : 0);

/** ReputationMgr::GetDefaultStateFlags / GetBaseReputation: the race/class entry of a Faction.dbc row. */
function entryFor([, raceMasks, classMasks, bases, flags], race, playerClass) {
  for (let index = 0; index < 4; index++) {
    const races = raceMasks[index];
    const classes = classMasks[index];
    if (((races & (1 << (race - 1))) !== 0 || (races === 0 && classes !== 0))
      && ((classes & (1 << (playerClass - 1))) !== 0 || classes === 0)) return { base: bases[index], flags: flags[index] };
  }
  return { base: 0, flags: 0 };
}

/** SMSG_INITIALIZE_FACTIONS as the core builds it: 128 rows; the later login adds AT_WAR at Hostile or below. */
function serverRows(race, playerClass, { firstLogin }) {
  const rows = new Map();
  for (let listId = 0; listId < 128; listId++) rows.set(listId, { listId, flags: 0, standing: 0 });
  for (const row of Object.values(FACTIONS)) {
    const { base, flags } = entryFor(row, race, playerClass);
    let sent = flags;
    const refused = (flags & PEACE_FORCED) !== 0 && (flags & RIVAL) === 0; // :481 (Standing 0 is above Hated)
    if (!firstLogin && rankOf(base) <= 1 && !refused) sent |= AT_WAR;
    rows.set(row[0], { listId: row[0], flags: sent, standing: 0 });
  }
  return rows;
}

const SELF = 1n;
const BYTES_0 = UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset;

function unitObject(guid, { typeId = 3, template, flags = 0, bytes0 = 0, playerFlags = 0, x = 3 }) {
  const fields = new Map([
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100],
    [UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset, template],
    [UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, flags],
    [BYTES_0, bytes0],
  ]);
  if (typeId === 4) fields.set(UPDATE_FIELDS.PLAYER_FLAGS.offset, playerFlags);
  return { guid, typeId, fields, position: { x, y: 0, z: 0, orientation: 0 } };
}

/** The characters: a human warrior and an orc warrior (UNIT_FIELD_BYTES_0: race, class). */
const HUMAN = { race: 1, playerClass: 1, template: 1 };
const ORC = { race: 2, playerClass: 1, template: 2 };

const UNIT_TEMPLATES = Object.keys(TEMPLATES).map(Number).filter((id) => id !== 1 && id !== 2);

/** Puts the character and one creature per template in a world; answers attack and Tab per template. */
function judge(character, { rows, contested = false, catalog, flags = false } = {}) { // L18 5.05: flags
  const self = unitObject(SELF, { typeId: 4, template: character.template, flags: 0x8,
    bytes0: character.race | (character.playerClass << 8), playerFlags: contested ? 0x100 : 0, x: 0 });
  const objects = new Map([[SELF, self]]);
  const byGuid = new Map();
  let guid = 100n;
  for (const template of UNIT_TEMPLATES) {
    const unit = unitObject(guid, { template, x: 3 + Number(guid - 100n) * 0.01 });
    objects.set(guid, unit);
    byGuid.set(guid, template);
    guid++;
  }
  const previousWorld = game.world;
  const previousFactions = game.factions;
  game.world = {
    state: { selfGuid: SELF, objects }, targetGuid: undefined, controlledGuid: undefined,
    forcedReactions: new Map(), creatureTemplates: new Map(), factions: rows ?? new Map(), group: undefined,
    selectionClears: 0,
  };
  game.factions = factionClient({ catalog, flags }); // L18 5.05: flags
  try {
    const tab = new Set(enemyCandidates().map(({ guid: picked }) => byGuid.get(picked)));
    const result = new Map();
    for (const [unitGuid, template] of byGuid) {
      const unit = objects.get(unitGuid);
      result.set(template, {
        attack: canAttackUnit(unit),
        tab: tab.has(template),
        // The pre-5.05 reading: the template masks alone (Targeting.reactionTo), as CanAttack took them.
        masks: isAttackableUnit(self, unit, reactionTo(unit)),
      });
    }
    return result;
  } finally {
    game.world = previousWorld;
    game.factions = previousFactions;
  }
}

/** The templates the player may attack (and Tab to — the two must agree everywhere). */
function attackable(result) {
  const out = [];
  for (const [template, { attack, tab }] of result) {
    assert.equal(tab, attack, `Tab and CanAttack disagree on template ${template}`);
    if (attack) out.push(template);
  }
  return out.sort((a, b) => a - b);
}
const byMasks = (result) => [...result].filter(([, { masks }]) => masks).map(([template]) => template).sort((a, b) => a - b);

test("L15-review: a human, after the first save — every faction at Hostile or below is fought; the rest only at war", () => {
  const result = judge(HUMAN, { rows: serverRows(1, 1, { firstLogin: false }) });
  assert.deepEqual(attackable(result), [
    14, // Monster: no reputation, the masks
    68, // Undercity: AT_WAR in Faction.dbc for Alliance races
    87, 119, 132, 414, // Syndicate, Bloodsail, Gelkis (Neutral but AT_WAR in the DBC), Timbermaw
    776, // Brood of Nozdormu: Hated — at war from the second login
    1668, // Thrallmar: Hated — likewise
    1824, // Netherwing: AT_WAR in the DBC
    2107, // Sons of Hodir: Hated — at war from the second login
  ]);
  // What changed against the masks: the neutral-on-the-masks factions the player is not at war with.
  const lost = byMasks(result).filter((template) => !result.get(template).attack);
  assert.deepEqual(lost, [120, 121, 473, 1708], "Booty Bay (both), Ravenholdt, Sporeggar (Unfriendly): Wow.exe's friends");
  assert.deepEqual(attackable(result).filter((template) => !result.get(template).masks), [], "nothing gained");
});

test("L15-review: an orc, after the first save", () => {
  const result = judge(ORC, { rows: serverRows(2, 1, { firstLogin: false }) });
  assert.deepEqual(attackable(result), [12, 14, 87, 119, 132, 414, 776, 1666, 1721, 1824, 2107]);
  const lost = byMasks(result).filter((template) => !result.get(template).attack);
  assert.deepEqual(lost, [120, 121, 473, 1708]);
});

test("L15-review: a character's first session — Faction.dbc flags only; Wow.exe reads the same rows", () => {
  // Thrallmar, Sons of Hodir and Nozdormu carry no AT_WAR in Faction.dbc for a human: the core sends
  // none until the second login, and Wow.exe's CanAttack calls them friends meanwhile.
  const human = judge(HUMAN, { rows: serverRows(1, 1, { firstLogin: true }) });
  assert.deepEqual(attackable(human), [14, 68, 87, 119, 132, 414, 1824]);
  const orc = judge(ORC, { rows: serverRows(2, 1, { firstLogin: true }) });
  assert.deepEqual(attackable(orc), [12, 14, 87, 119, 132, 414, 1824], "Honor Hold and Kurenai wait for the second login");
});

test("L15-review: the player's own war and peace move the attack (CMSG/SMSG_SET_FACTION_ATWAR)", () => {
  const rows = serverRows(1, 1, { firstLogin: false });
  rows.set(1, { listId: 1, flags: 0x40 | AT_WAR, standing: 0 }); // war on Booty Bay
  rows.set(2, { listId: 2, flags: 0, standing: 0 }); // peace with Gelkis (Neutral: allowed)
  const result = judge(HUMAN, { rows });
  assert.equal(result.get(120).attack, true, "Booty Bay at war");
  assert.equal(result.get(121).attack, true);
  assert.equal(result.get(132).attack, false, "Gelkis at peace: a friend to CanAttack");
  // List id 0 is a list id: Bloodsail Buccaneers' row (a row without AT_WAR reads "friend" as any other).
  rows.set(0, { listId: 0, flags: 0, standing: 0 });
  assert.equal(judge(HUMAN, { rows }).get(119).attack, false, "Bloodsail at peace");
});

test("L15-review: rows not received yet read the masks, never 'friendly'", () => {
  // Before SMSG_INITIALIZE_FACTIONS (or for a list id it did not carry) the client has no at-war flag to
  // read; the click and Tab keep the masks — the pre-5.05 reading — instead of calling every
  // reputation faction a friend (a Horde player could not hit a Stormwind guard).
  for (const character of [HUMAN, ORC]) {
    const result = judge(character, { rows: new Map() });
    assert.deepEqual(attackable(result), byMasks(result), character === HUMAN ? "human" : "orc");
  }
  const orc = judge(ORC, { rows: new Map() });
  assert.equal(orc.get(12).attack, true, "a Stormwind guard");
  // One row missing out of the 128: that faction alone reads the masks.
  const rows = serverRows(1, 1, { firstLogin: false });
  rows.delete(1);
  const human = judge(HUMAN, { rows });
  assert.equal(human.get(120).attack, true, "Booty Bay without its row: the masks' neutral");
  assert.equal(human.get(473).attack, false, "Ravenholdt has its row: at peace");
});

test("L15-review: the catalog not loaded reads the masks", () => {
  const result = judge(HUMAN, { rows: serverRows(1, 1, { firstLogin: false }), catalog: null });
  assert.deepEqual(attackable(result), byMasks(result));
});

test("L15-review: a PvP-contested player fights back at the contested guards", () => {
  // 0x007251c0 at 0x007253ca: a CONTESTED_GUARD template (FactionTemplate flags 0x1000) is hostile to a
  // player with PLAYER_FLAGS_CONTESTED_PVP (0x100) before the at-war flag is read — the Booty Bay bruiser
  // who attacks a contested player can be hit back. L18 5.05: a gateway before /dbc/factions v=3 carries
  // no template flags, so a contested player reads reputation factions on the masks (the pre-5.05 reading).
  const rows = serverRows(1, 1, { firstLogin: false });
  const contested = judge(HUMAN, { rows, contested: true });
  assert.equal(contested.get(121).attack, true, "the bruiser");
  assert.deepEqual(attackable(contested), byMasks(contested));
  const calm = judge(HUMAN, { rows });
  assert.equal(calm.get(121).attack, false, "not contested: at peace with Booty Bay");
});

test("L18 5.05: with the template flags a contested player fights the CONTESTED_GUARD templates alone", () => {
  // Wow.exe 0x007251c0, the branch at 0x007253ca (.runtime/re-2026-09-30/gw-data/r2.c): forced rank, then —
  // for a faction that keeps a reputation — a template with FACTION_TEMPLATE_FLAG_CONTESTED_GUARD 0x1000 is
  // hostile to a player with PLAYER_FLAGS_CONTESTED_PVP 0x100, and only then the at-war flag decides.
  for (const [character, race] of [[HUMAN, 1], [ORC, 2]]) {
    const rows = serverRows(race, 1, { firstLogin: false });
    const calm = judge(character, { rows, flags: true });
    const contested = judge(character, { rows, contested: true, flags: true });
    const label = character === HUMAN ? "human" : "orc";
    assert.deepEqual(attackable(calm), attackable(judge(character, { rows })), `${label}: not contested, the flags change nothing`);
    assert.deepEqual(attackable(contested), [...attackable(calm), 121].sort((a, b) => a - b),
      `${label}: the Booty Bay bruiser (template 121, flags 0x1821) and nothing else`);
    assert.equal(contested.get(120).attack, false, `${label}: Krazek's template (120) is no contested guard — at peace`);
    assert.equal(contested.get(473).attack, false, `${label}: Ravenholdt — at peace`);
  }
  // At war with Booty Bay the bruiser was an enemy anyway; the contested flag changes nothing there.
  const rows = serverRows(1, 1, { firstLogin: false });
  rows.set(1, { listId: 1, flags: 0x40 | AT_WAR, standing: 0 });
  const atWar = judge(HUMAN, { rows, contested: true, flags: true });
  assert.equal(atWar.get(120).attack, true);
  assert.equal(atWar.get(121).attack, true);
});

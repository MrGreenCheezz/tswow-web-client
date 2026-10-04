import assert from "node:assert/strict";
import test from "node:test";

// 11.02-tails-review: what a right click on an ordinary unit does (ui/Npc.ts `interactWithGuid`,
// game/Targeting.ts, world/UnitInteractGate.ts) — one table of the NPCs a player clicks every day,
// with the real faction rule (FactionRules.reactionBetween) over real FactionTemplate.dbc rows of the
// dataset (copied below with their ids). The player is a human (template 1).
//
// Wow.exe 3.3.5a 12340, Ghidra read-only (.runtime/re-2026-10-03/l1102tails-review/r1.c,
// l1102bcd-review/r1.c, r2.c; 0x007251c0 in re-2026-09-30/gw-data/r2.c): 0x00731260 hands a live unit
// to its services only when 0x00729530 lets the player talk to it, else swings when 0x00729a70 allows.
// 0x00729530's reaction test reads 0x007251c0 both ways; for a faction that keeps a reputation
// (0x00718b30: Faction.dbc ReputationIndex ≥ 0) that reads the player's at-war flag one way
// (the branch at 0x007253ca) and the player's rank the other (0x0071f770 → 0x005d0600), never the
// template masks this client has — so for those factions the old click stays (review fix).

// ---- a DOM just deep enough for ui/Npc.ts and its windows ---------------------------------------

class FakeNode {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.attributes = new Map();
    this.hidden = true;
    this.value = "";
    this.className = "";
    this.textContent = "";
    this.classList = { add() {}, remove() {}, contains: () => false, toggle: () => false };
  }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  remove() {}
  addEventListener() {}
  removeEventListener() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector(selector) { return selector === 'button[type="submit"]' ? new FakeNode("button") : null; }
  querySelectorAll() { return []; }
  contains() { return false; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  getContext() { return {}; }
  focus() {}
  blur() {}
}
globalThis.HTMLElement = FakeNode;
globalThis.HTMLInputElement = class extends FakeNode {};
globalThis.HTMLSelectElement = class extends FakeNode {};
globalThis.HTMLTextAreaElement = class extends FakeNode {};
globalThis.HTMLButtonElement = class extends FakeNode {};
const elements = new Map();
globalThis.document = {
  activeElement: null,
  head: new FakeNode("head"),
  body: new FakeNode("body"),
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_namespace, tag) => new FakeNode(tag),
  createTextNode: (text) => ({ textContent: text }),
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, new FakeNode());
    return elements.get(id);
  },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
};
globalThis.window = {
  innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {}, removeEventListener() {},
};
globalThis.location = window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const { interactWithGuid, closeNpcServiceWindow } = await import("../dist/code/browser/ui/Npc.js");
const { reactionBetween } = await import("../dist/code/world/FactionRules.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

// ---- real rows: FactionTemplate.dbc (dataset), with the Faction.dbc reputation index -----------

/** `[faction, factionGroup, friendGroup, enemyGroup, enemies, friends]`, as the gateway serves them. */
const ROWS = {
  1: [1, 3, 2, 12, [], []], // PLAYER, Human (no reputation)
  2: [2, 5, 4, 10, [], []], // PLAYER, Orc
  7: [7, 0, 0, 0, [], []], // Creature
  11: [72, 3, 2, 12, [], []], // Stormwind (reputation 19)
  12: [72, 2, 2, 4, [], [72]], // Stormwind
  14: [14, 8, 0, 1, [], []], // Monster
  35: [31, 0, 1, 0, [], [31]], // Friendly
  68: [68, 4, 4, 2, [], []], // Undercity (reputation 17)
  83: [66, 4, 4, 2, [], []], // Horde generic (no reputation)
  84: [189, 2, 2, 4, [], []], // Alliance generic
  120: [21, 0, 0, 0, [], [21]], // Booty Bay (reputation 1)
  121: [21, 1, 0, 8, [], [21]], // L18 5.05: Booty Bay, a Booty Bay Bruiser's (flags 0x1821: CONTESTED_GUARD)
  1806: [31, 0, 1, 8, [], [31]], // L18 5.05: Friendly (no reputation), flags 0x1001: CONTESTED_GUARD
  168: [128, 0, 0, 1, [], []], // Enemy (no reputation): hates players, looks neutral to them
  1729: [947, 4, 4, 2, [], []], // Thrallmar (reputation 37)
  1922: [1064, 0, 4, 2, [], [1064]], // Taunka (reputation 76)
  2107: [1119, 8, 0, 0, [1120, 1121], [1119]], // Sons of Hodir (reputation 97)
};
const DATA = { templates: {} };
for (const [id, [faction, factionGroup, friendGroup, enemyGroup, enemies, friends]] of Object.entries(ROWS)) {
  DATA.templates[id] = { faction, factionGroup, friendGroup, enemyGroup, enemies, friends };
}
/** `/dbc/reputation?v=1` by list index: only `factionId` is read here. */
const CATALOG = {
  version: 1,
  factions: { 1: { factionId: 21 }, 17: { factionId: 68 }, 19: { factionId: 72 }, 37: { factionId: 947 },
    76: { factionId: 1064 }, 97: { factionId: 1119 } },
};
/** `catalog: null` stands for a catalog that has not landed (undefined would take the default). */
function factionClient({ ready = true, catalog = CATALOG, templateFlags } = {}) { // L18 5.05: templateFlags
  return {
    ready,
    reaction: (mine, theirs) => (ready ? reactionBetween(DATA, mine, theirs) : 0),
    factionOf: (template) => (ready ? DATA.templates[template]?.faction : undefined),
    factionGroupOf: (template) => DATA.templates[template]?.factionGroup,
    get reputationCatalog() { return catalog ?? undefined; },
    // L18 5.05: FactionTemplate.Flags (/dbc/factions v=3); absent on a gateway before it.
    templateFlagsOf: templateFlags === undefined ? undefined : (template) => (ready ? templateFlags[template] ?? 0 : undefined),
  };
}

// ---- NPC flags (UnitDefines.h), unit flags ------------------------------------------------------

const GOSSIP = 0x1;
const QUESTGIVER = 0x2;
const VENDOR = 0x80;
const FLIGHTMASTER = 0x2000;
const SPIRITHEALER = 0x4000;
const INNKEEPER = 0x10000;
const BATTLEMASTER = 0x100000;
const AUCTIONEER = 0x200000;
const IMMUNE_TO_PC_NPC = 0x300;
const UNINTERACTIBLE = 0x0200_0000;
const ALLOW_ENEMY_INTERACT = 0x4000;
const VISIBLE_TO_GHOSTS = 0x2;

const SELF = 1n;
let nextGuid = 100n;

function unitObject(guid, { typeId = 3, template, npc = 0, flags = 0, flags2 = 0, entry = 0, health = 100 }) {
  return {
    guid, typeId,
    fields: new Map([
      [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry],
      [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health],
      [UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset, template],
      [UPDATE_FIELDS.UNIT_NPC_FLAGS.offset, npc],
      [UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, flags],
      [UPDATE_FIELDS.UNIT_FIELD_FLAGS_2.offset, flags2],
    ]),
    position: { x: 0, y: 0, z: 0, orientation: 0 },
  };
}

/** L15 5.05: the player's reputation rows (SMSG_INITIALIZE_FACTIONS) by list id: `[flags, standing]`. */
function reputationRows(rows = {}) {
  return new Map(Object.entries(rows).map(([listId, [flags, standing]]) =>
    [Number(listId), { listId: Number(listId), flags, standing }]));
}
const AT_WAR = 0x2;

/** A world holding the player and one unit; every request the click makes is recorded. */
function worldWith(unit, { ghost = false, typeFlags, forced, reputation, selfFlags2 = 0, selfPlayerFlags = 0 } = {}) { // L18 5.05: selfPlayerFlags
  const calls = [];
  const record = (kind) => (guid) => { calls.push(`${kind}`); assert.equal(guid, unit.guid); };
  const self = unitObject(SELF, { typeId: 4, template: 1, flags: 0x8, flags2: selfFlags2 });
  self.fields.set(UPDATE_FIELDS.PLAYER_FLAGS.offset, (ghost ? 0x10 : 0) | selfPlayerFlags); // L18 5.05: | selfPlayerFlags
  const entry = unit.fields.get(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset) ?? 0;
  return {
    calls,
    state: { selfGuid: SELF, objects: new Map([[SELF, self], [unit.guid, unit]]) },
    targetGuid: undefined, chatLog: [],
    forcedReactions: forced ?? new Map(),
    creatureTemplates: new Map(typeFlags === undefined ? [] : [[entry, { entry, found: true, flags: typeFlags }]]),
    questGiverStatus: new Map(), group: undefined, factions: reputationRows(reputation), // L15 5.05
    selectTarget(guid) { this.targetGuid = guid; },
    startAttack() { calls.push("attack"); assert.equal(this.targetGuid, unit.guid); },
    openGossip: record("gossip"), openQuestList: record("quests"), openVendor: record("vendor"),
    openTrainer: record("trainer"), openBank: record("bank"), requestTaxiMenu: record("taxi"),
    openAuctionHouse: record("auction"), battlemasterHello: record("battlemaster"), openLoot: record("loot"),
    spellClick: record("spellclick"), enterPlayerVehicle: record("vehicle"),
    closeNpcServices() {}, closeAuctionHouse() {}, cancelTrade() {}, closeBank() {}, closeLoot() {},
    aurasFor: () => [], displayName: () => "",
  };
}

/** What one right click on this unit asks of the world: [] is "nothing at all". */
function click(spec, { ghost = false, factions = factionClient(), forced, reputation, selfFlags2, selfPlayerFlags } = {}) { // L18 5.05: selfPlayerFlags
  const guid = nextGuid++;
  const entry = spec.entry ?? 0;
  const unit = unitObject(guid, { ...spec, entry });
  const world = worldWith(unit, { ghost, typeFlags: spec.typeFlags, forced, reputation, selfFlags2, selfPlayerFlags }); // L18 5.05
  const previousWorld = game.world;
  const previousFactions = game.factions;
  game.world = world;
  game.factions = factions;
  try {
    interactWithGuid(guid);
    closeNpcServiceWindow();
    return world.calls;
  } finally {
    game.world = previousWorld;
    game.factions = previousFactions;
  }
}

const ORDINARY = [
  ["a Stormwind vendor", { template: 12, npc: GOSSIP | VENDOR }, ["gossip"]],
  ["a Stormwind flight master", { template: 12, npc: FLIGHTMASTER }, ["taxi"]],
  ["a Stormwind guard (directions)", { template: 11, npc: GOSSIP }, ["gossip"]],
  ["the neutral Booty Bay innkeeper", { template: 120, npc: GOSSIP | VENDOR | INNKEEPER }, ["gossip"]],
  ["the neutral goblin auctioneer", { template: 120, npc: AUCTIONEER }, ["auction"]],
  ["a quest giver of the Friendly template", { template: 35, npc: QUESTGIVER }, ["quests"]],
  ["an Alliance battlemaster", { template: 84, npc: GOSSIP | BATTLEMASTER }, ["gossip"]],
  ["a monster", { template: 14 }, ["attack"]],
  ["a neutral beast", { template: 7 }, ["attack"]],
  ["a hostile Horde NPC it can fight", { template: 83, npc: GOSSIP }, ["attack"]],
  // 0x00729530 refuses the talk (hostile, no reputation in the way) and CanAttack the swing: nothing.
  ["a hostile Horde NPC immune to players", { template: 83, npc: GOSSIP, flags: IMMUNE_TO_PC_NPC }, []],
  ["a Horde NPCBot for hire (ALLOW_ENEMY_INTERACT)", { template: 2, npc: GOSSIP, flags2: ALLOW_ENEMY_INTERACT }, ["gossip"]],
  ["the player's own hired NPCBot (its master's race faction)", { template: 1, npc: GOSSIP }, ["gossip"]],
  ["a dungeon bot still on FACTION_FRIENDLY", { template: 35, npc: GOSSIP }, ["gossip"]],
  ["an NPC of a template the table does not have", { template: 77777, npc: VENDOR }, ["vendor"]],
  ["a vendor the server made uninteractible", { template: 35, npc: VENDOR, flags: UNINTERACTIBLE }, []],
  ["a monster's corpse", { template: 14, health: 0 }, ["loot"]],
];

test("11.02-tails-review: the NPCs a living player clicks every day", () => {
  for (const [name, spec, expected] of ORDINARY) assert.deepEqual(click(spec), expected, name);
});

test("11.02-tails-review: a faction that keeps a reputation is not refused on the template masks", () => {
  // Sons of Hodir's flight master Halvdan (32571) and Calder (32594): template 2107 is a monster-group
  // template every player race hates, but Wow.exe reads the player's own Sons of Hodir standing — a
  // player who is Friendly gets the flight map, and the realm serves it (the creature's reaction is the
  // player's rank, Object.cpp GetFactionReactionTo). The template alone must not take that away.
  assert.deepEqual(click({ template: 2107, npc: FLIGHTMASTER, flags: IMMUNE_TO_PC_NPC }), ["taxi"], "Halvdan");
  assert.deepEqual(click({ template: 2107, npc: VENDOR, flags: IMMUNE_TO_PC_NPC }), ["vendor"], "Calder");
  // Camp Winterhoof's Taunka innkeeper (24033): hostile to an Alliance player on the masks only one way;
  // the click stays the talk it was (the realm answers by the player's Taunka rank).
  assert.deepEqual(click({ template: 1922, npc: GOSSIP | VENDOR | INNKEEPER, flags: 0x200 }), ["gossip"], "Taunka innkeeper");
  // L15 5.05: the player's at-war flag decides it (the server's SMSG_INITIALIZE_FACTIONS row): a
  // Thrallmar vendor the Alliance player is at war with is fought (was the masks' "hostile").
  assert.deepEqual(click({ template: 1729, npc: VENDOR }, { reputation: { 37: [AT_WAR, 0] } }), ["attack"], "a Thrallmar vendor");
  // L15 5.05: and one immune to players is neither talked to nor fought — Wow.exe's "nothing" (was the
  // talk the realm never answered); not at war, it is talked to.
  assert.deepEqual(click({ template: 68, npc: VENDOR, flags: IMMUNE_TO_PC_NPC }, { reputation: { 17: [AT_WAR, 0] } }), [],
    "an Undercity vendor at war");
  assert.deepEqual(click({ template: 68, npc: VENDOR, flags: IMMUNE_TO_PC_NPC }), ["vendor"], "an Undercity vendor at peace");
  // Before the reputation catalog lands nothing tells which factions keep a reputation: no refusal.
  assert.deepEqual(click({ template: 2107, npc: FLIGHTMASTER, flags: IMMUNE_TO_PC_NPC },
    { factions: factionClient({ catalog: null }) }), ["taxi"], "catalog not loaded");
  // A forced reaction is what Wow.exe reads first (0x005d06a0): forced hostile, the talk is refused again.
  assert.deepEqual(click({ template: 2107, npc: FLIGHTMASTER, flags: IMMUNE_TO_PC_NPC },
    { forced: new Map([[1119, 1]]) }), [], "forced hostile");
});

// L15 5.05: Wow.exe reads a reputation faction off the player's at-war flag (the player's view, 0x007251c0
// branch 0x007253ca: hostile at war, friendly otherwise — CanAttack's) and rank (the unit's view, 0x0071f770
// → 0x005d0600); 0x00729530 talks at neutral (3) or better. .runtime/re-2026-10-04/l15-combat/g1.c.
test("L15 5.05: a Friendly Sons of Hodir NPC is talked to, not fought; at war it is fought", () => {
  const FRIENDLY_STANDING = 3_000; // the fixture's catalog has no race rows: base 0, so 3000 is Friendly
  // King Jokkum (30105) and Njormeld (30127): Sons of Hodir quest givers on template 2107, which every
  // player race hates on the masks — the click used to swing at them.
  const jokkum = { template: 2107, npc: GOSSIP | QUESTGIVER };
  assert.deepEqual(click(jokkum, { reputation: { 97: [0x1, FRIENDLY_STANDING] } }), ["gossip"], "King Jokkum, Friendly");
  assert.deepEqual(click({ template: 2107, npc: QUESTGIVER }, { reputation: { 97: [0x1, FRIENDLY_STANDING] } }), ["quests"],
    "Njormeld, Friendly");
  // At war (the flag the core sets below Unfriendly, or the player's own declaration) it is an enemy.
  assert.deepEqual(click(jokkum, { reputation: { 97: [0x1 | AT_WAR, FRIENDLY_STANDING] } }), ["attack"], "at war");
  // Hostile rank without the flag (the core's first login): no swing (not at war: CanAttack says friend),
  // no talk (the unit's rank is below neutral) — nothing, as in Wow.exe.
  assert.deepEqual(click(jokkum, { reputation: { 97: [0x1, -4_000] } }), [], "Hostile, not at war");
  // Neutral is enough to talk (3), Unfriendly (2) is not.
  assert.deepEqual(click(jokkum, { reputation: { 97: [0x1, 0] } }), ["gossip"], "Neutral");
  assert.deepEqual(click(jokkum, { reputation: { 97: [0x1, -1] } }), [], "Unfriendly");
  // UNIT_FLAG2_IGNORE_REPUTATION on the player sends both views back to the masks (the old swing).
  assert.deepEqual(click(jokkum, { reputation: { 97: [0x1, FRIENDLY_STANDING] }, selfFlags2: 0x4 }), ["attack"],
    "IGNORE_REPUTATION");
});

test("L15 5.05: a reputation faction's guard with nothing to say is not fought at peace", () => {
  // A Booty Bay bruiser (template 120, Booty Bay — reputation 1): neutral on the masks, so the click used
  // to swing at it; Wow.exe's CanAttack reads the player at peace with Booty Bay as a friend.
  assert.deepEqual(click({ template: 120 }, { reputation: { 1: [0x40, 0] } }), [], "at peace"); // L15-review: the server's row
  assert.deepEqual(click({ template: 120 }, { reputation: { 1: [AT_WAR, 0] } }), ["attack"], "at war");
  // L15-review: no row for Booty Bay yet (before SMSG_INITIALIZE_FACTIONS): the masks, as before 5.05.
  assert.deepEqual(click({ template: 120 }), ["attack"], "no row yet"); // L15-review
  // A neutral beast keeps no reputation: still fought.
  assert.deepEqual(click({ template: 7 }), ["attack"]);
});

test("L15 5.05: a forced Unfriendly reaction refuses the talk (0x00729530 wants neutral or better)", () => {
  // Forced ranks are read first both ways (0x005d06a0), as the rank itself: 2 is below neutral.
  assert.deepEqual(click({ template: 35, npc: GOSSIP, flags: IMMUNE_TO_PC_NPC }, { forced: new Map([[31, 2]]) }), [],
    "a forced Unfriendly NPC immune to players");
  assert.deepEqual(click({ template: 35, npc: GOSSIP }, { forced: new Map([[31, 2]]) }), ["attack"],
    "open to a swing: CanAttack takes anything below friendly");
  assert.deepEqual(click({ template: 35, npc: GOSSIP }, { forced: new Map([[31, 3]]) }), ["gossip"], "a forced Neutral talks");
  // The same for a reputation faction: Friendly standing, forced Unfriendly.
  assert.deepEqual(click({ template: 2107, npc: FLIGHTMASTER, flags: IMMUNE_TO_PC_NPC },
    { forced: new Map([[1119, 2]]), reputation: { 97: [0x1, 3_000] } }), [], "Halvdan under a forced Unfriendly");
});

test("11.02-tails-review: where Wow.exe reads the masks, the unit's own view of the player counts too", () => {
  // Template 168 ("Enemy", faction 128, no reputation) hates every player while the player sees it
  // neutral: 0x007251c0 called the unit's way refuses the talk, and CanAttack decides the rest
  // (Highlord Tirion Fordring 29175 rides the same shape on template 2088).
  assert.deepEqual(click({ template: 168, npc: GOSSIP }), ["attack"], "open to a swing");
  assert.deepEqual(click({ template: 168, npc: GOSSIP, flags: IMMUNE_TO_PC_NPC }), [], "immune to players");
  // Its forced reaction (keyed by its Faction, 128) is read first both ways.
  assert.deepEqual(click({ template: 168, npc: GOSSIP, flags: IMMUNE_TO_PC_NPC }, { forced: new Map([[128, 4]]) }),
    ["gossip"], "forced friendly");
});

test("11.02-tails-review: a ghost talks to the spirit healer, and never swings at what will not talk to it", () => {
  const healer = { template: 35, npc: GOSSIP | SPIRITHEALER, entry: 6491, typeFlags: VISIBLE_TO_GHOSTS };
  assert.deepEqual(click(healer, { ghost: true }), ["gossip"], "the spirit healer");
  assert.deepEqual(click({ template: 12, npc: VENDOR, entry: 1000, typeFlags: 0 }, { ghost: true }), [], "a Stormwind vendor");
  // A neutral vendor is attackable: the refused talk used to turn into a swing a dead player cannot
  // make (Unit::Attack refuses a dead attacker, Unit.cpp:5930).
  assert.deepEqual(click({ template: 120, npc: VENDOR, entry: 1001, typeFlags: 0 }, { ghost: true }), [], "a neutral vendor");
  assert.deepEqual(click({ template: 14 }, { ghost: true }), [], "a monster");
  // Alive again, the same vendor is talked to.
  assert.deepEqual(click({ template: 120, npc: VENDOR, entry: 1001, typeFlags: 0 }), ["vendor"]);
});

test("11.02-tails-review: before the faction table lands nothing is fought and every service opens", () => {
  const factions = factionClient({ ready: false });
  assert.deepEqual(click({ template: 14 }, { factions }), [], "a monster is not fought blind");
  assert.deepEqual(click({ template: 83, npc: GOSSIP, flags: IMMUNE_TO_PC_NPC }, { factions }), ["gossip"]);
  assert.deepEqual(click({ template: 2107, npc: FLIGHTMASTER, flags: IMMUNE_TO_PC_NPC }, { factions }), ["taxi"]);
});

// L18 5.05: CONTESTED_GUARD, as Wow.exe reads it both ways (.runtime/re-2026-09-30/gw-data/r2.c 0x007251c0 at
// 0x007253ca; .runtime/re-2026-10-03/l1102tails-review/r1.c 0x0071f770). The player's view: forced rank,
// then — a reputation faction — a CONTESTED_GUARD template (FactionTemplate flags 0x1000) is hostile to a
// player with PLAYER_FLAGS_CONTESTED_PVP (0x100), then the at-war flag. The unit's view: the CONTESTED_GUARD
// test comes first of all — before the forced rank, with or without a reputation. The realm agrees
// (Object.cpp GetReactionTo / GetFactionReactionTo; Player.cpp GetNPCIfCanInteractWith).
test("L18 5.05: a contested player hits the Booty Bay bruiser back and talks to no contested guard", () => {
  const CONTESTED_PVP = 0x100;
  const flagged = factionClient({ templateFlags: { 121: 0x1821, 1806: 0x1001 } }); // the dataset's FactionTemplate.Flags
  const peace = { 1: [0x40, 0] }; // the server's Booty Bay row: at peace
  assert.deepEqual(click({ template: 121 }, { factions: flagged, reputation: peace }), [], "the bruiser, calm: at peace");
  assert.deepEqual(click({ template: 121 }, { factions: flagged, reputation: peace, selfPlayerFlags: CONTESTED_PVP }),
    ["attack"], "the bruiser, contested");
  // Krazek's template (120) is Booty Bay too, without the guard flag: a contested player stays at peace with it.
  assert.deepEqual(click({ template: 120, npc: GOSSIP | VENDOR }, { factions: flagged, reputation: peace,
    selfPlayerFlags: CONTESTED_PVP }), ["gossip"], "Krazek talks");
  assert.deepEqual(click({ template: 120 }, { factions: flagged, reputation: peace, selfPlayerFlags: CONTESTED_PVP }), [],
    "a Booty Bay unit without the flag is no enemy");
  // A contested guard of a faction without a reputation (1806, «Friendly» 31): the player sees it friendly on
  // the masks (no swing), it sees the contested player hostile (no talk).
  assert.deepEqual(click({ template: 1806, npc: GOSSIP }, { factions: flagged, selfPlayerFlags: CONTESTED_PVP }), [],
    "contested: neither");
  assert.deepEqual(click({ template: 1806, npc: GOSSIP }, { factions: flagged }), ["gossip"], "calm: the talk");
  // A forced reaction does not save the talk: the unit's view reads CONTESTED_GUARD before it.
  assert.deepEqual(click({ template: 1806, npc: GOSSIP }, { factions: flagged, selfPlayerFlags: CONTESTED_PVP,
    forced: new Map([[31, 4]]) }), [], "forced friendly, contested");
  // A gateway before /dbc/factions v=3 (no flags): the L15-review stopgap — the masks for a contested player.
  assert.deepEqual(click({ template: 121 }, { reputation: peace, selfPlayerFlags: CONTESTED_PVP }), ["attack"], "old gateway: the bruiser");
  assert.deepEqual(click({ template: 120 }, { reputation: peace, selfPlayerFlags: CONTESTED_PVP }), ["attack"],
    "old gateway: Krazek's template too (the masks' neutral)");
  assert.deepEqual(click({ template: 1806, npc: GOSSIP }, { selfPlayerFlags: CONTESTED_PVP }), ["gossip"], "old gateway: the talk");
});

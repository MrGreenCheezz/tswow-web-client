import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 6.06 (line A7a, slice D, 05.10): what a melee swing looks like on both ends — the off-hand swing
// (HITINFO_OFFHAND → attackOff), the victim's reaction by VictimState/HitInfo, the swing by the weapon's subclass
// (Wow.exe 0x755130, 05.10-A7a-D-review) and the parry/stance tables (`/dbc/weapon-anims`). Constants are TrinityCore's: HitInfo `UnitDefines.h:359-387`, VictimState
// `Unit.h:44-55`, outcomes `Unit::CalculateMeleeDamage` `Unit.cpp:1400-1560`. Nothing here talks
// to the running gateway.

const { ANIMATION_DATA_AVAILABLE, ANIMATION_IDS, ANIMATION_NAMES } = await import("../dist/code/generated/animations.js");
const {
  HITINFO_AFFECTS_VICTIM, HITINFO_CRITICAL, HITINFO_MISS, HITINFO_OFFHAND,
} = await import("../dist/code/world/CombatProtocol.js");
const { combatAnimations, swingAction } = await import(
  process.env.COMBAT_ANIMATIONS_MODULE ?? "../dist/code/browser/game/CombatAnimations.js");
const {
  WEAPON_ANIMS_ROUTE_PATH, WEAPON_ANIMS_ROUTE_VERSION, STAND_IN_WEAPON_ANIMS, setWeaponAnimTable, weaponAnimTable,
  weaponAnimTableFrom,
} = await import(process.env.WEAPON_ANIMATIONS_MODULE ?? "../dist/code/browser/WeaponAnimations.js");
const { WEAPON_ANIMS_VERSION, loadWeaponAnims } = await import("../dist/code/gateway/WeaponAnimMetadata.js");
const { serveCatalogRoute } = await import("../dist/code/gateway/CatalogRoutes.js");
const { readyStance } = await import("../dist/code/browser/UnitStandingPose.js");
const { UnitActionQueue } = await import("../dist/code/browser/UnitActionArbiter.js");

let dbcDirectory;
try { dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory(); } catch { dbcDirectory = undefined; }
let datasetReadable = false;
try { if (dbcDirectory) { readFileSync(`${dbcDirectory}/AttackAnimKits.dbc`); datasetReadable = true; } } catch { /* no dataset */ }
const withData = { skip: ANIMATION_DATA_AVAILABLE ? false : "no locally generated animation data" };
const withDataset = { skip: ANIMATION_DATA_AVAILABLE && datasetReadable ? false : "no dataset DBC directory" };
const A = ANIMATION_IDS;
const weapon = (slot, inventoryType, subClass) => ({ slot, inventoryType, ...(subClass === undefined ? {} : { subClass }) });

// The shape the route answers, in this dataset's values (probe .runtime/re-2026-10-05/A7a-D/probe.mjs):
// a few subclass rows and the AttackAnimKits rows of the dagger (15), the sword (7) and the staff (10).
const ROUTE = {
  version: 1,
  subclasses: [
    [0, 2, 2, 3, 1], [1, 0, 0, 0, 2], [6, 1, 1, 1, 2], [7, 2, 2, 3, 1], [10, 1, 1, 1, 2],
    [13, 3, 2, 3, 0], [15, 2, 2, 3, 0], [17, 1, 1, 1, 2],
  ],
  kits: [
    [7, 7, 1, 4, 0], [8, 7, 2, 1, 0], [16, 7, 7, 1, 1], [19, 7, 8, 4, 1],
    [10, 10, 4, 4, 0], [21, 10, 3, 1, 0],
    [22, 15, 2, 1, 0], [23, 15, 8, 1, 1], [24, 15, 1, 1, 0], [25, 15, 7, 1, 1],
  ],
  types: [[1, "1H_Main_Swing"], [2, "1H_Main_Pierce"], [3, "2HL_Pierce"], [4, "2HL_Swing"], [5, "2HT_Swing"],
    [7, "OffH_Swing"], [8, "OffH_Pierce"]],
};

test("HITINFO_OFFHAND is the off-hand swing; nothing else in the word is", () => {
  assert.equal(swingAction(0), "attack");
  assert.equal(swingAction(HITINFO_AFFECTS_VICTIM | HITINFO_CRITICAL), "attack");
  assert.equal(swingAction(HITINFO_OFFHAND), "attackOff");
  assert.equal(swingAction(HITINFO_OFFHAND | HITINFO_AFFECTS_VICTIM | HITINFO_MISS), "attackOff");
  assert.equal(HITINFO_OFFHAND, 0x4);
});

// 05.10-A7a-D2: which reaction and when moved to game/SwingReactionCues.ts (Wow.exe plays it at the
// attacker's M2 events, not on the packet) — tests/swing-reaction-cues.test.mjs.

test("the route answer decodes into ladders; a bad shape is refused", withData, () => {
  const table = weaponAnimTableFrom(ROUTE);
  assert.ok(table);
  assert.equal(table.fromRoute, true);
  assert.equal(weaponAnimTableFrom({ ...ROUTE, version: 2 }), undefined);
  assert.equal(weaponAnimTableFrom({ ...ROUTE, kits: [[1, 2, 3]] }), undefined);
  assert.equal(weaponAnimTableFrom({ ...ROUTE, types: [[1, 7]] }), undefined);
  assert.equal(weaponAnimTableFrom(null), undefined);
  assert.equal(WEAPON_ANIMS_ROUTE_VERSION, WEAPON_ANIMS_VERSION);
  assert.equal(WEAPON_ANIMS_ROUTE_PATH, `/dbc/weapon-anims?v=${WEAPON_ANIMS_VERSION}`);
  // A dagger swings and stabs with either hand; the kits of the left hand are OffH_*.
  const daggerMain = table.attackLadders(15, "main").map((ladder) => ladder[0]).sort((a, b) => a - b);
  assert.deepEqual(daggerMain, [A.Attack1H, A.Attack1HPierce].sort((a, b) => a - b));
  const daggerOff = table.attackLadders(15, "off").map((ladder) => ladder[0]).sort((a, b) => a - b);
  assert.deepEqual(daggerOff, [A.AttackOff, A.AttackOffPierce].sort((a, b) => a - b));
  // A staff: 2HL_Swing and 2HL_Pierce, each backed by the WeaponAttackSeq ladder (1 = 2HL).
  for (const ladder of table.attackLadders(10, "main")) {
    assert.ok([A.Attack2HL, A.Attack2HLoosePierce].includes(ladder[0]));
    assert.deepEqual(ladder.slice(-3), [A.Attack2H, A.Attack1H, A.AttackUnarmed]);
    assert.ok(ladder.includes(A.Attack2HL));
  }
  // No kit for a fist weapon (13) or a spear (17): the subclass's WeaponAttackSeq decides.
  assert.equal(table.attackLadders(13, "main"), undefined);
  assert.equal(table.attackLadders(13, "off"), undefined);
});

// 05.10-A7a-D-review: the swing is Wow.exe's, not a roll. `0x755130` (UnitCombat_C, called from the
// opcode switch 0x756800, case 0x14A) picks one animation by the class-2 subclass in the hand —
// AttackAnimKits are not consulted and nothing is random — and the AnimationData chain does the rest.
test("a swing is the subclass's own (Wow.exe 0x755130): no roll, no kit variants", withData, () => {
  const table = weaponAnimTableFrom(ROUTE);
  const head = (action, attached) => combatAnimations({ action, roll: 0.999 }, attached, table)?.[0];
  const main = (sub, inventoryType = 13) => [weapon(15, inventoryType, sub)];
  // The same answer for every roll and every table, the same shared array each frame.
  const dagger = [weapon(15, 13, 15), weapon(16, 13, 15)];
  assert.equal(combatAnimations({ action: "attack", roll: 0 }, dagger, table),
    combatAnimations({ action: "attack", roll: 0.999 }, dagger, STAND_IN_WEAPON_ANIMS), "no roll, no table");
  assert.deepEqual(combatAnimations({ action: "attack", roll: 0 }, dagger, table),
    [A.Attack1HPierce, A.Attack1H, A.AttackUnarmed], "a dagger stabs, then the DBC chain");
  for (const sub of [0, 4, 7, 11, 14]) assert.equal(head("attack", main(sub)), A.Attack1H, `one-hander ${sub}`);
  for (const sub of [1, 5, 8, 12]) assert.equal(head("attack", main(sub, 17)), A.Attack2H, `two-hander ${sub}`);
  for (const sub of [6, 10, 17, 20]) assert.equal(head("attack", main(sub, 17)), A.Attack2HL, `loose two-hander ${sub}`);
  for (const sub of [9, 13]) assert.equal(head("attack", main(sub)), A.AttackUnarmed, `subclass ${sub}: unarmed`);
  assert.equal(head("attack", [weapon(15, 15, 2)]), A.AttackUnarmed, "a bow in the main-hand slot (an NPC)");
  // Titan's Grip: a two-hander with anything in the left hand swings one-handed.
  assert.equal(head("attack", [weapon(15, 17, 1), weapon(16, 17, 8)]), A.Attack1H);
  // Empty hands, or only a ranged weapon (a hunter without a melee weapon): unarmed, not AttackBow.
  assert.equal(head("attack", []), A.AttackUnarmed);
  assert.equal(head("attack", [weapon(17, 15, 2)]), A.AttackUnarmed);
  // The left hand: a weapon swings AttackOff, a dagger AttackOffPierce, nothing AttackUnarmedOff.
  assert.equal(head("attackOff", dagger), A.AttackOffPierce);
  assert.equal(head("attackOff", [weapon(15, 21, 7), weapon(16, 22, 13)]), A.AttackOff, "a fist weapon in the left");
  assert.equal(head("attackOff", [weapon(15, 21, 7)]), A.AttackUnarmedOff);
  assert.equal(head("attackOff", [weapon(15, 21, 7), weapon(16, 14)]), A.AttackUnarmedOff, "a shield is not a weapon");
  // Nothing to read yet, or no subclass on an old payload: the caller's inventory-type list.
  assert.equal(combatAnimations({ action: "attack" }, undefined, table), undefined);
  assert.equal(combatAnimations({ action: "attack" }, [weapon(15, 17)], table), undefined);
  assert.equal(combatAnimations({ action: "shoot" }, [weapon(17, 15, 2)], table), undefined);
  assert.equal(combatAnimations({ action: undefined }, dagger, table), undefined);
});

// 05.10-A7a-D2: the parry is Wow.exe's `0x73b050` — a byte table by the main hand's subclass, not
// `WeaponParrySeq` (which disagrees for 11, 12, 14, 20) — and some weapons have none at all.
test("the victim's reaction pose; a parry by the victim's main-hand subclass (Wow.exe 0x73b050)", withData, () => {
  const table = weaponAnimTableFrom(ROUTE);
  const ladder = (reaction, attached) => combatAnimations({ action: undefined, reaction }, attached, table);
  const react = (reaction, attached) => ladder(reaction, attached)?.[0];
  assert.equal(react("wound", undefined), A.CombatWound);
  assert.equal(react("standWound", undefined), A.StandWound);
  assert.equal(react("critical", undefined), A.CombatCritical);
  assert.equal(react("dodge", undefined), A.Dodge);
  assert.equal(react("block", undefined), A.ShieldBlock);
  assert.equal(react("parryUnarmed", [weapon(15, 17, 1)]), A.ParryUnarmed, "weapons sheathed");
  const main = (sub, inventoryType = 13) => [weapon(15, inventoryType, sub)];
  for (const sub of [0, 4, 7, 11, 14, 15, 20]) assert.equal(react("parry", main(sub)), A.Parry1H, `one-hander ${sub}`);
  for (const sub of [1, 5, 8, 12]) assert.equal(react("parry", main(sub, 17)), A.Parry2H, `two-hander ${sub}`);
  assert.equal(react("parry", [weapon(15, 17, 8), weapon(16, 17, 1)]), A.Parry1H, "Titan's Grip");
  for (const sub of [6, 10, 17]) assert.equal(react("parry", main(sub, 17)), A.Parry2HL, `loose two-hander ${sub}`);
  assert.equal(react("parry", main(13)), A.ParryUnarmed, "a fist weapon");
  for (const sub of [2, 3, 9, 16, 18, 19]) assert.deepEqual(ladder("parry", main(sub, 15)), [], `no parry for ${sub}`);
  assert.equal(react("parry", undefined), A.ParryUnarmed, "nothing known yet");
  assert.equal(react("parry", []), A.ParryUnarmed, "empty hands");
  assert.equal(react("parry", [weapon(16, 13, 7)]), A.ParryUnarmed, "an off-hand alone does not parry with it");
  assert.equal(react("parry", [weapon(15, 14)]), A.ParryUnarmed, "a shield in the main-hand slot is not a weapon");
  // An old payload without the subclass: the inventory type is all there is.
  assert.equal(react("parry", [weapon(15, 17)]), A.Parry2H);
  assert.equal(react("parry", [weapon(15, 21)]), A.Parry1H);
  // The table is not consulted: a route that says otherwise changes nothing.
  const other = weaponAnimTableFrom({ ...ROUTE, subclasses: [[7, 0, 0, 0, 2]] });
  assert.equal(combatAnimations({ action: undefined, reaction: "parry" }, main(7), other)?.[0], A.Parry1H);
});

test("without the route: the stand-in table — the dataset's columns, no kits", withData, () => {
  setWeaponAnimTable(undefined);
  assert.equal(weaponAnimTable(), STAND_IN_WEAPON_ANIMS);
  assert.equal(STAND_IN_WEAPON_ANIMS.fromRoute, false);
  const dagger = [weapon(15, 13, 15)];
  assert.equal(combatAnimations({ action: "attack", roll: 0.9 }, dagger)[0], A.Attack1HPierce,
    "the swing needs no route (05.10-A7a-D-review)");
  assert.equal(combatAnimations({ action: undefined, reaction: "parry" }, [weapon(15, 17, 6)])[0], A.Parry2HL,
    "the parry column needs no route");
  // The route, once it lands, is what the renderer and the stance read.
  const fake = weaponAnimTableFrom({ ...ROUTE, subclasses: [[7, 0, 0, 0, 2]] });
  setWeaponAnimTable(fake);
  try {
    assert.equal(weaponAnimTable(), fake);
    assert.equal(readyStance([weapon(15, 13, 7)], 1)[0], A.Ready2H, "the stance reads WeaponReadySeq from the route");
    assert.equal(readyStance([weapon(15, 13, 4)], 1)[0], A.Ready1H, "a subclass the route lacks keeps the stand-in");
  } finally {
    setWeaponAnimTable(undefined);
  }
  assert.equal(readyStance([weapon(15, 13, 7)], 1)[0], A.Ready1H);
});

test("this dataset: the stand-in is the table, every kit names a real AnimationData row", withDataset, async () => {
  const catalog = await loadWeaponAnims(dbcDirectory);
  assert.equal(catalog.version, WEAPON_ANIMS_VERSION);
  assert.equal(catalog.subclasses.length, 21);
  assert.equal(catalog.kits.length, 26);
  assert.equal(catalog.types.length, 7);
  for (const [sub, parry, ready, attack, swingSize] of catalog.subclasses) {
    assert.deepEqual(STAND_IN_WEAPON_ANIMS.subclass(sub), { parry, ready, attack, swing: swingSize }, `subclass ${sub}`);
  }
  const table = weaponAnimTableFrom(JSON.parse(JSON.stringify(catalog)));
  assert.ok(table);
  for (const [, sub, , , offhand] of catalog.kits) {
    for (const ladder of table.attackLadders(sub, offhand ? "off" : "main")) {
      assert.ok(ladder.length > 0 && ladder.every((id) => ANIMATION_NAMES[id] !== undefined), `kit ladder of ${sub}`);
      const name = ANIMATION_NAMES[ladder[0]];
      assert.ok(offhand ? name.startsWith("AttackOff") : !name.startsWith("AttackOff"), `${sub}: ${name}`);
    }
  }
  assert.equal(table.attackLadders(15, "main").length, 2, "the dagger stabs and swings");
  assert.equal(table.attackLadders(15, "off").length, 2);
  assert.deepEqual(table.attackLadders(10, "main").map((ladder) => ANIMATION_NAMES[ladder[0]]).sort(),
    ["Attack2HL", "Attack2HLoosePierce"]);
  // Every class-2 subclass: a parry that names a real row, or (05.10-A7a-D2, 0x73b050) none at all.
  for (const [sub] of catalog.subclasses) {
    const parry = combatAnimations({ action: undefined, reaction: "parry" }, [weapon(15, 13, sub)], table);
    assert.ok(parry && (parry.length === 0 || ANIMATION_NAMES[parry[0]]?.startsWith("Parry")), `parry of ${sub}`);
  }
});

test("the route answers through the catalog table with the Origin and version checks", withDataset, async () => {
  const run = async (path, origin) => {
    const url = new URL(path, "http://127.0.0.1");
    const response = { status: 0, body: "", headers: undefined,
      writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
      end(body = "") { this.body = body; return this; } };
    await serveCatalogRoute({ method: "GET", headers: { origin } }, response, url, new Map(),
      { dbcDirectory, allowedOrigins: ["http://127.0.0.1:5173"] });
    return response;
  };
  const ok = await run(WEAPON_ANIMS_ROUTE_PATH, "http://127.0.0.1:5173");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.ok(weaponAnimTableFrom(JSON.parse(ok.body)));
  assert.ok(ok.body.length < 4_000, `under 4 KB (${ok.body.length}; 777 on this dataset)`);
  assert.equal((await run("/dbc/weapon-anims?v=9", "http://127.0.0.1:5173")).status, 400);
  assert.equal((await run(WEAPON_ANIMS_ROUTE_PATH, "http://evil.test")).status, 403);
});

test("a reaction never interrupts the unit's own swing or cast (UNIT_ACTION_PRIORITY)", () => {
  const payload = { wanted: [], action: undefined, stage: "main", sequenceAt: 0, waitUntil: 900, sidecarWaitUntil: 3_000, source: "external" };
  for (const layer of ["melee", "cast"]) {
    const queue = new UnitActionQueue();
    queue.submit({ layer, held: false, until: 3_000, payload: { ...payload, action: layer === "melee" ? "attack" : "cast" } }, 0);
    assert.equal(queue.submit({ layer: "reaction", held: false, until: 3_000, payload: { ...payload, reaction: "wound" } }, 10),
      undefined, `a flinch is refused over ${layer}`);
    assert.equal(queue.top().layer, layer);
  }
  const queue = new UnitActionQueue();
  queue.submit({ layer: "reaction", held: false, until: 3_000, payload: { ...payload, reaction: "parry" } }, 0);
  queue.submit({ layer: "melee", held: false, until: 3_000, payload: { ...payload, action: "attack" } }, 10);
  assert.equal(queue.top().layer, "melee", "the unit's own swing takes over a parry at once");
});

test("hook lines: onSwing, the renderer's reaction entry and the variant roll", () => {
  const enter = readFileSync(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  const onSwing = enter.slice(enter.indexOf("world.onSwing = "), enter.indexOf("world.onEmote = "));
  // 05.10-A7a-D2: no reaction on arrival — the swing goes through game/SwingReactionHost.ts, which
  // queues it on the attacker and reacts the victim at the swing's $CPP / $CAH moments
  // (tests/swing-reaction-cues.test.mjs).
  assert.doesNotMatch(onSwing, /playUnitReaction\(/);
  assert.match(onSwing, /swingReactions\.swing\(swing, swingAction\(swing\.hitInfo\)\)/);
  assert.match(enter, /world\.onMeleeAttack = \(attacker, victim\) => swingReactions\.meleeAttack\(attacker, victim\)/);
  assert.match(enter, /entryLifecycle\.track\(\(\) => swingReactions\.dispose\(\)\)/);
  const host = readFileSync(new URL("../src/browser/game/SwingReactionHost.ts", import.meta.url), "utf8");
  assert.match(host, /renderer\?\.playUnitAction\(swing\.attacker, action\)/);
  assert.match(host, /renderer\.afterUnits = this\.#tick/);
  const client = readFileSync(new URL("../src/world/WorldClient.ts", import.meta.url), "utf8");
  assert.match(client, /parseAttackStart\(packet\.payload\);\n\s+this\.onMeleeAttack\?\.\(attack\.attacker, attack\.victim\);/);
  assert.match(client, /parseAttackStop\(packet\.payload\);\n\s+this\.onMeleeAttack\?\.\(attack\.attacker, undefined\);/);
  const renderer = readFileSync(process.env.UNIT_ACTION_RENDERER_SOURCE ?? new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const body = (name) => {
    const start = renderer.indexOf(`  ${name}(`);
    assert.ok(start > 0, name);
    return renderer.slice(start, renderer.indexOf("\n  }\n", start));
  };
  assert.match(body("playUnitAction"), /roll: Math\.random\(\)/);
  assert.match(body("playUnitReaction"), /layer: "reaction"/);
  assert.match(body("#entryAnimation"), /combatAnimations\(pending, attachedOf\(metadata\)\)/);
  // 05.10-A7a-D2: a weapon without a parry (0x73b050) drops the entry instead of waiting for a clip.
  assert.match(body("#entryAnimation"), /combat !== undefined && combat\.length === 0\) return "drop"/);
  assert.match(body("playUnitAction"), /return this\.#submitUnitAction\(/);
  assert.match(body("meleeSwingProgress"), /shown\.entry === token/);
  assert.match(body("#updateUnits"), /this\.afterUnits\?\.\(now\)/);
  // 05.10-A7a-D-review: a queue for a guid never drawn leaves with the range — one reaction per hit
  // on every victim must not pile up queues for units beyond the draw distance.
  assert.match(body("#updateUnits"),
    /for \(const guid of this\.#actions\.keys\(\)\) if \(!inRange\.has\(guid\)\) this\.#actions\.delete\(guid\);/);
});

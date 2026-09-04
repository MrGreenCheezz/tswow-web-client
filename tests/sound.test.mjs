import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { normaliseSoundPath } from "../dist/code/gateway/SoundMetadata.js";
import {
  normaliseSoundPath as toolNormalise, soundId, validSoundPath,
} from "../tools/generate-sound.mjs";
import {
  forgetZoneSound, isDaytime, updateZoneSound, zoneAmbienceOf, zoneMusicOf, zoneMusicSilence,
} from "../dist/code/browser/game/ZoneSound.js";
import { SoundIndex, WeaponSoundIndex } from "../dist/code/gateway/SoundMetadata.js";
import {
  IMPACT_SLOT, impactSubclassOf, isSilentWeapon, swingSizeOf, weaponSoundFor,
} from "../dist/code/browser/game/WeaponSounds.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import {
  HITINFO_BLOCK, HITINFO_CRITICAL, HITINFO_MISS, HITINFO_OFFHAND,
  VICTIMSTATE_BLOCKS, VICTIMSTATE_DEFLECTS, VICTIMSTATE_DODGE, VICTIMSTATE_EVADES,
  VICTIMSTATE_HIT, VICTIMSTATE_IMMUNE, VICTIMSTATE_PARRY,
} from "../dist/code/world/CombatProtocol.js";
import { game } from "../dist/code/browser/game/Context.js";
import { forgetGameSounds, playCreatureSound, retryPendingSounds } from "../dist/code/browser/game/GameSounds.js";
import * as combatSounds from "../dist/code/browser/game/CombatSounds.js";

const { forgetCombatSounds, playSwingSounds, updateCombatSounds } = combatSounds;

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

const SEP = String.fromCharCode(92);
const FOOTSTEP = ["Sound", "Character", "Footsteps", "mFootSmallDirtA.wav"].join(SEP);
const ORIGIN = { origin: "http://localhost:5173" };

test("beneficial and utility spell logs never manufacture combat voices", () => {
  assert.equal(typeof combatSounds.spellCombatVoices, "function");
  assert.deepEqual(combatSounds.spellCombatVoices({
    kind: "heal", casterGuid: 1n, targetGuid: 1n, critical: false,
  }), [], "self-healing must not grunt and cry as if it were a weapon hit");
  assert.deepEqual(combatSounds.spellCombatVoices({
    kind: "utility", casterGuid: 1n, targetGuid: 2n, critical: false,
  }), []);
  assert.deepEqual(combatSounds.spellCombatVoices({
    kind: "damage", casterGuid: 1n, targetGuid: 2n, critical: true,
  }), [{ guid: 1n, voice: "exertionCritical" }],
  "damage may use the caster's effort voice; target injury already comes from FLOATING_TEXT");
});

test("Ж2.1 a sound path has one spelling, and the gateway and the generator agree on it", () => {
  // `SoundEntries` writes the same file several ways: 45 of the 20,642 slots join their directory
  // to their filename with a doubled separator and 26 carry a leading one. Left alone those are
  // 163 paths the archives do not have; normalised, the misses are the 124 that genuinely are not
  // in the client, which is the number the negative cache has to carry.
  const doubled = SEP + "Sound" + SEP + SEP + "Creature" + SEP + "Boar.wav";
  const tidy = "Sound" + SEP + "Creature" + SEP + "Boar.wav";
  assert.equal(normaliseSoundPath(doubled), tidy);
  assert.equal(toolNormalise(doubled), tidy, "the gateway and the generator must not disagree");
  assert.equal(normaliseSoundPath("Sound/Creature/Boar.wav"), tidy, "and a forward slash is the same file");

  assert.equal(validSoundPath(FOOTSTEP), true);
  assert.equal(validSoundPath("Sound" + SEP + ".." + SEP + "secrets.wav"), false);
  assert.equal(validSoundPath("Tileset" + SEP + "Grass.blp"), false, "only .wav and .mp3 are sounds");
});

test("Ж2.1 the sound route serves from disk, and answers 404 for what the client does not have", async () => {
  const soundDirectory = await mkdtemp(join(tmpdir(), "webclient-sound-"));
  // The kit as the generator would leave it: five variants, all five on disk after one miss.
  const kit = ["A", "B", "C", "D", "E"].map((variant) =>
    ["Sound", "Character", "Footsteps", `mFootSmallDirt${variant}.wav`].join(SEP));
  let runs = 0;
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    soundDirectory,
    generateSound: async (path) => {
      runs++;
      if (!path.toLowerCase().includes("footsmalldirt")) throw new Error(`${path} is not in the client`);
      // A whole `SoundEntries` row per run, which is the entire point of the route's lane key.
      for (const file of kit) {
        const id = createHash("sha1").update(`sound-v1\0${file.toLowerCase()}`).digest("hex");
        await writeFile(join(soundDirectory, `${id}.wav`), Buffer.alloc(file.endsWith("A.wav") ? 27908 : 1024));
      }
    },
  });
  try {
    const url = (path) => `http://127.0.0.1:${gateway.port}/sound?path=${encodeURIComponent(path)}`;

    // The origin gate applies here as everywhere: an `<audio src>` sends no Origin and gets this.
    const refused = await fetch(url(FOOTSTEP));
    assert.equal(refused.status, 403);
    await refused.arrayBuffer();

    const first = await fetch(url(FOOTSTEP), { headers: ORIGIN });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "audio/wav");
    assert.equal(first.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    const etag = first.headers.get("etag");
    assert.match(etag ?? "", /^"[0-9a-f]{40}"$/);
    assert.equal((await first.arrayBuffer()).byteLength, 27908);
    assert.equal(runs, 1);

    const unchanged = await fetch(url(FOOTSTEP), {
      headers: { ...ORIGIN, "if-none-match": etag },
    });
    assert.equal(unchanged.status, 304, "an unchanged sound keeps the stable URL without resending its body");
    assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
    assert.equal(runs, 1);

    // Checked by looking, not by timing: the whole kit is on disk after the one miss.
    const published = await readdir(soundDirectory);
    assert.equal(published.length, 5, `expected the whole kit, found ${published.join(", ")}`);

    // And none of the other four costs a process.
    for (const file of kit.slice(1)) {
      const response = await fetch(url(file), { headers: ORIGIN });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    assert.equal(runs, 1, "a variant already on disk must not start a generator");

    // 124 of the paths `SoundEntries` names are not in the archives at all, and each of them would
    // otherwise start a process every time something asked for it.
    const missing = ["Sound", "Creature", "Ogre", "mOgreFidget3.wav"].join(SEP);
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(url(missing), { headers: ORIGIN });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
      await response.arrayBuffer();
    }
    assert.equal(runs, 2, "the generator should have run once for the missing kit, not four times");

    const rejected = await fetch(url("Sound" + SEP + ".." + SEP + "x.wav"), { headers: ORIGIN });
    assert.equal(rejected.status, 400);
    await rejected.arrayBuffer();
  } finally {
    await gateway.close();
    await rm(soundDirectory, { recursive: true, force: true });
  }
});

test("Ж2.2 the id a path hashes to is the name the file is published under", () => {
  // The gateway hashes the path itself and the generator hashes it again in another process; if
  // the two ever drift, every sound is a permanent 404 and nothing says why.
  const id = soundId(FOOTSTEP);
  const gatewaySide = createHash("sha1")
    .update(`sound-v1\0${normaliseSoundPath(FOOTSTEP).toLowerCase()}`)
    .digest("hex");
  assert.equal(id, gatewaySide);
});

test("Ж2.4 a sub-area with no music of its own borrows the zone's", () => {
  // A tavern names nothing; the forest around it does. Falling silent indoors would be the
  // opposite of what the table means by a zero.
  const parents = new Map([[87, 12], [12, 0]]);
  const music = new Map([[87, 0], [12, 3]]);
  const walk = (areaId) => zoneMusicOf(areaId, (id) => parents.get(id), (id) => music.get(id) ?? 0);
  assert.equal(walk(87), 3);
  assert.equal(walk(12), 3);
  assert.equal(walk(4242), 0, "an area nothing knows about is silence, not a guess");

  // A dataset whose parents loop must not spin the frame.
  const looped = new Map([[1, 2], [2, 1]]);
  assert.equal(zoneMusicOf(1, (id) => looped.get(id), () => 0), 0);
});

test("Ж2.4 the clock picks the day track between six and eight", () => {
  assert.equal(isDaytime(0), false);
  assert.equal(isDaytime(6 * 60 - 1), false);
  assert.equal(isDaytime(6 * 60), true);
  assert.equal(isDaytime(12 * 60), true);
  assert.equal(isDaytime(20 * 60 - 1), true);
  assert.equal(isDaytime(20 * 60), false, "eight in the evening is night");
});

test("zone music normalises its authored silence range", async () => {
  assert.equal(zoneMusicSilence(180_000, 300_000, () => 0), 180_000);
  assert.equal(zoneMusicSilence(180_000, 300_000, () => 0.5), 240_000);
  assert.equal(zoneMusicSilence(1_800_000, 300_000, () => 0), 300_000,
    "a reversed DBC pair starts at its smaller value");
  assert.equal(zoneMusicSilence(-10, 30, () => 1), 30, "negative silence is clamped away");
});

test("zone music metadata carries the pauses that separate its alternative tracks", withDataset, async () => {
  const sounds = await SoundIndex.load(dbcDirectory);
  assert.deepEqual(sounds.zoneMusic(1), {
    day: { kit: 2523, silenceMin: 180_000, silenceMax: 300_000 },
    night: { kit: 2523, silenceMin: 180_000, silenceMax: 300_000 },
  });
  assert.deepEqual(sounds.kit(2523).files.map((path) => path.split(SEP).at(-1)),
    ["DayForest01.mp3", "DayForest02.mp3", "DayForest03.mp3"],
    "the files are alternatives in one kit, not one short file to loop");

  // This real row is malformed in the source DBC. Keeping the assertion here prevents a future
  // refactor from turning its reversed night interval into a deadline in the past.
  assert.deepEqual(sounds.zoneMusic(225).night,
    { kit: 7076, silenceMin: 300_000, silenceMax: 1_800_000 });
});

test("Ж2.5 a creature finds its voice through its model, not only through its display", withDataset, async () => {
  // `CreatureDisplayInfo.SoundID` is an override and only 1,205 of 24,262 rows carry one. The
  // usual answer is on the model the display points at, and following both is the difference
  // between five per cent of creatures being audible and effectively all of them.
  const index = await SoundIndex.load(dbcDirectory);
  let viaDisplay = 0;
  let covered = 0;
  for (const displayId of [4, 49, 1126, 19723]) {
    const sounds = index.creature(displayId);
    if (!sounds) continue;
    covered++;
    if (sounds.aggro > 0 && sounds.injury > 0 && sounds.death > 0) viaDisplay++;
  }
  assert.equal(covered, 4, "every one of these displays should have a voice");
  assert.equal(viaDisplay, 4);

  // A tarantula and an infernal do not sound alike, and the ids have to be the row's own.
  const spider = index.creature(4);
  const infernal = index.creature(1126);
  assert.notEqual(spider.aggro, infernal.aggro);
  // And the kits behind them are real rows with files in them.
  for (const id of [spider.aggro, spider.injury, spider.death, infernal.death]) {
    const kit = index.kit(id);
    assert.ok(kit && kit.files.length > 0, `sound ${id} names no file`);
    assert.ok(kit.maxDistance > kit.minDistance, "a positional sound needs two radii");
  }

  // A display nothing knows about answers nothing rather than guessing.
  assert.equal(index.creature(999999), undefined);
});

test("Ж2.5 the interface asks for its own noises by name", withDataset, async () => {
  // Names and not ids: `LEVELUP` says what it is and `888` does not, and the mapping is a column
  // of the table rather than a convention.
  const index = await SoundIndex.load(dbcDirectory);
  for (const name of ["LEVELUP", "QUESTCOMPLETED", "igMainMenuOpen", "igBackPackOpen",
    "LOOTWINDOWOPENEMPTY", "igQuestFailed"]) {
    const id = index.named(name);
    assert.ok(id && id > 0, `${name} is not in this client's table`);
    assert.ok(index.kit(id)?.files.length, `${name} resolves to a row with no file`);
  }
  // Four of the names one would reach for first are genuinely absent, which is why the client's
  // list is what was found rather than what was expected.
  assert.equal(index.named("InterfaceError"), undefined);
  assert.equal(index.named("PickUpGold"), undefined);
});

test("Ж2.5 one request answers about creatures and about the interface at once", withDataset, async () => {
  // The kits behind both ride back in the same `kits` array, so a client that has the answer has
  // everything it needs to play it without a second round trip.
  const index = await SoundIndex.load(dbcDirectory);
  const spider = index.creature(4);
  const levelUp = index.named("LEVELUP");
  assert.ok(spider && levelUp);
  assert.ok(index.kit(spider.aggro));
  assert.ok(index.kit(levelUp));
});

const encoder = new TextEncoder();

/** A WDBC file with `fields` columns and no strings, which is all four weapon tables need. */
function dbcFixture(fields, rows) {
  const result = new Uint8Array(20 + rows.length * fields * 4 + 1);
  result.set(encoder.encode("WDBC"));
  const view = new DataView(result.buffer);
  view.setUint32(4, rows.length, true);
  view.setUint32(8, fields, true);
  view.setUint32(12, fields * 4, true);
  view.setUint32(16, 1, true);
  for (let row = 0; row < rows.length; row++) {
    for (let field = 0; field < fields; field++) {
      view.setInt32(20 + (row * fields + field) * 4, rows[row][field] ?? 0, true);
    }
  }
  return result;
}

/**
 * The four tables `/dbc/weapon-sounds` opens, as fixtures.
 *
 * Column positions are the ones the generated layout declares, so a fixture that drifts from the
 * real table fails to open rather than quietly reading the neighbouring slot.
 */
function weaponDbcs() {
  // WeaponImpactSounds: ID, WeaponSubClassID, ParrySoundType, ImpactSoundID[10] at 3..12,
  // CritImpactSoundID[10] at 13..22.
  const metalSword = [1, 7, 1, 143, 145, 147, 3263, 3262, 1002, 1001, 3202, 3206, 3210,
    144, 146, 148, 3263, 3262, 1002, 1001, 3203, 3207, 3210];
  const woodSword = [2, 7, 0, 941, 939, 945, 3263, 3262, 1000, 999, 3202, 3206, 3210,
    942, 940, 946, 3263, 3262, 1000, 999, 3203, 3207, 3210];
  // A subclass with one row, which is what the 264 weapons whose material has nothing to choose
  // between fall back to.
  const bow = [3, 2, 0, 601, 602, 603, 3263, 3262, 0, 0, 0, 0, 0,
    611, 612, 613, 3263, 3262, 0, 0, 0, 0, 0];

  // ItemSubClass: ClassID, SubClassID, … WeaponSwingSize at 9, then two localised names.
  const subClass = (classId, id, swingSize) => {
    const row = Array(44).fill(0);
    row[0] = classId;
    row[1] = id;
    row[9] = swingSize;
    return row;
  };

  // Item: ID, ClassID, SubclassID, Sound_Override_Subclassid, Material, DisplayInfoID,
  // InventoryType, SheatheType.
  return {
    WeaponImpactSounds: dbcFixture(23, [metalSword, woodSword, bow]),
    WeaponSwingSounds2: dbcFixture(4, [
      [1, 0, 0, 233], [2, 0, 1, 234], [3, 1, 0, 235], [4, 1, 1, 236], [5, 2, 0, 237], [6, 2, 1, 238],
    ]),
    ItemSubClass: dbcFixture(44, [
      subClass(2, 7, 1), subClass(2, 1, 2), subClass(2, 15, 0),
      // A shield is class 4 and has a swing size of its own in the table; it must not appear in a
      // list of how hard a *weapon* swings.
      subClass(4, 6, 2),
    ]),
    Item: dbcFixture(8, [
      [25, 2, 7, -1, 1, 1542, 21, 3],
      [36, 2, 4, -1, 2, 1234, 21, 3],
      [2362, 4, 6, -1, 1, 999, 14, 4],
    ]),
  };
}

test("Н1а the weapon-sounds route serves the tables whole and the items in batches", async () => {
  const dbcDirectory = await mkdtemp(join(tmpdir(), "webclient-weapons-"));
  for (const [table, bytes] of Object.entries(weaponDbcs())) {
    await writeFile(join(dbcDirectory, `${table}.dbc`), bytes);
  }
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    dbcDirectory,
  });
  try {
    const url = `http://127.0.0.1:${gateway.port}/dbc/weapon-sounds`;

    // The origin gate applies here as everywhere.
    const refused = await fetch(url);
    assert.equal(refused.status, 403);
    await refused.arrayBuffer();

    const response = await fetch(url, { headers: ORIGIN });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
    const tables = await response.json();
    assert.equal(tables.impacts.length, 3);
    assert.deepEqual(tables.impacts[0], {
      subClass: 7, metal: 1,
      normal: [143, 145, 147, 3263, 3262, 1002, 1001, 3202, 3206, 3210],
      critical: [144, 146, 148, 3263, 3262, 1002, 1001, 3203, 3207, 3210],
    });
    assert.deepEqual(tables.swings[2], { size: 1, critical: false, soundId: 235 });
    assert.deepEqual(tables.swings[3], { size: 1, critical: true, soundId: 236 });
    // Weapons only: the shield's row is in the same table and has nothing to do with a swing.
    assert.deepEqual(tables.swingSizes, [[7, 1], [1, 2], [15, 0]]);
    // The two miss whooshes ride in the payload because `/dbc/sounds?names=` cannot be asked for
    // them: `(DONOTRENAME)Combat Miss 1H` fails its `/^[A-Za-z0-9_]{1,64}$/`.
    assert.deepEqual(tables.miss, { oneHanded: 7080, twoHanded: 7081 });
    assert.equal(tables.items, undefined, "the tables answer carries no item list");

    // `?items=` answers with the items *instead of* the tables: those are held for the session,
    // and repeating 4,671 bytes of them on every batch would be the whole payload again for
    // nothing. An entry `Item.dbc` does not carry is left out rather than answered with a zero.
    const batch = await fetch(`${url}?items=25,2362,999999`, { headers: ORIGIN });
    assert.equal(batch.status, 200);
    const items = await batch.json();
    assert.equal(items.impacts, undefined);
    assert.deepEqual(items.items, [
      { entry: 25, classId: 2, subClass: 7, soundOverrideSubclass: -1, material: 1, sheathe: 3 },
      { entry: 2362, classId: 4, subClass: 6, soundOverrideSubclass: -1, material: 1, sheathe: 4 },
    ]);

    // The batch cap is the one every other batched route has.
    const tooMany = await fetch(`${url}?items=${Array.from({ length: 201 }, (_, at) => at + 1).join(",")}`,
      { headers: ORIGIN });
    assert.equal(tooMany.status, 400);
    await tooMany.arrayBuffer();
  } finally {
    await gateway.close();
    await rm(dbcDirectory, { recursive: true, force: true });
  }
});

test("Н1а the sounds route resolves an area's wind into the kits behind it", withDataset, async () => {
  // Against the real dataset, because this is the one part of the chain that is a join across
  // three tables: `AreaTable.AmbienceID` to `SoundAmbience` to two `SoundEntries` rows, and the
  // kits have to come back in the same reply or the wind arrives a round trip after the zone.
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    dbcDirectory,
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${gateway.port}/dbc/sounds?ambience=35&music=1&creatures=49`,
      { headers: ORIGIN });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.deepEqual(reply.ambience, [{ id: 35, day: 4183, night: 4184 }]);
    const kits = new Map(reply.kits.map((kit) => [kit.id, kit]));
    assert.equal(kits.get(4183)?.name, "ForestNormalDay");
    assert.equal(kits.get(4184)?.name, "ForestNormalNight");
    assert.ok(kits.get(4183).files.length > 0);
    assert.deepEqual(reply.music, [{
      id: 1,
      day: { kit: 2523, silenceMin: 180_000, silenceMax: 300_000 },
      night: { kit: 2523, silenceMin: 180_000, silenceMax: 300_000 },
    }]);
    assert.equal(kits.get(2523)?.name, "Zone-Forest Day",
      "the programme and the kit behind it arrive in the same reply");

    // And the widened creature row, whose critical wound is only useful if its kit came too.
    const [human] = reply.creatures;
    assert.equal(human.id, 49);
    assert.equal(kits.get(human.injuryCritical)?.name, "HumanMalePlayerWoundCrit");
    assert.equal(kits.get(human.exertionCritical)?.name, "HumanMaleCombatExertionCritical");

    // An ambience id nothing has is left out rather than answered with a zero.
    const unknown = await fetch(`http://127.0.0.1:${gateway.port}/dbc/sounds?ambience=999999`,
      { headers: ORIGIN });
    assert.equal(unknown.status, 200);
    assert.deepEqual((await unknown.json()).ambience, []);
  } finally {
    await gateway.close();
  }
});

test("Н1а ten combat events, each naming a row of SoundEntries this client actually has", withDataset, async () => {
  // The acceptance live-plan-2 asked for and could not write, because the tables it needed had no
  // definition: for ten events of one fight, name the `SoundEntries` row the client would choose
  // and fail if the dataset does not carry it. Driven through the real selector and the real
  // tables, so it fails if either the choice or the data moves.
  const sounds = await SoundIndex.load(dbcDirectory);
  const weapons = await WeaponSoundIndex.load(dbcDirectory);
  const tables = weapons.tables();
  const item = (entry) => {
    const found = weapons.item(entry);
    assert.ok(found, `item ${entry} is not in Item.dbc`);
    return found;
  };
  // 25 is the Worn Shortsword: class 2, subclass 7 (Sword1H), material 1 (metal). 2362 is a
  // shield whose material is metal despite being called a wooden one, and 1196 is a two-handed axe.
  const attacker = { weapon: item(25) };
  const defender = { weapon: item(25), offHand: item(2362) };
  const twoHanded = { weapon: item(1196) };
  const named = (id) => {
    const kit = sounds.kit(id);
    assert.ok(kit && kit.files.length > 0, `sound ${id} is not a row with a file in it`);
    return kit.name;
  };
  const swing = (outcome, critical, from = attacker) =>
    named(weaponSoundFor(outcome, critical, from, defender, tables).swing);
  const impact = (outcome, critical, from = attacker) =>
    named(weaponSoundFor(outcome, critical, from, defender, tables).impact);

  // Display 49 is the human male, which is what a player being hit is.
  const human = sounds.creature(49);
  assert.ok(human, "display 49 should have a voice");

  assert.deepEqual([
    ["замах", swing("hit", false)],
    ["попадание", impact("hit", false)],
    ["промах", impact("miss", false)],
    ["крит", impact("hit", true)],
    ["крит-свист", swing("hit", true)],
    ["парирование", impact("parry", false)],
    ["блок", impact("block", false)],
    ["смерть цели", named(human.death)],
    ["аггро", named(human.aggro)],
    ["ранение", named(human.injury)],
  ], [
    ["замах", "MediumWeaponNormal"],
    ["попадание", "Sword1H_ArmorFlesh"],
    ["промах", "(DONOTRENAME)Combat Miss 1H"],
    ["крит", "Sword1H_ArmorFleshCritical"],
    ["крит-свист", "MediumWeaponCritical"],
    ["парирование", "1hParryMetalHitMetal"],
    ["блок", "Shield Metal Impact"],
    ["смерть цели", "HumanMalePlayerDeath"],
    // Not a mistake and not a placeholder: the row the human male's aggro points at is called
    // «New Sound» in this build, and it plays `HumanMaleAggroA.wav`. The name of a row is not the
    // name of the noise, which is exactly why the sound is resolved by id and checked by file.
    ["аггро", "New Sound"],
    ["ранение", "HumanMalePlayerWound"],
  ]);
  assert.match(sounds.kit(human.aggro).files[0], /HumanMaleAggroA\.wav$/);

  // Two-handed misses are a different row, and the whoosh that precedes them a different one again.
  assert.equal(impact("miss", false, twoHanded), "(DONOTRENAME)Combat Miss 2H");
  assert.equal(swing("hit", false, twoHanded), "HeavyWeaponNormal");
  // A dodge is a miss: a search of every `SoundEntries` name for miss, dodge, parry, block, evade
  // or deflect returns 80 rows and not one of them is a dodge.
  assert.equal(impact("dodge", false), "(DONOTRENAME)Combat Miss 1H");
  assert.equal(impact("evade", false), "(DONOTRENAME)Combat Miss 1H");
  assert.equal(impact("deflect", false), "(DONOTRENAME)Combat Miss 1H");
});

test("Н1а the weapon's own material picks the row, and three subclasses borrow another's", withDataset, async () => {
  const weapons = await WeaponSoundIndex.load(dbcDirectory);
  const sounds = await SoundIndex.load(dbcDirectory);
  const tables = weapons.tables();
  const item = (entry) => weapons.item(entry);
  const impactName = (attacker, defender = {}, outcome = "hit", critical = false) => {
    const id = weaponSoundFor(outcome, critical, attacker, defender, tables).impact;
    return sounds.kit(id)?.name;
  };
  const swingName = (attacker, critical = false) =>
    sounds.kit(weaponSoundFor("hit", critical, attacker, {}, tables).swing)?.name;

  // 36 is a wooden mace and 30918 a metal one, and the two rows are the same subclass: the whole
  // point of `ParrySoundType` is that a mace of wood and a mace of steel are different noises.
  assert.equal(impactName({ weapon: item(36) }), "Mace1H_ArmorFlesh");
  assert.equal(impactName({ weapon: item(30918) }), "Mace1HMetal_ArmorFlesh");

  // Crossbow to bow and thrown to dagger, because neither has a row of its own — 158 crossbows and
  // 135 thrown weapons in `Item.dbc` and no `WeaponImpactSounds` row for either.
  assert.equal(impactSubclassOf(item(2551)), 2, "a crossbow lands like a bow");
  assert.equal(impactSubclassOf(item(5856)), 15, "a thrown knife lands like a held one");
  assert.ok(impactName({ weapon: item(2551) }), "and both therefore have a sound");
  assert.ok(impactName({ weapon: item(5856) }));
  // The borrowing is the landing and not the swing. A thrown knife is a one-handed swing in its
  // own `ItemSubClass` row — `WeaponSwingSize` 1 against the dagger's 0 — and there are 135 of
  // them, the only subclass whose whoosh the borrowing would move.
  assert.equal(swingName({ weapon: item(5856) }), "MediumWeaponNormal");
  assert.equal(swingName({ weapon: item(2551) }), "MediumWeaponNormal", "and a crossbow the same");

  // A wand is silent on purpose: 339 of them, and what a player hears is the spell it fires.
  assert.equal(isSilentWeapon(item(4547)), true);
  assert.deepEqual(weaponSoundFor("hit", false, { weapon: item(4547) }, {}, tables), { swing: 0, impact: 0 });

  // `Sound_Override_Subclassid` wins where an item has one: 8177 is a two-handed sword that says
  // it sounds like a staff, and 1,976 of the 46,098 rows carry an override.
  assert.equal(item(8177).subClass, 8);
  assert.equal(item(8177).soundOverrideSubclass, 10);
  assert.equal(impactSubclassOf(item(8177)), 10);
  assert.equal(impactName({ weapon: item(8177) }), impactName({ weapon: { ...item(8177), subClass: 10, soundOverrideSubclass: -1 } }));

  // The defender decides which of the ten slots is heard.
  const sword = { weapon: item(25) };
  assert.equal(impactName(sword, { chest: item(285) }), "Sword1H_ArmorChain");
  assert.equal(impactName(sword, { chest: item(3242) }), "Sword1H_ArmorPlate");
  // Plate says so two ways. 22416 is one of the 274 plate chests whose `Material` is 1, metal,
  // against the 345 that say 6 — and no chest of any other armour subclass carries metal at all,
  // so the metal ones are plate and used to be heard as bare flesh.
  assert.equal(item(22416).material, 1);
  assert.equal(impactName(sword, { chest: item(22416) }), "Sword1H_ArmorPlate");
  assert.equal(impactName(sword, { chest: item(77) }), "Sword1H_ArmorFlesh", "cloth is flesh");
  assert.equal(impactName(sword, {}), "Sword1H_ArmorFlesh", "and so is nothing at all");
  assert.equal(impactName(sword, { impactType: IMPACT_SLOT.chain }), "Sword1H_ArmorChain",
    "a creature says which slot it is in `CreatureImpactType`");
  assert.equal(impactName(sword, { offHand: item(18352) }, "block"), "(DONOTRENAME)ShieldWoodImpact");
  assert.equal(impactName(sword, { offHand: item(2362) }, "block"), "Shield Metal Impact");
  assert.equal(impactName(sword, { weapon: item(36) }, "parry"), "1hParryMetalHitWood");
  assert.equal(impactName(sword, { weapon: item(25) }, "parry"), "1hParryMetalHitMetal");

  // A critical blow whose slot the table leaves empty is heard as an ordinary one rather than as
  // silence. `WeaponImpactSounds` rows 21 and 22 — the dagger, metal weapon and wood — are the two
  // of the 30 with a zero crit beside a sound that exists, and 921 of `Item.dbc`'s weapons land on
  // one of them, so this is a dagger's critical hit parried on a sword.
  assert.equal(tables.impacts.filter((row) => row.subClass === 15).every((row) => row.critical[5] === 0), true);
  assert.equal(weaponSoundFor("parry", true, { weapon: item(776) }, sword, tables).impact, 1002);
  assert.equal(impactName({ weapon: item(776) }, sword, "parry", true), "1hParryMetalHitMetal");

  // Bare hands: the fist row, whose sounds say so, and a medium whoosh rather than the light one
  // `ItemSubClass` gives fist weapons — a bear's paw is not a dagger.
  assert.equal(impactName({}), "Unarmed_Generic");
  assert.equal(impactName({}, { weapon: item(25) }, "parry"), "Unarmed_WeaponMetal");
  assert.equal(swingName({}), "MediumWeaponNormal");
  // And a hand holding something that is not a weapon swings like the hand. The guard is on the
  // item's class and not on whether the hand holds anything, because a subclass number means
  // nothing outside its own class: 6 is a shield among armour and a polearm among weapons, so a
  // shield read as a weapon would whoosh like a two-hander.
  assert.equal(item(2362).classId, 4);
  assert.equal(item(2362).subClass, 6);
  assert.equal(swingSizeOf(tables, 6), 2, "weapon subclass 6 is the polearm");
  assert.equal(swingName({ weapon: item(2362) }), "MediumWeaponNormal");
  assert.equal(swingName({ weapon: item(1131) }), "MediumWeaponNormal");
  assert.equal(impactName({ weapon: item(1131) }), "Unarmed_Generic");
  assert.equal(swingSizeOf(tables, 15), 0, "a dagger is a light swing");
  assert.equal(swingSizeOf(tables, 7), 1);
  assert.equal(swingSizeOf(tables, 1), 2);

  // And with no tables at all — the fetch has not landed yet — silence rather than a guess.
  assert.deepEqual(weaponSoundFor("hit", false, sword, {}, undefined), { swing: 0, impact: 0 });
});

test("Н1а every weapon that can be heard is heard, and the ones that cannot are named", withDataset, async () => {
  // The denominators, pinned so a dataset change is loud rather than quiet. A client that lost the
  // material key would still pass the tests above and fall to the single row of each subclass here.
  const weapons = await WeaponSoundIndex.load(dbcDirectory);
  const tables = weapons.tables();
  const sounds = await SoundIndex.load(dbcDirectory);
  assert.equal(tables.impacts.length, 30);
  assert.equal(tables.swings.length, 6);
  assert.equal(tables.swingSizes.length, 21, "class 2 has 21 subclasses in ItemSubClass");

  // Counted twice over: once on the item's own subclass, which is what the table can answer, and
  // once on the subclass the client asks for after the two borrowings. The first is the state of
  // the data and the second is what a player hears, and they are different numbers.
  const count = (subclassOf) => {
    const tally = { weapons: 0, exact: 0, viaSubclass: 0, noRow: new Map() };
    for (let entry = 1; entry <= 60000; entry++) {
      const item = weapons.item(entry);
      if (!item || item.classId !== 2) continue;
      tally.weapons++;
      const subClass = subclassOf(item);
      const metal = item.material === 1 ? 1 : 0;
      if (tables.impacts.some((row) => row.subClass === subClass && row.metal === metal)) tally.exact++;
      else if (tables.impacts.some((row) => row.subClass === subClass)) tally.viaSubclass++;
      else tally.noRow.set(item.subClass, (tally.noRow.get(item.subClass) ?? 0) + 1);
    }
    return tally;
  };

  const raw = count((item) => (item.soundOverrideSubclass >= 0 ? item.soundOverrideSubclass : item.subClass));
  assert.equal(raw.weapons, 6651, "the active TSWoW Item.dbc holds 6,651 weapons");
  assert.equal(raw.exact, 5755, "and 5,755 of them hit a subclass|material row exactly");
  // The 264 that do not are the four subclasses that ship a single row — Bow, Gun, Exotic,
  // Exotic2 — where the material has nothing to choose between.
  assert.equal(raw.viaSubclass, 264);
  // 632 have no row at all, and they are exactly the three subclasses the client knows about.
  assert.deepEqual([...raw.noRow].sort((left, right) => left[0] - right[0]), [[16, 135], [18, 158], [19, 339]]);

  const asked = count(impactSubclassOf);
  assert.equal(asked.exact, 6026, "a crossbow asking for the bow row hits it exactly");
  assert.equal(asked.viaSubclass, 286);
  // Only the wand is left silent, because only the wand is meant to be.
  assert.deepEqual([...asked.noRow].sort((left, right) => left[0] - right[0]), [[19, 339]]);

  // Every id the two tables name is a row with a file behind it, which is what makes the route
  // safe to hand straight to `/sound`.
  const ids = weapons.soundIds();
  assert.equal(ids.length, 85);
  assert.deepEqual(ids.filter((id) => !sounds.kit(id)?.files.length), []);

  // `SoundType` 6 is the combat whoosh family: the six swings and the two misses, and nothing else
  // in 12,941 rows. That is what makes the miss an id rather than a string match.
  const whooshes = [];
  for (const id of ids) if (sounds.kit(id)?.type === 6) whooshes.push(id);
  assert.deepEqual(whooshes.sort((left, right) => left - right), [233, 234, 235, 236, 237, 238, 7080, 7081]);
});

test("Н1а walking into a zone starts its wind, and the border crossfades it", async () => {
  // The whole path from an area id to a looping kit, with the player's ears and the gateway
  // stubbed: what is being tested is the decision — which row, which half of the clock, and when
  // to stop — not the Web Audio graph, which is the test below this one.
  const { game } = await import("../dist/code/browser/game/Context.js");
  const { forgetZoneSound, updateZoneSound } = await import("../dist/code/browser/game/ZoneSound.js");
  const areas = new Map([
    [12, { id: 12, parentId: 0, ambienceId: 35, zoneMusic: 0, introSound: 0 }],
    // A tavern in the forest: no wind of its own, and it must not fall silent indoors.
    [87, { id: 87, parentId: 12, ambienceId: 0, zoneMusic: 0, introSound: 0 }],
    [1519, { id: 1519, parentId: 0, ambienceId: 0, zoneMusic: 0, introSound: 0 }],
  ]);
  const kit = (id) => ({ id, type: 50, name: `kit${id}`, files: [`${id}.wav`], volume: 1, minDistance: 8, maxDistance: 45, flags: 0 });
  const asked = [];
  const done = [];
  const previous = { sound: game.sound, soundKits: game.soundKits, areas: game.areas };
  game.areas = { area: (id) => areas.get(id) };
  game.soundKits = {
    ambience: (id) => (id === 35 ? { day: 4183, night: 4184 } : undefined),
    kit: (id) => { asked.push(id); return kit(id); },
    zoneMusic: () => undefined,
    zoneIntro: () => undefined,
  };
  const sound = {
    playingAmbience: undefined,
    playingMusic: undefined,
    playAmbience(which) { done.push(`play ${which.id}`); this.playingAmbience = which.id; },
    stopAmbience() { done.push("stop"); this.playingAmbience = undefined; },
    play() { done.push("music"); },
    stopMusic() { done.push("stop music"); },
  };
  game.sound = sound;
  try {
    // The reset itself silences whatever the last realm was playing, so the watch starts after it.
    forgetZoneSound();
    done.length = 0;
    updateZoneSound(10_000, 12 * 60, 12);
    assert.deepEqual(done, ["play 4183"], "midday in Elwynn is the day kit");

    // Two looks less than the interval apart are one look: the zone is walked every two seconds.
    updateZoneSound(10_500, 12 * 60, 1519);
    assert.deepEqual(done, ["play 4183"]);

    // Into the tavern: the same wind, inherited, and therefore no second start.
    updateZoneSound(12_001, 12 * 60, 87);
    assert.deepEqual(done, ["play 4183"]);

    // Night falls, and the row's other slot is a different kit.
    updateZoneSound(14_002, 22 * 60, 87);
    assert.deepEqual(done, ["play 4183", "play 4184"]);

    // A zone that names no wind and inherits none is silence, not the forest following the player.
    updateZoneSound(16_003, 22 * 60, 1519);
    assert.deepEqual(done, ["play 4183", "play 4184", "stop"]);
    // And staying there does not stop it again every two seconds.
    updateZoneSound(18_004, 22 * 60, 1519);
    assert.deepEqual(done.length, 3);

    // And a border is not the only way out of a zone. A teleport is the case the walk above cannot
    // catch: the wind is running, the module is reset, and the map on the other side is an
    // instance that names no ambience at all — 86 of the 2,307 areas end the parent walk with
    // none, and they are mostly dungeons. The forest used to keep looping over them.
    updateZoneSound(20_005, 12 * 60, 12);
    assert.deepEqual(done.slice(3), ["play 4183"], "back outdoors, and the wind is back");
    forgetZoneSound();
    assert.deepEqual(done.slice(3), ["play 4183", "stop"], "and a teleport takes it with it");
    assert.equal(sound.playingAmbience, undefined);
    // Nothing left to stop on the other side, however long the player stands in the dungeon.
    updateZoneSound(22_006, 12 * 60, 1519);
    updateZoneSound(24_007, 12 * 60, 1519);
    assert.deepEqual(done.length, 5);
  } finally {
    forgetZoneSound();
    game.sound = previous.sound;
    game.soundKits = previous.soundKits;
    game.areas = previous.areas;
  }
});

test("zone music is one-shot, does not duplicate a slow start, and waits its silence", () => {
  const previous = { sound: game.sound, soundKits: game.soundKits, areas: game.areas };
  const areas = new Map([
    [12, { id: 12, parentId: 0, ambienceId: 0, zoneMusic: 1, introSound: 0 }],
    [1519, { id: 1519, parentId: 0, ambienceId: 0, zoneMusic: 0, introSound: 0 }],
  ]);
  const soundKit = (id) => ({
    id, type: 28, name: `kit${id}`, files: [`${id}-a.mp3`, `${id}-b.mp3`],
    volume: 1, minDistance: 8, maxDistance: 45, flags: 0,
  });
  const plays = [];
  let stops = 0;
  const sound = {
    playingAmbience: undefined,
    playingMusic: undefined,
    play(kit, options) {
      plays.push({ kit, options });
      // SoundPlayer exposes a wanted kit before its slow fetch/decode lands.
      this.playingMusic = kit.id;
    },
    stopMusic() { stops++; this.playingMusic = undefined; },
    stopAmbience() { this.playingAmbience = undefined; },
    playAmbience() {},
  };
  game.areas = { area: (id) => areas.get(id) };
  game.soundKits = {
    ambience: () => undefined,
    zoneMusic: (id) => id === 1 ? {
      day: { kit: 2523, silenceMin: 4_000, silenceMax: 8_000 },
      night: { kit: 2523, silenceMin: 4_000, silenceMax: 8_000 },
    } : undefined,
    zoneIntro: () => undefined,
    zoneIntroAnswered: () => true,
    kitAnswered: () => true,
    kit: soundKit,
  };
  game.sound = sound;
  const originalRandom = Math.random;
  try {
    forgetZoneSound();
    plays.length = 0;
    stops = 0;

    updateZoneSound(10_000, 12 * 60, 12);
    assert.equal(plays.length, 1);
    assert.equal(plays[0].kit.id, 2523);
    assert.notEqual(plays[0].options.loop, true, "a complete track is never a looping source");
    assert.equal(plays[0].options.guard(), true);

    // These are the polls that used to enqueue another random file while the first was decoding.
    updateZoneSound(12_001, 12 * 60, 12);
    updateZoneSound(14_002, 12 * 60, 12);
    assert.equal(plays.length, 1, "one wanted track includes its fetch/decode time");

    Math.random = () => 0.5;
    sound.playingMusic = undefined;
    plays[0].options.onEnded();
    // The first look after the end anchors the authored six-second silence.
    updateZoneSound(16_003, 12 * 60, 12);
    updateZoneSound(18_004, 12 * 60, 12);
    updateZoneSound(20_005, 12 * 60, 12);
    assert.equal(plays.length, 1);
    updateZoneSound(22_006, 12 * 60, 12);
    assert.equal(plays.length, 2, "a fresh random draw starts only after the silence deadline");

    const stale = plays[1].options;
    updateZoneSound(24_007, 12 * 60, 1519);
    assert.ok(stops > 0, "a zone with no programme cancels the old wanted decode/source");
    assert.equal(stale.guard(), false);
    stale.onEnded();
    stale.onFailed();
    updateZoneSound(26_008, 12 * 60, 1519);
    assert.equal(plays.length, 2, "a stale completion cannot schedule the departed zone again");
  } finally {
    Math.random = originalRandom;
    forgetZoneSound();
    game.sound = previous.sound;
    game.soundKits = previous.soundKits;
    game.areas = previous.areas;
  }
});

test("a cold-cache zone intro owns music until it ends, and stale intro callbacks are guarded", () => {
  const previous = { sound: game.sound, soundKits: game.soundKits, areas: game.areas };
  const areas = new Map([
    [12, { id: 12, parentId: 0, ambienceId: 0, zoneMusic: 1, introSound: 7 }],
    [87, { id: 87, parentId: 12, ambienceId: 0, zoneMusic: 0, introSound: 0 }],
  ]);
  const soundKit = (id) => ({
    id, type: id === 700 ? 16 : 28, name: `kit${id}`, files: [`${id}.mp3`],
    volume: 1, minDistance: 8, maxDistance: 45, flags: 0,
  });
  let introAnswered = false;
  const plays = [];
  const sound = {
    playingAmbience: undefined,
    playingMusic: undefined,
    play(kit, options) { plays.push({ kit, options }); this.playingMusic = kit.id; },
    stopMusic() { this.playingMusic = undefined; },
    stopAmbience() { this.playingAmbience = undefined; },
    playAmbience() {},
  };
  game.areas = { area: (id) => areas.get(id) };
  game.soundKits = {
    ambience: () => undefined,
    zoneMusic: () => ({
      day: { kit: 2523, silenceMin: 180_000, silenceMax: 300_000 },
      night: { kit: 2523, silenceMin: 180_000, silenceMax: 300_000 },
    }),
    zoneIntro: () => introAnswered ? 700 : undefined,
    zoneIntroAnswered: () => introAnswered,
    kitAnswered: () => true,
    kit: soundKit,
  };
  game.sound = sound;
  try {
    forgetZoneSound();
    plays.length = 0;

    updateZoneSound(10_000, 12 * 60, 12);
    assert.deepEqual(plays, [], "the zone track waits while its authored intro metadata is in flight");
    introAnswered = true;
    updateZoneSound(12_001, 12 * 60, 12);
    assert.deepEqual(plays.map((entry) => entry.kit.id), [700]);
    updateZoneSound(14_002, 12 * 60, 12);
    assert.equal(plays.length, 1, "polling does not duplicate an intro decode");

    sound.playingMusic = undefined;
    plays[0].options.onEnded();
    updateZoneSound(16_003, 12 * 60, 12);
    assert.deepEqual(plays.map((entry) => entry.kit.id), [700, 2523],
      "the zone programme starts only after the sting naturally ends");

    // Re-enter, start another sting, then leave for an inheriting sub-area before its decode/end.
    updateZoneSound(18_004, 12 * 60, 87);
    updateZoneSound(20_005, 12 * 60, 12);
    const staleIntro = plays.at(-1).options;
    assert.equal(plays.at(-1).kit.id, 700);
    updateZoneSound(22_006, 12 * 60, 87);
    assert.equal(staleIntro.guard(), false);
    const countAfterLeaving = plays.length;
    staleIntro.onEnded();
    staleIntro.onFailed();
    updateZoneSound(24_007, 12 * 60, 87);
    assert.equal(plays.length, countAfterLeaving,
      "completion from the area left behind cannot start a second zone track");
  } finally {
    forgetZoneSound();
    game.sound = previous.sound;
    game.soundKits = previous.soundKits;
    game.areas = previous.areas;
  }
});

test("Н1а one ambience loop fades into the next rather than cutting to it", async () => {
  // A zone border is a line on a map and not a door. What this pins is that the second loop starts
  // at zero and climbs, the first is ridden down and *stopped* — a fade that leaves the old source
  // running is a client that accumulates one loop per zone for the length of the session.
  const { SoundPlayer } = await import("../dist/code/browser/Sound.js");
  const nodes = [];
  const param = (owner) => ({
    value: 0,
    setValueAtTime(value) { this.value = value; owner.calls.push(["set", value]); },
    linearRampToValueAtTime(value, at) { this.value = value; owner.calls.push(["ramp", value, at]); },
    cancelScheduledValues() { owner.calls.push(["cancel"]); },
  });
  class FakeContext {
    currentTime = 100;
    state = "running";
    destination = { kind: "destination" };
    createGain() {
      const node = { kind: "gain", calls: [], connect: (to) => to };
      node.gain = param(node);
      nodes.push(node);
      return node;
    }
    createBufferSource() {
      const node = { kind: "source", calls: [], connect: (to) => to, addEventListener() {} };
      node.start = (...args) => node.calls.push(["start", ...args]);
      node.stop = (...args) => node.calls.push(["stop", ...args]);
      nodes.push(node);
      return node;
    }
    createPanner() { return { connect: (to) => to }; }
    async decodeAudioData() { return { kind: "buffer" }; }
    async resume() {}
    async close() {}
  }
  const originalContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  globalThis.AudioContext = FakeContext;
  globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const kit = (id) => ({ id, type: 50, name: `kit${id}`, files: [`${id}.wav`], volume: 0.8, minDistance: 8, maxDistance: 45, flags: 0 });
  try {
    const player = new SoundPlayer("ws://127.0.0.1:8090/auth");
    player.playAmbience(kit(4183));
    // Asked for twice before the first fetch lands, which is what a two-second poll does: the
    // second call must not start a second loop of the same kit.
    player.playAmbience(kit(4183));
    await settle();
    assert.equal(player.playingAmbience, 4183);
    const sources = () => nodes.filter((node) => node.kind === "source");
    const gains = () => nodes.filter((node) => node.kind === "gain" && node.calls.length > 0);
    assert.equal(sources().length, 1, "one loop, not two");
    assert.equal(sources()[0].loop, true, "the environmental ambience remains a real loop");
    assert.deepEqual(sources()[0].calls, [["start"]]);
    assert.deepEqual(gains()[0].calls, [["set", 0], ["ramp", 0.8, 102]], "in from silence over two seconds");

    player.playAmbience(kit(4184));
    await settle();
    assert.equal(player.playingAmbience, 4184);
    assert.equal(sources().length, 2);
    // The first is ridden down from wherever its ramp had got to and stopped at the bottom of it.
    assert.deepEqual(gains()[0].calls.slice(2), [["cancel"], ["set", 0.8], ["ramp", 0, 102]]);
    assert.deepEqual(sources()[0].calls, [["start"], ["stop", 102]]);
    assert.deepEqual(sources()[1].calls, [["start"]]);

    player.stopAmbience();
    assert.equal(player.playingAmbience, undefined);
    assert.deepEqual(sources()[1].calls, [["start"], ["stop", 102]]);

    // A loop that does not arrive is not the zone's last word. `playingAmbience` is what the zone
    // walk compares against and what `playAmbience` refuses a repeat on, so a failed fetch that
    // left it set would leave the zone silent until the player walked out of it and back in.
    player.onStatus = () => {};
    globalThis.fetch = async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) });
    player.playAmbience(kit(4185));
    assert.equal(player.playingAmbience, 4185, "asked for");
    await settle();
    assert.equal(player.playingAmbience, undefined, "and let go of, so the next poll asks again");
    assert.equal(sources().length, 2, "and nothing was started");
  } finally {
    globalThis.AudioContext = originalContext;
    globalThis.fetch = originalFetch;
  }
});

test("music generation ignores an old end and a guarded stale decode", async () => {
  const { SoundPlayer } = await import("../dist/code/browser/Sound.js");
  const sources = [];
  class FakeContext {
    state = "running";
    destination = {};
    listener = {};
    createGain() { return { gain: { value: 0 }, connect: (to) => to }; }
    createPanner() { return { connect: (to) => to }; }
    createBufferSource() {
      const listeners = [];
      const source = {
        loop: false,
        connect: (to) => to,
        start() { this.started = true; },
        stop() { this.stopped = true; },
        addEventListener(name, callback) { if (name === "ended") listeners.push(callback); },
        end() { for (const callback of listeners) callback(); },
      };
      sources.push(source);
      return source;
    }
    async decodeAudioData() { return {}; }
    async resume() {}
    async close() {}
  }
  const originalContext = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  const deferred = new Map();
  const response = { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  globalThis.AudioContext = FakeContext;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).searchParams.get("path");
    if (path === "a.mp3") return response;
    return await new Promise((resolve) => deferred.set(path, () => resolve(response)));
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const kit = { id: 10, type: 28, name: "zone", files: ["a.mp3", "b.mp3"], volume: 1,
    minDistance: 8, maxDistance: 45, flags: 0 };
  let oldEnds = 0;
  let newEnds = 0;
  try {
    const player = new SoundPlayer("ws://127.0.0.1:8090/auth");
    Math.random = () => 0;
    player.play(kit, { channel: "music", onEnded: () => oldEnds++ });
    await settle();
    assert.equal(sources.length, 1);

    // A second request for the same kit chooses another file and remains in decode. The old source
    // may naturally end in that window, but it no longer owns the programme generation.
    Math.random = () => 0.99;
    player.play(kit, { channel: "music", onEnded: () => newEnds++ });
    assert.equal(player.playingMusic, 10);
    sources[0].end();
    assert.equal(oldEnds, 0);
    assert.equal(player.playingMusic, 10, "old ended cannot clear the newer wanted request");
    deferred.get("b.mp3")();
    await settle();
    assert.equal(sources.length, 2);
    assert.equal(sources[1].started, true);

    // A lifecycle guard can expire after fetch begins. Its decode is discarded and, because it is
    // still the newest generation, its wanted marker is released instead of hanging forever.
    let alive = true;
    const stale = { ...kit, id: 11, files: ["c.mp3"] };
    Math.random = () => 0;
    player.play(stale, { channel: "music", guard: () => alive });
    assert.equal(player.playingMusic, 11);
    alive = false;
    deferred.get("c.mp3")();
    await settle();
    assert.equal(sources.length, 2, "a stale decode creates no source");
    assert.equal(player.playingMusic, undefined);
    assert.equal(newEnds, 0);
    player.close();
  } finally {
    Math.random = originalRandom;
    globalThis.AudioContext = originalContext;
    globalThis.fetch = originalFetch;
  }
});

test("Н1а the client fetches the weapon tables once and the items a batch at a time", async () => {
  // Against a stubbed `fetch` rather than the gateway, as the area client's test is: Node sends no
  // `Origin` header and the gateway refuses a request without one. What is worth testing here is
  // the batching — one request for everything asked for in a frame, and nothing asked for twice.
  const { SoundClient } = await import("../dist/code/browser/SoundClient.js");
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url).replace("http://127.0.0.1:8090", ""));
    const query = new URL(String(url)).searchParams;
    if (query.has("items")) {
      const entries = query.get("items").split(",").map(Number);
      return {
        ok: true, status: 200,
        // 999999 is not in `Item.dbc`; the reply is shorter rather than padded with a zero.
        json: async () => ({ items: entries.filter((entry) => entry !== 999999)
          .map((entry) => ({ entry, classId: 2, subClass: 7, soundOverrideSubclass: -1, material: 1, sheathe: 3 })) }),
      };
    }
    if (query.has("ambience") || query.has("music")) {
      return { ok: true, status: 200, json: async () => ({
        kits: [],
        music: [{
          id: 1,
          day: { kit: 2523, silenceMin: 180_000, silenceMax: 300_000 },
          night: { kit: 2523, silenceMin: 180_000, silenceMax: 300_000 },
        }],
        ambience: [{ id: 35, day: 4183, night: 4184 }],
      }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ impacts: [], swings: [], swingSizes: [], miss: { oneHanded: 7080, twoHanded: 7081 } }),
    };
  };
  try {
    const client = new SoundClient("ws://127.0.0.1:8090/auth");
    const loaded = new Promise((resolve) => { client.onLoaded = resolve; });
    client.loadWeaponSounds();
    client.loadWeaponSounds(); // Idempotent: the tables are fetched once for the session.
    await loaded;
    // `v` is the cache-buster: both routes are held for an hour and both are asked for by a URL
    // that recurs across sessions, so a reply whose shape changes needs the URL to change with it.
    assert.deepEqual(asked, ["/dbc/weapon-sounds?v=1"]);
    assert.deepEqual(client.weaponSounds().miss, { oneHanded: 7080, twoHanded: 7081 });

    // Three entries asked for in one turn are one request, and an answer is not asked for again.
    assert.equal(client.itemSound(25), undefined);
    assert.equal(client.itemSound(36), undefined);
    assert.equal(client.itemSound(999999), undefined);
    // Н1б: not yet an answer, which is what makes a swing wait for it instead of throwing a fist.
    assert.equal(client.itemAnswered(25), false);
    assert.equal(client.itemAnswered(0), true, "an empty hand needs no waiting for");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(asked.slice(1), ["/dbc/weapon-sounds?v=1&items=25,36,999999"]);
    assert.equal(client.itemSound(25)?.material, 1);
    // An entry the table does not carry is remembered as absent, or it is asked for on every swing
    // for the rest of the session.
    assert.equal(client.itemSound(999999), undefined);
    // And «absent» has to read as an answer, or every swing with that item in it waits 800 ms for
    // a row that is never coming — which for a realm's own weapon is every swing of the session.
    assert.equal(client.itemAnswered(25), true);
    assert.equal(client.itemAnswered(999999), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(asked.length, 2);

    // Ambience and the complete zone-music programme share one batch.
    assert.equal(client.zoneMusic(1), undefined);
    assert.equal(client.ambience(35), undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(asked.slice(2), ["/dbc/sounds?v=3&music=1&ambience=35"]);
    assert.deepEqual(client.zoneMusic(1), {
      day: { kit: 2523, silenceMin: 180_000, silenceMax: 300_000 },
      night: { kit: 2523, silenceMin: 180_000, silenceMax: 300_000 },
    });
    assert.deepEqual(client.ambience(35), { day: 4183, night: 4184 });
    assert.equal(asked.length, 3, "and the answer is not asked for twice");
  } finally {
    globalThis.fetch = original;
  }
});

test("Н1а a sub-area with no wind of its own borrows the zone's", () => {
  // The same walk the music does, and for a stronger reason: only 445 of the 2,307 areas carry an
  // `AmbienceID`, so a client that did not inherit would be silent nearly everywhere.
  const parents = new Map([[87, 12], [12, 0]]);
  const ambience = new Map([[87, 0], [12, 35]]);
  const walk = (areaId) => zoneAmbienceOf(areaId, (id) => parents.get(id), (id) => ambience.get(id) ?? 0);
  assert.equal(walk(87), 35);
  assert.equal(walk(12), 35);
  assert.equal(walk(4242), 0, "an area nothing knows about is silence, not a guess");

  const looped = new Map([[1, 2], [2, 1]]);
  assert.equal(zoneAmbienceOf(1, (id) => looped.get(id), () => 0), 0);
});

test("Н1а the zones that name a wind all have one, day and night", withDataset, async () => {
  const sounds = await SoundIndex.load(dbcDirectory);
  const { loadAreaData } = await import("../dist/code/gateway/AreaMetadata.js");
  const areas = await loadAreaData(dbcDirectory);
  assert.equal(areas.areas.length, 2307);
  const carrying = areas.areas.filter((area) => area.ambienceId > 0);
  assert.equal(carrying.length, 445);
  const distinct = new Set(carrying.map((area) => area.ambienceId));
  assert.equal(distinct.size, 86);

  // Not one of the 86 is missing from `SoundAmbience`, and every kit either slot names is a row
  // with a file: the chain is resolvable end to end without the network.
  const missing = [];
  const silent = [];
  for (const id of distinct) {
    const row = sounds.ambience(id);
    if (!row) {
      missing.push(id);
      continue;
    }
    for (const kit of [row.day, row.night]) if (!sounds.kit(kit)?.files.length) silent.push(kit);
  }
  assert.deepEqual(missing, []);
  assert.deepEqual(silent, []);

  // Elwynn Forest, in the terms a player would recognise them.
  const elwynn = areas.areas.find((area) => area.id === 12);
  assert.equal(elwynn.ambienceId, 35);
  const forest = sounds.ambience(35);
  assert.equal(sounds.kit(forest.day).name, "ForestNormalDay");
  assert.equal(sounds.kit(forest.night).name, "ForestNormalNight");
  assert.notEqual(forest.day, forest.night, "the wind is not the same after dark");
  // And the ambience column is not the music column: Elwynn's music row is a different number.
  assert.notEqual(elwynn.ambienceId, elwynn.zoneMusic);
});

test("Н1а a creature's whole voice comes back, and every id in it resolves", withDataset, async () => {
  // The gateway read four of `CreatureSoundData`'s 38 columns. `injuryCritical` alone doubles what
  // a player hears in a fight, and it costs four bytes on a row that was already being sent.
  const sounds = await SoundIndex.load(dbcDirectory);
  const human = sounds.creature(49);
  assert.equal(sounds.kit(human.injuryCritical)?.name, "HumanMalePlayerWoundCrit");
  assert.equal(sounds.kit(human.exertionCritical)?.name, "HumanMaleCombatExertionCritical");
  assert.equal(human.impactType, 0, "a human is flesh, which is slot 0");
  assert.deepEqual(human.fidget, [], "and the column is only carried where it is filled");

  // Every id `creatureSoundIds` reports is one the route resolves into a kit, which is what stops
  // the first critical hit on a kind of creature from being silent.
  let rows = 0;
  const unresolved = [];
  // The highest display id in this dataset is 32,754, and 24,220 of them have a voice.
  for (let display = 1; display <= 40000; display++) {
    const row = sounds.creature(display);
    if (!row) continue;
    rows++;
    for (const id of SoundIndex.creatureSoundIds(row)) if (!sounds.kit(id)) unresolved.push(id);
  }
  assert.ok(rows > 24000, `expected effectively every display to have a voice, got ${rows}`);
  // Not «they all happen to resolve»: three of the ids `CreatureSoundData` names are not in
  // `SoundEntries` at all on this dataset, and the index reports them as no sound rather than as
  // an id whose only possible outcome is a failed request on every swing.
  assert.deepEqual([...new Set(unresolved)], []);

  // The interface's own list rides along: three of the four names `GameSounds.ts` reached for
  // first are absent from `SoundEntries.Name`, and `UISoundLookups` spells two of them.
  assert.equal(sounds.named("CURSORGRABOBJECT"), 902);
  assert.equal(sounds.named("CURSORDROPOBJECT"), 903);
  // `SoundEntries` still wins where both name the same thing.
  assert.equal(sounds.named("LEVELUP"), 888);
  // And a name whose row has no file at all is not registered: 887 is `GAMEERRORINVALIDTARGET`
  // in `UISoundLookups` and names nothing playable in this build, so the client is told «no» once
  // rather than handed an id that can only fail.
  assert.equal(sounds.kit(887), undefined);
  assert.equal(sounds.named("GAMEERRORINVALIDTARGET"), undefined);
});

// ---------------------------------------------------------------------------------------------
// Н1б — the swing itself: what a blow sounds like, and the one death nothing on the wire says.
// ---------------------------------------------------------------------------------------------

/**
 * The three weapon tables, written so that an id says which slot it came from.
 *
 * Synthetic rather than the dataset's, and deliberately: what is under test here is the wiring
 * between `SMSG_ATTACKERSTATEUPDATE` and the play queue, and a test that needs `Item.dbc` on the
 * machine is a test that does not run on a machine without it. The shape is the real one — ten
 * slots per row, an ordinary array and a critical one, six whooshes and two miss ids — and the
 * choice inside `weaponSoundFor` is checked against the real tables by the Н1а tests above.
 */
function fakeWeaponTables() {
  const row = (subClass, metal, base) => ({
    subClass,
    metal,
    normal: Array.from({ length: 10 }, (_, slot) => base + slot),
    critical: Array.from({ length: 10 }, (_, slot) => base + 1000 + slot),
  });
  return {
    // 7 Sword1H metal, 8 Sword2H metal, 13 Unarmed, 15 Dagger wooden.
    impacts: [row(7, 1, 1000), row(8, 1, 1800), row(13, 0, 1300), row(15, 0, 1500)],
    swings: [
      { size: 0, critical: false, soundId: 233 }, { size: 0, critical: true, soundId: 234 },
      { size: 1, critical: false, soundId: 235 }, { size: 1, critical: true, soundId: 236 },
      { size: 2, critical: false, soundId: 237 }, { size: 2, critical: true, soundId: 238 },
    ],
    swingSizes: [[7, 1], [8, 2], [13, 0], [15, 0], [19, 1]],
    miss: { oneHanded: 7080, twoHanded: 7081 },
  };
}

/** What `Item.dbc` would say about the handful of things these fighters are carrying. */
const COMBAT_ITEMS = {
  25: { entry: 25, classId: 2, subClass: 7, soundOverrideSubclass: -1, material: 1, sheathe: 3 },
  30: { entry: 30, classId: 2, subClass: 15, soundOverrideSubclass: -1, material: 2, sheathe: 2 },
  40: { entry: 40, classId: 2, subClass: 19, soundOverrideSubclass: -1, material: 1, sheathe: 0 },
  50: { entry: 50, classId: 2, subClass: 8, soundOverrideSubclass: -1, material: 1, sheathe: 1 },
  60: { entry: 60, classId: 4, subClass: 6, soundOverrideSubclass: -1, material: 1, sheathe: 0 },
  61: { entry: 61, classId: 4, subClass: 6, soundOverrideSubclass: -1, material: 2, sheathe: 0 },
  70: { entry: 70, classId: 4, subClass: 4, soundOverrideSubclass: -1, material: 6, sheathe: 0 },
  71: { entry: 71, classId: 4, subClass: 3, soundOverrideSubclass: -1, material: 5, sheathe: 0 },
  80: { entry: 80, classId: 2, subClass: 4, soundOverrideSubclass: -1, material: 2, sheathe: 3 },
};

/** The human male's own row, which is what a player being hit sounds like. */
const HUMAN_MALE = {
  id: 49, aggro: 1263, injury: 2942, injuryCritical: 2943, death: 2944, exertion: 2941,
  exertionCritical: 0, alert: 0, loop: 0, fidget: [], jumpStart: 0, jumpEnd: 0, birth: 0,
  impactType: 0,
};

/** One unit standing in the world, wearing what it is told to wear. */
function combatUnit(guid, {
  typeId = 4, displayId = 49, main = 0, off = 0, chest = 0, health = 100, x = 0,
} = {}) {
  const fields = new Map();
  fields.set(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, displayId);
  fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health);
  if (typeId === 4) {
    // The nineteen `PLAYER_VISIBLE_ITEM_N_ENTRYID` words, two apart, indexed by `EQUIPMENT_SLOT_*`.
    const first = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
    const stride = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - first;
    if (main) fields.set(first + 15 * stride, main);
    if (off) fields.set(first + 16 * stride, off);
    if (chest) fields.set(first + 4 * stride, chest);
  } else {
    // A creature's three `UNIT_VIRTUAL_ITEM_SLOT_ID` words, which nothing in this client read
    // before this slice. Main hand, off hand, ranged — item entries, in 3.3.5.
    if (main) fields.set(UPDATE_FIELDS.UNIT_VIRTUAL_ITEM_SLOT_ID.offset, main);
    if (off) fields.set(UPDATE_FIELDS.UNIT_VIRTUAL_ITEM_SLOT_ID.offset + 1, off);
  }
  return { guid, typeId, position: { x, y: 0, z: 0, orientation: 0 }, fields };
}

/** A world with ears in it: the play queue is the list of `SoundEntries` ids that reached them. */
function combatWorld(units, { creatures = {}, tables = fakeWeaponTables(), answered = true } = {}) {
  const played = [];
  /** Where each of those was heard from, so «the whoosh is at the arm» is a fact and not a comment. */
  const from = [];
  const previous = { world: game.world, sound: game.sound, soundKits: game.soundKits };
  const objects = new Map(units.map((unit) => [unit.guid, unit]));
  const state = { objects, selfGuid: units[0]?.guid };
  // What `Item.dbc` has been asked about, and whether the batch carrying it has come back. The two
  // are separate on purpose, and nothing here can be answered that was not first asked for: the
  // defect this fake exists to catch is a swing that waits for the answer to a question nobody put.
  // `answered: true` is a gateway that replies the instant it is asked, which is what the outcome
  // tables below want; the wait test flips it by hand.
  const held = { answered, asked: new Set() };
  game.world = { state };
  game.soundKits = {
    weaponSounds: () => tables,
    itemSound: (entry) => {
      if (entry > 0) held.asked.add(entry);
      return held.answered && held.asked.has(entry) ? COMBAT_ITEMS[entry] : undefined;
    },
    itemAnswered: (entry) => entry <= 0 || (held.answered && held.asked.has(entry)),
    creatureSounds: (displayId) => creatures[displayId],
    kit: (id) => ({
      id, type: 6, name: `kit${id}`, files: [`${id}.wav`], volume: 1, minDistance: 8,
      maxDistance: 45, flags: 0,
    }),
  };
  game.sound = {
    play(kit, options) {
      played.push(kit.id);
      from.push(options?.at?.x);
    },
  };
  forgetGameSounds();
  forgetCombatSounds();
  return {
    played,
    from,
    state,
    held,
    /** Clears the queue and every cooldown, so each case is judged on its own. */
    fresh() {
      forgetGameSounds();
      played.length = 0;
      from.length = 0;
    },
    restore() {
      forgetGameSounds();
      forgetCombatSounds();
      game.world = previous.world;
      game.sound = previous.sound;
      game.soundKits = previous.soundKits;
    },
  };
}

test("creature exertion guard survives deferred metadata and reaches async sound playback", async () => {
  const creatures = {};
  const world = combatWorld([combatUnit(1n)], { creatures });
  let alive = true;
  const guard = () => alive;
  try {
    playCreatureSound(1n, "exertion", guard);
    alive = false;
    retryPendingSounds();
    assert.deepEqual(world.played, [], "a failed-world guard drops a deferred creature lookup");

    alive = true;
    creatures[49] = HUMAN_MALE;
    const pendingSoundOptions = [];
    game.sound.play = (_kit, options) => pendingSoundOptions.push(options);
    playCreatureSound(1n, "exertion", guard);
    assert.equal(pendingSoundOptions.length, 1);
    assert.equal(pendingSoundOptions[0].guard, guard);
    alive = false;
    assert.equal(pendingSoundOptions[0].guard(), false,
      "the callback handed to the sound player rejects a late async decode");
  } finally {
    world.restore();
  }
  const soundSource = await readFile(new URL("../src/browser/Sound.ts", import.meta.url), "utf8");
  assert.ok((soundSource.match(/if \(options\.guard && !options\.guard\(\)\)/g) ?? []).length >= 2,
    "SoundPlayer checks lifecycle guard before fetch and after async decode");
});

const swingOf = ({
  hitInfo = 0, victimState = VICTIMSTATE_HIT, damage = 10, attacker = 1n, victim = 2n,
} = {}) =>
  ({ hitInfo, attacker, victim, damage, overkill: 0, victimState, blocked: 0, damages: [] });

test("Н1б every outcome of a swing reaches the queue as the row the tables name for it", () => {
  // The ten events of Н1а's acceptance, driven this time through the packet rather than through
  // the selector: `hitInfo` and `victimState` in, a whoosh at the attacker and a landing at the
  // defender out. 1 holds a metal one-handed sword and a wooden dagger and wears chain, 2 wears
  // plate and holds a wooden mace behind a metal shield, 3 wears chain, 4 wears nothing, 5 swings a
  // two-hander and 6 hides behind a wooden shield.
  const world = combatWorld([
    combatUnit(1n, { main: 25, off: 30, chest: 71 }),
    combatUnit(2n, { main: 80, off: 60, chest: 70 }),
    combatUnit(3n, { chest: 71 }),
    combatUnit(4n, { x: 7 }),
    combatUnit(5n, { main: 50 }),
    combatUnit(6n, { off: 61, chest: 70 }),
  ]);
  const swing = (extra) => {
    world.fresh();
    playSwingSounds(swingOf(extra));
    return [...world.played];
  };
  try {
    assert.deepEqual(swing({}), [235, 1002], "one-handed whoosh, and a sword into plate");
    // And exactly those four rows were asked of `Item.dbc`: the hand the blow came from, and the
    // defender's weapon, shield and breastplate — the three things an outcome can land on. Neither
    // the attacker's own chain shirt (71) nor the dagger in their other hand (30) is here, because
    // no outcome reads either: a row fetched on every swing to be thrown away is a row too many.
    assert.deepEqual([...world.held.asked].sort((one, other) => one - other), [25, 60, 70, 80]);
    assert.deepEqual(swing({ victim: 3n }), [235, 1001], "the same sword into chain");
    assert.deepEqual(swing({ victim: 4n }), [235, 1000], "and into a man wearing nothing");
    // The two halves come from the two ends of the blow: the arm swings where the attacker stands
    // and the landing happens seven yards away, where the man being hit is.
    assert.deepEqual(world.from, [0, 7]);
    assert.deepEqual(swing({ hitInfo: HITINFO_CRITICAL }), [236, 2002],
      "a critical blow takes the critical whoosh and the critical array");

    // The four ways a swing arrives at nothing at all. There is no dodge sound in `SoundEntries`
    // and never was: all four play the miss whoosh for the size of the weapon that missed.
    assert.deepEqual(swing({ hitInfo: HITINFO_MISS, damage: 0, victimState: 0 }), [235, 7080]);
    assert.deepEqual(swing({ victimState: VICTIMSTATE_DODGE, damage: 0 }), [235, 7080]);
    assert.deepEqual(swing({ victimState: VICTIMSTATE_EVADES, damage: 0 }), [235, 7080]);
    assert.deepEqual(swing({ victimState: VICTIMSTATE_DEFLECTS, damage: 0 }), [235, 7080]);
    // `VICTIMSTATE_IMMUNE` is not in the plan's list of seven and is the only other state that
    // produces no damage whatever, so it goes past rather than landing on flesh.
    assert.deepEqual(swing({ victimState: VICTIMSTATE_IMMUNE, damage: 0 }), [235, 7080]);

    // Parried on the defender's own weapon: wood, so the wooden-weapon slot rather than the metal.
    assert.deepEqual(swing({ victimState: VICTIMSTATE_PARRY, damage: 0 }), [235, 1006]);
    // Blocked on a shield, and which shield decides between two slots and not two rows.
    assert.deepEqual(swing({ victimState: VICTIMSTATE_BLOCKS, damage: 4 }), [235, 1003]);
    assert.deepEqual(swing({ hitInfo: HITINFO_BLOCK, damage: 4 }), [235, 1003],
      "the flag says block even when the victim state does not");
    assert.deepEqual(swing({ victimState: VICTIMSTATE_BLOCKS, victim: 6n, damage: 4 }), [235, 1004],
      "a wooden shield is a different noise");

    // The other hand. The dagger is a lighter whoosh and a different family of impact, and this is
    // the only thing that says which of the two weapons swung.
    assert.deepEqual(swing({ hitInfo: HITINFO_OFFHAND }), [233, 1502]);
    // Two hands: a heavier whoosh, its own row, and the other miss id.
    assert.deepEqual(swing({ attacker: 5n }), [237, 1802]);
    assert.deepEqual(swing({ attacker: 5n, hitInfo: HITINFO_MISS, damage: 0 }), [237, 7081]);
  } finally {
    world.restore();
  }
});

test("Н1б the two voices are the fighters' own, and a blow that hurt nobody has none", () => {
  const world = combatWorld([
    combatUnit(1n, { main: 25, off: 30, chest: 70 }),
    combatUnit(2n, { main: 80, off: 60, chest: 70 }),
    combatUnit(3n, { displayId: 900, chest: 70 }),
  ], {
    creatures: {
      49: HUMAN_MALE,
      // One of the 262 displays that have an ordinary wound sound and no critical one.
      900: { ...HUMAN_MALE, id: 900, injury: 5942, injuryCritical: 0 },
    },
  });
  const swing = (extra) => {
    world.fresh();
    playSwingSounds(swingOf(extra));
    return [...world.played];
  };
  try {
    // Whoosh, landing, the attacker's effort and the victim's cry — in that order, and each from
    // its own end of the blow.
    assert.deepEqual(swing({}), [235, 1002, 2941, 2942]);
    // A critical hit is a different scream. `injuryCritical` is 818 of `CreatureSoundData`'s 1,306
    // rows and had never been on the wire before Н1а widened the reply.
    assert.deepEqual(swing({ hitInfo: HITINFO_CRITICAL }), [236, 2002, 2941, 2943]);
    // A parry is a noise without a wound: the old `COMBAT_LOG` handler cried out on every line
    // whatever had happened, which is the defect this replaces.
    assert.deepEqual(swing({ victimState: VICTIMSTATE_PARRY, damage: 0 }), [235, 1006, 2941]);
    assert.deepEqual(swing({ hitInfo: HITINFO_MISS, damage: 0, victimState: 0 }), [235, 7080, 2941]);
    // A victim whose row has no critical scream falls back to its ordinary one instead of going
    // quiet on the one blow in twenty worth hearing: 262 of the 23,088 displays that have a wound
    // sound at all on this dataset have no critical one.
    assert.deepEqual(swing({ victim: 3n, hitInfo: HITINFO_CRITICAL }), [236, 2002, 2941, 5942]);

    // The 700 ms throttle is on the voices and not on the weapon, which is what lets a dual-wielder
    // landing both hands in the same tenth of a second be heard as two blows and one cry.
    world.fresh();
    playSwingSounds(swingOf({}));
    playSwingSounds(swingOf({ hitInfo: HITINFO_OFFHAND }));
    assert.deepEqual(world.played, [235, 1002, 2941, 2942, 233, 1502],
      "the off hand keeps its own whoosh and its own landing and loses the grunt and the cry");

    // And the same when the second blow is the critical one. The two wounds are one throat and not
    // two files: keyed on the kind, an ordinary blow and a critical one on the same victim in the
    // same instant were measured as `[2942, 2943]` — both cries out of one man — which is the
    // stuck record the throttle exists to refuse.
    world.fresh();
    playSwingSounds(swingOf({}));
    playSwingSounds(swingOf({ hitInfo: HITINFO_OFFHAND | HITINFO_CRITICAL }));
    assert.deepEqual(world.played, [235, 1002, 2941, 2942, 234, 2502],
      "one cry, and the critical off-hand blow still has its own whoosh and landing");
  } finally {
    world.restore();
  }
});

test("Н1б a creature swings what its virtual item slots say, and a fist when they say nothing", () => {
  // `UNIT_VIRTUAL_ITEM_SLOT_ID` is three words at offset 56 that nothing in this client had ever
  // read, and it is the only thing that says what a creature is holding.
  const armed = combatUnit(10n, { typeId: 3, displayId: 800, main: 25 });
  const bare = combatUnit(11n, { typeId: 3, displayId: 801 });
  const chain = combatUnit(12n, { typeId: 3, displayId: 802 });
  const world = combatWorld([armed, bare, chain], {
    creatures: {
      800: { ...HUMAN_MALE, id: 800 },
      801: { ...HUMAN_MALE, id: 801 },
      // The two rows of the 1,306 whose `CreatureImpactType` is not flesh.
      802: { ...HUMAN_MALE, id: 802, impactType: 1 },
    },
  });
  const swing = (extra) => {
    world.fresh();
    playSwingSounds(swingOf(extra));
    return [...world.played];
  };
  try {
    assert.deepEqual(swing({ attacker: 10n, victim: 11n }), [235, 1000, 2941, 2942],
      "a creature holding a sword lands like a sword");
    assert.deepEqual(swing({ attacker: 11n, victim: 10n }), [235, 1300, 2941, 2942],
      "and one holding nothing swings medium and lands on the unarmed row");
    assert.deepEqual(swing({ attacker: 11n, victim: 12n }), [235, 1301, 2941, 2942],
      "a creature made of chain is hit on the chain slot, with no breastplate anywhere");
  } finally {
    world.restore();
  }
});

test("Н1б a wand is silent on purpose, and the two fighters are not", () => {
  // 339 of `Item.dbc`'s weapons are wands and none of them has a `WeaponImpactSounds` row: a wand
  // fires a spell and the spell has a sound of its own. The silence is the weapon's, though — the
  // arm holding it still grunts and the thing it hit still cries out.
  const world = combatWorld([
    combatUnit(1n, { main: 40 }),
    combatUnit(2n, { chest: 70 }),
  ], { creatures: { 49: HUMAN_MALE } });
  try {
    playSwingSounds(swingOf({}));
    assert.deepEqual(world.played, [2941, 2942]);
  } finally {
    world.restore();
  }
});

test("Н1б the first swing of a session asks for the weapons, and waits for the answer", () => {
  // `Item.dbc` is 46,098 rows and is asked about a batch at a time, so what is in a fighter's hand
  // is not known on the frame the first blow lands. Two things have to be true and only the second
  // was: the swing has to *ask*, and it has to hold the steel until the answer comes back.
  // `itemSound` is the one thing in the client that queues a batch and `itemAnswered` is a pure
  // read, so a swing that checked without asking waited on a question nobody had put — measured
  // against the real `SoundClient` over a fake gateway, four swings in a row issued no request and
  // played nothing whatever.
  const world = combatWorld([
    combatUnit(1n, { main: 25, chest: 70 }),
    combatUnit(2n, { chest: 70, x: 7 }),
    combatUnit(3n, { chest: 71 }),
  ], { answered: false, creatures: { 49: HUMAN_MALE } });
  try {
    playSwingSounds(swingOf({}));
    assert.deepEqual([...world.held.asked].sort((one, other) => one - other), [25, 70],
      "the sword and the breastplate it is about to land on are asked for by the blow itself");
    assert.deepEqual(world.played, [2941, 2942],
      "and the two voices are heard when the blow happens: neither of them is in `Item.dbc`");

    // A batch landing that is not the one this swing is waiting for must not settle it. That is
    // the ordinary case in a session — kits and creature rows land all the time — and settling
    // there and then means choosing the sound from items that have not arrived, which is the bare
    // fist the wait exists to prevent.
    retryPendingSounds();
    assert.deepEqual(world.played, [2941, 2942], "still the voices and no steel");

    world.held.answered = true;
    retryPendingSounds();
    assert.deepEqual(world.played, [2941, 2942, 235, 1002],
      "the batch carrying the two items is what plays the sword — 1002, and not 1300 the fist");
    retryPendingSounds();
    assert.deepEqual(world.played, [2941, 2942, 235, 1002],
      "once, not once per batch that lands afterwards");

    // And the window closing. A swing that has waited its 800 ms is dropped rather than played
    // late or guessed at: the fight keeps the two voices it already had, and a punch on a man in
    // plate is a wrong sound where a missing whoosh is only a missing one.
    world.fresh();
    world.held.answered = false;
    playSwingSounds(swingOf({}), { until: performance.now() - 1 });
    assert.deepEqual(world.played, [], "nothing, and no second pair of voices for the one blow");
    world.held.answered = true;
    retryPendingSounds();
    assert.deepEqual(world.played, [], "and it is not waiting any more: no blow rings a second late");

    // Nor does a blow that is over start a batch. Asking is the first pass's work — the batch takes
    // its entries out of the wanted set the moment it goes out, so a retry that asked again would
    // be a second request for rows already in flight. Nobody has swung at 3 yet, so the chain shirt
    // they are wearing could only be in the asked set if this swing had put it there.
    world.fresh();
    world.held.answered = false;
    playSwingSounds(swingOf({ victim: 3n }), { until: performance.now() - 1 });
    assert.equal(world.held.asked.has(71), false, "the shirt of a man nobody has hit yet");
  } finally {
    world.restore();
  }
});

test("Н1б one swing over the real sound client is one request, and the sword it names", async () => {
  // The fake above can prove that a swing waits for what it asked for; only this can prove that it
  // asks at all. Everything here is the client's own — the real `SoundClient`, the real deferral
  // queue, the real `CombatSounds` — with `fetch` and the audio device replaced and `onLoaded`
  // wired to `retryPendingSounds` the way `EnterWorld` wires it.
  const { SoundClient } = await import("../dist/code/browser/SoundClient.js");
  const requests = [];
  const played = [];
  const originalFetch = globalThis.fetch;
  const previous = { world: game.world, sound: game.sound, soundKits: game.soundKits };
  globalThis.fetch = async (url) => {
    const text = String(url);
    requests.push(text.replace("http://127.0.0.1:8090", ""));
    const query = new URL(text).searchParams;
    const numbers = (key) => (query.get(key) ?? "").split(",").filter(Boolean).map(Number);
    if (query.has("items")) {
      return { ok: true, status: 200,
        json: async () => ({ items: numbers("items").map((entry) => COMBAT_ITEMS[entry]).filter(Boolean) }) };
    }
    if (query.has("ids") || query.has("creatures")) {
      // One reply carries every key the request asked about: the client batches kits and creature
      // rows into the same URL, and a fake answering only the first of them drops the very sounds
      // under test on the floor.
      return { ok: true, status: 200, json: async () => ({
        kits: numbers("ids").map((id) => ({
          id, type: 6, name: `kit${id}`, files: [`${id}.wav`], volume: 1, minDistance: 8,
          maxDistance: 45, flags: 0,
        })),
        creatures: numbers("creatures").map((id) => ({ ...HUMAN_MALE, id })),
        music: [], intro: [], ambience: [], named: [],
      }) };
    }
    return { ok: true, status: 200, json: async () => fakeWeaponTables() };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const client = new SoundClient("ws://127.0.0.1:8090/auth");
    const tablesLanded = new Promise((resolve) => { client.onLoaded = resolve; });
    client.loadWeaponSounds();
    await tablesLanded;
    client.onLoaded = () => retryPendingSounds();
    game.soundKits = client;
    game.sound = { play: (kit) => played.push(kit.id) };
    game.world = { state: { selfGuid: 1n, objects: new Map([
      [1n, combatUnit(1n, { main: 25, chest: 71 })],
      [2n, combatUnit(2n, { chest: 70, x: 7 })],
    ]) } };
    forgetGameSounds();
    forgetCombatSounds();

    playSwingSounds(swingOf({}));
    await settle();
    assert.deepEqual(requests.filter((request) => request.includes("items=")),
      ["/dbc/weapon-sounds?v=1&items=25,70"],
      "the blow asks for the sword in the hand and the plate it is landing on, and for nothing else");
    // Everything the four sounds need now lands in its own turn: the item rows, then the creature
    // row and the kits the two halves name.
    for (let turn = 0; turn < 8; turn += 1) await settle();
    assert.deepEqual(played, [235, 1002, 2941, 2942],
      "the one-handed whoosh, the sword into plate, the grunt and the cry");
    assert.equal(requests.filter((request) => request.includes("items=")).length, 1,
      "and the batch is asked for once, not once per batch that wakes the swing waiting for it");
  } finally {
    globalThis.fetch = originalFetch;
    forgetGameSounds();
    forgetCombatSounds();
    game.world = previous.world;
    game.sound = previous.sound;
    game.soundKits = previous.soundKits;
  }
});

test("Н1б the player's own death is an edge on their own health, because no packet announces it", () => {
  // `death` had exactly one caller — `PARTY_KILL`, which the server sends to the killer's party and
  // never to the victim — so the one death a player is guaranteed to care about was the one this
  // client never played.
  const self = combatUnit(1n, {});
  const world = combatWorld([self], { creatures: { 49: HUMAN_MALE } });
  const health = (value) => self.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, value);
  try {
    updateCombatSounds();
    updateCombatSounds();
    assert.deepEqual(world.played, [], "a living character does not die once a frame");

    health(0);
    updateCombatSounds();
    assert.deepEqual(world.played, [2944]);
    updateCombatSounds();
    updateCombatSounds();
    assert.deepEqual(world.played, [2944], "and a corpse does not go on dying");

    // Up again and down again is a second death. Through a fresh start because the 700 ms throttle
    // is the thing that would otherwise refuse it, and the throttle is not what is under test here.
    world.fresh();
    health(120);
    updateCombatSounds();
    health(0);
    updateCombatSounds();
    assert.deepEqual(world.played, [2944]);

    // A character who logs in dead does not die on arrival: the first look only takes a baseline.
    world.fresh();
    forgetCombatSounds();
    updateCombatSounds();
    updateCombatSounds();
    assert.deepEqual(world.played, []);

    // Nor does one whose body left the client's sight and came back. `#checkTarget` aside, an
    // object can be destroyed and recreated by a phase change with the same guid.
    world.fresh();
    health(120);
    updateCombatSounds();
    world.state.objects.delete(1n);
    updateCombatSounds();
    world.state.objects.set(1n, self);
    health(0);
    updateCombatSounds();
    assert.deepEqual(world.played, [], "an object that was not there is not one that just died");
  } finally {
    world.restore();
  }
});

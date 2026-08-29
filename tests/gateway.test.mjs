import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import WebSocket from "ws";
import {
  SOURCE_MISSING_EXIT, isCharacterVisualTexture, socketPeerAddress, startGateway, visualModelCacheNamespace,
} from "../dist/code/gateway/Gateway.js";
import { SOURCE_MISSING_EXIT as generatorMissingExit } from "../tools/generate-texture.mjs";
import { isLoopbackAddress } from "../dist/code/gateway/ModuleIndex.js";
import { parseVMapTile } from "../dist/code/gateway/VMapProtocol.js";
import { parseSpellMetadata } from "../dist/code/gateway/SpellMetadata.js";
import { parseVMapModel } from "../dist/code/gateway/VMapModel.js";
import { parseGameObjectDisplayMetadata } from "../dist/code/gateway/GameObjectMetadata.js";
import { PacketWriter } from "../dist/code/protocol/index.js";
import { decodeCollisionModel } from "../dist/code/world/CollisionFormat.js";
import { openClientArchives } from "../tools/mpq.mjs";
import { repositoryRoot } from "../tools/paths.mjs";
import { sourceStamp, stampSidecar, writeSourceStamp } from "../tools/source-stamp.mjs";

const encoder = new TextEncoder();
const WORLD_MID = 0.5 * 64 * 533.33333333;

function vmapTile() {
  const name = encoder.encode("ExampleTree.m2");
  return new PacketWriter()
    .bytes(encoder.encode("VMAP_4.8"))
    .u32(1)
    .u32(5)
    .u16(7)
    .u32(123)
    .f32(WORLD_MID - 100)
    .f32(WORLD_MID - 200)
    .f32(3)
    .f32(0)
    .f32(0)
    .f32(45)
    .f32(1)
    .f32(WORLD_MID - 102)
    .f32(WORLD_MID - 203)
    .f32(1)
    .f32(WORLD_MID - 98)
    .f32(WORLD_MID - 197)
    .f32(9)
    .u32(name.byteLength)
    .bytes(name)
    .u32(42)
    .toUint8Array();
}

function writeBih(writer) {
  for (let index = 0; index < 6; index++) writer.f32(0);
  return writer.u32(0).u32(0);
}

function vmapModel() {
  const writer = new PacketWriter()
    .bytes(encoder.encode("VMAP_4.8"))
    .bytes(encoder.encode("WMOD"))
    .u32(8)
    .u32(1)
    .bytes(encoder.encode("GMOD"))
    .u32(1);
  for (const value of [0, 0, 0, 1, 1, 1]) writer.f32(value);
  writer.u32(0).u32(1).bytes(encoder.encode("VERT")).u32(40).u32(3)
    .f32(0).f32(0).f32(0)
    .f32(1).f32(0).f32(0)
    .f32(0).f32(1).f32(0)
    .bytes(encoder.encode("TRIM")).u32(16).u32(1).u32(0).u32(1).u32(2)
    .bytes(encoder.encode("MBIH"));
  writeBih(writer).bytes(encoder.encode("LIQU")).u32(0).bytes(encoder.encode("GBIH"));
  return writeBih(writer).toUint8Array();
}

function stringBlock(values) {
  const offsets = new Map();
  const bytes = [0];
  for (const value of values) {
    offsets.set(value, bytes.length);
    bytes.push(...encoder.encode(value), 0);
  }
  return { bytes: Uint8Array.from(bytes), offsets };
}

function dbcFixture(fields, rows, strings) {
  const result = new Uint8Array(20 + rows.length * fields * 4 + strings.byteLength);
  result.set(encoder.encode("WDBC"));
  const view = new DataView(result.buffer);
  view.setUint32(4, rows.length, true);
  view.setUint32(8, fields, true);
  view.setUint32(12, fields * 4, true);
  view.setUint32(16, strings.byteLength, true);
  for (let row = 0; row < rows.length; row++) {
    for (let field = 0; field < fields; field++) view.setUint32(20 + (row * fields + field) * 4, rows[row][field] ?? 0, true);
  }
  result.set(strings, 20 + rows.length * fields * 4);
  return result;
}

/**
 * The three tables a spell's picture is spread across, with one usable row each.
 *
 * Kit 20 hangs a flame in the right spell hand and asks the caster for animation 53; visual 10
 * uses it as its cast phase and throws effect 2 as a missile. The point of the fixture is the
 * walk: four tables and a renamed extension between a spell id and a model path.
 */
function spellVisualDbcs() {
  const strings = stringBlock(["Fire Cast Hand", "Spells\\Fire_Cast_Hand.mdx", "Fireball Missile", "Spells\\Fireball_Missile.mdx"]);
  const float = (value) => new DataView(Float32Array.of(value).buffer).getUint32(0, true);

  const name = (id, label, file) => {
    const row = Array(7).fill(0);
    row[0] = id;
    row[1] = strings.offsets.get(label);
    row[2] = strings.offsets.get(file);
    row[3] = float(1);
    row[4] = float(1);
    row[5] = float(0.01);
    row[6] = float(100);
    return row;
  };
  const names = dbcFixture(7, [
    name(1, "Fire Cast Hand", "Spells\\Fire_Cast_Hand.mdx"),
    name(2, "Fireball Missile", "Spells\\Fireball_Missile.mdx"),
  ], strings.bytes);

  // 38 fields: ID, StartAnimID, AnimID, then the eight single effects and the rest.
  const kit = Array(38).fill(0);
  kit[0] = 20;
  kit[1] = 0xffffffff;   // StartAnimID: none
  kit[2] = 53;           // AnimID
  kit[7] = 1;            // RightHandEffect -> effect name 1
  kit[15] = 77;          // SoundID
  const kits = dbcFixture(38, [kit], new Uint8Array(0));

  // 32 fields: every kit column is populated so the route proves the complete phase map.
  const visual = Array(32).fill(0);
  visual[0] = 10;
  for (const index of [1, 2, 3, 4, 5, 6, 14, 15, 22, 23, 24, 25]) visual[index] = 20;
  visual[8] = 2;         // MissileModel -> effect name 2
  visual[11] = 88;       // MissileSound
  visual[12] = 99;       // AnimEventSoundID
  visual[16] = 22;       // MissileAttachment: the right spell hand
  const visuals = dbcFixture(32, [visual], new Uint8Array(0));

  return { visuals, kits, names };
}

/**
 * `ChrRaces`, `ChrClasses` and `CharBaseInfo` with a custom race and a custom class in them.
 *
 * The point of the fixture is the pair that the hardcoded lists could not have: race 22 is not in
 * `RACE_NAMES` and class 14 is not in `CLASS_NAMES`, so a form built from those two records cannot
 * offer either, whatever the dataset says. `Name_lang` is written into the enUS slot and the ruRU
 * slot with *different* words, so a route that picked the wrong locale column would be visible
 * rather than merely untested.
 */
function characterCreationDbcs() {
  const strings = stringBlock([
    "Hu", "Go", "Wo", "Vr", "Human", "Человек", "Goblin", "Гоблин",
    "Worgen", "Ворген", "Vrykul", "Врайкул",
    "WARRIOR", "Warrior", "Воин", "MONK", "Monk", "Монах",
  ]);
  const at = (value) => strings.offsets.get(value);
  // Field indexes out of src/generated/dbcLayouts.ts: 69 fields, Name_lang at 14 and ruRU is the
  // ninth of its seventeen slots.
  const race = ({ id, flags, alliance, prefix, language, name, localName }) => {
    const row = new Array(69).fill(0);
    row[0] = id;
    row[1] = flags;
    row[2] = 1;                 // FactionID
    row[6] = at(prefix);        // ClientPrefix
    row[7] = language;          // BaseLanguage
    row[13] = alliance;         // Alliance
    row[14] = at(name);         // Name_lang, enUS
    row[14 + 8] = at(localName);// Name_lang, ruRU
    row[68] = 0;                // Required_expansion
    return row;
  };
  // 60 fields, Name_lang at 4, Filename at 55.
  const characterClass = ({ id, power, file, name, localName }) => {
    const row = new Array(60).fill(0);
    row[0] = id;
    row[2] = power;             // DisplayPower
    row[4] = at(name);          // Name_lang, enUS
    row[4 + 8] = at(localName); // Name_lang, ruRU
    row[55] = at(file);         // Filename
    return row;
  };

  // Two one-byte columns and no id of its own, so `dbcFixture` — which writes words — cannot
  // build this one.
  const pairs = [[1, 1], [1, 14], [22, 14], [200, 1]];
  const base = new Uint8Array(20 + pairs.length * 2 + 1);
  const view = new DataView(base.buffer);
  base.set(encoder.encode("WDBC"));
  view.setUint32(4, pairs.length, true);
  view.setUint32(8, 2, true);
  view.setUint32(12, 2, true);
  view.setUint32(16, 1, true);
  pairs.forEach(([raceId, classId], index) => {
    base[20 + index * 2] = raceId;
    base[21 + index * 2] = classId;
  });

  return {
    races: dbcFixture(69, [
      race({ id: 1, flags: 0x0c, alliance: 0, prefix: "Hu", language: 7, name: "Human", localName: "Человек" }),
      race({ id: 9, flags: 0x01, alliance: 2, prefix: "Go", language: 7, name: "Goblin", localName: "Гоблин" }),
      race({ id: 22, flags: 0x0e, alliance: 1, prefix: "Wo", language: 1, name: "Worgen", localName: "Ворген" }),
      // Past 127, which is where `CharBaseInfo`'s signed byte columns start reading negative.
      race({ id: 200, flags: 0x0e, alliance: 1, prefix: "Vr", language: 1, name: "Vrykul", localName: "Врайкул" }),
    ], strings.bytes),
    classes: dbcFixture(60, [
      characterClass({ id: 1, power: 1, file: "WARRIOR", name: "Warrior", localName: "Воин" }),
      characterClass({ id: 14, power: 0, file: "MONK", name: "Monk", localName: "Монах" }),
    ], strings.bytes),
    base,
  };
}

function spellDbcs(localizedName = "Огненный шар") {
  const spellStrings = stringBlock(["Fireball", localizedName, "Rank 1", "Ранг 1", "Hurls a fiery ball.", "Бросает огненный шар."]);
  const variableStrings = stringBlock(["$damage=42"]);
  const iconStrings = stringBlock(["Interface\\Icons\\Spell_Fire_FlameBolt"]);
  const spell = Array(234).fill(0);
  spell[0] = 133;
  spell[1] = 2; // SpellCategoryID, whose flags below mark cooldown-start-on-event.
  spell[29] = 8000;
  spell[30] = 12000;
  spell[41] = 0;
  spell[42] = 30;
  // SpellVisualID is two wide, at 131 and 132: the spell's own picture and its fallback.
  spell[131] = 10;
  // Speed, in yards a second, as a float — the only place a missile's flight time is written.
  spell[47] = new DataView(Float32Array.of(24).buffer).getUint32(0, true);
  spell[133] = 7;
  // What a description's markers are made of. Fireball rank 1 stores 13 and 9 and reads 14 to 22
  // on the real tooltip: an effect rolls `EffectBasePoints + 1` to `EffectBasePoints + DieSides`.
  spell[74] = 9;    // EffectDieSides[0]
  spell[80] = 13;   // EffectBasePoints[0]
  spell[98] = 3000; // EffectAuraPeriod[0], which is `$t` — and not EffectAmplitude, three slots on
  spell[104] = 2;   // EffectChainTargets[0]
  spell[92] = 4;    // EffectRadiusIndex[0]
  spell[40] = 3;    // DurationIndex
  spell[35] = 101;  // ProcChance, the table's own way of writing "always"
  spell[232] = 5;   // DescriptionVariablesID
  spell[136] = spellStrings.offsets.get("Fireball");
  spell[144] = spellStrings.offsets.get(localizedName);
  spell[153] = spellStrings.offsets.get("Rank 1");
  spell[161] = spellStrings.offsets.get("Ранг 1");
  spell[170] = spellStrings.offsets.get("Hurls a fiery ball.");
  spell[178] = spellStrings.offsets.get("Бросает огненный шар.");
  spell[206] = 1500;
  // K1: what a rank chain is made of, plus the cost that is not written in `ManaCost`. The real
  // row 133 has `ManaCost = 0` and `ManaCostPct = 8`; this fixture keeps its flat 30 as well so
  // both halves of the cost rule travel in one payload.
  spell[39] = 1;    // SpellLevel
  spell[204] = 8;   // ManaCostPct
  spell[208] = 3;   // SpellClassSet, the mage family
  spell[209] = 1;   // SpellClassMask[0]; the other two words stay zero, as on the real row
  spell[225] = 4;   // SchoolMask, fire
  spell[46] = 35;   // RangeIndex, resolved below to 0..35 yards
  spell[28] = 16;   // CastingTimeIndex, resolved below to 1500 ms

  // Find Herbs, so the payload is proved to carry what a tracking menu needs. Effect[0] is slot
  // 71, EffectAura[0] is 95 and EffectMiscValue[0] is 110; the misc value is a one-based LockType,
  // 2 for herbalism, and nothing else in this table could tell a tracking spell from any other.
  const tracker = Array(234).fill(0);
  tracker[0] = 2383;
  tracker[4] = 0x02000000; // SPELL_ATTR0_DISABLED_WHILE_ACTIVE, independent of SpellCategory.Flags.
  tracker[71] = 6;   // SPELL_EFFECT_APPLY_AURA
  tracker[95] = 45;  // SPELL_AURA_TRACK_RESOURCES
  tracker[110] = 2;  // LOCKTYPE_HERBALISM
  tracker[133] = 7;
  tracker[136] = spellStrings.offsets.get("Fireball");
  const ordinary = Array(234).fill(0);
  ordinary[0] = 9999;
  return {
    spells: dbcFixture(234, [spell, tracker, ordinary], spellStrings.bytes),
    icons: dbcFixture(2, [[7, iconStrings.offsets.get("Interface\\Icons\\Spell_Fire_FlameBolt")]], iconStrings.bytes),
    // Both are indexes into small side tables, and both are resolved on the gateway: an index into
    // a table the browser does not have is not information.
    durations: dbcFixture(4, [[3, 12000, 0, 15000]], stringBlock([]).bytes),
    radii: dbcFixture(4, [[4, floatBits(8.5), 0, 0]], stringBlock([]).bytes),
    categories: dbcFixture(2, [[2, 0x04]], stringBlock([]).bytes),
    descriptionVariables: dbcFixture(2, [[5, variableStrings.offsets.get("$damage=42")]], variableStrings.bytes),
    // Two more indexes resolved the same way. `SpellRange` is forty fields wide: id, two words of
    // RangeMin, two of RangeMax, flags, then two seventeen-slot localised names. Slot 1 of each
    // pair is the friendly range, and it differs from the hostile one on five of the real 65 rows.
    // The flags word carries 2 the way the real 35-yard row does (114, «Hunter Range»), so a column
    // read one slot wide of it cannot pass by answering zero.
    ranges: dbcFixture(40, [[35, 0, 0, floatBits(35), floatBits(35), 2, ...Array(34).fill(0)]], stringBlock([]).bytes),
    castTimes: dbcFixture(4, [[16, 1500, 0, 0]], stringBlock([]).bytes),
  };
}

/** A float in the four bytes a DBC slot holds, since the fixture writes slots as integers. */
function floatBits(value) {
  return new DataView(Float32Array.of(value).buffer).getUint32(0, true);
}

/**
 * Two faction templates that disagree: one whose enemy mask names the other's group. Fourteen
 * fields — id, faction, flags, three group masks, four enemies, four friends — which is exactly
 * what the reaction rule reads.
 */
function factionTemplateDbc() {
  const alliance = [1, 1, 0, 2, 2, 4, 0, 0, 0, 0, 0, 0, 0, 0];
  const horde = [2, 2, 0, 4, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0];
  return dbcFixture(14, [alliance, horde], Uint8Array.of(0));
}

/**
 * `Faction.dbc`: 57 fields, the name a seventeen-slot localised string at index 23.
 *
 * Row two has a reputation index of −1, which is a faction a player can never have standing with;
 * it has to be dropped rather than folded onto slot 0.
 */
function factionDbc() {
  const strings = stringBlock(["Дарнас", "Скрытая"]);
  const row = (id, index, name) => {
    const fields = new Array(57).fill(0);
    fields[0] = id;
    fields[1] = index;
    // The locale this client reads is the eighth slot; the first is enUS.
    fields[23 + 7] = strings.offsets.get(name);
    return fields;
  };
  return dbcFixture(57, [row(69, 21, "Дарнас"), row(70, -1, "Скрытая")], strings.bytes);
}

function gameObjectDbc() {
  const strings = stringBlock(["World\\Generic\\ActiveDoodads\\Chest02\\Chest02.mdx"]);
  return dbcFixture(19, [[1, strings.offsets.get("World\\Generic\\ActiveDoodads\\Chest02\\Chest02.mdx")]], strings.bytes);
}

/**
 * One `.vmo` in the format the vmap extractor writes: a header, two groups, and the BIH trees
 * between them that the reader has to skip over rather than trip on.
 */
function collisionVmo() {
  const writer = new PacketWriter().bytes(encoder.encode("VMAP_4.8")).bytes(encoder.encode("WMOD")).u32(8).u32(1)
    .bytes(encoder.encode("GMOD")).u32(2);
  const group = (offset, groupId) => {
    for (const value of [offset, offset, 0, offset + 1, offset + 1, 1]) writer.f32(value);
    writer.u32(0).u32(groupId);
    writer.bytes(encoder.encode("VERT")).u32(40).u32(3)
      .f32(offset).f32(offset).f32(0)
      .f32(offset + 1).f32(offset).f32(0)
      .f32(offset).f32(offset + 1).f32(0);
    writer.bytes(encoder.encode("TRIM")).u32(16).u32(1).u32(0).u32(1).u32(2);
    writer.bytes(encoder.encode("MBIH"));
    writeBih(writer);
    writer.bytes(encoder.encode("LIQU")).u32(0);
  };
  group(0, 701);
  group(10, 702);
  writer.bytes(encoder.encode("GBIH"));
  return writeBih(writer).toUint8Array();
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("gateway forwards binary WebSocket data to a fixed TCP target", async () => {
  const echo = createServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echo);
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: echoPort },
    world: { host: "127.0.0.1", port: echoPort },
    allowedOrigins: ["*"],
  });

  try {
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/auth`, {
      origin: "http://192.168.1.25:5173",
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    socket.send(Uint8Array.of(0x00, 0x12, 0x34));
    const response = await new Promise((resolve, reject) => {
      socket.once("message", resolve);
      socket.once("error", reject);
    });
    assert.deepEqual([...response], [0x00, 0x12, 0x34]);
    socket.close();
  } finally {
    await gateway.close();
    await close(echo);
  }
});

test("gateway serves validated local terrain tiles to allowed origins", async () => {
  const mapsDirectory = await mkdtemp(join(tmpdir(), "webclient-maps-"));
  const vmapsDirectory = await mkdtemp(join(tmpdir(), "webclient-vmaps-"));
  const dbcDirectory = await mkdtemp(join(tmpdir(), "webclient-dbc-"));
  const buildingsDirectory = await mkdtemp(join(tmpdir(), "webclient-buildings-"));
  const visualTilesDirectory = await mkdtemp(join(tmpdir(), "webclient-visual-tiles-"));
  const visualModelsDirectory = await mkdtemp(join(tmpdir(), "webclient-visual-models-"));
  const spellFiles = spellDbcs();
  await writeFile(join(mapsDirectory, "0003232.map"), Uint8Array.of(1, 2, 3));
  await mkdir(join(mapsDirectory, "textures", "0"), { recursive: true });
  await writeFile(join(mapsDirectory, "textures", "0", "32-32.png"), Uint8Array.of(0x89, 0x50, 0x4e, 0x47));
  await mkdir(join(mapsDirectory, "item-icons"), { recursive: true });
  await writeFile(join(mapsDirectory, "item-icons", "220.png"), Uint8Array.of(0x89, 0x50, 0x4e, 0x47));
  await writeFile(join(vmapsDirectory, "000_31_32.vmtile"), vmapTile());
  await writeFile(join(dbcDirectory, "Spell.dbc"), spellFiles.spells);
  await writeFile(join(dbcDirectory, "SpellIcon.dbc"), spellFiles.icons);
  // The two side tables a description's `$d` and `$a` are resolved through. Written here rather
  // than tolerated as missing: a gateway that quietly answered zero for every duration would take
  // «Оглушение цели на $d» to «Оглушение цели на » and look finished.
  await writeFile(join(dbcDirectory, "SpellDuration.dbc"), spellFiles.durations);
  await writeFile(join(dbcDirectory, "SpellRadius.dbc"), spellFiles.radii);
  await writeFile(join(dbcDirectory, "SpellCategory.dbc"), spellFiles.categories);
  await writeFile(join(dbcDirectory, "SpellRange.dbc"), spellFiles.ranges);
  await writeFile(join(dbcDirectory, "SpellCastTimes.dbc"), spellFiles.castTimes);
  const visualFiles = spellVisualDbcs();
  await writeFile(join(dbcDirectory, "SpellVisual.dbc"), visualFiles.visuals);
  await writeFile(join(dbcDirectory, "SpellVisualKit.dbc"), visualFiles.kits);
  await writeFile(join(dbcDirectory, "SpellVisualEffectName.dbc"), visualFiles.names);
  await writeFile(join(dbcDirectory, "GameObjectDisplayInfo.dbc"), gameObjectDbc());
  await writeFile(join(dbcDirectory, "FactionTemplate.dbc"), factionTemplateDbc());
  await writeFile(join(dbcDirectory, "Faction.dbc"), factionDbc());
  await writeFile(join(dbcDirectory, "creatures.json"), JSON.stringify([[123, "Лесной волк", "", 1, 1, 0]]));
  await writeFile(join(dbcDirectory, "items.json"), JSON.stringify([[25, "Потрёпанный меч", 220, 1, 13, 1, 7]]));
  await writeFile(join(buildingsDirectory, "Triangle.wmo.vmo"), vmapModel());
  await writeFile(join(buildingsDirectory, "Hut.wmo.vmo"), collisionVmo());
  await mkdir(join(visualTilesDirectory, "0"), { recursive: true });
  await writeFile(join(visualTilesDirectory, "0", "32-32.json"), JSON.stringify([{ id: 7, kind: "m2", name: "World\\Tree.m2", x: 1, y: 2, z: 3, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 }]));
  const visualPath = "World\\Tree.m2";
  // v6 keys on the model path alone: the artifact carries no appearance, so every skin and hair
  // combination of a race shares it. Up to v5 the resolved texture list was part of the key,
  // which turned 1,105 models into 17,217 artifacts.
  // v12 is where a WMO became its groups: a model over the triangle budget writes one file per
  // group beside the header, and `group` asks for one of them. v13 is where the artifact gained
  // the colour and texture-weight tables and the portrait camera, and v15 the texture transforms.
  const visualHash = createHash("sha1").update(`visual-v16\0${visualPath.toLowerCase()}`).digest("hex");
  await writeFile(join(visualModelsDirectory, `${visualHash}.bin`), Buffer.from("WVM2-test"));
  // LightSkybox metadata is normalized to this archive spelling before it reaches the browser.
  // Keep an artifact under the real Dalaran path so the regression covers the final model route,
  // not only the DBC parser's string value.
  const skyboxPath = "ENVIRONMENTS\\Stars\\DalaranSkyBox.m2";
  const skyboxHash = createHash("sha1").update(`visual-v16\0${skyboxPath.toLowerCase()}`).digest("hex");
  await writeFile(join(visualModelsDirectory, `${skyboxHash}.bin`), Buffer.from("WVM2-dalaran-sky"));
  // The poses the model did not ship with live beside it under the same key.
  await writeFile(join(visualModelsDirectory, `${visualHash}.anim.bin`), Buffer.from("WVA1-test"));
  await writeFile(join(visualModelsDirectory, `${visualHash}.g007.bin`), Buffer.from("WWM1-room-7"));
  await writeFile(join(visualModelsDirectory, `${visualHash}-0.png`), Uint8Array.of(0x89, 0x50, 0x4e, 0x47));
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    mapsDirectory,
    vmapsDirectory,
    dbcDirectory,
    creatureMetadataFile: join(dbcDirectory, "creatures.json"),
    itemMetadataFile: join(dbcDirectory, "items.json"),
    itemIconsDirectory: join(mapsDirectory, "item-icons"),
    buildingsDirectory,
    terrainTexturesDirectory: join(mapsDirectory, "textures"),
    visualTilesDirectory,
    visualModelsDirectory,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/terrain/0/32/32`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.of(1, 2, 3));
    const terrainTexture = await fetch(`http://127.0.0.1:${gateway.port}/terrain-texture/0/32/32`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(terrainTexture.status, 200);
    assert.equal(terrainTexture.headers.get("content-type"), "image/png");
    assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/terrain/0/32/32`)).status, 403);
    const environment = await fetch(`http://127.0.0.1:${gateway.port}/environment/0/32/31`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(environment.status, 200);
    assert.equal((await environment.json())[0].name, "ExampleTree.m2");
    const spells = await fetch(`http://127.0.0.1:${gateway.port}/dbc/spells?ids=133`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(spells.status, 200);
    const [served] = await spells.json();
    assert.equal(served.name, "Огненный шар");
    // K1: the six columns the spellbook could not see. The percentage is the one that shows on the
    // screen — a live gateway answers `"powerCost":0` for 133 and the cost line was simply missing.
    assert.equal(served.powerCostPercent, 8);
    assert.equal(served.spellLevel, 1);
    assert.equal(served.spellClassSet, 3);
    assert.deepEqual(served.spellClassMask, [1, 0, 0]);
    assert.equal(served.schoolMask, 4);
    assert.equal(served.rangeMax, 35, "resolved through SpellRange, not served as the index 35");
    assert.equal(served.rangeFlags, 2, "and the flags word beside it, which is what says «melee»");
    assert.equal(served.castTime, 1500, "and through SpellCastTimes, not as the index 16");
    // And the substitution data reaches the browser whole, resolved where it was an index.
    assert.deepEqual(served.effectBasePoints, [13, 0, 0]);
    assert.deepEqual(served.effectDieSides, [9, 0, 0]);
    assert.equal(served.duration, 12000);
    assert.equal(served.effectRadius[0], 8.5);
    // Four tables deep, and the extension renamed on the way out: the table stores `.mdx`, which
    // is Warcraft III's and is not in the archives at all.
    const spellVisuals = await fetch(`http://127.0.0.1:${gateway.port}/dbc/spell-visuals?ids=133,999999`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(spellVisuals.status, 200);
    const [fireball, unknown] = await spellVisuals.json();
    assert.equal(fireball.id, 133);
    assert.deepEqual(fireball.cast.effects, [{ path: "Spells\\Fire_Cast_Hand.m2", attachment: 22, scale: 1 }]);
    assert.equal(fireball.cast.animation, 53);
    for (const phase of [
      "precast", "cast", "impact", "state", "stateDone", "channel", "casterImpact", "targetImpact",
      "missileTargeting", "instantArea", "impactArea", "persistentArea",
    ]) assert.equal(fireball[phase].sound, 77, `${phase} kit sound`);
    assert.equal(fireball.missileSound, 88);
    assert.equal(fireball.animEventSound, 99);
    assert.equal(fireball.durationMs, 12000);
    assert.equal(fireball.missile.path, "Spells\\Fireball_Missile.m2");
    assert.equal(fireball.missile.attachment, 22);
    assert.equal(fireball.missile.sound, 88);
    // A spell nobody has a picture for still answers, so the browser stops asking.
    assert.deepEqual(unknown, { id: 999999 });
    assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/dbc/spell-visuals?ids=133`)).status, 403);

    const gameobjects = await fetch(`http://127.0.0.1:${gateway.port}/dbc/gameobjects?ids=1`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(gameobjects.status, 200);
    assert.deepEqual(await gameobjects.json(), [{ id: 1, model: "World\\Generic\\ActiveDoodads\\Chest02\\Chest02.m2" }]);
    // Whole rather than queried: the reaction to a unit is asked for every unit on screen, several
    // times a second, and the table is smaller than one texture.
    const factions = await fetch(`http://127.0.0.1:${gateway.port}/dbc/factions`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(factions.status, 200);
    const factionBody = await factions.json();
    // Names travel with the templates: the reputation block on the wire is 128 slots numbered by
    // `ReputationIndex`, and without this the character sheet can only print the number.
    assert.deepEqual(factionBody.names, { 21: "Дарнас" });
    assert.deepEqual(factionBody.templates, {
      1: { faction: 1, factionGroup: 2, friendGroup: 2, enemyGroup: 4, enemies: [], friends: [] },
      2: { faction: 2, factionGroup: 4, friendGroup: 4, enemyGroup: 2, enemies: [], friends: [] },
    });
    assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/dbc/factions`)).status, 403);
    const creatures = await fetch(`http://127.0.0.1:${gateway.port}/data/creatures?entries=123`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(creatures.status, 200);
    assert.deepEqual(await creatures.json(), [{ entry: 123, name: "Лесной волк", subname: "", type: 1, family: 1, rank: 0 }]);
    const items = await fetch(`http://127.0.0.1:${gateway.port}/data/items?entries=25`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(items.status, 200);
    assert.deepEqual(await items.json(), [{ entry: 25, name: "Потрёпанный меч", displayId: 220, quality: 1, inventoryType: 13, stackable: 1, iconId: 7 }]);
    const itemIcon = await fetch(`http://127.0.0.1:${gateway.port}/item-icon/220`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(itemIcon.status, 200);
    assert.equal(itemIcon.headers.get("content-type"), "image/png");
    // The server's own collision geometry, group by group. Whole on the first request because it
    // is small; a city answers with its boxes and waits to be asked for the rooms that matter.
    const collision = await fetch(`http://127.0.0.1:${gateway.port}/collision/model/Hut.wmo`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(collision.status, 200);
    const decoded = decodeCollisionModel(await collision.arrayBuffer());
    assert.equal(decoded.groups.length, 2);
    assert.deepEqual(decoded.groups.map((group) => group.groupId), [701, 702],
      "the authored ids after each .vmo group's flags survive the gateway");
    assert.deepEqual([...decoded.groups[0].vertices], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.deepEqual([...decoded.groups[1].vertices], [10, 10, 0, 11, 10, 0, 10, 11, 0]);

    const oneGroup = await fetch(`http://127.0.0.1:${gateway.port}/collision/model/Hut.wmo?groups=1`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    const partial = decodeCollisionModel(await oneGroup.arrayBuffer());
    assert.equal(partial.groups[0].vertices, undefined, "a group nobody asked for costs nothing");
    assert.equal(partial.groups[0].triangleCount, 1, "and its size is still on the wire");
    assert.equal(partial.groups[0].groupId, 701, "group identity remains in a header-only entry");
    assert.deepEqual([...partial.groups[1].indices], [0, 1, 2]);
    assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/collision/model/Hut.wmo`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/collision/model/Missing.wmo`, {
      headers: { origin: "http://127.0.0.1:5173" },
    })).status, 204);

    const model = await fetch(`http://127.0.0.1:${gateway.port}/environment/model/Triangle.wmo`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(model.status, 200);
    const modelData = new DataView(await model.arrayBuffer());
    assert.equal(modelData.getUint32(0, true), 3);
    assert.equal(modelData.getUint32(4, true), 3);
    assert.deepEqual([modelData.getUint32(44, true), modelData.getUint32(48, true), modelData.getUint32(52, true)], [0, 1, 2]);
    const visualEnvironment = await fetch(`http://127.0.0.1:${gateway.port}/visual/environment/0/32/32`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(visualEnvironment.status, 200);
    assert.equal((await visualEnvironment.json())[0].name, visualPath);
    const visualModel = await fetch(`http://127.0.0.1:${gateway.port}/visual/model?path=${encodeURIComponent(visualPath)}`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(visualModel.status, 200);
    assert.equal(Buffer.from(await visualModel.arrayBuffer()).toString(), "WVM2-test");
    const skyboxModel = await fetch(`http://127.0.0.1:${gateway.port}/visual/model?path=${encodeURIComponent(skyboxPath)}`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(skyboxModel.status, 200);
    assert.equal(Buffer.from(await skyboxModel.arrayBuffer()).toString(), "WVM2-dalaran-sky");
    // Separators differ between references to the same model; both must reach one artifact.
    const again = await fetch(`http://127.0.0.1:${gateway.port}/visual/model?path=${encodeURIComponent(visualPath.replaceAll("\\", "/"))}`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(again.status, 200);
    assert.equal(Buffer.from(await again.arrayBuffer()).toString(), "WVM2-test");
    // One key, two files: the animations a model holds back are addressed by the same path.
    const heldBack = await fetch(`http://127.0.0.1:${gateway.port}/visual/animations?path=${encodeURIComponent(visualPath)}`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(heldBack.status, 200);
    assert.equal(Buffer.from(await heldBack.arrayBuffer()).toString(), "WVA1-test");
    const badModel = await fetch(`http://127.0.0.1:${gateway.port}/visual/model?path=${encodeURIComponent("..\\escape.m2")}`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(badModel.status, 400);

    // One room of a building too big to send whole. Named by number under the model's own key, so
    // the header and every group it lists are one artifact addressed one way.
    const room = await fetch(`http://127.0.0.1:${gateway.port}/visual/model?path=${encodeURIComponent(visualPath)}&group=7`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(room.status, 200);
    assert.equal(Buffer.from(await room.arrayBuffer()).toString(), "WWM1-room-7");
    const missingRoom = await fetch(`http://127.0.0.1:${gateway.port}/visual/model?path=${encodeURIComponent(visualPath)}&group=8`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(missingRoom.status, 404);
    const badRoom = await fetch(`http://127.0.0.1:${gateway.port}/visual/model?path=${encodeURIComponent(visualPath)}&group=-1`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(badRoom.status, 400, "a group is a number, and a rejected one must not reach the filesystem");

    // An ampersand is in the client's own directory names, and a 400 is never retried, so a path
    // class that omits it loses those models permanently. Measured over 46,064 placement names
    // from real tiles, `&` is the only character outside the class that occurs at all — 780 times,
    // every one of them in `PASSIVE DOODADS\FOOD&UTENSILS` or `WEAPONS&ARMOR`. This asks for a
    // model that does not exist in the fixture, so 404 is the right answer: what matters is that
    // it is not 400, because 400 means the request never reached the archives.
    const ampersand = await fetch(
      `http://127.0.0.1:${gateway.port}/visual/model?path=${encodeURIComponent("World\\Generic\\Human\\Passive Doodads\\Food&Utensils\\TurkeyLeg.m2")}`,
      { headers: { origin: "http://127.0.0.1:5173" } });
    assert.equal(ampersand.status, 404, "an ampersand is a filename character, not a rejection");

    // A failure has to carry the CORS header as well, or the browser hides the real status behind
    // a cross-origin error and a missing model looks like a misconfigured gateway.
    for (const [label, failing] of [
      ["rejected request", `/visual/model?path=${encodeURIComponent("../escape.m2")}`],
      ["missing model", `/visual/model?path=${encodeURIComponent("World\\Absent.m2")}`],
      ["missing terrain tile", "/terrain/0/1/1"],
      ["missing splat", "/terrain-splat/0/1/1"],
      ["missing ground texture", `/terrain-layer/${"0".repeat(40)}.png`],
    ]) {
      const response = await fetch(`http://127.0.0.1:${gateway.port}${failing}`, {
        headers: { origin: "http://127.0.0.1:5173" },
      });
      assert.ok(response.status >= 400, `${label} should fail`);
      assert.equal(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173", `${label} needs the CORS header`);
    }

    // A rejected origin is the one case that must not be echoed back.
    const forbidden = await fetch(`http://127.0.0.1:${gateway.port}/terrain/0/32/32`, {
      headers: { origin: "http://evil.example:5173" },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.headers.get("access-control-allow-origin"), null);
    const visualTexture = await fetch(`http://127.0.0.1:${gateway.port}/visual/texture/${visualHash}-0.png`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(visualTexture.status, 200);
    assert.equal(visualTexture.headers.get("content-type"), "image/png");
    const initialTextureTag = visualTexture.headers.get("etag");
    assert.match(initialTextureTag ?? "", /^"[0-9a-f]{40}"$/, "WMO textures need a content validator");
    assert.equal(visualTexture.headers.get("cache-control"), "public, max-age=0, must-revalidate");

    // A republished WMO keeps the same hash-keyed filename. A browser must therefore be able to
    // revalidate the old URL and receive the new bytes instead of retaining the former 24-hour
    // response. The conditional request also pins the 304 path used by a normal browser cache.
    const republishedTexture = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x01);
    await writeFile(join(visualModelsDirectory, `${visualHash}-0.png`), republishedTexture);
    const refreshedTexture = await fetch(`http://127.0.0.1:${gateway.port}/visual/texture/${visualHash}-0.png`, {
      headers: { origin: "http://127.0.0.1:5173", "if-none-match": initialTextureTag },
    });
    assert.equal(refreshedTexture.status, 200, "changed WMO bytes must invalidate the old validator");
    assert.notEqual(refreshedTexture.headers.get("etag"), initialTextureTag);
    assert.deepEqual(new Uint8Array(await refreshedTexture.arrayBuffer()), republishedTexture);
    const refreshedTag = refreshedTexture.headers.get("etag");
    const unchangedTexture = await fetch(`http://127.0.0.1:${gateway.port}/visual/texture/${visualHash}-0.png`, {
      headers: { origin: "http://127.0.0.1:5173", "if-none-match": refreshedTag },
    });
    assert.equal(unchangedTexture.status, 304, "unchanged WMO bytes should use conditional revalidation");
    assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/visual/model?path=..%5Csecret.m2`, {
      headers: { origin: "http://127.0.0.1:5173" },
    })).status, 400);
  } finally {
    await gateway.close();
    await rm(mapsDirectory, { recursive: true, force: true });
    await rm(vmapsDirectory, { recursive: true, force: true });
    await rm(dbcDirectory, { recursive: true, force: true });
    await rm(buildingsDirectory, { recursive: true, force: true });
    await rm(visualTilesDirectory, { recursive: true, force: true });
    await rm(visualModelsDirectory, { recursive: true, force: true });
  }
});

test("Spell DBC metadata resolves localized names, icon paths and cooldowns", () => {
  const files = spellDbcs();
  assert.deepEqual(parseSpellMetadata(files.spells, files.icons, files.durations, files.radii, files.categories,
    files.descriptionVariables, files.ranges, files.castTimes).get(133), {
    id: 133,
    name: "Огненный шар",
    rank: "Ранг 1",
    description: "Бросает огненный шар.",
    iconId: 7,
    iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt",
    passive: false,
    autoRepeat: false,
    // The bit that actually means "keep me out of the spellbook", carried beside the passive one
    // because they are different questions: a passive spell is listed and greyed, a hidden one is
    // not listed at all.
    hidden: false,
    powerType: 0,
    powerCost: 30,
    // K1: the percentage the spellbook prices a caster's spells from. On the real dataset 6,728 of
    // the 7,369 spells that reach the book have `ManaCost = 0` and 1,543 of those carry this
    // instead, so without it the cost line is absent from every mage, priest, warlock, druid and
    // shaman spell there is.
    powerCostPercent: 8,
    recoveryTime: 8000,
    categoryRecoveryTime: 12000,
    startRecoveryTime: 1500,
    cooldownStartedOnEvent: true,
    // The rank chain's key, which is the only thing in 3.3.5a that says two rows of one name are
    // two ranks of one spell: `SpellChain.dbc` does not exist and `SupercededBySpell` is filled on
    // 1,059 of 10,220 `SkillLineAbility` rows, none of them the sixteen «Огненный шар» ones.
    spellLevel: 1,
    spellClassSet: 3,
    spellClassMask: [1, 0, 0],
    schoolMask: 4,
    // Two more indexes resolved here rather than served raw, exactly like the duration and radius
    // above: 65 rows of `SpellRange` and 71 of `SpellCastTimes` on the real dataset.
    rangeMin: 0,
    rangeMax: 35,
    // And the flags beside them, because the yards alone are not the tooltip's answer: 544 of the
    // book's 7,369 spells resolve to row 2, whose 5 yards mean «melee» rather than five of
    // anything, and the browser has nothing else to tell that row from a five-yard spell.
    rangeFlags: 2,
    castTime: 1500,
    effectAura: [0, 0, 0],
    effectMiscValue: [0, 0, 0],
    // Everything a `$`-marker is made of. Served raw for the effect columns and resolved for the
    // two that are indexes: a browser holding an index into a table it does not have holds nothing.
    effectBasePoints: [13, 0, 0],
    effectDieSides: [9, 0, 0],
    effectPeriod: [3000, 0, 0],
    effectChainTargets: [2, 0, 0],
    effectRadius: [8.5, 0, 0],
    duration: 12000,
    maxDuration: 15000,
    // 101 in the table means "always" and is written on 44,180 rows; left alone it would put
    // "101%" on every tooltip that mentions a chance.
    procChance: 100,
    // The side table is optional for old/custom datasets, but this fixture carries it and exposes
    // the authored macro body alongside the id.
    descriptionVariablesId: 5,
    descriptionVariables: "$damage=42",
  });

  // The tracking columns reach the browser, which is the only way it can tell a tracking spell
  // from any other: `SPELL_AURA_TRACK_RESOURCES` with a one-based `LockType` beside it.
  const tracker = parseSpellMetadata(files.spells, files.icons, files.durations, files.radii, files.categories).get(2383);
  assert.deepEqual(tracker.effectAura, [45, 0, 0]);
  assert.deepEqual(tracker.effectMiscValue, [2, 0, 0]);
  assert.equal(tracker.cooldownStartedOnEvent, true, "the Attributes flag is exposed independently");
  assert.equal(
    parseSpellMetadata(files.spells, files.icons, files.durations, files.radii, files.categories)
      .get(9999)?.cooldownStartedOnEvent,
    false,
    "ordinary spells do not defer cooldown to an event",
  );
});

test("GameObject display DBC resolves VMAP model filenames", () => {
  // The full path, not the basename: the browser asks /visual/model with it and only derives
  // the basename itself for the VMAP fallback. Reducing it here guaranteed every game object
  // was an untextured collision hull, and wasted a doomed generation per display.
  assert.deepEqual(parseGameObjectDisplayMetadata(gameObjectDbc()).get(1), { id: 1, model: "World\\Generic\\ActiveDoodads\\Chest02\\Chest02.m2" });
});

test("VMAP tile parser converts internal positions and bounds to world coordinates", () => {
  const [object] = parseVMapTile(vmapTile());
  assert.equal(object.kind, "m2");
  assert.equal(object.id, 123);
  assert.ok(Math.abs(object.x - 100) < 0.01);
  assert.ok(Math.abs(object.y - 200) < 0.01);
  assert.ok(Math.abs(object.bounds.minX - 98) < 0.01);
  assert.ok(Math.abs(object.bounds.maxY - 203) < 0.01);
});

test("VMAP building parser exposes collision vertices and triangles", () => {
  assert.deepEqual(parseVMapModel(vmapModel()), {
    vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
  });
});

test("a failed generation is remembered, so one broken asset stops re-entering the lane", async () => {
  const visualModelsDirectory = await mkdtemp(join(tmpdir(), "webclient-negcache-"));
  let attempts = 0;
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    visualModelsDirectory,
    generateVisualModel: () => {
      attempts++;
      return Promise.reject(Object.assign(
        new Error("Model World\\Missing.m2 is not in the client"), { exitCode: SOURCE_MISSING_EXIT }));
    },
  });
  try {
    const url = `http://127.0.0.1:${gateway.port}/visual/model?path=World%5CMissing.m2`;
    const headers = { origin: "http://localhost:5173" };
    for (let request = 0; request < 5; request++) {
      const response = await fetch(url, { headers });
      assert.equal(response.status, 404);
      // Error responses still carry the header, or the browser reports every failure as CORS.
      assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
      await response.arrayBuffer();
    }
    assert.equal(attempts, 1, "the generator should have run once, not once per request");
  } finally {
    await gateway.close();
    await rm(visualModelsDirectory, { recursive: true, force: true });
  }
});

test("Ж0 a model the client does not hold is a 404, and a generator that died is a 500", async () => {
  // The twin of the `/texture` split Т6 made, on the route that was left without it. Every way of
  // failing here answered 404 — and `EnvironmentClient` takes a 404 as final and never asks again,
  // so one dead generator child cost a building for the life of the tab. In Orgrimmar, whose 92
  // models were published over 130.8 s of the owner's own session at 1.42 s apiece, that is a long
  // window in which to lose a city and get a grey box in its place.
  //
  // `tools/generate-visual-model.mjs` is the end that chooses the code, so the number is pinned
  // across the process boundary the same way `generate-texture.mjs`'s already is.
  // Pinned by running the real generator, because it cannot be imported: it is a script whose body
  // is top-level `await`, and the whole difficulty of giving it this exit code was that a rejection
  // out of one of those is fatal before any handler can see it. A loose patch directory with one
  // file in it is a client chain that opens and holds nothing, so this needs no 3.3.5a install.
  const emptyClient = await mkdtemp(join(tmpdir(), "webclient-nomodel-"));
  const models = await mkdtemp(join(tmpdir(), "webclient-nomodel-out-"));
  try {
    await mkdir(join(emptyClient, "Data", "ruRU", "patch-ruRU-A.MPQ", "World"), { recursive: true });
    await writeFile(join(emptyClient, "Data", "ruRU", "patch-ruRU-A.MPQ", "World", "keep.txt"), "x");
    const child = await promisify(execFile)(
      process.execPath,
      [join(repositoryRoot, "tools", "generate-visual-model.mjs"), "World\\Absent.m2", "0".repeat(40)],
      { cwd: repositoryRoot, env: { ...process.env, CLIENT_DIR: emptyClient, VISUAL_MODEL_DIR: models } },
    ).catch((error) => error);
    assert.equal(child.code, SOURCE_MISSING_EXIT,
      "the generator has to say «not in the client» in the one way that survives the process boundary");
    assert.match(child.stderr, /World\\Absent\.m2 is not in the client/,
      "and the sentence the gateway relays has to survive the exit as well");
  } finally {
    await rm(emptyClient, { recursive: true, force: true });
    await rm(models, { recursive: true, force: true });
  }

  const visualModelsDirectory = await mkdtemp(join(tmpdir(), "webclient-modelsplit-"));
  const absent = "World\\Absent.m2";
  const crashed = "World\\Crashed.m2";
  let runs = 0;
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    visualModelsDirectory,
    generateVisualModel: (path) => {
      runs++;
      // What the generator does for a path the archives hold no file for.
      if (path === absent) {
        return Promise.reject(Object.assign(
          new Error(`Model ${path} is not in the client`), { exitCode: SOURCE_MISSING_EXIT }));
      }
      // And what a child that died looks like from here: no message worth reading, and the exit
      // code Windows gives an access violation.
      return Promise.reject(Object.assign(
        new Error("generate-visual-model.mjs exited with 3221225477"), { exitCode: 3221225477 }));
    },
    datasetPollMs: 0,
  });
  const headers = { origin: "http://127.0.0.1:5173" };
  const ask = (path) => fetch(
    `http://127.0.0.1:${gateway.port}/visual/model?path=${encodeURIComponent(path)}`, { headers });
  try {
    assert.equal((await ask(crashed)).status, 500, "a generator that died is this minute's problem");
    assert.equal((await ask(absent)).status, 404, "a model the client has not got is the browser's answer");
    assert.equal(runs, 2);

    // And the five-minute memory of a failure has to answer with the same news the run gave, or
    // the second request for a model that is simply not there sends the browser back four times.
    assert.equal((await ask(crashed)).status, 500);
    assert.equal((await ask(absent)).status, 404);
    assert.equal(runs, 2, "and neither generator ran again inside the TTL");
  } finally {
    await gateway.close();
    await rm(visualModelsDirectory, { recursive: true, force: true });
  }
});

test("a format bump rebuilds one artifact at a time and deletes nothing", async () => {
  // What the owner pays for `visual-v16`, and what nobody has to do by hand. The key is part of the
  // file's name, so an artifact published under the old one is simply never asked for again: the
  // route misses, the generator runs, and the stale file stays on the disk until somebody clears
  // it. The fingerprint pass never drops an entry that has no stamp and cannot recover the path a
  // model artifact was built from — `tools/restamp.mjs` counts those and leaves them — so nothing
  // else is going to come back for them either.
  const visualModelsDirectory = await mkdtemp(join(tmpdir(), "webclient-bump-"));
  const dbcDirectory = await mkdtemp(join(tmpdir(), "webclient-bump-dbc-"));
  const path = "World\\Tree.m2";
  const stale = createHash("sha1").update(`visual-v13\0${path.toLowerCase()}`).digest("hex");
  const current = createHash("sha1").update(`visual-v16\0${path.toLowerCase()}`).digest("hex");
  await writeFile(join(visualModelsDirectory, `${stale}.bin`), Buffer.from("WVM8-artifact"));
  let generated = 0;
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    visualModelsDirectory,
    // Configured so the dataset really is watched and `ensureCurrent` runs on the miss path.
    dbcDirectory,
    generateVisualModel: async (modelPath, hash) => {
      generated++;
      assert.equal(modelPath, path);
      assert.equal(hash, current, "the generator is asked for the new key, not the old one");
      await writeFile(join(visualModelsDirectory, `${hash}.bin`), Buffer.from("WVM9-artifact"));
    },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/visual/model?path=${encodeURIComponent(path)}`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(response.status, 200);
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "WVM9-artifact");
    assert.equal(generated, 1, "one model, one child; the rest of the cache is not touched");
    assert.equal((await readFile(join(visualModelsDirectory, `${stale}.bin`))).toString(), "WVM8-artifact",
      "and the artifact under the old key is orphaned, not deleted");
  } finally {
    await gateway.close();
    await rm(visualModelsDirectory, { recursive: true, force: true });
    await rm(dbcDirectory, { recursive: true, force: true });
  }
});

test("the two artifact namespaces move independently and never collide", () => {
  // R5.1 takes WMO to 17 and Э1's WVM9 follows at 16. The families invalidate independently while
  // their generation numbers remain unambiguous to readers and diagnostics.
  assert.equal(visualModelCacheNamespace("World\\Tree.m2"), "visual-v16");
  assert.equal(visualModelCacheNamespace("World\\Stormwind.WMO"), "visual-wmo-v17");
});

test("a rebuilt DBC is answered without restarting the gateway", async () => {
  // The whole point of the dataset fingerprint. Every DBC index was memoised for the life of the
  // process and cleared by nothing, so a module could add a spell, rebuild, and go on being told
  // what the table said when the gateway started — for the four other workstreams that edit DBCs
  // this was the difference between a fix that works and a fix that looks like it does nothing.
  const dbcDirectory = await mkdtemp(join(tmpdir(), "webclient-reload-"));
  const files = spellDbcs();
  await writeFile(join(dbcDirectory, "Spell.dbc"), files.spells);
  await writeFile(join(dbcDirectory, "SpellIcon.dbc"), files.icons);
  await writeFile(join(dbcDirectory, "SpellDuration.dbc"), files.durations);
  await writeFile(join(dbcDirectory, "SpellRadius.dbc"), files.radii);
  await writeFile(join(dbcDirectory, "SpellCategory.dbc"), files.categories);
  await writeFile(join(dbcDirectory, "SpellRange.dbc"), files.ranges);
  await writeFile(join(dbcDirectory, "SpellCastTimes.dbc"), files.castTimes);
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    dbcDirectory,
    // Every request, so the test does not have to sleep out the default two seconds.
    datasetPollMs: 0,
  });
  const headers = { origin: "http://127.0.0.1:5173" };
  const spellName = async () => {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/dbc/spells?ids=133`, { headers });
    assert.equal(response.status, 200);
    const [spell] = await response.json();
    return spell.name;
  };
  try {
    assert.equal(await spellName(), "Огненный шар");
    // A module renames the spell and rebuilds. Nothing restarts, nothing is asked over the network.
    await writeFile(join(dbcDirectory, "Spell.dbc"), spellDbcs("Огненный шарик").spells);
    assert.equal(await spellName(), "Огненный шарик");
  } finally {
    await gateway.close();
    await rm(dbcDirectory, { recursive: true, force: true });
  }
});

test("emote route keeps dataset text and active client-media sound rows separate", async () => {
  const dbcDirectory = await mkdtemp(join(tmpdir(), "webclient-emote-dbc-"));
  const audioDbcDirectory = await mkdtemp(join(tmpdir(), "webclient-emote-audio-"));
  const strings = stringBlock(["wave", "Иван машет рукой."]);
  const text = Array(19).fill(0);
  text[0] = 101;
  text[1] = strings.offsets.get("wave");
  text[2] = 3;
  text[3] = 201;
  const sentence = Array(18).fill(0);
  sentence[0] = 201;
  sentence[1] = strings.offsets.get("Иван машет рукой.");
  await writeFile(join(dbcDirectory, "EmotesText.dbc"), dbcFixture(19, [text], strings.bytes));
  await writeFile(join(dbcDirectory, "EmotesTextData.dbc"), dbcFixture(18, [sentence], strings.bytes));
  await writeFile(join(audioDbcDirectory, "EmotesTextSound.dbc"), dbcFixture(5, [
    [1, 101, 1, 0, 2942],
  ], new Uint8Array([0])));
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    dbcDirectory, audioDbcDirectory, datasetPollMs: 0,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/dbc/emotes?v=2`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.emotes[0].command, "wave");
    assert.deepEqual(body.sounds, [{ id: 1, textEmoteId: 101, raceId: 1, gender: 0, soundId: 2942 }]);
    // The audio DBC is one of the fingerprinted client-media inputs: replacing the override is
    // visible without restarting the gateway, while the dataset-owned text row stays untouched.
    await writeFile(join(audioDbcDirectory, "EmotesTextSound.dbc"), dbcFixture(5, [
      [1, 101, 1, 0, 2943],
      [2, 101, 1, 1, 2944],
    ], new Uint8Array([0])));
    const changed = await fetch(`http://127.0.0.1:${gateway.port}/dbc/emotes?v=2`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.deepEqual((await changed.json()).sounds, [
      { id: 1, textEmoteId: 101, raceId: 1, gender: 0, soundId: 2943 },
      { id: 2, textEmoteId: 101, raceId: 1, gender: 1, soundId: 2944 },
    ]);
  } finally {
    await gateway.close();
    await rm(dbcDirectory, { recursive: true, force: true });
    await rm(audioDbcDirectory, { recursive: true, force: true });
  }
});

test("a texture replaced in a patch directory is republished for the same path", async () => {
  // The other half: the answer is not in memory but on disk, keyed on the path alone. A module
  // that overrides a stock texture keeps the path, so `data/textures` served the old picture for
  // as long as the file sat there — and it sits there until somebody deletes 71 MB by hand.
  const client = await mkdtemp(join(tmpdir(), "webclient-patchdir-"));
  const texturesDirectory = await mkdtemp(join(tmpdir(), "webclient-textures-"));
  const texturePath = "Tileset\\Test.blp";
  const loose = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "Tileset", "Test.blp");
  await mkdir(join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "Tileset"), { recursive: true });
  await writeFile(loose, "BLP-one");

  // Stands in for tools/generate-texture.mjs: read through the real chain, publish, stamp. The
  // stamp is written by the same helper the real generators use, so the format cannot drift.
  const generateTexture = async (path) => {
    const chain = await openClientArchives(client);
    try {
      const data = await chain.read(path);
      if (!data) throw new Error(`${path} is not in the client`);
      const id = createHash("sha1").update(`texture-v1\0${path.toLowerCase()}`).digest("hex");
      const destination = join(texturesDirectory, `${id}.png`);
      await writeFile(destination, data);
      await writeSourceStamp(destination, await sourceStamp(chain, { paths: [path] }));
    } finally {
      chain.close();
    }
  };

  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    clientDirectory: client,
    texturesDirectory,
    generateTexture,
    datasetPollMs: 0,
  });
  const headers = { origin: "http://127.0.0.1:5173" };
  const url = `http://127.0.0.1:${gateway.port}/texture?path=${encodeURIComponent(texturePath)}`;
  try {
    const first = await fetch(url, { headers });
    assert.equal(first.status, 200);
    assert.equal(await first.text(), "BLP-one");

    // Replaced in the overlay, the way a module replaces a stock texture. Longer as well as
    // different, because a rewrite inside the same millisecond leaves the mtime alone.
    await writeFile(loose, "BLP-two-and-longer");
    const second = await fetch(url, { headers });
    assert.equal(second.status, 200);
    assert.equal(await second.text(), "BLP-two-and-longer");

    // And the file that was not touched is not rebuilt: the point is one entry, not the cache.
    const rebuilt = await fetch(url, { headers });
    assert.equal(await rebuilt.text(), "BLP-two-and-longer");
  } finally {
    await gateway.close();
    await rm(client, { recursive: true, force: true });
    await rm(texturesDirectory, { recursive: true, force: true });
  }
});

test("a cache entry from before stamps existed is served as it stands, and the pass is what stamps it", async () => {
  // The other half of the rule above, and the one that decides what walking into a zone costs.
  // `data/` on this machine holds 23,025 files published before stamps existed, and asking for
  // each of them to be rebuilt the first time it is served is one generator process apiece on a
  // serial lane: measured over sixteen already-published, already-correct ground textures, 5,749
  // ms and 345 to 373 ms each, against 125 ms and no process at all for the same sixteen served
  // as they stand. So nothing is rebuilt on the request path, and the pass the gateway starts at
  // startup is what gives the entry a stamp.
  const client = await mkdtemp(join(tmpdir(), "webclient-patchdir-"));
  const texturesDirectory = await mkdtemp(join(tmpdir(), "webclient-textures-"));
  const texturePath = "Tileset\\Test.blp";
  const loose = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "Tileset", "Test.blp");
  await mkdir(join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "Tileset"), { recursive: true });
  await writeFile(loose, "BLP-from-the-module");

  // Published by a gateway that had never heard of stamps: the right name, no sidecar, and bytes
  // that no longer have anything to do with what the path holds.
  const id = createHash("sha1").update(`texture-v1\0${texturePath.toLowerCase()}`).digest("hex");
  const legacy = join(texturesDirectory, `${id}.png`);
  await writeFile(legacy, "PNG-FROM-BEFORE-STAMPS");

  let generated = 0;
  const generateTexture = async (path) => {
    generated++;
    const chain = await openClientArchives(client);
    try {
      const data = await chain.read(path);
      if (!data) throw new Error(`${path} is not in the client`);
      const destination = join(texturesDirectory, `${createHash("sha1").update(`texture-v1\0${path.toLowerCase()}`).digest("hex")}.png`);
      await writeFile(destination, data);
      await writeSourceStamp(destination, await sourceStamp(chain, { paths: [path] }));
    } finally {
      chain.close();
    }
  };

  // Held until the test lets it go, because the whole claim is that the request does not wait for
  // it: with the pass free to finish first, "served as it stands" and "served the rebuilt file"
  // are the same bytes and the assertion proves nothing.
  let started = 0;
  let release;
  let finished;
  const held = new Promise((go) => { release = go; });
  const passed = new Promise((done) => { finished = done; });
  const restampCaches = async () => {
    started++;
    await held;
    try {
      await generateTexture(texturePath);
    } finally {
      finished();
    }
  };

  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    clientDirectory: client,
    texturesDirectory,
    generateTexture,
    restampCaches,
    datasetPollMs: 0,
  });
  const headers = { origin: "http://127.0.0.1:5173" };
  const url = `http://127.0.0.1:${gateway.port}/texture?path=${encodeURIComponent(texturePath)}`;
  try {
    assert.equal(started, 1, "the pass is started when the gateway comes up, not by a request");
    const first = await fetch(url, { headers });
    assert.equal(first.status, 200);
    assert.equal(await first.text(), "PNG-FROM-BEFORE-STAMPS", "an entry with no stamp is served as it stands");
    assert.equal(generated, 0, "and nothing is generated to say so");
    await assert.rejects(readFile(stampSidecar(legacy)), "it is the pass that gives it a stamp, not the request");

    // A second request does not start a second pass either — one per startup, and the entries the
    // pass cannot recover would otherwise start one apiece for the life of the process.
    assert.equal((await (await fetch(url, { headers })).text()), "PNG-FROM-BEFORE-STAMPS");
    assert.equal(started, 1);

    release();
    // The pass is what stamps it, and afterwards the ordinary rule above applies again.
    await passed;
    assert.equal(generated, 1);
    await assert.doesNotReject(readFile(stampSidecar(legacy)), "and it can say what it came from now");
  } finally {
    release();
    await gateway.close();
    await rm(client, { recursive: true, force: true });
    await rm(texturesDirectory, { recursive: true, force: true });
  }
});

test("an unstamped character texture is regenerated against the active visual pack", async () => {
  assert.equal(isCharacterVisualTexture("Creature/Wolf/WolfSkin.blp"), true,
    "HD creature skins follow the same coordinated cache policy as playable characters");
  const client = await mkdtemp(join(tmpdir(), "webclient-character-pack-"));
  const texturesDirectory = await mkdtemp(join(tmpdir(), "webclient-character-textures-"));
  const texturePath = "Character\\Human\\Male\\HumanMaleSkin00_00.blp";
  const loose = join(client, "Data", "patch-W.MPQ", ...texturePath.split("\\"));
  await mkdir(join(client, "Data", "patch-W.MPQ", "Character", "Human", "Male"), { recursive: true });
  await writeFile(loose, "PNG-FROM-ACTIVE-HD-PACK");
  const id = createHash("sha1").update(`texture-v1\0${texturePath.toLowerCase()}`).digest("hex");
  await writeFile(join(texturesDirectory, `${id}.png`), "PNG-FROM-STALE-STOCK-CACHE");

  let generated = 0;
  const generateTexture = async (path) => {
    generated++;
    const chain = await openClientArchives(client);
    try {
      const data = await chain.read(path);
      assert.ok(data);
      const destination = join(texturesDirectory, `${createHash("sha1").update(`texture-v1\0${path.toLowerCase()}`).digest("hex")}.png`);
      await writeFile(destination, data);
      await writeSourceStamp(destination, await sourceStamp(chain, { paths: [path] }));
    } finally {
      chain.close();
    }
  };
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    clientDirectory: client, texturesDirectory, generateTexture, datasetPollMs: 0,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/texture?v=1&path=${encodeURIComponent(texturePath)}`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "PNG-FROM-ACTIVE-HD-PACK");
    assert.equal(generated, 1, "the legacy stock cache must not win for a visual character path");
    assert.doesNotReject(readFile(stampSidecar(join(texturesDirectory, `${id}.png`))));
  } finally {
    await gateway.close();
    await rm(client, { recursive: true, force: true });
    await rm(texturesDirectory, { recursive: true, force: true });
  }
});

test("an unstamped visual model is regenerated against the active HD pack", async () => {
  const client = await mkdtemp(join(tmpdir(), "webclient-model-pack-"));
  const visualModelsDirectory = await mkdtemp(join(tmpdir(), "webclient-model-cache-"));
  const modelPath = "Character\\Human\\Male\\HumanMale.m2";
  const loose = join(client, "Data", "patch-W.MPQ", ...modelPath.split("\\"));
  await mkdir(join(client, "Data", "patch-W.MPQ", "Character", "Human", "Male"), { recursive: true });
  await writeFile(loose, "WVM-FROM-ACTIVE-HD-PACK");
  const hash = createHash("sha1")
    .update(`${visualModelCacheNamespace(modelPath)}\0${modelPath.toLowerCase()}`).digest("hex");
  const destination = join(visualModelsDirectory, `${hash}.bin`);
  await writeFile(destination, "WVM-FROM-STALE-STOCK-CACHE");

  let generated = 0;
  const generateVisualModel = async (path, requestedHash) => {
    generated++;
    assert.equal(requestedHash, hash);
    const chain = await openClientArchives(client);
    try {
      const data = await chain.read(path);
      assert.ok(data);
      await writeFile(destination, data);
      await writeSourceStamp(destination, await sourceStamp(chain, { paths: [path] }));
    } finally {
      chain.close();
    }
  };
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    clientDirectory: client, visualModelsDirectory, generateVisualModel, datasetPollMs: 0,
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${gateway.port}/visual/model?path=${encodeURIComponent(modelPath)}&v=1`,
      { headers: { origin: "http://127.0.0.1:5173" } },
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "WVM-FROM-ACTIVE-HD-PACK");
    assert.equal(generated, 1, "an unstamped stock artifact must not survive the HD model switch");
    await assert.doesNotReject(readFile(stampSidecar(destination)));
  } finally {
    await gateway.close();
    await rm(client, { recursive: true, force: true });
    await rm(visualModelsDirectory, { recursive: true, force: true });
  }
});

test("cached HD character assets revalidate to classic bytes after the pack is removed", async () => {
  const client = await mkdtemp(join(tmpdir(), "webclient-hd-classic-client-"));
  const texturesDirectory = await mkdtemp(join(tmpdir(), "webclient-hd-classic-textures-"));
  const visualModelsDirectory = await mkdtemp(join(tmpdir(), "webclient-hd-classic-models-"));
  const texturePath = "Character\\Human\\Male\\HumanMaleSkin00_00.blp";
  const modelPath = "Character\\Human\\Male\\HumanMale.m2";
  const textureId = createHash("sha1")
    .update(`texture-v1\0${texturePath.toLowerCase()}`).digest("hex");
  const modelHash = createHash("sha1")
    .update(`${visualModelCacheNamespace(modelPath)}\0${modelPath.toLowerCase()}`).digest("hex");
  const writePack = async (name, generation) => {
    const root = join(client, "Data", name, "Character", "Human", "Male");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "HumanMaleSkin00_00.blp"), `PNG-FROM-${generation}`);
    await writeFile(join(root, "HumanMale.m2"), `WVM-FROM-${generation}`);
  };
  await writePack("patch-W.MPQ", "HD");

  let textureBuilds = 0;
  let modelBuilds = 0;
  const publish = async (path, destination) => {
    const chain = await openClientArchives(client);
    try {
      const data = await chain.read(path);
      assert.ok(data, `${path} is present in the active synthetic pack`);
      await writeFile(destination, data);
      await writeSourceStamp(destination, await sourceStamp(chain, { paths: [path] }));
    } finally {
      chain.close();
    }
  };
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    clientDirectory: client,
    texturesDirectory,
    visualModelsDirectory,
    datasetPollMs: 0,
    generateTexture: async (path) => {
      textureBuilds++;
      await publish(path, join(texturesDirectory, `${textureId}.png`));
    },
    generateVisualModel: async (path, hash) => {
      modelBuilds++;
      assert.equal(hash, modelHash);
      await publish(path, join(visualModelsDirectory, `${modelHash}.bin`));
    },
  });
  const headers = { origin: "http://127.0.0.1:5173" };
  const textureUrl = `http://127.0.0.1:${gateway.port}/texture?v=2&path=${encodeURIComponent(texturePath)}`;
  const modelUrl = `http://127.0.0.1:${gateway.port}/visual/model?path=${encodeURIComponent(modelPath)}&v=2`;
  try {
    const hdTexture = await fetch(textureUrl, { headers });
    const hdModel = await fetch(modelUrl, { headers });
    assert.equal(await hdTexture.text(), "PNG-FROM-HD");
    assert.equal(await hdModel.text(), "WVM-FROM-HD");
    assert.equal(hdTexture.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    assert.equal(hdModel.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    const textureTag = hdTexture.headers.get("etag");
    const modelTag = hdModel.headers.get("etag");
    assert.match(textureTag ?? "", /^"[0-9a-f]{40}"$/);
    assert.match(modelTag ?? "", /^"[0-9a-f]{40}"$/);

    assert.equal((await fetch(textureUrl, {
      headers: { ...headers, "if-none-match": textureTag },
    })).status, 304, "unchanged coordinated textures use conditional revalidation");
    assert.equal((await fetch(modelUrl, {
      headers: { ...headers, "if-none-match": modelTag },
    })).status, 304, "unchanged visual models use conditional revalidation");

    await rm(join(client, "Data", "patch-W.MPQ"), { recursive: true, force: true });
    await writePack("patch-3.MPQ", "CLASSIC");
    const classicTexture = await fetch(textureUrl, {
      headers: { ...headers, "if-none-match": textureTag },
    });
    const classicModel = await fetch(modelUrl, {
      headers: { ...headers, "if-none-match": modelTag },
    });
    assert.equal(classicTexture.status, 200, "changed texture bytes invalidate the HD validator");
    assert.equal(classicModel.status, 200, "changed model bytes invalidate the HD validator");
    assert.equal(await classicTexture.text(), "PNG-FROM-CLASSIC");
    assert.equal(await classicModel.text(), "WVM-FROM-CLASSIC");
    assert.notEqual(classicTexture.headers.get("etag"), textureTag);
    assert.notEqual(classicModel.headers.get("etag"), modelTag);
    assert.equal(textureBuilds, 2, "the same texture key is rebuilt once per active pack");
    assert.equal(modelBuilds, 2, "the same model key is rebuilt once per active pack");
  } finally {
    await gateway.close();
    await rm(client, { recursive: true, force: true });
    await rm(texturesDirectory, { recursive: true, force: true });
    await rm(visualModelsDirectory, { recursive: true, force: true });
  }
});

test("a texture the client does not hold is a 404, and a generator that died is a 500", async () => {
  // The review's finding, and the half of Т6 that was resting on a status this route never sent.
  // The browser retries a 5xx on the 2 s / 8 s / 30 s backoff and takes a 404 as final — but every
  // way of failing here used to answer 404, so one generator child that died removed that layer,
  // or the whole unit for a baked NPC whose only layer it was, for the life of the tab. That is
  // precisely the failure Т6 was written to end, and Т7 makes it likelier to matter: the first
  // spelling the gateway offers is now one its own listing found in the archives.
  assert.equal(SOURCE_MISSING_EXIT, generatorMissingExit,
    "the gateway and the generator have to mean the same number by it, or every crash reads as 404");

  const client = await mkdtemp(join(tmpdir(), "webclient-patchdir-"));
  const texturesDirectory = await mkdtemp(join(tmpdir(), "webclient-textures-"));
  const crashed = "Tileset\\Crashed.blp";
  const absent = "Tileset\\Absent.blp";
  let runs = 0;
  const generateTexture = async (path) => {
    runs++;
    // What `tools/generate-texture.mjs` does for a path the chain holds no file for.
    if (path === absent) throw Object.assign(new Error(`${path} is not in the client`), { exitCode: SOURCE_MISSING_EXIT });
    // And what a child that died looks like from here: no message worth reading, and the exit code
    // Windows gives an access violation. `main.ts` puts that code on the rejection.
    throw Object.assign(new Error("generate-texture.mjs exited with 3221225477"), { exitCode: 3221225477 });
  };

  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    clientDirectory: client,
    texturesDirectory,
    generateTexture,
    datasetPollMs: 0,
  });
  const headers = { origin: "http://127.0.0.1:5173" };
  const ask = (path) => fetch(
    `http://127.0.0.1:${gateway.port}/texture?path=${encodeURIComponent(path)}`, { headers });
  try {
    assert.equal((await ask(crashed)).status, 500, "a generator that died is this minute's problem");
    assert.equal((await ask(absent)).status, 404, "a source the client has not got is the browser's answer");
    assert.equal(runs, 2);

    // And the five-minute memory of a failure has to answer with the same news the run gave. It
    // refuses to run the generator again, so without carrying the reason the second request for a
    // file that is simply not there would answer 500 and send the browser back four more times.
    assert.equal((await ask(crashed)).status, 500);
    assert.equal((await ask(absent)).status, 404);
    assert.equal(runs, 2, "and neither generator ran again inside the TTL");
  } finally {
    await gateway.close();
    await rm(client, { recursive: true, force: true });
    await rm(texturesDirectory, { recursive: true, force: true });
  }
});

test("the gateway caps how many sockets one caller may bridge", async () => {
  const backend = createServer((socket) => socket.on("error", () => {}));
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendPort = backend.address().port;
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: backendPort },
    world: { host: "127.0.0.1", port: backendPort },
    allowedOrigins: ["http://localhost:5173"],
  });
  const sockets = [];
  try {
    const open = (index) => new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/auth`, { origin: "http://localhost:5173" });
      sockets.push(socket);
      socket.once("open", () => resolve({ index, ok: true }));
      socket.once("unexpected-response", (_, response) => resolve({ index, ok: false, status: response.statusCode }));
      socket.once("error", (error) => (socket.readyState === WebSocket.CONNECTING ? resolve({ index, ok: false }) : reject(error)));
    });

    const accepted = [];
    for (let index = 0; index < 8; index++) accepted.push(await open(index));
    assert.ok(accepted.every((result) => result.ok), "the first eight from one address are allowed");

    const refused = await open(8);
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 503);
  } finally {
    for (const socket of sockets) socket.terminate();
    await gateway.close();
    await new Promise((resolve) => backend.close(resolve));
  }
});

/**
 * One request with the path written exactly as given.
 *
 * `fetch` folds `..` out of a URL before it reaches the socket, so it cannot ask the question this
 * one asks: what a client that does not normalise gets.
 */
function rawStatus(port, path) {
  return new Promise((resolve, reject) => {
    const call = httpRequest({ host: "127.0.0.1", port, path, headers: { origin: "http://localhost:5173" } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    call.once("error", reject);
    call.end();
  });
}

test("the module index lists message schemas, and the file route hands one over", async () => {
  const moduleRoot = await mkdtemp(join(tmpdir(), "webclient-modules-"));
  const draftRoot = await mkdtemp(join(tmpdir(), "webclient-drafts-"));
  const missingRoot = join(moduleRoot, "not-a-directory");
  const schema = JSON.stringify({
    messages: [{ name: "shop.State", opcode: 4001, direction: "in", fields: [{ name: "gold", type: "u32" }] }],
  });
  await mkdir(join(moduleRoot, "shop", "content", "messages"), { recursive: true });
  await writeFile(join(moduleRoot, "shop", "content", "messages", "shop.json"), schema);
  // A module with nothing for this client is left out of the index entirely, which is what keeps
  // today's answer `{"modules":[]}` rather than a row per module directory on the machine.
  await mkdir(join(moduleRoot, "silent", "content", "ui"), { recursive: true });
  // A draft carries no `content/` level: it is nobody's build output.
  await mkdir(join(draftRoot, "bank", "messages"), { recursive: true });
  await writeFile(join(draftRoot, "bank", "messages", "bank.json"), schema);
  // Over the 256 KiB ceiling: left out of the index rather than listed and then refused, because
  // the browser fetches everything the index names.
  await writeFile(join(draftRoot, "bank", "messages", "huge.json"), "x".repeat(300 * 1024));

  const roots = [
    { root: moduleRoot, inner: "content", source: "module" },
    { root: draftRoot, inner: "", source: "draft" },
    // A root that does not exist is the ordinary case — `data/ui` is absent until somebody drafts
    // something — and must contribute nothing rather than fail the whole index.
    { root: missingRoot, inner: "", source: "draft" },
  ];
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    moduleDirectories: roots,
  });
  const headers = { origin: "http://localhost:5173" };
  try {
    const index = await fetch(`http://127.0.0.1:${gateway.port}/modules/index`, { headers });
    assert.equal(index.status, 200);
    // Nothing may hold this: the whole point of the route is to notice that a file was saved.
    assert.equal(index.headers.get("cache-control"), "no-store");
    const listed = await index.json();
    assert.deepEqual(listed.modules.map((entry) => entry.module), ["shop", "bank"]);
    assert.deepEqual(listed.modules[1].messages.map((file) => file.file), ["bank.json"]);
    // Which root answered is said per file rather than per module: one module can be answered from
    // both at once, one file drafted and the rest its own.
    assert.deepEqual(listed.modules.map((entry) => entry.messages.map((one) => one.source)),
      [["module"], ["draft"]]);
    const [file] = listed.modules[0].messages;
    assert.equal(file.file, "shop.json");
    assert.equal(file.bytes, Buffer.byteLength(schema));
    // sha1 of the contents rather than the mtime: an editor that saves on every keystroke moves
    // the mtime constantly and the hash only when there is something to rebuild.
    assert.equal(file.sha1, createHash("sha1").update(schema).digest("hex"));
    assert.ok(file.mtimeMs > 0);

    const served = await fetch(`http://127.0.0.1:${gateway.port}/modules/messages/shop/shop.json`, { headers });
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.deepEqual(await served.json(), JSON.parse(schema));

    // The refusals, in the order a browser meets them.
    assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/modules/index`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/modules/messages/shop/shop.json`)).status, 403);
    // A `..` written plainly never survives to the handler: `new URL()` folds it out of the
    // pathname before anything here looks at it, so `/modules/messages/../shop.json` arrives as
    // `/modules/shop.json` and matches no route. What can still arrive is a separator or a dot that
    // was percent-encoded, because `%2F` and `%2E` stay encoded in `pathname` — those are the ones
    // the validator has to refuse, and it refuses them by shape rather than by looking for "..".
    for (const path of [
      "/modules/messages/shop%2Fx/y.json",
      "/modules/messages/shop/..%2Fpasswd.json",
      "/modules/messages/shop/%2E%2E.json",
      "/modules/messages/shop/shop.txt",
      "/modules/messages/shop/sub/shop.json",
      "/modules/messages/shop",
      "/modules/messages/shop/.json",
    ]) {
      const refused = await fetch(`http://127.0.0.1:${gateway.port}${path}`, { headers });
      assert.equal(refused.status, 400, `${path} should be a 400`);
      // Even a refusal carries the header, or the browser reports the status as a CORS failure.
      assert.equal(refused.headers.get("access-control-allow-origin"), "http://localhost:5173");
    }
    // And a client that does not normalise at all — `fetch` does, `node:http` does not — gets
    // nothing either: the folded path leaves the route's prefix behind.
    assert.equal(await rawStatus(gateway.port, "/modules/messages/shop/../../../../../etc/hosts"), 404);
    assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/modules/messages/shop/absent.json`, { headers })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/modules/messages/nosuch/shop.json`, { headers })).status, 404);
    // Listed nowhere, but asked for by name it says why rather than pretending it is missing.
    assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/modules/messages/bank/huge.json`, { headers })).status, 413);
  } finally {
    await gateway.close();
    await rm(moduleRoot, { recursive: true, force: true });
    await rm(draftRoot, { recursive: true, force: true });
  }
});

test("a draft shadows one file of a module, and the index lists exactly what the route hands over", async () => {
  // The bug this holds shut: the index used to push one entry per root with no merging, while the
  // file route answered from the first root only. A draft named after a module the machine already
  // has listed that module twice, published a sha1 the route would never return, made the loader
  // fetch the same URL twice — and the second copy was refused by the registry as a collision with
  // its own module: «module "shop": shop.State is already defined by module "shop"».
  const draftRoot = await mkdtemp(join(tmpdir(), "webclient-drafts-"));
  const moduleRoot = await mkdtemp(join(tmpdir(), "webclient-modules-"));
  const message = (name, opcode, field) => JSON.stringify({
    messages: [{ name, opcode, direction: "in", fields: [{ name: field, type: "u32" }] }],
  });
  const drafted = message("shop.State", 4001, "goldBeingTried");
  const shipped = message("shop.State", 4001, "gold");
  const prices = message("shop.Prices", 4003, "entry");
  await mkdir(join(draftRoot, "shop", "messages"), { recursive: true });
  await writeFile(join(draftRoot, "shop", "messages", "shop.json"), drafted);
  await mkdir(join(moduleRoot, "shop", "content", "messages"), { recursive: true });
  await writeFile(join(moduleRoot, "shop", "content", "messages", "shop.json"), shipped);
  // Not drafted, so it is still the module's own — shadowing is per file, or trying one change
  // would mean taking the rest of the module out of the running.
  await writeFile(join(moduleRoot, "shop", "content", "messages", "prices.json"), prices);

  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    moduleDirectories: [
      { root: draftRoot, inner: "", source: "draft" },
      { root: moduleRoot, inner: "content", source: "module" },
    ],
  });
  const headers = { origin: "http://localhost:5173" };
  try {
    const listed = await (await fetch(`http://127.0.0.1:${gateway.port}/modules/index`, { headers })).json();
    assert.equal(listed.modules.length, 1, "one module, however many roots hold a directory of that name");
    assert.deepEqual(listed.modules[0].messages.map((file) => [file.file, file.source]),
      [["prices.json", "module"], ["shop.json", "draft"]]);

    // The invariant the review was about: every sha1 in the index is the sha1 of the bytes the
    // only route that exists will answer with. Checked by fetching each one and hashing it.
    for (const file of listed.modules[0].messages) {
      const served = await fetch(`http://127.0.0.1:${gateway.port}/modules/messages/shop/${file.file}`, { headers });
      assert.equal(served.status, 200);
      const body = Buffer.from(await served.arrayBuffer());
      assert.equal(createHash("sha1").update(body).digest("hex"), file.sha1, `${file.file} is the copy the index named`);
      assert.equal(body.byteLength, file.bytes);
    }
    // And it is the draft that wins, which is the only thing that makes `data/ui` a place to try a
    // change rather than a place files go to be ignored.
    const served = await fetch(`http://127.0.0.1:${gateway.port}/modules/messages/shop/shop.json`, { headers });
    assert.deepEqual(await served.json(), JSON.parse(drafted));

    // That order is not this test's to choose: it is `moduleDirectories()`'s, and the whole
    // paragraph above is wrong if it ever flips.
    const { moduleDirectories } = await import("../tools/paths.mjs");
    assert.deepEqual(moduleDirectories().map((root) => root.source), ["draft", "module"]);
  } finally {
    await gateway.close();
    await rm(draftRoot, { recursive: true, force: true });
    await rm(moduleRoot, { recursive: true, force: true });
  }
});

test("the index grew windows and stylesheets beside messages, and each kind has its own route", async () => {
  const moduleRoot = await mkdtemp(join(tmpdir(), "webclient-modules-"));
  const draftRoot = await mkdtemp(join(tmpdir(), "webclient-drafts-"));
  const screen = JSON.stringify({ kind: "addon", id: "shop-screen", params: { screen: {} } });
  const sheet = ".row { color: red }";
  const schema = JSON.stringify({
    messages: [{ name: "shop.State", opcode: 4001, direction: "in", fields: [{ name: "gold", type: "u32" }] }],
  });
  await mkdir(join(moduleRoot, "shop", "content", "ui"), { recursive: true });
  await mkdir(join(moduleRoot, "shop", "content", "css"), { recursive: true });
  await mkdir(join(moduleRoot, "shop", "content", "messages"), { recursive: true });
  await writeFile(join(moduleRoot, "shop", "content", "ui", "shop.json"), screen);
  await writeFile(join(moduleRoot, "shop", "content", "css", "shop.css"), sheet);
  await writeFile(join(moduleRoot, "shop", "content", "messages", "shop.json"), schema);
  // A module that ships only a window is still a module. М3's index left out anything with no
  // `messages/` directory, and that rule would have hidden every screen on this machine:
  // `test/content/ui/` is the one such directory a module here actually has.
  await mkdir(join(moduleRoot, "screens-only", "content", "ui"), { recursive: true });
  await writeFile(join(moduleRoot, "screens-only", "content", "ui", "one.json"), screen);

  const roots = [
    { root: draftRoot, inner: "", source: "draft" },
    { root: moduleRoot, inner: "content", source: "module" },
  ];
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    moduleDirectories: roots,
  });
  const headers = { origin: "http://localhost:5173" };
  const at = (path) => `http://127.0.0.1:${gateway.port}${path}`;
  try {
    const listed = await (await fetch(at("/modules/index"), { headers })).json();
    assert.deepEqual(listed.modules.map((entry) => entry.module), ["screens-only", "shop"]);
    const shop = listed.modules.find((entry) => entry.module === "shop");
    // Only added keys: a browser written against М3's answer still finds `messages` where it was.
    assert.deepEqual(shop.messages.map((file) => file.file), ["shop.json"]);
    assert.deepEqual(shop.windows.map((file) => file.file), ["shop.json"]);
    assert.deepEqual(shop.css.map((file) => file.file), ["shop.css"]);
    assert.equal(shop.windows[0].sha1, createHash("sha1").update(screen).digest("hex"));
    const only = listed.modules.find((entry) => entry.module === "screens-only");
    assert.deepEqual([only.messages, only.css], [[], []]);
    assert.equal(only.windows.length, 1);

    const window = await fetch(at("/modules/ui/shop/shop.json"), { headers });
    assert.equal(window.status, 200);
    assert.equal(window.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(await window.json(), JSON.parse(screen));

    const style = await fetch(at("/modules/css/shop/shop.css"), { headers });
    assert.equal(style.status, 200);
    // The content type is the one thing the file routes do not share, and a stylesheet served as
    // JSON is a stylesheet the browser will not apply.
    assert.equal(style.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal(await style.text(), sheet);

    // The same refusals as the messages route, because they come from the same block: a filename is
    // validated against its own kind's extension, so a `.css` asked for on the window route is 400.
    for (const path of [
      "/modules/ui/shop/shop.css",
      "/modules/css/shop/shop.json",
      "/modules/ui/shop%2Fx/y.json",
      "/modules/css/shop/..%2Fx.css",
      "/modules/ui/shop/sub/shop.json",
    ]) {
      assert.equal((await fetch(at(path), { headers })).status, 400, `${path} should be a 400`);
    }
    assert.equal((await fetch(at("/modules/ui/shop/absent.json"), { headers })).status, 404);
    assert.equal((await fetch(at("/modules/ui/shop/shop.json"))).status, 403, "no Origin, no answer");

    // A kind nobody declared is a 404 like any other unknown path — including the ones an object
    // literal answers `in` for. `"constructor" in MODULE_FILE_KINDS` was true, so this walked into
    // the file block, read `.extension` off `Object` and answered 500 with a stack trace in the log.
    for (const path of [
      "/modules/nosuch/shop/absent.json",
      "/modules/constructor/shop/y.json",
      "/modules/constructor/shop/undefined",
      "/modules/toString/shop/undefined",
      "/modules/valueOf/shop/undefined",
    ]) {
      assert.equal((await fetch(at(path), { headers })).status, 404, `${path} should be a 404`);
    }
  } finally {
    await gateway.close();
    await rm(moduleRoot, { recursive: true, force: true });
    await rm(draftRoot, { recursive: true, force: true });
  }
});

test("PUT is refused unless the write flag is set, and then it writes into the drafts root", async () => {
  const draftRoot = await mkdtemp(join(tmpdir(), "webclient-drafts-"));
  const moduleRoot = await mkdtemp(join(tmpdir(), "webclient-modules-"));
  const roots = [
    { root: draftRoot, inner: "", source: "draft" },
    { root: moduleRoot, inner: "content", source: "module" },
  ];
  const headers = { origin: "http://localhost:5173", "content-type": "application/json" };
  const body = JSON.stringify({ kind: "addon", id: "drafted", params: { screen: {} } });

  const shut = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    moduleDirectories: roots,
  });
  try {
    const refused = await fetch(`http://127.0.0.1:${shut.port}/modules/ui/shop/drafted.json`, {
      method: "PUT", headers, body,
    });
    // 405 and not 403: the route exists and the *method* is what is refused, and `allow` is the one
    // word a client can act on. The gateway warns at start-up that it is an unauthenticated pipe,
    // which is why the one route that touches the disk has to be asked for by name.
    assert.equal(refused.status, 405);
    assert.equal(refused.headers.get("allow"), "GET");
    assert.equal(refused.headers.get("access-control-allow-origin"), "http://localhost:5173");
  } finally {
    await shut.close();
  }

  const open = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    moduleDirectories: roots,
    moduleWrite: true,
  });
  try {
    const at = (path) => `http://127.0.0.1:${open.port}${path}`;
    const written = await fetch(at("/modules/ui/shop/drafted.json"), { method: "PUT", headers, body });
    assert.equal(written.status, 204);
    // Into the *first* root, which is the drafts directory. A gateway that could overwrite a file
    // inside the tswow install would let a web page rewrite a module's shipped source.
    assert.equal(await readFile(join(draftRoot, "shop", "ui", "drafted.json"), "utf8"), body);
    // And it is served straight back, so the builder overlay (М8) can save and reload in one step.
    assert.deepEqual(await (await fetch(at("/modules/ui/shop/drafted.json"), { headers })).json(), JSON.parse(body));

    // The name rules are the GET route's, and the ceiling is the same 256 KiB.
    assert.equal((await fetch(at("/modules/ui/shop/drafted.css"), { method: "PUT", headers, body })).status, 400);
    assert.equal((await fetch(at("/modules/ui/shop/big.json"), {
      method: "PUT", headers, body: "x".repeat(300 * 1024),
    })).status, 413);
    // Origin first, as everywhere else here.
    assert.equal((await fetch(at("/modules/ui/shop/drafted.json"), { method: "PUT", body })).status, 403);
  } finally {
    await open.close();
  }

  // The other half of the guard, driven through the route: the flag is on and the request is not
  // from this machine. A gateway bound to 127.0.0.1 has no peer that is not loopback, and binding
  // one to a network interface to prove a refusal means a listening socket on somebody's network
  // for the length of a test run — so the address the route reads is injected here. The default is
  // what answered 204 above, and it reads the socket and nothing else.
  let peer = "192.0.2.133";
  const remote = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    moduleDirectories: roots,
    moduleWrite: true,
    peerAddress: () => peer,
  });
  try {
    const at = (path) => `http://127.0.0.1:${remote.port}${path}`;
    const put = () => fetch(at("/modules/ui/shop/remote.json"), { method: "PUT", headers, body });

    const refused = await put();
    assert.equal(refused.status, 405, "the flag alone must not be enough: this is an unauthenticated pipe");
    assert.equal(refused.headers.get("allow"), "GET");
    await assert.rejects(readFile(join(draftRoot, "shop", "ui", "remote.json")), "and nothing was written");

    // A socket with no address at all — one that has already gone, or a pipe — is not this machine.
    peer = undefined;
    assert.equal((await put()).status, 405);

    // And the spelling `node:net` reports for a loopback socket opened over IPv6, which is the
    // ordinary case for `localhost` on Windows, is this machine.
    peer = "::ffff:127.0.0.1";
    assert.equal((await put()).status, 204);
    assert.equal(await readFile(join(draftRoot, "shop", "ui", "remote.json"), "utf8"), body);
  } finally {
    await remote.close();
    await rm(draftRoot, { recursive: true, force: true });
    await rm(moduleRoot, { recursive: true, force: true });
  }
});

test("the write route answers the preflight, or no browser could ever reach it", async () => {
  // The page is on :5173 and this gateway is on :8090, so every request to it is cross-origin — and
  // `PUT` is not one of the three methods a browser may send without asking first. Without this
  // answer the request is blocked *before it is sent*: М6's write route existed and no page could
  // reach it, and М8's builder would have reported «шлюз недоступен» for every export.
  const draftRoot = await mkdtemp(join(tmpdir(), "webclient-drafts-"));
  const roots = [{ root: draftRoot, inner: "", source: "draft" }];
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    moduleDirectories: roots,
  });
  try {
    const at = (path) => `http://127.0.0.1:${gateway.port}${path}`;
    const preflight = await fetch(at("/modules/ui/shop/drafted.json"), {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:5173");
    // `PUT` is advertised even though this gateway was started with the write flag *off*: the
    // method is a fact about the route and writing is a fact about the configuration, and the
    // second is what the 405 says in words the author can act on. A preflight that refused the
    // method would turn that sentence into a network error with nothing in it.
    assert.match(preflight.headers.get("access-control-allow-methods"), /PUT/);
    assert.equal(preflight.headers.get("access-control-allow-headers"), "content-type");

    // And the origin check comes first here as everywhere else: a preflight from nowhere is a 403.
    assert.equal((await fetch(at("/modules/ui/shop/drafted.json"), { method: "OPTIONS" })).status, 403);
    // A kind nobody declared is still a 404, preflight or not — the block is only entered for one
    // of the three this gateway serves.
    assert.equal((await fetch(at("/modules/nosuch/shop/x.json"), {
      method: "OPTIONS", headers: { origin: "http://localhost:5173" },
    })).status, 404);
  } finally {
    await gateway.close();
    await rm(draftRoot, { recursive: true, force: true });
  }
});

test("the write route reads the socket's own address, and knows both spellings of loopback", () => {
  // Where the address comes from, which is the half a header could have taken over: the refusal
  // itself is driven through the route in the test above, with the address injected, and this is
  // what says the default reads the socket. `X-Forwarded-For` and `Host` are written by whoever is
  // asking; a socket's address is not.
  assert.equal(socketPeerAddress({ socket: { remoteAddress: "10.1.2.3" }, headers: {
    "x-forwarded-for": "127.0.0.1", host: "127.0.0.1",
  } }), "10.1.2.3");
  assert.equal(socketPeerAddress({ socket: {}, headers: {} }), undefined);

  // And the predicate, against the addresses `node:net` actually reports.
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  // What a socket opened over IPv6 to `localhost` reports, which is the ordinary case on Windows:
  // a check for the first spelling alone would refuse a browser on this very machine.
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("127.0.1.7"), true, "the whole 127/8 block is this machine");
  assert.equal(isLoopbackAddress("192.168.1.14"), false);
  assert.equal(isLoopbackAddress("::ffff:192.168.1.14"), false);
  assert.equal(isLoopbackAddress(undefined), false, "a socket with no address is not this machine");
});

test("a gateway with no module directories does not answer the module routes at all", async () => {
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
  });
  try {
    // 404 and not 403: the route is not mounted, which is exactly what the live gateway answered
    // when this slice started (probed on :8090 with an allowed Origin).
    const response = await fetch(`http://127.0.0.1:${gateway.port}/modules/index`, {
      headers: { origin: "http://localhost:5173" },
    });
    assert.equal(response.status, 404);
  } finally {
    await gateway.close();
  }
});

test("the creation route serves a race and a class this client was never compiled with", async () => {
  // Д3. `RACE_NAMES` and `CLASS_NAMES` in the browser hold ten entries each, and the creation form
  // was built from exactly those — so a module that adds a race or a class could name it, colour
  // it and give it an icon, and nobody could pick it. `ChrRaces`, `ChrClasses` and `CharBaseInfo`
  // are what the original client builds that screen from, and they were read by nothing.
  const dbcDirectory = await mkdtemp(join(tmpdir(), "webclient-creation-"));
  const files = characterCreationDbcs();
  await writeFile(join(dbcDirectory, "ChrRaces.dbc"), files.races);
  await writeFile(join(dbcDirectory, "ChrClasses.dbc"), files.classes);
  await writeFile(join(dbcDirectory, "CharBaseInfo.dbc"), files.base);
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    dbcDirectory,
  });
  const url = `http://127.0.0.1:${gateway.port}/dbc/character-creation`;
  try {
    const refused = await fetch(url, { headers: { origin: "http://evil.example" } });
    assert.equal(refused.status, 403);
    await refused.arrayBuffer();

    const response = await fetch(url, { headers: { origin: "http://127.0.0.1:5173" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    const data = await response.json();

    assert.deepEqual(data.races.map((race) => race.id), [1, 9, 22, 200]);
    // The name comes out of the locale column this build reads, not out of the enUS slot beside
    // it: the fixture writes "Human" into one and «Человек» into the other.
    assert.deepEqual(data.races.map((race) => race.name), ["Человек", "Гоблин", "Ворген", "Врайкул"]);
    assert.deepEqual(data.races.map((race) => race.playable), [true, false, true, true],
      "Flags bit 0 is NOT_PLAYABLE, so the goblin is the one that is out");
    assert.deepEqual(data.races.map((race) => race.side), [0, 2, 1, 1]);
    assert.deepEqual(data.races.map((race) => race.clientPrefix), ["Hu", "Go", "Wo", "Vr"]);
    assert.equal(data.races[0].baseLanguage, 7);

    // CharBaseInfo grouped by race: a human may be a warrior or the custom class, and the custom
    // race may only be the custom class. This is the pair table the class list is filtered by.
    assert.deepEqual(data.races.find((race) => race.id === 1).classes, [1, 14]);
    assert.deepEqual(data.races.find((race) => race.id === 22).classes, [14]);
    assert.deepEqual(data.races.find((race) => race.id === 9).classes, []);
    // `CharBaseInfo` is two *signed* bytes wide, so an id past 127 arrives as a negative number
    // and its pairs would be filed under a race that does not exist. tswow hands out ids upwards
    // and the column holds 256 of them, so this is a custom race the moment there are enough.
    assert.deepEqual(data.races.find((race) => race.id === 200).classes, [1]);

    assert.deepEqual(data.classes.map((entry) => entry.id), [1, 14]);
    assert.deepEqual(data.classes.map((entry) => entry.name), ["Воин", "Монах"]);
    assert.deepEqual(data.classes.map((entry) => entry.fileName), ["WARRIOR", "MONK"],
      "which is the key CLASS_ICON_TCOORDS is written with, so a custom class can have a cell");
    assert.deepEqual(data.classes.map((entry) => entry.classMask), [1, 1 << 13],
      "3.3.5 has no ClassMask column; it is 1 << (id - 1)");
    assert.deepEqual(data.classes.map((entry) => entry.powerType), [1, 0]);
    assert.deepEqual(data.classes.map((entry) => entry.playable), [true, true],
      "a class is playable when CharBaseInfo names it, which is the only place 3.3.5 says so");
  } finally {
    await gateway.close();
    await rm(dbcDirectory, { recursive: true, force: true });
  }
});

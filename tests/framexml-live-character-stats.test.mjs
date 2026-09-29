import assert from "node:assert/strict";
import test from "node:test";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { FRAMEXML_VERTICAL_TOC } from "../dist/code/browser/framexml/FrameXmlCorpus.js";
import { LiveWorldSeam } from "../dist/code/browser/framexml/LiveWorldSeam.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

let clientDirectory;
try { clientDirectory = (await import("../tools/paths.mjs")).clientDirectory(); } catch {}

test("stock PaperDoll fills every live stat category from server update fields", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const fields = new Map();
  const word = new DataView(new ArrayBuffer(4));
  const set = (name, value, index = 0) => {
    word.setFloat32(0, value, true);
    fields.set(UPDATE_FIELDS[name].offset + index,
      UPDATE_FIELDS[name].type === "FLOAT" ? word.getUint32(0, true) : value >>> 0);
  };
  set("UNIT_FIELD_BYTES_0", 1 | (2 << 8)); // human paladin: stock defaults select melee
  set("UNIT_FIELD_LEVEL", 80);
  set("UNIT_FIELD_MAXPOWER1", 5000);
  set("UNIT_FIELD_STAT0", 123);
  set("UNIT_FIELD_POSSTAT0", 10);
  set("UNIT_FIELD_NEGSTAT0", -3);
  set("UNIT_FIELD_RESISTANCES", 500);
  set("UNIT_FIELD_RESISTANCEBUFFMODSPOSITIVE", 25);
  set("UNIT_FIELD_RESISTANCEBUFFMODSNEGATIVE", -5);
  set("PLAYER_CRIT_PERCENTAGE", 12.5);
  set("PLAYER_RANGED_CRIT_PERCENTAGE", 13.25);
  set("PLAYER_FIELD_MOD_HEALING_DONE_POS", 600);
  for (let index = 1; index < 7; index++) {
    set("PLAYER_FIELD_MOD_DAMAGE_DONE_POS", 450, index);
    set("PLAYER_SPELL_CRIT_PERCENTAGE1", 15.5, index);
  }
  set("UNIT_FIELD_POWER_REGEN_FLAT_MODIFIER", 80);
  set("UNIT_FIELD_POWER_REGEN_INTERRUPTED_FLAT_MODIFIER", 40);
  set("PLAYER_DODGE_PERCENTAGE", 18.5);
  set("PLAYER_SKILL_INFO_1_1", 95);
  set("PLAYER_SKILL_INFO_1_1", 400 | (400 << 16), 1);
  set("PLAYER_FIELD_COMBAT_RATING_1", 125, 1);
  const selfGuid = 1n;
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, { guid: selfGuid, typeId: 4, fields }]]) },
    actionButtons: [], casts: new Map(), channels: new Map(), events: { on: () => () => {} },
    itemTemplates: new Map(), cooldownRemaining: () => 0,
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    characterStats: () => ({ spellCritBase: [0, 0.03], spellCritPerIntellect: Array(200).fill(0.001),
      combatRatingPerLevel: Array(2500).fill(5), combatRatingScalar: { 34: 2 } }),
  });
  const boot = new FrameXmlBoot({
    provider: { read: async (path) => {
      const data = await chain.read(path);
      return data ? new TextDecoder().decode(data) : undefined;
    } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false,
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    await boot.load();
    const row = (index) => boot.bridge.getFrame(`PlayerStatFrameLeft${index}StatText`).text;
    for (const [category, expectedRows] of [
      ["BASE_STATS", { 1: "123", 6: "500" }],
      ["MELEE_COMBAT", { 5: "12.50%" }],
      ["RANGED_COMBAT", { 5: "13.25%" }],
      ["SPELL_COMBAT", { 1: "450", 2: "600", 4: "15.50%", 6: "400" }],
      ["DEFENSES", { 1: "500", 2: "450", 3: "18.50%" }],
    ]) {
      const update = boot.vm.execute(`UpdatePaperdollStats("PlayerStatFrameLeft", "PLAYERSTAT_${category}")`,
        `@live-character:${category}`);
      assert.equal(update.ok, true, `${category}: ${update.error}`);
      for (const [index, expected] of Object.entries(expectedRows)) {
        assert.equal(row(index).replace(/\|c[0-9a-f]{8}|\|r/gi, ""), expected, `${category} row ${index}`);
      }
    }
  } finally {
    boot.close();
    chain.close();
  }
});

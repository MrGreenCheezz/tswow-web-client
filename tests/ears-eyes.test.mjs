import assert from "node:assert/strict";
import test from "node:test";
import { CharacterAppearanceIndex } from "../dist/code/gateway/CharacterAppearance.js";
import { CreatureModelClient } from "../dist/code/browser/CreatureModelClient.js";
import { CHARACTER_APPEARANCE_VERSION } from "../dist/code/browser/CharacterAtlas.js";

// 6.10 (line A7a): the ear stub a helmet leaves behind and the death knight's eye glow. Both are
// decided by the gateway's geoset list, so the test reads the dataset's own DBCs; the census that
// chose the cases is `docs/implementation/probes/A7a/probe-geosets.mjs` (05.10): 701 exists only in
// HumanMale, OrcMale, GnomeMale and BloodElfMale among the playable bodies, 1703 in all twenty.
let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

let index;
async function appearances() {
  index ??= await CharacterAppearanceIndex.load(dbcDirectory, undefined, dbcDirectory, false);
  return index;
}

const HEAD = 0;
const INVTYPE_HEAD = 1;
// A head display whose HelmetGeosetVisData hides family 7 for races 1 and 10, male
// (`.runtime/re-2026-10-05/A7a-A/probe-ears.mjs`: 14957 and 14964 hide, 14903 keeps the ears).
const EAR_HIDING_HELM = 14957;
const EAR_KEEPING_HELM = 14903;
const helm = (displayId) => [{ slot: HEAD, inventoryType: INVTYPE_HEAD, displayId }];

for (const [race, name] of [[1, "HumanMale"], [10, "BloodElfMale"]]) {
  test(`6.10 ${name}: a helmet that covers the ears leaves stub 701, not nothing`, withDataset, async () => {
    const looks = await appearances();
    const bare = looks.forPlayer(race, 0, 0, 0, 0, 0, 0).geosets;
    assert.ok(bare.includes(702) && !bare.includes(701), `bare ears are 702: ${bare}`);
    const covered = looks.forPlayer(race, 0, 0, 0, 0, 0, 0, helm(EAR_HIDING_HELM)).geosets;
    assert.ok(covered.includes(701), `the stub stays under the helmet: ${covered}`);
    assert.ok(!covered.includes(702), `the full ear is hidden: ${covered}`);
    const open = looks.forPlayer(race, 0, 0, 0, 0, 0, 0, helm(EAR_KEEPING_HELM)).geosets;
    assert.ok(open.includes(702) && !open.includes(701), `a helmet that leaves the ears keeps 702: ${open}`);
  });
}

test("6.10 a death knight's eyes glow (1703); no other class's do", withDataset, async () => {
  const looks = await appearances();
  const human = looks.forPlayer(1, 0, 0, 0, 0, 0, 0, [], 6).geosets;
  assert.ok(human.includes(1703), `DK human: ${human}`);
  for (const classId of [undefined, 0, 1, 5]) {
    const other = looks.forPlayer(1, 0, 0, 0, 0, 0, 0, [], classId).geosets;
    assert.ok(!other.some((id) => id >= 1700 && id < 1800), `class ${classId}: ${other}`);
  }
  // A helmet does not cover the glow.
  const helmed = looks.forPlayer(1, 0, 0, 0, 0, 0, 0, helm(EAR_HIDING_HELM), 6).geosets;
  assert.ok(helmed.includes(1703), `DK under a helmet: ${helmed}`);
});

test("6.10 the death knight's glow takes family 17 from the racial glow (one variant per family)", withDataset, async () => {
  const looks = await appearances();
  const elf = looks.forPlayer(10, 0, 0, 0, 0, 0, 0).geosets;
  assert.ok(elf.includes(1702), `a blood elf's racial glow: ${elf}`);
  const knight = looks.forPlayer(10, 0, 0, 0, 0, 0, 0, [], 6).geosets;
  assert.ok(knight.includes(1703) && !knight.includes(1702), `DK blood elf: ${knight}`);
});

test("6.10 the class is part of the look's key and of the request", async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: false, status: 500 };
  };
  try {
    const client = new CreatureModelClient("ws://127.0.0.1:8090/auth", () => 0);
    client.playerAppearance(1, 0, 0, 0, 0, 0, 0, [], 6);
    client.playerAppearance(1, 0, 0, 0, 0, 0, 0, [], 1);
    client.playerAppearance(1, 0, 0, 0, 0, 0, 0, []);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(urls.length, 3, "three classes, three looks");
    assert.match(urls[0], /[?&]class=6(&|$)/);
    assert.match(urls[1], /[?&]class=1(&|$)/);
    assert.doesNotMatch(urls[2], /[?&]class=/, "no class, no parameter (the old spelling)");
    assert.match(urls[0], new RegExp(`[?&]v=${CHARACTER_APPEARANCE_VERSION}&`));
  } finally {
    globalThis.fetch = original;
  }
});

test("6.10 the appearance version moved for the class parameter", () => {
  assert.equal(CHARACTER_APPEARANCE_VERSION, 15);
});

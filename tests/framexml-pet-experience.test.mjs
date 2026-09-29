import assert from "node:assert/strict";
import test from "node:test";

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { frameXmlPetExperience } = await import("../dist/code/browser/framexml/FrameXmlPetExperience.js");
const { frameXmlPetSpellBonusDamage } = await import("../dist/code/browser/framexml/FrameXmlPetSpellPower.js");
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { clientArchives } = await import("../tools/mpq.mjs");

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

test("pet XP reads only the two owner fields and waits for both", () => {
  const pet = { fields: new Map() };
  const current = UPDATE_FIELDS.UNIT_FIELD_PETEXPERIENCE.offset;
  const next = UPDATE_FIELDS.UNIT_FIELD_PETNEXTLEVELEXP.offset;
  assert.equal(frameXmlPetExperience(undefined), undefined);
  assert.equal(frameXmlPetExperience(pet), undefined);
  pet.fields.set(current, 125);
  assert.equal(frameXmlPetExperience(pet), undefined,
    "a partial owner update cannot be presented as a next-level range");
  pet.fields.set(next, 400);
  assert.deepEqual(frameXmlPetExperience(pet), [125, 400]);
  pet.fields.set(current, 300);
  assert.deepEqual(frameXmlPetExperience(pet), [300, 400],
    "the current value is read anew after the owner update");
});

test("pet spell bonus reads the signed owner field written by the server", () => {
  const owner = { fields: new Map() };
  const offset = UPDATE_FIELDS.PLAYER_PET_SPELL_POWER.offset;
  assert.equal(frameXmlPetSpellBonusDamage(undefined), undefined);
  assert.equal(frameXmlPetSpellBonusDamage(owner), undefined);
  owner.fields.set(offset, 123);
  assert.equal(frameXmlPetSpellBonusDamage(owner), 123);
  owner.fields.set(offset, 0xfffffff6);
  assert.equal(frameXmlPetSpellBonusDamage(owner), -10);
});

test("a non-mana pet has no intellect-based spell crit contribution", () => {
  const seam = new CannedWorldSeam();
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.UnitLevel(seam, ["Pet"]), [60],
    "stock PetPaperDollFrame passes a capitalized Pet token to PaperDollFrame_SetArmor");
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.UnitArmor(seam, ["Pet"]),
    FRAMEXML_SEAM_BINDINGS.UnitArmor(seam, ["pet"]));
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetSpellCritChanceFromIntellect(seam, ["pet"]), [0],
    "PetPaperDollFrame.lua:599 formats this value even when UnitHasMana is false");
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetSpellCritChanceFromIntellect(seam, ["player"]), [0],
    "unknown player coefficients contribute nothing, and stock format() still receives a number");
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetPetSpellBonusDamage(seam, []), [0],
    "the canned pet has no owner spell-power field and cannot claim a bonus");
});

test("real MPQ PetExpBar no longer compares nil before a pet owner update", withClient, async () => {
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const bytes = await chain.read(path.replaceAll("/", "\\"));
        return bytes ? decoder.decode(bytes) : undefined;
      },
    },
    locale: "ruRU",
    screen: () => ({ width: 1280, height: 768 }),
    seam: new CannedWorldSeam(),
  });
  try {
    const inventory = await boot.load();
    assert.deepEqual(inventory.errors.filter((error) => error.file === ""), [],
      "the anonymous min(nil) failure from PetPaperDollFrame.lua:630 must stay closed");
    assert.deepEqual(inventory.errors.filter((error) => error.file.endsWith("/petpaperdollframe.lua")), [],
      "the stock pet stamina tooltip must not multiply by a missing aura modifier");
    assert.deepEqual(inventory.errors.filter((error) => error.file === "GlueLua:shims"
      && error.message.includes("_format")), [],
      "the original non-mana pet intellect tooltip has a numeric format argument");
    assert.deepEqual(inventory.errors.filter((error) => error.file.endsWith("/paperdollframe.lua")), [],
      "the original Pet alias resolves the pet level for its armor-reduction tooltip");
    assert.deepEqual(inventory.errors.filter((error) => error.file === "GlueLua:shims"
      && error.message.includes("number expected")), [],
      "the original pet spell-damage display has a numeric owner-field answer");
    assert.deepEqual(inventory.errors, [],
      "the complete unmodified 3.3.5a FrameXML corpus initializes without Lua errors");
    const ref = boot.vm.globalFunction("GetPetExperience");
    assert.ok(ref);
    try { assert.deepEqual(boot.vm.call(ref, [], 2), [0, 0]); }
    finally { boot.vm.release(ref); }
    const healthModifier = boot.vm.globalFunction("GetUnitHealthModifier");
    assert.ok(healthModifier);
    try { assert.deepEqual(boot.vm.call(healthModifier, ["pet"], 1), [1],
      "without an authoritative aura feed, the documented baseline multiplier is the identity"); }
    finally { boot.vm.release(healthModifier); }
  } finally {
    boot.close();
    chain.close();
  }
});

import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.09 (L17, 04.10): the ruRU pet name declension as Wow.exe 3.3.5a 12340 answers it (read-only
// Ghidra, .runtime/re-2026-10-04/l17/g1.c, g2.c): GetNumDeclensionSets 0x00511dd0 → 0x0076dd40, DeclineName
// 0x00511e80 → 0x0076dd60 (only locale index 8 reaches the rule engine), PetRename 0x005d5670 (ERR_NO_PET,
// ERR_NOTYOURPET, ERR_PET_NOT_RENAMEABLE, ERR_NAME_NO_NAME; 0x0076dd20 decides the declension step; five
// forms send 0x005d4a00, fewer fire event 0x252), SMSG_PET_NAME_INVALID (case 0x178): the declined block
// fires the event again with the server's forms.
const { FrameXmlPetDeclensionModel, FRAMEXML_PET_DECLENSION_BINDINGS, FRAMEXML_PET_FORCE_NAME_DECLENSION,
  frameXmlPetDeclensionsApply } = await import("../dist/code/browser/framexml/FrameXmlPetDeclension.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { globalString } = await import("../dist/code/generated/globalStrings.js");

const SELF = 0x10n;
const PET = 0xf1400000000000aan;
const FORMS = ["Тузика", "Тузику", "Тузика", "Тузиком", "Тузике"];

function petObject({ owner = SELF, renameable = true, typeId = 3 } = {}) {
  const fields = new Map();
  fields.set(UPDATE_FIELDS.UNIT_FIELD_SUMMONEDBY.offset, Number(owner & 0xffffffffn));
  fields.set(UPDATE_FIELDS.UNIT_FIELD_SUMMONEDBY.offset + 1, Number(owner >> 32n));
  // UNIT_FIELD_BYTES_2: byte 2 is the pet flags, 0x01 UNIT_CAN_BE_RENAMED.
  fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, renameable ? 0x01 << 16 : 0);
  return { guid: PET, typeId, fields };
}

function stage({ locale = "ruRU", pet = petObject(), petGuid = PET } = {}) {
  const fired = [];
  const sent = [];
  const objects = new Map([[SELF, { guid: SELF, typeId: 4, fields: new Map() }]]);
  if (pet) objects.set(pet.guid, pet);
  const world = {
    state: { selfGuid: SELF, objects },
    petSpells: petGuid === null ? undefined : { guid: petGuid },
    renamePet: (name, declined) => { sent.push(declined === undefined ? [name] : [name, ...declined]); },
    onPetNameInvalid: undefined,
  };
  const model = new FrameXmlPetDeclensionModel({ world: () => world, locale: () => locale });
  model.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
  const seam = { locale, petDeclension: model, petRename: () => { throw new Error("the companion send is not used"); } };
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  return { world, model, fired, sent, call };
}

const uiError = (key) => ["UI_ERROR_MESSAGE", globalString(key) ?? key];

test("the three names are the declension bindings in the seam table", () => {
  for (const name of ["GetNumDeclensionSets", "DeclineName", "PetRename"]) {
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], FRAMEXML_PET_DECLENSION_BINDINGS[name], name);
  }
});

test("GetNumDeclensionSets and DeclineName answer on a ruRU client only (0x0076dd40/0x0076dd60)", () => {
  const ru = stage();
  assert.equal(ru.call("GetNumDeclensionSets", "Тузик", 2)[0] >= 1, true);
  assert.deepEqual(ru.call("DeclineName", "Тузик", 2, 1), FORMS);
  const en = stage({ locale: "enUS" });
  assert.deepEqual(en.call("GetNumDeclensionSets", "Тузик", 2), [0]);
  assert.deepEqual(en.call("DeclineName", "Тузик", 2, 1), [undefined, undefined, undefined, undefined, undefined]);
});

test("PetRename refuses in Wow.exe's order with the UI errors, and sends nothing", () => {
  const cases = [
    [{ petGuid: null }, "ERR_NO_PET"],
    [{ pet: null }, "ERR_NO_PET"],
    [{ pet: petObject({ owner: 0x99n }) }, "ERR_NOTYOURPET"],
    [{ pet: petObject({ renameable: false }) }, "ERR_PET_NOT_RENAMEABLE"],
  ];
  for (const [options, key] of cases) {
    const { call, fired, sent } = stage(options);
    assert.deepEqual(call("PetRename", "Тузик"), []);
    assert.deepEqual(fired, [uiError(key)], key);
    assert.deepEqual(sent, [], key);
  }
  // Not your pet comes before not renameable; an empty name only after both.
  const both = stage({ pet: petObject({ owner: 0x99n, renameable: false }) });
  both.call("PetRename", "");
  assert.deepEqual(both.fired, [uiError("ERR_NOTYOURPET")]);
  for (const name of ["", undefined]) {
    const empty = stage();
    empty.call("PetRename", name);
    assert.deepEqual(empty.fired, [uiError("ERR_NAME_NO_NAME")]);
    assert.deepEqual(empty.sent, []);
  }
});

test("the client's own name check (0x007e1f00) refuses before any declension or send, with 0x005218c0's error", () => {
  const cases = [
    ["Тууузик", "ERR_NAME_THREE_CONSECUTIVE"],
    ["Ъузик", "ERR_NAME_RUSSIAN_SILENT_CHARACTER_AT_BEGINNING_OR_END"],
    ["Тузъьик", "ERR_NAME_RUSSIAN_CONSECUTIVE_SILENT_CHARACTERS"],
    ["Rex Two", "ERR_NAME_INVALID"],
    ["   ", "ERR_NAME_INVALID"],
    ["Rexа", "ERR_NAME_INVALID"],
    ["Т", "ERR_NAME_TOO_SHORT"],
    ["Абвгдежзийклм", "ERR_NAME_TOO_LONG"],
  ];
  for (const [name, key] of cases) {
    const { call, fired, sent } = stage();
    call("PetRename", name, ...FORMS);
    assert.deepEqual(fired, [uiError(key)], name);
    assert.deepEqual(sent, [], name);
  }
  // Twelve letters pass; the CJK limit is 8 here (the character check's is 6).
  const twelve = stage();
  twelve.call("PetRename", "Абвгдежзийкл", ...FORMS);
  assert.deepEqual(twelve.sent, [["Абвгдежзийкл", ...FORMS]]);
  const cjk = stage({ locale: "zhCN" });
  cjk.call("PetRename", "一二三四五六七");
  assert.deepEqual(cjk.sent, [["一二三四五六七"]]);
});

test("a Cyrillic name on ruRU opens the declension frame until all five forms come with it", () => {
  const { call, fired, sent } = stage();
  call("PetRename", "Тузик");
  assert.deepEqual(fired, [[FRAMEXML_PET_FORCE_NAME_DECLENSION, "Тузик"]]);
  assert.deepEqual(sent, []);
  fired.length = 0;
  // A missing or empty form stops the reading: the frame again, nothing sent.
  call("PetRename", "Тузик", ...FORMS.slice(0, 4));
  call("PetRename", "Тузик", FORMS[0], "", ...FORMS.slice(2));
  assert.deepEqual(fired, [[FRAMEXML_PET_FORCE_NAME_DECLENSION, "Тузик"], [FRAMEXML_PET_FORCE_NAME_DECLENSION, "Тузик"]]);
  assert.deepEqual(sent, []);
  fired.length = 0;
  call("PetRename", "Тузик", ...FORMS);
  assert.deepEqual(fired, []);
  assert.deepEqual(sent, [["Тузик", ...FORMS]]);
});

test("a Latin name on ruRU, and any name on another locale, is sent without declensions", () => {
  const ru = stage();
  ru.call("PetRename", "Rex", ...FORMS);
  assert.deepEqual(ru.sent, [["Rex"]]);
  assert.deepEqual(ru.fired, []);
  assert.equal(frameXmlPetDeclensionsApply("ruRU", "Rex"), false);
  assert.equal(frameXmlPetDeclensionsApply("ruRU", "Тузик"), true);
  const en = stage({ locale: "enUS" });
  en.call("PetRename", "Тузик");
  assert.deepEqual(en.sent, [["Тузик"]]);
  assert.deepEqual(en.fired, []);
});

test("SMSG_PET_NAME_INVALID with a declined block reopens the frame with the server's forms", () => {
  const { world, fired } = stage();
  const earlier = [];
  // A listener that held the hook before attach keeps hearing the packet.
  world.onPetNameInvalid({ error: 16, name: "Тузик", declined: FORMS });
  assert.deepEqual(fired, [[FRAMEXML_PET_FORCE_NAME_DECLENSION, "Тузик", ...FORMS]]);
  fired.length = 0;
  world.onPetNameInvalid({ error: 11, name: "Тууузик", declined: [] });
  assert.deepEqual(fired, [], "an error without the block opens nothing (its text is the native notice)");
  const chained = stage();
  chained.model.detach();
  chained.world.onPetNameInvalid = (rejected) => earlier.push(rejected.error);
  chained.model.attach({ fire: (event, ...args) => { chained.fired.push([event, ...args]); return 1; }, now: () => 0 });
  chained.world.onPetNameInvalid({ error: 16, name: "Тузик", declined: FORMS });
  assert.deepEqual(earlier, [16]);
  assert.equal(chained.fired.length, 1);
  chained.model.detach();
  assert.equal(typeof chained.world.onPetNameInvalid, "function", "detach gives the earlier listener back");
  chained.world.onPetNameInvalid({ error: 16, name: "Тузик", declined: FORMS });
  assert.deepEqual(earlier, [16, 16]);
  assert.equal(chained.fired.length, 1);
});

test("a seam without the model keeps the companion binding's plain send", () => {
  const names = [];
  const seam = { locale: "ruRU", petRename: (name) => names.push(name) };
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.PetRename(seam, ["Тузик"]), []);
  assert.deepEqual(names, ["Тузик"]);
});

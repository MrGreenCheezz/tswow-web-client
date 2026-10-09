import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

// 05.10-petfood: `GetPetFoodTypes()` as Wow.exe 3.3.5a 12340 answers it (0x005d3bd0, registered beside its
// name at .data 0x00ad0d00; notes .runtime/re-2026-10-05/l-petfood/g1.c): the PetInfo pet, a hunter's only
// (0x0071b630), its creature cache family (0x007153e0), CreatureFamily.PetFoodMask (record +0x1c), and the
// ItemPetFood names whose bit `1 << (ID - 1)` is set, in table order. The stock diet tooltip
// (PetPaperDollFrame.xml:298) formats `BuildListString(GetPetFoodTypes())` with `%s`, which raises on nil
// since string.format became the client's own (3.27, 05.10). Nothing here talks to the running gateway.
const { PET_FOODS_VERSION, loadPetFoods, petFoodCatalog } = await import("../dist/code/gateway/PetFoodMetadata.js");
const { serveCatalogRoute, CATALOG_ROUTES } = await import("../dist/code/gateway/CatalogRoutes.js");
const { PET_FOODS_ROUTE_PATH, PET_FOODS_ROUTE_VERSION, petFoodTableFrom } = await import("../dist/code/browser/PetFoodClient.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");

let dbcDirectory;
try { dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory(); } catch { dbcDirectory = undefined; }
const withDataset = {
  skip: dbcDirectory && existsSync(`${dbcDirectory}/ItemPetFood.dbc`) ? false : "no dataset DBCs on this machine",
};
const uiParent = dbcDirectory ? `${dbcDirectory}/../luaxml/Interface/FrameXML/UIParent.lua` : undefined;
const withStockUi = { skip: uiParent && existsSync(uiParent) ? false : "no stock FrameXML on this machine" };

// Wolf (family 1): meat 1, fish 2, bread 4 → bits 0, 1, 3; a family 2 that eats only fish.
const SAMPLE = {
  version: 1,
  families: [[1, 0b1011], [2, 0b10]],
  foods: [[1, "Мясо"], [2, "Рыба"], [3, "Сыр"], [4, "Хлеб"]],
};

test("the route and the client agree on the version and the path; the table is validated", () => {
  assert.equal(PET_FOODS_ROUTE_VERSION, PET_FOODS_VERSION);
  assert.equal(PET_FOODS_ROUTE_PATH, `/dbc/pet-foods?v=${PET_FOODS_VERSION}`);
  assert.ok(CATALOG_ROUTES.some((route) => route.pathname === "/dbc/pet-foods" && route.version === PET_FOODS_VERSION));
  assert.ok(petFoodTableFrom(SAMPLE));
  assert.equal(petFoodTableFrom({ ...SAMPLE, version: 2 }), undefined);
  assert.equal(petFoodTableFrom({ ...SAMPLE, foods: [[1]] }), undefined);
  assert.equal(petFoodTableFrom({ ...SAMPLE, families: [[1, "x"]] }), undefined);
  const table = petFoodTableFrom(SAMPLE);
  assert.deepEqual([...table.foodNames(table.familyMask(1))], ["Мясо", "Рыба", "Хлеб"], "table order, bit ID - 1");
  assert.deepEqual([...table.foodNames(table.familyMask(2))], ["Рыба"]);
  assert.equal(table.familyMask(9), 0);
  assert.equal(table.foodNames(0b1011), table.foodNames(0b1011), "one frozen answer per mask, no allocation per hover");
});

test("the catalog reads ID and the ruRU Name_lang slot of ItemPetFood, PetFoodMask (field 7) of CreatureFamily", () => {
  // Synthetic rows: field 1 is enUS, 2 koKR, 9 ruRU (slot 8); CreatureFamily field 7 the mask, 8 PetTalentType.
  const foods = { records: 1, int: (_row, field) => (field === 0 ? 1 : 0), float: () => 0,
    string: (_row, field) => ({ 1: "Meat", 2: "고기", 9: "Мясо" })[field] ?? "" };
  const families = { records: 2, int: (row, field) => [[1, 0, 0, 0, 0, 0, 0, 0b1011, 5], [2, 0, 0, 0, 0, 0, 0, 0, 1]][row][field] ?? 0,
    float: () => 0, string: () => "" };
  const catalog = petFoodCatalog(families, foods, "ruRU");
  assert.deepEqual(catalog.foods, [[1, "Мясо"]]);
  assert.deepEqual(catalog.families, [[1, 0b1011]], "a family with mask 0 is left out");
});

test("this dataset's tables: eight ruRU food names in file order, every hunter family has a diet", withDataset, async () => {
  const catalog = await loadPetFoods(dbcDirectory);
  const table = petFoodTableFrom(JSON.parse(JSON.stringify(catalog)));
  assert.ok(table);
  assert.deepEqual(catalog.foods.map(([id]) => id), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...table.foodNames(0xff)],
    ["Мясо", "Рыба", "Сыр", "Хлеб", "Грибы", "Фрукты", "Сырое мясо", "Сырая рыба"]);
  assert.ok(table.familyMask(1) !== 0, "the wolf (CreatureFamily 1) eats something");
  assert.ok(catalog.families.every(([, mask]) => mask > 0 && mask <= 0xffffffff));
});

test("the route answers through the catalog table with the Origin and version checks", withDataset, async () => {
  const run = async (path, origin) => {
    const url = new URL(path, "http://127.0.0.1");
    const response = { status: 0, body: "", writeHead(status) { this.status = status; return this; }, end(body = "") { this.body = body; return this; } };
    await serveCatalogRoute({ method: "GET", headers: { origin } }, response, url, new Map(),
      { dbcDirectory, allowedOrigins: ["http://127.0.0.1:5173"] });
    return response;
  };
  const ok = await run(PET_FOODS_ROUTE_PATH, "http://127.0.0.1:5173");
  assert.equal(ok.status, 200);
  assert.ok(petFoodTableFrom(JSON.parse(ok.body)));
  assert.equal((await run("/dbc/pet-foods?v=9", "http://127.0.0.1:5173")).status, 400);
  assert.equal((await run(PET_FOODS_ROUTE_PATH, "http://evil.test")).status, 403);
});

function fixture(table) {
  const offset = (name) => UPDATE_FIELDS[name].offset;
  const selfGuid = 0x10n;
  const petGuid = 0xf140000000000200n;
  // A hunter (class 3) and the pet the pet bar names: a pet number, created by that hunter.
  const self = { guid: selfGuid, typeId: 4, fields: new Map([[offset("UNIT_FIELD_BYTES_0"), 1 | (3 << 8)]]) };
  const pet = {
    guid: petGuid, typeId: 3,
    fields: new Map([[offset("OBJECT_FIELD_ENTRY"), 299], [offset("UNIT_FIELD_PETNUMBER"), 7]]),
  };
  pet.fields.set(offset("UNIT_FIELD_CREATEDBY"), Number(selfGuid));
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, self], [petGuid, pet]]) },
    petSpells: { guid: petGuid },
    creatureTemplates: new Map([[299, { entry: 299, found: true, name: "Волк", creatureType: 1, creatureFamily: 1 }]]),
    actionButtons: [], casts: new Map(), cooldownRemaining: () => 0, partyStats: new Map(),
  };
  const holder = { table };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, monotonic: () => 1,
    globalCooldownUntil: () => 0, castSpell: () => {}, petFoods: { table: () => holder.table },
  });
  const call = () => [...FRAMEXML_SEAM_BINDINGS.GetPetFoodTypes(seam, [])];
  return { self, pet, world, holder, call, offset, seam };
}

test("GetPetFoodTypes: the hunter pet's diet; nothing without a pet, a hunter, a cached family or a diet", () => {
  const { call, self, pet, world, offset, holder } = fixture(petFoodTableFrom(SAMPLE));
  assert.deepEqual(call(), ["Мясо", "Рыба", "Хлеб"]);
  world.creatureTemplates.get(299).creatureFamily = 2;
  assert.deepEqual(call(), ["Рыба"]);
  world.creatureTemplates.get(299).creatureFamily = 9;
  assert.deepEqual(call(), [], "a family with no diet row: no values (Wow.exe 0x005d3bd0)");
  world.creatureTemplates.get(299).creatureFamily = 1;
  world.creatureTemplates.get(299).found = false;
  assert.deepEqual(call(), [], "nothing in the creature cache: family 0 (0x007153e0)");
  world.creatureTemplates.get(299).found = true;
  self.fields.set(offset("UNIT_FIELD_BYTES_0"), 1 | (9 << 8));
  assert.deepEqual(call(), [], "a warlock's demon is no hunter's pet (0x0071b630)");
  self.fields.set(offset("UNIT_FIELD_BYTES_0"), 1 | (3 << 8));
  pet.fields.set(offset("UNIT_FIELD_PETNUMBER"), 0);
  assert.deepEqual(call(), [], "a charmed creature has no pet number");
  pet.fields.set(offset("UNIT_FIELD_PETNUMBER"), 7);
  world.petSpells = undefined;
  assert.deepEqual(call(), [], "no pet");
  world.petSpells = { guid: pet.guid };
  holder.table = undefined;
  assert.deepEqual(call(), [""], "a gateway older than the route: an empty list, never a guessed food");
});

/** The stock tooltip line, with the stock BuildListString read from the dataset's UIParent.lua. */
function stockDietTooltip(seam) {
  const source = readFileSync(uiParent, "utf8");
  const start = source.indexOf("function BuildListString(...)");
  const end = source.indexOf("\nend", start);
  assert.ok(start >= 0 && end > start, "UIParent.lua defines BuildListString");
  const vm = new GlueLuaVm();
  try {
    vm.registerGlobal("GetPetFoodTypes", (args) => FRAMEXML_SEAM_BINDINGS.GetPetFoodTypes(seam, args));
    assert.equal(vm.execute(source.slice(start, end + 4), "@UIParent.lua").ok, true);
    vm.setGlobal("PET_DIET_TEMPLATE", "Рацион: %s");
    // PetPaperDollFrame.xml:298, the diet icon's OnEnter.
    const result = vm.execute("__r = format(PET_DIET_TEMPLATE, BuildListString(GetPetFoodTypes()))", "@PetPaperDollFrame.xml");
    return result.ok ? vm.getGlobal("__r") : { error: String(result.error) };
  } finally {
    vm.close();
  }
}

test("the stock diet tooltip formats without a format error, with and before the route's table", withStockUi, () => {
  const { seam, holder } = fixture(petFoodTableFrom(SAMPLE));
  assert.equal(stockDietTooltip(seam), "Рацион: Мясо, Рыба, Хлеб");
  holder.table = undefined;
  assert.equal(stockDietTooltip(seam), "Рацион: ", "stale gateway: an empty list, not «bad argument #2 to 'format'»");
});

// PetStable.lua:101 formats `BuildListString(GetStablePetFoodTypes(i))` for the selected stabled pet with no
// guard; Wow.exe 0x005a16a0 reads the slot pet's creature cache family (no hunter check) over the same tables.
test("GetStablePetFoodTypes: the slot pet's family diet, 0 the pet that is out; nothing for an empty slot", async () => {
  const { FrameXmlStableModel, FRAMEXML_STABLE_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlStable.js");
  const { FrameXmlCannedStableWorld } = await import("../dist/code/browser/framexml/FrameXmlStableCanned.js");
  const world = new FrameXmlCannedStableWorld();
  const holder = { table: petFoodTableFrom(SAMPLE) };
  // The canned list: slot 0 a wolf (69), 1 a tiger (681), 2 a spider (30, family 3: no diet row here).
  const families = new Map([[69, 1], [681, 2], [30, 3]]);
  const model = new FrameXmlStableModel({
    world: () => world,
    creatureFamily: (entry) => world.uncached.has(entry) ? undefined : families.get(entry),
    familyIcon: () => undefined, familyName: () => undefined, talentTree: () => undefined,
    petFoods: () => holder.table,
  });
  model.attach({ fire: () => 1 });
  model.owned = true;
  const host = { stable: model };
  const call = (...args) => [...FRAMEXML_STABLE_BINDINGS.GetStablePetFoodTypes(host, args)];
  assert.deepEqual(call(1), [], "no stable open");
  world.open();
  assert.deepEqual(call(0), ["Мясо", "Рыба", "Хлеб"]);
  assert.deepEqual(call(1), ["Рыба"]);
  assert.deepEqual(call(2), [], "a family without a diet row");
  assert.deepEqual(call(3), [], "a bought, empty slot");
  world.uncached.add(681);
  assert.deepEqual(call(1), [], "the template has not answered: family unknown");
  world.uncached.delete(681);
  holder.table = undefined;
  assert.deepEqual(call(1), [""], "a gateway older than the route: an empty list");
});

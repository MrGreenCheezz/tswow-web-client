import assert from "node:assert/strict";
import test from "node:test";

// The title picker's C API (FrameXmlTitles.ts) over a scripted host, the live host over a scripted
// WorldClient (FrameXmlTitlesLive.ts), CMSG_SET_TITLE / CMSG_UNLEARN_SKILL, the canned stand-in realm
// and the gateway catalog against this dataset's CharTitles.dbc (gateway/CharTitleMetadata.ts).
const {
  FrameXmlTitleModel, FRAMEXML_TITLE_BINDINGS, FRAMEXML_KNOWN_TITLE_WORDS, FRAMEXML_NO_TITLE, frameXmlTitleCatalog,
} = await import("../dist/code/browser/framexml/FrameXmlTitles.js");
const { createLiveFrameXmlTitles, liveFrameXmlTitleWearer } = await import("../dist/code/browser/framexml/FrameXmlTitlesLive.js");
const {
  createCannedFrameXmlTitles, CANNED_TITLE_ROWS, CANNED_KNOWN_TITLES, CANNED_CHOSEN_TITLE,
} = await import("../dist/code/browser/framexml/FrameXmlTitlesCanned.js");
const { CHAR_TITLE_ROUTE_VERSION, CHAR_TITLE_ROUTE_PATH, charTitleRows } = await import("../dist/code/browser/CharTitleClient.js");
const { CHAR_TITLES_VERSION, loadCharTitles } = await import("../dist/code/gateway/CharTitleMetadata.js");
const { buildSetTitle, buildUnlearnSkill } = await import("../dist/code/world/CharacterProgressProtocol.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const ROWS = [
  { id: 1, maskId: 1, name: "Рядовой %s", nameFemale: "Рядовой %s" },
  { id: 15, maskId: 15, name: "Разведчик %s", nameFemale: "Разведчица %s" },
  { id: 53, maskId: 36, name: "%s, защитник Наару", nameFemale: "%s, защитница Наару" },
  { id: 63, maskId: 38, name: "%s из Расколотого Солнца", nameFemale: "" },
];
/** Masks 1 and 15 in the first word, 36 in the second (bit 4). */
const WORDS = [(1 << 1) | (1 << 15), 1 << 4, 0, 0, 0, 0];

function harness({ words = WORDS, chosen = 1, female = false, catalog = frameXmlTitleCatalog(ROWS) } = {}) {
  const sent = [];
  const events = [];
  const state = { words, chosen, female, catalog, session: {} };
  const model = new FrameXmlTitleModel({
    catalog: () => state.catalog,
    knownWords: () => state.words,
    wearer: () => ({ chosen: state.chosen, female: state.female }),
    setTitle: (index) => sent.push(index),
    session: () => state.session,
  });
  model.attach({ fire: (event, ...args) => { events.push([event, ...args]); return 1; } });
  return { model, state, sent, events, host: { titles: model } };
}

test("the catalog is keyed by mask and its count is the loop bound stock iterates to", () => {
  const catalog = frameXmlTitleCatalog(ROWS);
  assert.equal(catalog.count, 39, "the highest mask plus one: `for i = 1, GetNumTitles()` reaches bit 38");
  assert.equal(catalog.title(36)?.id, 53);
  assert.equal(catalog.title(53), undefined, "the CharTitles id is not the mask");
  assert.equal(frameXmlTitleCatalog([]).count, 0);
  assert.equal(frameXmlTitleCatalog([{ id: 9, maskId: 192, name: "x", nameFemale: "" }]).count, 0, "MAX_TITLE_INDEX is refused");
});

test("GetNumTitles / IsTitleKnown / GetTitleName / GetCurrentTitle answer from the fields and the catalog", () => {
  const { host, state } = harness();
  const call = (name, ...args) => [...FRAMEXML_TITLE_BINDINGS[name](host, args)];
  assert.deepEqual(call("GetNumTitles"), [39]);
  assert.deepEqual([1, 2, 15, 36, 38, 0, 192].map((mask) => call("IsTitleKnown", mask)[0]), [1, 0, 1, 1, 0, 0, 0],
    "a number, never a boolean: PaperDollFrame.lua:2605 tests `~= 0`");
  assert.deepEqual(call("GetTitleName", 1), ["Рядовой "], "the %s placeholder is taken out, its space kept for strtrim");
  assert.deepEqual(call("GetTitleName", 36), [", защитник Наару"]);
  assert.deepEqual(call("GetTitleName", 2), [], "no row: nil");
  state.female = true;
  assert.deepEqual(call("GetTitleName", 15), ["Разведчица "], "the declined female form");
  assert.deepEqual(call("GetTitleName", 38), [" из Расколотого Солнца"], "no female form: the male one");
  assert.deepEqual(call("GetCurrentTitle"), [1]);
  state.chosen = 0;
  assert.deepEqual(call("GetCurrentTitle"), [FRAMEXML_NO_TITLE], "PLAYER_CHOSEN_TITLE 0 is the picker's «Нет» row");
  state.chosen = undefined;
  assert.deepEqual(call("GetCurrentTitle"), [FRAMEXML_NO_TITLE], "no player object yet");
  state.catalog = undefined;
  assert.deepEqual(call("GetNumTitles"), [0]);
  assert.deepEqual(call("GetTitleName", 1), []);
  assert.deepEqual([...FRAMEXML_TITLE_BINDINGS.GetNumTitles({}, [])], [0], "no model: the neutral answer");
  assert.deepEqual([...FRAMEXML_TITLE_BINDINGS.GetCurrentTitle({}, [])], [FRAMEXML_NO_TITLE]);
  assert.deepEqual([...FRAMEXML_TITLE_BINDINGS.IsTitleKnown({}, [1])], [0]);
});

test("SetCurrentTitle sends a known mask or -1 and nothing the core would refuse", () => {
  const { host, sent } = harness();
  const call = (name, ...args) => [...FRAMEXML_TITLE_BINDINGS[name](host, args)];
  assert.deepEqual(call("SetCurrentTitle", 36), []);
  assert.deepEqual(call("SetCurrentTitle", -1), []);
  call("SetCurrentTitle", 2);
  call("SetCurrentTitle", 0);
  call("SetCurrentTitle", "15");
  assert.deepEqual(sent, [36, -1, 15], "an unknown mask and 0 send nothing; a string index is a number");
});

test("UnitPVPName fills the placeholder with the name, by the wearer's sex", () => {
  const { model, state } = harness();
  assert.equal(model.displayName("Игрок", { chosen: 1, female: false }), "Рядовой Игрок");
  assert.equal(model.displayName("Игрок", { chosen: 36, female: true }), "Игрок, защитница Наару");
  assert.equal(model.displayName("Игрок", { chosen: 0, female: false }), "Игрок");
  assert.equal(model.displayName("Игрок", { chosen: 2, female: false }), "Игрок", "a mask without a row");
  assert.equal(model.displayName("Игрок", { chosen: undefined, female: undefined }), "Игрок");
  state.catalog = undefined;
  assert.equal(model.displayName("Игрок", { chosen: 1, female: false }), "Игрок", "no catalog: the bare name");
});

test("the per-frame compare fires KNOWN_TITLES_UPDATE and UNIT_NAME_UPDATE(player) once per edge", () => {
  const { model, state, events } = harness({ catalog: undefined });
  model.tick();
  model.tick();
  assert.deepEqual(events, [], "the first look is the baseline");
  state.catalog = frameXmlTitleCatalog(ROWS);
  model.tick();
  assert.deepEqual(events, [["KNOWN_TITLES_UPDATE"]], "the catalog landing redraws the picker");
  events.length = 0;
  state.words = [WORDS[0] | (1 << 38 % 32), 1 << 4, 0, 0, 0, 0];
  model.tick();
  model.tick();
  assert.deepEqual(events, [["KNOWN_TITLES_UPDATE"]]);
  events.length = 0;
  state.chosen = 36;
  model.tick();
  assert.deepEqual(events, [["UNIT_NAME_UPDATE", "player"]]);
  events.length = 0;
  state.session = {};
  state.chosen = 0;
  model.tick();
  assert.deepEqual(events, [], "a replaced world session restarts the compare silently");
});

test("the live host reads the title fields and the sex byte, sends CMSG_SET_TITLE and fetches the catalog once", async () => {
  const known = UPDATE_FIELDS.PLAYER__FIELD_KNOWN_TITLES.offset;
  const fields = new Map([
    [UPDATE_FIELDS.PLAYER_CHOSEN_TITLE.offset, 15],
    // Race 1, class 1, female (GENDER_FEMALE = 1), mana: the sex byte is the third.
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1 | (1 << 8) | (1 << 16)],
    ...WORDS.map((word, index) => [known + index, word]),
  ]);
  const player = { guid: 7n, typeId: 4, fields };
  const sent = [];
  const world = { state: { selfGuid: 7n, objects: new Map([[7n, player]]) }, setTitle: (index) => sent.push(index) };
  const requests = [];
  const { model, prepare } = createLiveFrameXmlTitles({
    world: () => world,
    gatewayOrigin: () => "http://127.0.0.1:8090",
    fetch: async (url) => { requests.push(url); return { ok: true, json: async () => ({ version: 1, titles: ROWS }) }; },
  });
  assert.equal(model.count(), 0, "before the catalog nothing is known by name");
  assert.equal(model.isKnown(15), true, "the bits are the fields', catalog or not");
  await prepare();
  await prepare();
  assert.deepEqual(requests, [`http://127.0.0.1:8090${CHAR_TITLE_ROUTE_PATH}`], "fetched once");
  assert.equal(model.count(), 39);
  assert.equal(model.name(15), "Разведчица ", "the sex byte picks the female form");
  assert.equal(model.current(), 15);
  assert.equal(model.displayName("Мага", liveFrameXmlTitleWearer(player)), "Разведчица Мага");
  assert.deepEqual(liveFrameXmlTitleWearer(undefined), { chosen: undefined, female: undefined });
  model.setCurrent(-1);
  model.setCurrent(1);
  model.setCurrent(2);
  assert.deepEqual(sent, [-1, 1]);
  assert.deepEqual([...buildSetTitle(-1)], [0xff, 0xff, 0xff, 0xff], "an int32");
  assert.deepEqual([...buildSetTitle(15)], [15, 0, 0, 0]);
  assert.deepEqual([...buildUnlearnSkill(164)], [164, 0, 0, 0], "CMSG_UNLEARN_SKILL: the SkillLine id");
});

test("a gateway without the route (404) leaves every title value nil and raises nothing", async () => {
  const world = { state: { selfGuid: 7n, objects: new Map([[7n, { guid: 7n, typeId: 4, fields: new Map() }]]) }, setTitle: () => {} };
  const { model, prepare } = createLiveFrameXmlTitles({
    world: () => world, gatewayOrigin: () => "http://127.0.0.1:8090",
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  await prepare();
  assert.equal(model.count(), 0);
  assert.equal(model.name(1), undefined);
  assert.equal(model.displayName("Игрок", { chosen: 1, female: false }), "Игрок");
  const failing = createLiveFrameXmlTitles({ world: () => world, gatewayOrigin: () => "http://127.0.0.1:8090", fetch: async () => { throw new Error("down"); } });
  await failing.prepare();
  assert.equal(failing.model.count(), 0);
  assert.equal(charTitleRows({ version: 2, titles: ROWS }), undefined, "another route version is refused");
  assert.equal(charTitleRows({ version: 1, titles: [{ id: 1 }, ...ROWS] })?.length, ROWS.length, "a malformed row is dropped");
});

test("the live seam's UnitPVPName wears the title around the name; a creature is its bare name", () => {
  const known = UPDATE_FIELDS.PLAYER__FIELD_KNOWN_TITLES.offset;
  const fields = new Map([
    [UPDATE_FIELDS.PLAYER_CHOSEN_TITLE.offset, 1],
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1 | (1 << 8)],
    ...WORDS.map((word, index) => [known + index, word]),
  ]);
  const world = {
    state: { selfGuid: 7n, objects: new Map([[7n, { guid: 7n, typeId: 4, fields }]]) },
    names: new Map([[7n, "Игрок"]]),
    setTitle: () => {},
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  assert.deepEqual(call("UnitPVPName", "player"), ["Игрок"], "before the catalog: the bare name, never nil");
  assert.deepEqual(call("IsTitleKnown", 15), [1]);
  assert.deepEqual(call("GetCurrentTitle"), [1]);
  assert.deepEqual(call("UnitPVPName", "target"), [], "no unit: nil, as UnitName");
});

test("the canned realm wears a known mask, clears on -1, and earns bits", () => {
  const { model, world } = createCannedFrameXmlTitles(() => false);
  const events = [];
  model.attach({ fire: (...args) => { events.push(args); return 1; } });
  model.tick();
  assert.equal(model.count(), 39);
  assert.deepEqual(CANNED_KNOWN_TITLES.map((mask) => model.isKnown(mask)), [true, true, true]);
  assert.equal(model.isKnown(38), false);
  assert.equal(model.current(), CANNED_CHOSEN_TITLE);
  model.setCurrent(36);
  assert.equal(world.chosen(), 36);
  model.setCurrent(38);
  assert.equal(world.chosen(), 36, "an unearned mask sends nothing and changes nothing");
  model.setCurrent(-1);
  assert.equal(world.chosen(), 0);
  assert.equal(model.current(), FRAMEXML_NO_TITLE);
  assert.deepEqual(world.sent, [36, -1]);
  model.tick();
  assert.deepEqual(events, [["UNIT_NAME_UPDATE", "player"]]);
  events.length = 0;
  world.earn(38);
  model.tick();
  assert.deepEqual(events, [["KNOWN_TITLES_UPDATE"]]);
  assert.equal(model.isKnown(38), true);
});

test("the canned seam answers the picker and the name line from the canned warrior", () => {
  const seam = new CannedWorldSeam();
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  assert.deepEqual(call("GetNumTitles"), [39]);
  assert.deepEqual(call("UnitPVPName", "player"), ["Рядовой Игрок"]);
  assert.deepEqual(call("GetTitleName", 15), ["Разведчик "], "the canned warrior is male");
  call("SetCurrentTitle", 36);
  assert.deepEqual(call("UnitPVPName", "player"), ["Игрок, защитник Наару"]);
  assert.deepEqual(seam.titleWorld.sent, [36]);
});

test("the route version is pinned on both sides and the canned rows are this dataset's", () => {
  assert.equal(CHAR_TITLE_ROUTE_VERSION, CHAR_TITLES_VERSION);
  assert.equal(CANNED_TITLE_ROWS.length, 4);
  assert.equal(FRAMEXML_KNOWN_TITLE_WORDS, 6, "three uint64 fields");
});

let dbcDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  dbcDirectory = paths.dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const { existsSync } = await import("node:fs");
const withDataset = { skip: dbcDirectory && existsSync(`${dbcDirectory}/CharTitles.dbc`) ? false : "no dataset DBCs on this machine" };

test("the gateway catalog over this dataset: every row masked, the canned rows measured, the female forms declined", withDataset, async () => {
  const catalog = await loadCharTitles(dbcDirectory);
  assert.equal(catalog.version, CHAR_TITLES_VERSION);
  assert.ok(catalog.titles.length >= 140, `rows: ${catalog.titles.length}`);
  assert.ok(catalog.titles.every((row) => row.maskId > 0 && row.maskId < 192 && row.name.includes("%s")),
    "every title carries a mask below MAX_TITLE_INDEX and the name placeholder");
  const masks = catalog.titles.map((row) => row.maskId);
  assert.deepEqual(masks, [...masks].sort((a, b) => a - b), "ascending by mask");
  assert.equal(new Set(masks).size, masks.length, "one row per mask");
  const byMask = new Map(catalog.titles.map((row) => [row.maskId, row]));
  for (const row of CANNED_TITLE_ROWS) assert.deepEqual(byMask.get(row.maskId), { ...row });
  assert.ok(catalog.titles.some((row) => row.nameFemale !== row.name), "ruRU declines some titles");
  const rows = charTitleRows(JSON.parse(JSON.stringify(catalog)));
  assert.equal(rows?.length, catalog.titles.length, "the browser accepts the route's own answer");
});

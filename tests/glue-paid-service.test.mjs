import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import {
  CHAR_CUSTOMIZE_FLAG_CUSTOMIZE, CHAR_CUSTOMIZE_FLAG_FACTION, CHAR_CUSTOMIZE_FLAG_RACE,
  buildCustomizeCharacter, buildFactionOrRaceChange, paidServiceKind,
} from "../dist/code/world/CharacterServiceProtocol.js";
import { GlueCreation, SEX_FEMALE } from "../dist/code/browser/glue/GlueCreation.js";
import { GlueSession } from "../dist/code/browser/glue/GlueSession.js";
import { GlueRuntime } from "../dist/code/browser/glue/GlueRuntime.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { fakeGlueSession } from "../dist/code/browser/glue/GlueFakeSession.js";

/**
 * WORK_PLAN 2.08: the paid services — customisation, faction change, race change — on the stock
 * creation screen, held to TrinityCore and to Wow.exe 3.3.5a 12340 (`.runtime/re-2026-10-02/a6-208/`):
 * * HandleCharCustomize (CharacterHandler.cpp:1393-1409) and HandleCharFactionOrRaceChange
 *   (:1645-1665) read guid, name, gender, skin, hairColor, hairStyle, facialHair, face [, race]; the
 *   client's senders 0x4d8e10 (0x473), 0x4d8f20 (0x4d9), 0x4d9040 (0x4f8) write that order, after a
 *   CANCEL dialog with CHAR_CUSTOMIZE_IN_PROGRESS / FACTION_CHANGE_IN_PROGRESS / RACE_CHANGE_IN_PROGRESS.
 * * CreateCharacter (0x4e0c60 → 0x4e0380) in paid mode picks the packet by the list entry's
 *   customise flags — race bit, then faction bit, else customise — and skips the name check when the
 *   name is the character's own (`_strnicmp`).
 * * CustomizeExistingCharacter (0x4e2330) loads race, class, sex and look; PaidChange_* (0x4e0ca0,
 *   0x4e0cd0, 0x4e1b70) answer the loaded character; ResetCharCustomize (0x4e1fd0) ends paid mode.
 * * The answers (0x4d9190, 0x4d92d0): success updates the row (0x4e29e0), closes the dialog and goes
 *   back to charselect; a refusal is OKAY with the screen's key.
 */

const utf8 = (text) => [...new TextEncoder().encode(text)];
const GUID = [0x34, 0x12, 0, 0, 0, 0, 0, 0];
const settle = async () => {
  for (let round = 0; round < 8; round++) await new Promise((resolve) => { setImmediate(resolve); });
};

test("CMSG_CHAR_CUSTOMIZE is guid, name, gender, skin, hairColor, hairStyle, facialHair, face", () => {
  const request = { guid: 0x1234n, name: "Ана", gender: 1, skin: 2, face: 3, hairStyle: 4, hairColor: 5, facialHair: 6 };
  assert.deepEqual([...buildCustomizeCharacter(request)], [...GUID, ...utf8("Ана"), 0, 1, 2, 5, 4, 6, 3]);
  // The faction and the race change are the same body and the new race's id after it.
  assert.deepEqual([...buildFactionOrRaceChange({ ...request, race: 10 })],
    [...GUID, ...utf8("Ана"), 0, 1, 2, 5, 4, 6, 3, 10]);
});

test("the customise flags pick the packet: race, then faction, then customise", () => {
  assert.equal(CHAR_CUSTOMIZE_FLAG_CUSTOMIZE, 0x1);
  assert.equal(CHAR_CUSTOMIZE_FLAG_FACTION, 0x10000);
  assert.equal(CHAR_CUSTOMIZE_FLAG_RACE, 0x100000);
  assert.equal(paidServiceKind(CHAR_CUSTOMIZE_FLAG_RACE | CHAR_CUSTOMIZE_FLAG_FACTION | 1), "race");
  assert.equal(paidServiceKind(CHAR_CUSTOMIZE_FLAG_FACTION | 1), "faction");
  assert.equal(paidServiceKind(1), "customize");
  assert.equal(paidServiceKind(0), "customize", "0x4e0380's last branch takes everything else");
});

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) { const resume = wake; wake = undefined; resume(queue.shift()); }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload: [...payload] }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

test("WorldClient sends the three opcodes and reads the core's two answers", async () => {
  const connection = fakeConnection();
  const client = new WorldClient(connection);
  const request = { guid: 0x1234n, name: "Ана", gender: 0, skin: 1, face: 2, hairStyle: 3, hairColor: 4, facialHair: 5 };
  connection.push(OPCODES.SMSG_CHAR_CUSTOMIZE, Uint8Array.of(50));
  assert.equal((await client.customizeCharacter(request)).result, 50);
  assert.equal(connection.sent.at(-1).opcode, OPCODES.CMSG_CHAR_CUSTOMIZE);

  const success = new PacketWriter().u8(0).u64(0x1234n).cString("Ана").u8(0).u8(1).u8(2).u8(3).u8(4).u8(5).u8(2)
    .toUint8Array();
  connection.push(OPCODES.SMSG_CHAR_FACTION_CHANGE, success);
  const faction = await client.changeRaceOrFaction({ ...request, race: 2 }, true);
  assert.equal(connection.sent.at(-1).opcode, OPCODES.CMSG_CHAR_FACTION_CHANGE);
  assert.equal(faction.appearance.race, 2);
  connection.push(OPCODES.SMSG_CHAR_FACTION_CHANGE, Uint8Array.of(67));
  assert.equal((await client.changeRaceOrFaction({ ...request, race: 2 }, false)).result, 67);
  assert.equal(connection.sent.at(-1).opcode, OPCODES.CMSG_CHAR_RACE_CHANGE);
  assert.equal(OPCODES.CMSG_CHAR_CUSTOMIZE, 0x473);
  assert.equal(OPCODES.CMSG_CHAR_FACTION_CHANGE, 0x4d9);
  assert.equal(OPCODES.CMSG_CHAR_RACE_CHANGE, 0x4f8);
});

/* --- The creation screen in paid mode ---------------------------------------------------------- */

const race = (id, name, file, side, classes) => ({
  id, name, clientPrefix: file.slice(0, 2), clientFileString: file, playable: true, side,
  factionId: id, baseLanguage: 0, expansion: 0, maleDisplayId: 100 + id, femaleDisplayId: 200 + id,
  hairCustomization: "NORMAL", facialHairCustomization: ["NORMAL", "NORMAL"], classes,
});
const RACES = [
  race(1, "Человек", "Human", 0, [1, 5]),
  race(2, "Орк", "Orc", 1, [1]),
  race(4, "Ночной эльф", "NightElf", 0, [1, 5, 11]),
  race(5, "Нежить", "Scourge", 1, [1, 5]),
];
const CLASSES = [
  { id: 1, name: "Воин", fileName: "WARRIOR", classMask: 1, powerType: 1, expansion: 0, playable: true },
  { id: 5, name: "Жрец", fileName: "PRIEST", classMask: 16, powerType: 0, expansion: 0, playable: true },
  { id: 11, name: "Друид", fileName: "DRUID", classMask: 1024, powerType: 0, expansion: 0, playable: true },
];
/** An answer that offers none of the looks the character wears: a clamp would show. */
const OPTIONS = { skins: [0], faces: [0], hairStyles: [0], hairColors: [0], facialHairs: [0], facesBySkin: { 0: [0] } };

function orc(overrides = {}) {
  return {
    guid: 0x1002n, name: "Гаррош", race: 2, classId: 1, gender: 1,
    skin: 3, face: 2, hairStyle: 1, hairColor: 4, facialHair: 0, level: 80, zone: 1, map: 1,
    x: 0, y: 0, z: 0, guildId: 0, flags: 0, customizeFlags: CHAR_CUSTOMIZE_FLAG_FACTION,
    firstLogin: false, petDisplayId: 0, petLevel: 0, petFamily: 0, equipment: [], ...overrides,
  };
}

function creation(overrides = {}) {
  const calls = { paid: [], events: [], screens: [] };
  let answer = overrides.answer ?? { status: "answered", answer: { result: 0, guid: 0x1002n, name: "", appearance: undefined } };
  const model = new GlueCreation({
    tables: () => ({ races: RACES, classes: CLASSES }),
    source: { options: async () => OPTIONS, startOutfit: async () => [], displayId: () => 1 },
    create: async () => { throw new Error("CMSG_CHAR_CREATE in paid mode"); },
    ...(overrides.noPaid ? {} : { paid: async (request) => { calls.paid.push(request); return typeof answer === "function" ? answer() : answer; } }),
    fireEvent: (event, ...args) => { calls.events.push([event, ...args].join(" / ")); },
    setGlueScreen: (name) => { calls.screens.push(name); },
    glueString: (key) => `<${key}>`,
    nameRules: () => overrides.nameRules ?? {},
    random: () => 0.999,
  });
  return { model, calls, setAnswer: (next) => { answer = next; } };
}

test("CustomizeExistingCharacter puts the character on the screen as it is and PaidChange_* keep it", async () => {
  const { model } = creation();
  assert.equal(model.paidName(), undefined, "outside paid mode PaidChange_GetName is nil");
  assert.equal(model.paidRaceIndex(), 0);
  assert.equal(model.beginPaidService(orc()), true);
  await settle();
  assert.equal(model.raceIndex, 2, "the orc's button, not the first");
  assert.equal(model.classIndex, 1);
  assert.equal(model.sex, SEX_FEMALE);
  assert.deepEqual(model.look, { skin: 3, face: 2, hairStyle: 1, hairColor: 4, facialHair: 0 },
    "no randomise and no clamp onto the profile's offered values");
  assert.equal(model.paid.kind, "faction");
  // The player picks another race: the current-race answers still name the character's.
  model.selectRace(4);
  await settle();
  assert.equal(model.paidRaceIndex(), 2);
  assert.equal(model.paidClassIndex(), 1);
  assert.equal(model.paidName(), "Гаррош");
  // ResetCharCustomize (the ordinary creation screen's OnShow) forgets the paid character.
  model.reset();
  assert.equal(model.paid, undefined);
  assert.equal(model.paidName(), undefined);
  assert.equal(model.beginPaidService(undefined), false, "a row that is not there changes nothing");
});

test("CreateCharacter in faction mode sends the chosen race's id and answers in the screen's dialogs", async () => {
  const { model, calls, setAnswer } = creation();
  model.beginPaidService(orc());
  await settle();
  model.selectRace(3);
  await settle();
  setAnswer({ status: "answered", answer: { result: 66, guid: 0n, name: "", appearance: undefined } });
  assert.equal(await model.createCharacter("Гаррош"), 66);
  assert.equal(calls.paid.length, 1);
  assert.deepEqual({ ...calls.paid[0] }, {
    kind: "faction", guid: 0x1002n, name: "Гаррош", race: 4, gender: 1,
    skin: model.look.skin, face: model.look.face, hairStyle: model.look.hairStyle,
    hairColor: model.look.hairColor, facialHair: model.look.facialHair,
  });
  assert.deepEqual(calls.events, [
    "OPEN_STATUS_DIALOG / CANCEL / <FACTION_CHANGE_IN_PROGRESS>",
    "OPEN_STATUS_DIALOG / OKAY / <CHAR_FACTION_CHANGE_SWAP_FACTION>",
    "UPDATE_STATUS_DIALOG / <CHAR_FACTION_CHANGE_SWAP_FACTION>",
  ]);
  assert.deepEqual(calls.screens, [], "a refusal keeps the creation screen in paid mode");
  assert.equal(model.paid?.kind, "faction");

  calls.events.length = 0;
  setAnswer({ status: "answered", answer: { result: 0, guid: 0x1002n, name: "Гаррош", appearance: undefined } });
  assert.equal(await model.createCharacter("Гаррош"), 0);
  assert.deepEqual(calls.events, ["OPEN_STATUS_DIALOG / CANCEL / <FACTION_CHANGE_IN_PROGRESS>", "CLOSE_STATUS_DIALOG"]);
  assert.deepEqual(calls.screens, ["charselect"]);
});

test("the race and customise flags pick their packets, dialogs and refusal keys", async () => {
  const raceStage = creation({ answer: { status: "answered", answer: { result: 48, guid: 0n, name: "", appearance: undefined } } });
  raceStage.model.beginPaidService(orc({ customizeFlags: CHAR_CUSTOMIZE_FLAG_RACE }));
  await settle();
  await raceStage.model.createCharacter("Гаррош");
  assert.equal(raceStage.calls.paid[0].kind, "race");
  assert.equal(raceStage.calls.paid[0].race, 2, "the race is sent even when it did not change");
  assert.equal(raceStage.calls.events[0], "OPEN_STATUS_DIALOG / CANCEL / <RACE_CHANGE_IN_PROGRESS>");
  assert.equal(raceStage.calls.events[1], "OPEN_STATUS_DIALOG / OKAY / <CHAR_FACTION_CHANGE_FAILED>",
    "0x4d92d0 answers the race change too");

  const customize = creation({ answer: { status: "answered", answer: { result: 50, guid: 0n, name: "", appearance: undefined } } });
  customize.model.beginPaidService(orc({ customizeFlags: CHAR_CUSTOMIZE_FLAG_CUSTOMIZE }));
  await settle();
  await customize.model.createCharacter("Тралл");
  assert.equal(customize.calls.paid[0].kind, "customize");
  assert.deepEqual(customize.calls.events.slice(0, 2), [
    "OPEN_STATUS_DIALOG / CANCEL / <CHAR_CUSTOMIZE_IN_PROGRESS>",
    "OPEN_STATUS_DIALOG / OKAY / <CHAR_CREATE_NAME_IN_USE>",
  ]);
  customize.setAnswer({ status: "answered", answer: { result: 48, guid: 0n, name: "", appearance: undefined } });
  await customize.model.createCharacter("Тралл");
  assert.equal(customize.calls.events.at(-2), "OPEN_STATUS_DIALOG / OKAY / <CHAR_CUSTOMIZE_FAILED>");
});

test("the character's own name skips the name check; another name goes through it", async () => {
  // A Cyrillic-only realm category (mask 4): the Latin name the character already has would be
  // refused by the creation rules, and 0x4e0380 does not ask them about the unchanged name.
  const { model, calls } = creation({ nameRules: { alphabetMask: 4 } });
  model.beginPaidService(orc({ name: "Garrosh", customizeFlags: CHAR_CUSTOMIZE_FLAG_CUSTOMIZE }));
  await settle();
  await model.createCharacter("GARROSH");
  assert.equal(calls.paid.length, 1, "the same name, ASCII case aside, is sent unchecked");
  assert.equal(calls.paid[0].name, "GARROSH");
  calls.events.length = 0;
  await model.createCharacter("Thrall");
  assert.equal(calls.paid.length, 1, "a new Latin name is refused before anything is sent");
  assert.match(calls.events[0], /^OPEN_STATUS_DIALOG \/ OKAY \/ <CHAR_NAME_/);
});

test("with nobody to ask the paid screen says it failed instead of waiting forever", async () => {
  const { model, calls } = creation({ answer: { status: "unavailable" } });
  model.beginPaidService(orc());
  await settle();
  await model.createCharacter("Гаррош");
  assert.equal(calls.events.at(-2), "OPEN_STATUS_DIALOG / OKAY / <CHAR_FACTION_CHANGE_FAILED>");
  assert.deepEqual(calls.screens, []);
});

/* --- The session ------------------------------------------------------------------------------- */

async function sessionStage() {
  const events = [];
  let resolve;
  const sent = [];
  const characters = [orc(), orc({ guid: 0x1003n, name: "Сильвана", customizeFlags: 0 })];
  const world = {
    characters: async () => characters.map((character) => ({ ...character })),
    deleteCharacter: async () => 71,
    changeRaceOrFaction: (request, faction) => {
      sent.push([request, faction]);
      return new Promise((done) => { resolve = done; });
    },
    close: () => {},
  };
  const session = new GlueSession({
    connect: async () => world,
    fireEvent: (event) => { events.push(event); },
  });
  session.beginSession({ username: "T", sessionKey: new Uint8Array(40), realms: [] });
  await session.connect({ type: 0, locked: false, flags: 0, name: "R", address: "x", population: 0, characters: 2, timezone: 1, id: 1 });
  return { session, events, sent, answer: (value) => resolve(value) };
}

const request = (overrides = {}) => ({
  kind: "faction", guid: 0x1002n, name: "Гаррош", race: 5, gender: 1,
  skin: 1, face: 2, hairStyle: 3, hairColor: 4, facialHair: 5, ...overrides,
});

test("a successful faction change updates the row and clears its paid-service bits", async () => {
  const stage = await sessionStage();
  assert.equal(stage.session.canPaidService("faction"), true);
  assert.equal(stage.session.canPaidService("customize"), false, "the fake world carries only one call");
  const pending = stage.session.paidService(request());
  await settle();
  assert.equal(stage.sent[0][1], true, "faction: CMSG_CHAR_FACTION_CHANGE");
  stage.events.length = 0;
  stage.answer({ result: 0, guid: 0x1002n, name: "Гарри", appearance: { gender: 1, skin: 1, face: 2, hairStyle: 3, hairColor: 4, facialHair: 5, race: 5 } });
  const outcome = await pending;
  assert.equal(outcome.status, "answered");
  const row = stage.session.characters[0];
  assert.equal(row.name, "Гарри");
  assert.equal(row.race, 5);
  assert.equal(row.customizeFlags, 0);
  assert.equal(stage.session.characterRow(1).factionChange, false);
  assert.deepEqual(stage.events, ["CHARACTER_LIST_UPDATE"]);
  assert.equal((await stage.session.paidService(request({ kind: "customize" }))).status, "unavailable");
  assert.equal((await stage.session.paidService(request({ guid: 0x9999n }))).status, "unavailable");
});

test("cancelling the wait drops the answer for the screen but a late success still lands", async () => {
  const stage = await sessionStage();
  const pending = stage.session.paidService(request({ kind: "race" }));
  await settle();
  assert.equal(stage.sent[0][1], false, "race: CMSG_CHAR_RACE_CHANGE");
  stage.session.cancelPending();
  stage.answer({ result: 0, guid: 0x1002n, name: "Гаррош", appearance: { gender: 0, skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0, race: 2 } });
  assert.equal((await pending).status, "cancelled");
  assert.equal(stage.session.characters[0].customizeFlags, 0);
  assert.equal(stage.session.characters[0].gender, 0);
});

test("a paid service cancelled while it still waits its turn in the queue is never sent", async () => {
  // Wow.exe sends the packet inside CreateCharacter, so its CANCEL can only come after it left. Here a
  // request queues behind the one before it (`GlueSession.request`): a CANCEL clicked while it still
  // waits must not let it reach the owner's character afterwards.
  const sent = [];
  let releaseList;
  let hold = false;
  const world = {
    characters: async () => {
      if (hold) await new Promise((done) => { releaseList = done; });
      return [orc()];
    },
    deleteCharacter: async () => 71,
    changeRaceOrFaction: async (body, faction) => {
      sent.push([body, faction]);
      return { result: 0, guid: body.guid, name: body.name, appearance: undefined };
    },
    close: () => {},
  };
  const session = new GlueSession({ connect: async () => world, fireEvent: () => {} });
  session.beginSession({ username: "T", sessionKey: new Uint8Array(40), realms: [] });
  await session.connect({ type: 0, locked: false, flags: 0, name: "R", address: "x", population: 0, characters: 1, timezone: 1, id: 1 });
  hold = true;
  const refresh = session.refreshCharacters();
  await settle();
  assert.equal(session.busy, true, "the list request holds the queue");
  const pending = session.paidService(request());
  session.cancelPending();
  releaseList();
  await refresh;
  assert.equal((await pending).status, "cancelled");
  assert.deepEqual(sent, [], "nothing goes out after the CANCEL");
  assert.equal(session.characters[0].customizeFlags, CHAR_CUSTOMIZE_FLAG_FACTION, "the row is untouched");
  // A request that is not cancelled still goes out once the queue frees.
  assert.equal((await session.paidService(request())).status, "answered");
  assert.equal(sent.length, 1);
});

/* --- The C API, end to end --------------------------------------------------------------------- */

const FIXTURE = {
  "Interface/GlueXML/GlueXML.toc": ["## Interface: 30300", "GlueStrings.lua", "GlueParent.xml"].join("\n"),
  "Interface/GlueXML/GlueStrings.lua": `
    GlueScreenInfo = {};
    SEEN = {};
    FACTION_CHANGE_IN_PROGRESS = "Обновление фракции…";
    function SetGlueScreen(name) SEEN[#SEEN + 1] = "screen " .. name end
  `,
  "Interface/GlueXML/GlueParent.xml": `<Ui>
    <Frame name="GlueParent" setAllPoints="true">
      <Scripts>
        <OnLoad>
          self:RegisterEvent("OPEN_STATUS_DIALOG");
          self:RegisterEvent("CLOSE_STATUS_DIALOG");
        </OnLoad>
        <OnEvent>SEEN[#SEEN + 1] = event .. " / " .. tostring(arg1) .. " / " .. tostring(arg2);</OnEvent>
      </Scripts>
    </Frame>
  </Ui>`,
};

test("the stock calls reach the real paid mode, not the old constant stubs", async () => {
  const canned = fakeGlueSession("charselect");
  const base = await (await canned.connect()).characters();
  // The second canned character (a night-elf druid) offered a faction change.
  const characters = base.map((character, at) => (at === 1 ? { ...character, customizeFlags: CHAR_CUSTOMIZE_FLAG_FACTION } : character));
  const sent = [];
  const world = {
    characters: async () => characters.map((character) => ({ ...character })),
    deleteCharacter: async () => 71,
    changeRaceOrFaction: async (body, faction) => {
      sent.push([body, faction]);
      return { result: 0, guid: body.guid, name: body.name, appearance: undefined };
    },
    close: () => {},
  };
  const runtime = new GlueRuntime({
    provider: createFixtureProvider(FIXTURE),
    api: {
      locale: "ruRU",
      session: { connect: async () => world },
      creation: {
        tables: () => ({ races: RACES, classes: CLASSES }),
        source: { options: async () => OPTIONS, startOutfit: async () => [], displayId: () => 1 },
      },
    },
  });
  await runtime.load();
  try {
    runtime.session.beginSession(canned.auth);
    await runtime.session.connect(canned.realm);
    const lua = (source) => {
      runtime.vm.setGlobal("__result", undefined);
      const outcome = runtime.vm.execute(`__result = (function() ${source} end)()`, "@glue-paid-probe");
      assert.equal(outcome.ok, true, `${source}: ${outcome.error ?? ""}`);
      return runtime.vm.getGlobal("__result");
    };
    lua("CustomizeExistingCharacter(2); return 1");
    await settle();
    assert.equal(lua("return PaidChange_GetName()"), base[1].name);
    assert.equal(lua("return PaidChange_GetCurrentRaceIndex()"), 3, "night elf is the third race button here, not the stub's 1");
    assert.equal(lua("return PaidChange_GetCurrentClassIndex()"), 3);
    assert.equal(lua("return (GetSelectedRace())"), 3);
    lua("SEEN = {}; SetSelectedRace(4); return 1");
    await settle();
    lua(`CreateCharacter(PaidChange_GetName()); return 1`);
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0][1], true);
    assert.equal(sent[0][0].race, 5);
    assert.equal(sent[0][0].guid, base[1].guid);
    assert.deepEqual(lua('return table.concat(SEEN, "\\n")').split("\n"), [
      "OPEN_STATUS_DIALOG / CANCEL / Обновление фракции…",
      "CLOSE_STATUS_DIALOG / nil / nil",
      "screen charselect",
    ]);
    for (const name of ["CustomizeExistingCharacter", "PaidChange_GetCurrentRaceIndex", "PaidChange_GetCurrentClassIndex", "PaidChange_GetName"]) {
      assert.equal(runtime.api.stubbedGlobals.includes(name), false, `${name} is not a stub any more`);
    }
  } finally {
    runtime.close();
  }
});

test("a pending paid service does not stop EnterWorld: Wow.exe 0x4d9bd0 reads only the character flags", async () => {
  const { enterWorldRefusal } = await import("../dist/code/browser/glue/GlueEnterGate.js");
  // The gate reads +0x170 (0x4, 0x01000000, 0x4000, 0x02000000) and never +0x174, where the three
  // paid-service bits live; the core loads such a character as usual (only AT_LOGIN_RENAME is refused
  // at login, Player.cpp:18123). The list flags here are the core's for a declined character.
  for (const customizeFlags of [CHAR_CUSTOMIZE_FLAG_CUSTOMIZE, CHAR_CUSTOMIZE_FLAG_FACTION, CHAR_CUSTOMIZE_FLAG_RACE]) {
    const character = orc({ flags: 0x02000000, customizeFlags });
    assert.equal(enterWorldRefusal(character.flags, { name: character.name, locale: "ruRU" }), undefined);
  }
});

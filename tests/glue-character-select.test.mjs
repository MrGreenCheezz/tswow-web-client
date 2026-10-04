import assert from "node:assert/strict";
import test from "node:test";
import { GlueRuntime } from "../dist/code/browser/glue/GlueRuntime.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { GlueSession } from "../dist/code/browser/glue/GlueSession.js";
import { sexedName } from "../dist/code/browser/glue/GlueNames.js";
import { GlueAddonList } from "../dist/code/browser/glue/GlueAddons.js";
import { declinableName, enterWorldRefusal } from "../dist/code/browser/glue/GlueEnterGate.js";
import { genderedNames } from "../dist/code/gateway/CharacterCreation.js";
import { buildDeclinedNames } from "../dist/code/world/CharacterProtocol.js";

/**
 * 10.09 — character select: names by sex, «Выход», the Russian declension step, «Модификации».
 */

const DECLINED = 0x02000000;

function summary(guid, name, extra = {}) {
  return {
    guid: BigInt(guid), name, race: 1, classId: 5, gender: 0, skin: 0, face: 0, hairStyle: 0, hairColor: 0,
    facialHair: 0, level: 10, zone: 12, map: 0, x: 0, y: 0, z: 0, guildId: 0, flags: 0, customizeFlags: 0,
    firstLogin: false, petDisplayId: 0, petLevel: 0, petFamily: 0, equipment: [], ...extra,
  };
}

const AUTH = {
  username: "TESTER", sessionKey: new Uint8Array(40),
  realms: [{ type: 0, locked: false, flags: 0, name: "Мир", address: "127.0.0.1:8085", population: 0,
    characters: 2, timezone: 1, id: 1, build: undefined }],
};

/* --- (a) names by sex ----------------------------------------------------------------------- */

test("a race or class is named by the character's sex, as GetCharacterInfo names it", () => {
  // Wow.exe 0x715970/0x7159e0: own sex's column, else the other sex's, else Name_lang.
  assert.deepEqual(genderedNames("Жрец", "Жрец", "Жрица"), { name: "Жрец", nameMale: "Жрец", nameFemale: "Жрица" });
  assert.deepEqual(genderedNames("Воин", "", ""), { name: "Воин", nameMale: "Воин", nameFemale: "Воин" });
  assert.deepEqual(genderedNames("X", "", "Xf"), { name: "X", nameMale: "Xf", nameFemale: "Xf" });
  const row = { name: "Жрец", nameMale: "Жрец", nameFemale: "Жрица" };
  assert.equal(sexedName(row, 1), "Жрица");
  assert.equal(sexedName(row, 0), "Жрец");
  assert.equal(sexedName(row), "Жрец", "no sex (the creation lists) is Name_lang");
  assert.equal(sexedName({ name: "Жрец" }, 1), "Жрец", "a gateway without the sexed names");

  const session = new GlueSession({
    fireEvent: () => {},
    names: {
      raceName: (race, sex) => (sex === 1 ? "Человек-ж" : "Человек"),
      className: (classId, sex) => (sex === 1 ? "Жрица" : "Жрец"),
      zoneName: () => "",
      raceDisplayId: () => undefined,
    },
    connect: async () => ({
      characters: async () => [summary(1, "Анна", { gender: 1 }), summary(2, "Иван")],
      deleteCharacter: async () => 71,
      close() {},
    }),
  });
  session.beginSession(AUTH);
  return session.connect(AUTH.realms[0]).then(() => {
    assert.equal(session.characterRow(1).className, "Жрица");
    assert.equal(session.characterRow(1).race, "Человек-ж");
    assert.equal(session.characterRow(2).className, "Жрец");
  });
});

/* --- the C API over a fake world ------------------------------------------------------------- */

const FIXTURE = { "Interface/GlueXML/GlueXML.toc": "## Interface: 30300\n" };

async function glue(api = {}, characters = [summary(1, "Артас"), summary(2, "Arthas")]) {
  const sent = [];
  let answer = 0;
  const events = [];
  const runtime = new GlueRuntime({
    provider: createFixtureProvider(FIXTURE),
    api: {
      locale: "ruRU",
      enterWorld: (request) => events.push(["ENTER", request.character.name]),
      session: {
        connect: async () => ({
          characters: async () => characters.map((entry) => ({ ...entry })),
          deleteCharacter: async () => 71,
          declineCharacterNames: async (guid, name, cases) => {
            sent.push([guid, name, cases]);
            return { result: answer, guid };
          },
          close() {},
        }),
      },
      ...api,
    },
  });
  await runtime.load();
  const original = runtime.api.fireEvent.bind(runtime.api);
  runtime.api.fireEvent = (event, ...args) => { events.push([event, ...args]); return original(event, ...args); };
  const evaluate = (expression) => {
    runtime.vm.setGlobal("__result", undefined);
    const outcome = runtime.vm.execute(`__result = (function() ${expression} end)()`, "@glue-charselect-probe");
    assert.equal(outcome.ok, true, `${expression}: ${outcome.error ?? ""}`);
    return runtime.vm.getGlobal("__result");
  };
  runtime.session.beginSession(AUTH);
  await runtime.session.connect(AUTH.realms[0]);
  return { runtime, evaluate, events, sent, setAnswer: (value) => { answer = value; } };
}

const settle = async () => { for (let round = 0; round < 6; round++) await new Promise((resolve) => setImmediate(resolve)); };

/* --- (b) «Выход» ---------------------------------------------------------------------------- */

test("QuitGame asks the host to close, once per call; without a host it stays a stub", async () => {
  let quits = 0;
  const { runtime, evaluate } = await glue({ onQuit: () => { quits++; } });
  try {
    evaluate("QuitGame(); return 1");
    assert.equal(quits, 1);
    evaluate("QuitGameAndRunLauncher(); return 1");
    assert.equal(quits, 2);
  } finally {
    runtime.close();
  }
  const plain = await glue();
  try {
    assert.equal(plain.evaluate("QuitGame(); return 1"), 1, "the stub still answers");
  } finally {
    plain.runtime.close();
  }
});

/* --- (c) the declension step ---------------------------------------------------------------- */

test("CMSG_SET_PLAYER_DECLINED_NAMES carries guid, name and five cases", () => {
  const bytes = buildDeclinedNames(0x0102n, "Аб", ["а", "б", "в", "г", "д"]);
  const enc = new TextEncoder();
  const expected = [
    0x02, 0x01, 0, 0, 0, 0, 0, 0,
    ...enc.encode("Аб"), 0,
    ...["а", "б", "в", "г", "д"].flatMap((form) => [...enc.encode(form), 0]),
  ];
  assert.deepEqual([...bytes], expected);
  assert.throws(() => buildDeclinedNames(1n, "Аб", ["а"]), /five cases/);
});

test("the enter gate asks for a declension only for an undeclined Russian name on ruRU", () => {
  assert.equal(declinableName("Артас"), true);
  assert.equal(declinableName("Arthas"), false);
  assert.equal(enterWorldRefusal(0, { name: "Артас", locale: "ruRU" })?.kind, "decline");
  assert.equal(enterWorldRefusal(DECLINED, { name: "Артас", locale: "ruRU" }), undefined);
  assert.equal(enterWorldRefusal(0, { name: "Артас", locale: "enUS" }), undefined);
  assert.equal(enterWorldRefusal(0, { name: "Arthas", locale: "ruRU" }), undefined);
  assert.equal(enterWorldRefusal(0), undefined, "the DOM card names no locale and never asks");
  assert.equal(enterWorldRefusal(0x4000, { name: "Артас", locale: "ruRU" })?.kind, "rename", "rename comes first");
});

test("EnterWorld stops at the declension frame, DeclineCharacter sends and marks the row", async () => {
  const { runtime, evaluate, events, sent, setAnswer } = await glue();
  try {
    evaluate("SelectCharacter(1); EnterWorld(); return 1");
    assert.deepEqual(events.filter(([event]) => event === "FORCE_DECLINE_CHARACTER"), [["FORCE_DECLINE_CHARACTER"]]);
    assert.equal(events.some(([event]) => event === "ENTER"), false, "not handed to the world");

    // Empty case: nothing at all, as the client does.
    assert.equal(evaluate("return DeclineCharacter(1, 'Артаса', '', 'Артаса', 'Артасом', 'Артасе')"), undefined);
    assert.equal(sent.length, 0);

    assert.equal(evaluate("return DeclineCharacter(1, 'Артаса', 'Артасу', 'Артаса', 'Артасом', 'Артасе')"), 1);
    await settle();
    assert.deepEqual(sent, [[1n, "Артас", ["Артаса", "Артасу", "Артаса", "Артасом", "Артасе"]]]);
    assert.ok(events.some(([event, type]) => event === "OPEN_STATUS_DIALOG" && type === "CANCEL"));
    assert.ok(events.some(([event]) => event === "CLOSE_STATUS_DIALOG"));
    assert.equal(runtime.session.characters[0].flags & DECLINED, DECLINED, "the row is declined now");

    events.length = 0;
    evaluate("SelectCharacter(1); EnterWorld(); return 1");
    assert.deepEqual(events.filter(([event]) => event === "ENTER"), [["ENTER", "Артас"]]);

    // A declined character is not sent again.
    assert.equal(evaluate("return DeclineCharacter(1, 'а', 'б', 'в', 'г', 'д')"), undefined);
    setAnswer(1);
  } finally {
    runtime.close();
  }
});

test("a refused declension re-opens the frame with CHAR_DECLINE_FAILED", async () => {
  const { runtime, evaluate, events, setAnswer } = await glue();
  try {
    setAnswer(1);
    evaluate("return DeclineCharacter(1, 'а', 'б', 'в', 'г', 'д')");
    await settle();
    assert.deepEqual(events.filter(([event]) => event === "FORCE_DECLINE_CHARACTER"),
      [["FORCE_DECLINE_CHARACTER", "CHAR_DECLINE_FAILED"]]);
    assert.equal(runtime.session.characters[0].flags & DECLINED, 0);
  } finally {
    runtime.close();
  }
});

test("a Latin name on a ruRU client enters without the frame", async () => {
  const { runtime, evaluate, events } = await glue();
  try {
    evaluate("SelectCharacter(2); EnterWorld(); return 1");
    assert.deepEqual(events.filter(([event]) => event === "ENTER"), [["ENTER", "Arthas"]]);
  } finally {
    runtime.close();
  }
});

/* --- (d) «Модификации» ---------------------------------------------------------------------- */

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}

test("the add-on list answers AddonList.lua and remembers what OK saved", async () => {
  const storage = memoryStorage({ "webclient.glue.addons:http://gw": '["mikscrollingbattletext"]' });
  const addons = new GlueAddonList({
    origin: "http://gw",
    storage,
    load: async () => [
      { name: "AnyIDTooltip", loadOnDemand: false },
      { name: "MikScrollingBattleText", loadOnDemand: false },
      { name: "Blizzard_Lazy", loadOnDemand: true },
    ],
  });
  await addons.load();
  const { runtime, evaluate } = await glue({ addons });
  try {
    assert.equal(evaluate("return GetNumAddOns()"), 3);
    assert.equal(evaluate("local n, t, notes, url, loadable, reason, sec = GetAddOnInfo(1); "
      + "return n .. '/' .. t .. '/' .. tostring(url) .. '/' .. tostring(loadable) .. '/' .. tostring(reason) .. '/' .. sec"),
    "AnyIDTooltip/AnyIDTooltip/nil/true/nil/INSECURE");
    assert.equal(evaluate("local _, _, _, _, loadable, reason = GetAddOnInfo(3); return tostring(loadable) .. reason"),
      "falseDEMAND_LOADED");
    assert.equal(evaluate("return GetAddOnEnableState(nil, 2)"), 0, "saved as off");
    assert.equal(evaluate("return GetAddOnEnableState(nil, 1)"), 2);

    // Cancel drops the clicks.
    evaluate("DisableAddOn(nil, 1); EnableAddOn('Тест', 2); return 1");
    assert.equal(evaluate("return GetAddOnEnableState(nil, 1)"), 0);
    assert.equal(evaluate("return GetAddOnEnableState(nil, 2)"), 2);
    evaluate("ResetAddOns(); return 1");
    assert.equal(evaluate("return GetAddOnEnableState(nil, 1)"), 2);
    assert.equal(evaluate("return GetAddOnEnableState(nil, 2)"), 0);

    // OK saves them, per gateway.
    evaluate("DisableAddOn(1); EnableAddOn(nil, 'MikScrollingBattleText'); SaveAddOns(); return 1");
    assert.equal(storage.data.get("webclient.glue.addons:http://gw"), '["anyidtooltip"]');
    assert.deepEqual(addons.disabledNames(), ["AnyIDTooltip"]);
    evaluate("DisableAllAddOns(); ResetAddOns(); EnableAllAddOns(); SaveAddOns(); return 1");
    assert.deepEqual(addons.disabledNames(), []);
    assert.equal(evaluate("return GetAddOnInfo(9)"), undefined, "an index past the list is nothing");
  } finally {
    runtime.close();
  }
});

test("no gateway list is an empty list, and a locked storage is no preference", async () => {
  const addons = new GlueAddonList({
    origin: "http://gw",
    storage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } },
    load: async () => { throw new TypeError("Failed to fetch"); },
  });
  await addons.load();
  assert.deepEqual(addons.addons, []);
  const { runtime, evaluate } = await glue({ addons });
  try {
    assert.equal(evaluate("return GetNumAddOns()"), 0);
    assert.equal(evaluate("SaveAddOns(); return 1"), 1, "a blocked storage does not raise");
  } finally {
    runtime.close();
  }
});

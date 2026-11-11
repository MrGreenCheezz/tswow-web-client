import assert from "node:assert/strict";
import test from "node:test";
import { GlueRuntime } from "../dist/code/browser/glue/GlueRuntime.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { GlueSession } from "../dist/code/browser/glue/GlueSession.js";
import { sexedName } from "../dist/code/browser/glue/GlueNames.js";
import { GlueAddonList, glueWorldAddonStates, setGlueWorldAddonStates } from "../dist/code/browser/glue/GlueAddons.js";
import { installFrameXmlWorldAddonApi, saveFrameXmlWorldAddonStates } from "../dist/code/browser/framexml/FrameXmlWorldAddonApi.js";
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

test("the add-on list answers AddonList.lua per character and keeps what OK saved (3.46, 11.11)", async () => {
  const fileKey = (character) => JSON.stringify(["webclient-addons-v1", "TESTER", "Мир", character]);
  const storage = memoryStorage({ [fileKey("Артас")]: "MikScrollingBattleText: disabled\r\n" });
  const tocs = {
    AnyIDTooltip: "## Interface: 30300\n## Title: Any ID\n## Notes: ids\n",
    MikScrollingBattleText: "## Interface: 30300\n",
    Blizzard_Lazy: "## Interface: 30300\n## LoadOnDemand: 1\n",
    Old: "## Interface: 20400\n",
    NeedsOld: "## Interface: 30300\n## Dependencies: Old\n",
    Quiet: "## Interface: 30300\n## DefaultState: disabled\n",
  };
  const holder = {};
  const addons = new GlueAddonList({
    storage,
    load: async () => ({
      checkAddonVersion: true,
      installed: [
        { name: "AnyIDTooltip", loadOnDemand: false, enabled: true },
        { name: "Blizzard_Lazy", loadOnDemand: true, enabled: true },
        { name: "MikScrollingBattleText", loadOnDemand: false, enabled: true },
        { name: "NeedsOld", loadOnDemand: false, enabled: true },
        { name: "Old", loadOnDemand: false, enabled: true },
        { name: "Quiet", loadOnDemand: false, enabled: true, defaultState: false },
      ],
    }),
    readToc: async (name) => tocs[name],
    identity: () => {
      const session = holder.runtime?.session;
      if (!session?.selectedRealm) return undefined;
      return { account: session.accountName, realm: session.selectedRealm.name, characters: session.characters.map((entry) => entry.name) };
    },
  });
  await addons.load();
  const { runtime, evaluate } = await glue({ addons });
  holder.runtime = runtime;
  try {
    assert.equal(evaluate("return GetNumAddOns()"), 6);
    // 0x5f79a0: in title order — «Any ID» first; title and notes are the TOC's.
    assert.equal(evaluate("local n, t, notes, url, loadable, reason, sec, new = GetAddOnInfo(1); "
      + "return n .. '/' .. t .. '/' .. notes .. '/' .. tostring(url) .. '/' .. tostring(loadable) .. '/' .. tostring(reason) .. '/' .. sec .. '/' .. tostring(new)"),
    "AnyIDTooltip/Any ID/ids/nil/1/nil/INSECURE/nil");
    const info = (index) => evaluate(`local n, _, _, _, loadable, reason = GetAddOnInfo(${index}); return n .. ':' .. tostring(loadable) .. ':' .. tostring(reason)`);
    assert.equal(info(2), "Blizzard_Lazy:nil:DEMAND_LOADED");
    assert.equal(info(4), "NeedsOld:nil:DEP_INTERFACE_VERSION");
    assert.equal(info(5), "Old:nil:INTERFACE_VERSION");
    assert.equal(info(6), "Quiet:nil:DISABLED", "DefaultState: disabled and no character names it");
    // Артас's own file has MSBT off; Arthas has none (no account file either): mixed over the two.
    assert.equal(evaluate("return GetAddOnEnableState('Артас', 3)"), 0);
    assert.equal(evaluate("return GetAddOnEnableState('Arthas', 3)"), 0, "no line of its own: the others' state");
    assert.equal(evaluate("return GetAddOnEnableState(nil, 1)"), 2);
    assert.equal(evaluate("return GetAddOnEnableState(nil, 6)"), 0);

    // A named character alone, then Cancel drops the clicks.
    evaluate("EnableAddOn('Arthas', 3); return 1");
    assert.equal(evaluate("return GetAddOnEnableState(nil, 3)"), 1, "on for some");
    assert.equal(evaluate("return GetAddOnEnableState('arthas', 3)"), 2, "character names compare in any case");
    evaluate("ResetAddOns(); return 1");
    assert.equal(evaluate("return GetAddOnEnableState('Arthas', 3)"), 0);

    // OK writes each changed character's AddOns.txt.
    evaluate("DisableAddOn(nil, 1); EnableAddOn('Артас', 3); SaveAddOns(); return 1");
    assert.equal(storage.data.get(fileKey("Артас")), "MikScrollingBattleText: enabled\r\nAnyIDTooltip: disabled\r\n");
    assert.equal(storage.data.get(fileKey("Arthas")), "AnyIDTooltip: disabled\r\n");

    // The usage errors and the range.
    const raised = (expression) => runtime.vm.execute(expression, "@addon-probe").error ?? "";
    assert.match(raised("EnableAddOn(1)"), /Usage: EnableAddOn\("character", index\)/);
    assert.match(raised("GetAddOnEnableState()"), /Usage: GetAddOnEnableState\("character", index\)/);
    assert.match(raised("GetAddOnInfo('AnyIDTooltip')"), /Usage: GetAddOnInfo\(index\)/);
    assert.match(raised("GetAddOnInfo(9)"), /AddOn index must be in the range of 1 to 6/);

    // «Load out of date AddOns» and the hand-over to the world.
    assert.equal(evaluate("return IsAddonVersionCheckEnabled()"), 1);
    evaluate("SetAddonVersionCheck(0); return 1");
    assert.equal(evaluate("return IsAddonVersionCheckEnabled()"), undefined);
    assert.equal(info(5), "Old:1:nil", "out of date, but allowed now");
    assert.equal(runtime.api.cvar("checkAddonVersion"), "0", "a glue CVar, kept with the others");
    addons.handOver("Arthas");
    const handed = glueWorldAddonStates();
    assert.equal(handed.character, "Arthas");
    assert.equal(handed.checkAddonVersion, false);
    assert.equal(handed.enabled.get("anyidtooltip"), false);
    assert.equal(handed.enabled.get("mikscrollingbattletext"), true, "Arthas has no line: Артас enables it");
    assert.equal(handed.enabled.get("quiet"), false);

    // 3.46 (11.11): the world's switches act on the same table (0x00511840 … 0x00511a40, FrameXmlWorldAddonApi.ts).
    const world = new Map();
    assert.equal(installFrameXmlWorldAddonApi({ registerGlobal: (name, fn) => world.set(name, fn) },
      ["AnyIDTooltip", "MikScrollingBattleText"]), true);
    const before = storage.data.get(fileKey("Arthas"));
    world.get("EnableAddOn")([1]);
    world.get("DisableAddOn")(["MikScrollingBattleText"]);
    assert.equal(handed.enabled.get("anyidtooltip"), true, "by index into the world's list");
    assert.equal(handed.enabled.get("mikscrollingbattletext"), false, "by name");
    assert.equal(evaluate("return GetAddOnEnableState('Arthas', 1)"), 2, "the glue's table is the same one");
    assert.equal(evaluate("return GetAddOnEnableState('Артас', 1)"), 0, "the other character's untouched");
    assert.equal(storage.data.get(fileKey("Arthas")), before, "nothing written until the world's interface unloads");
    world.get("ResetDisabledAddOns")([]);
    assert.equal(handed.enabled.get("anyidtooltip"), false, "ResetDisabledAddOns reads the file again");
    world.get("DisableAllAddOns")([]);
    saveFrameXmlWorldAddonStates();
    assert.equal(storage.data.get(fileKey("Arthas")), "AnyIDTooltip: disabled\r\nMikScrollingBattleText: disabled\r\n");
    assert.throws(() => world.get("EnableAddOn")([3]), /AddOn index must be in the range of 1 to 2/);
    assert.throws(() => world.get("EnableAddOn")([]), /Usage: EnableAddOn\(index or "name"\)/);
  } finally {
    setGlueWorldAddonStates(undefined);
    runtime.close();
  }
});

test("no gateway list is an empty list, and a locked storage is no preference", async () => {
  const addons = new GlueAddonList({
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

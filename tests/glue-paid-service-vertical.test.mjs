import assert from "node:assert/strict";
import test from "node:test";

// WORK_PLAN 2.08 against the client's own CharacterSelect and CharacterCreate out of the MPQ chain:
// the faction-change button, the creation screen in paid mode (CharacterChangeFixup) and the
// CONFIRM_PAID_SERVICE dialog, driven through the stock widgets. A machine without the client skips.
let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

/** The ten 3.3.5 races (ChrRaces) with the classes CharBaseInfo pairs them with. */
const STOCK_RACES = [
  [1, "Human", 0, [1, 2, 4, 5, 6, 8, 9]], [2, "Orc", 1, [1, 3, 4, 6, 7, 9]],
  [3, "Dwarf", 0, [1, 2, 3, 4, 5, 6]], [4, "NightElf", 0, [1, 3, 4, 5, 6, 11]],
  [5, "Scourge", 1, [1, 4, 5, 6, 8, 9]], [6, "Tauren", 1, [1, 3, 6, 7, 11]],
  [7, "Gnome", 0, [1, 4, 6, 8, 9]], [8, "Troll", 1, [1, 3, 4, 5, 6, 7, 8]],
  [10, "BloodElf", 1, [2, 3, 4, 5, 6, 8, 9]], [11, "Draenei", 0, [1, 2, 3, 5, 6, 7, 8]],
].map(([id, file, side, classes]) => ({
  id, name: file, clientPrefix: file.slice(0, 2), clientFileString: file, playable: true, side,
  factionId: id, baseLanguage: 0, expansion: 0, maleDisplayId: 0, femaleDisplayId: 0,
  hairCustomization: "NORMAL", facialHairCustomization: ["NORMAL", "NORMAL"], classes,
}));
const STOCK_CLASSES = [
  [1, "WARRIOR"], [2, "PALADIN"], [3, "HUNTER"], [4, "ROGUE"], [5, "PRIEST"], [6, "DEATHKNIGHT"],
  [7, "SHAMAN"], [8, "MAGE"], [9, "WARLOCK"], [11, "DRUID"],
].map(([id, fileName]) => ({ id, name: fileName, fileName, classMask: 1 << (id - 1), powerType: 0, expansion: 0, playable: true }));

test("a character offered a faction change opens the paid creation screen and sends CMSG_CHAR_FACTION_CHANGE", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { GlueRuntime } = await import("../dist/code/browser/glue/GlueRuntime.js");
  const { fakeGlueSession } = await import("../dist/code/browser/glue/GlueFakeSession.js");
  const chain = await clientArchives(clientDirectory);
  const canned = fakeGlueSession("charselect");
  const base = await (await canned.connect()).characters();
  // The second canned character, a night-elf druid, as the core lists AT_LOGIN_CHANGE_FACTION.
  const characters = base.map((character, at) => (at === 1 ? { ...character, customizeFlags: 0x00010000 } : character));
  const sent = [];
  const luaErrors = [];
  const runtime = new GlueRuntime({
    provider: {
      async read(path) {
        const data = await chain.read(path.replaceAll("/", "\\"));
        return data ? new TextDecoder("utf-8").decode(data) : undefined;
      },
    },
    lua: { onError: (message) => luaErrors.push(message) },
    api: {
      locale: "ruRU",
      screenWidth: 1024,
      screenHeight: 768,
      creation: {
        tables: () => ({ races: STOCK_RACES, classes: STOCK_CLASSES }),
        source: {
          options: async () => ({ skins: [0], faces: [0], hairStyles: [0], hairColors: [0], facialHairs: [0], facesBySkin: { 0: [0] } }),
          startOutfit: async () => [],
          displayId: () => undefined,
        },
      },
      session: {
        connect: async () => ({
          characters: async () => characters.map((character) => ({ ...character })),
          deleteCharacter: async () => 71,
          changeRaceOrFaction: async (request, faction) => {
            sent.push([request, faction]);
            return { result: 66, guid: 0n, name: "", appearance: undefined };
          },
          close: () => {},
        }),
      },
    },
  });
  const lua = (source) => {
    runtime.vm.setGlobal("__result", undefined);
    const outcome = runtime.vm.execute(`__result = (function() ${source} end)()`, "@glue-paid-vertical");
    assert.equal(outcome.ok, true, `${source}: ${outcome.error ?? ""}`);
    return runtime.vm.getGlobal("__result");
  };
  const settle = async () => {
    for (let round = 0; round < 8; round++) await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    await runtime.load();
    runtime.session.beginSession(canned.auth);
    await runtime.session.connect(canned.realm);
    assert.equal(runtime.api.setGlueScreen("charselect"), true);
    await settle();
    // CharacterSelect.lua:336-341: PFC shows the faction-change button and nothing else.
    assert.equal(lua("return CharSelectFactionChange2:IsShown() and 1 or 0"), 1);
    assert.equal(lua("return CharSelectFactionChange1:IsShown() and 1 or 0"), 0);
    assert.equal(lua("return CharSelectCharacterCustomize2:IsShown() and 1 or 0"), 0);

    lua("CharSelectFactionChange2:Click(); return 1");
    await settle();
    assert.deepEqual(luaErrors, [], "unhandled Lua errors while opening the paid creation screen");
    assert.equal(runtime.api.currentScreen, "charcreate");
    assert.equal(lua("return CharacterCreateNameEdit:GetText()"), characters[1].name);
    assert.equal(lua("return PaidChange_GetCurrentRaceIndex()"), 4, "night elf is the fourth button");
    // CharacterChangeFixup: the druid's class button alone, and the races of the other side that may
    // be druids (Tauren) beside the character's own.
    const enabled = (prefix, count) => {
      const lit = [];
      for (let at = 1; at <= count; at++) if (lua(`return (${prefix}${at}:IsEnabled() == 1) and 1 or 0`) === 1) lit.push(at);
      return lit;
    };
    assert.deepEqual(enabled("CharacterCreateClassButton", 10), [10]);
    assert.deepEqual(enabled("CharacterCreateRaceButton", 10), [4, 6]);

    // Pick the tauren, accept: CharacterCreate_Okay asks CONFIRM_PAID_SERVICE, whose OK calls
    // CreateCharacter with the edit box's name.
    lua("CharacterCreateRaceButton6:Click(); return 1");
    lua("CharacterCreate_Okay(); return 1");
    assert.equal(lua("return GlueDialog.which"), "CONFIRM_PAID_SERVICE");
    lua("GlueDialogButton1:Click(); return 1");
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0][1], true, "the faction change's opcode");
    assert.equal(sent[0][0].race, 6);
    assert.equal(sent[0][0].guid, characters[1].guid);
    // 66: the core's CHAR_CREATE_CHARACTER_SWAP_FACTION, in the corpus' words.
    assert.equal(lua("return GlueDialog.which"), "OKAY");
    assert.equal(lua("return GlueDialogText:GetText()"), runtime.vm.globalString("CHAR_FACTION_CHANGE_SWAP_FACTION"));
    assert.equal(runtime.api.currentScreen, "charcreate", "a refusal stays on the paid screen");
    assert.deepEqual(luaErrors, []);
  } finally {
    runtime.close();
    chain.close();
  }
});

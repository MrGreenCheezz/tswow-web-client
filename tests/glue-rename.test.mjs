import assert from "node:assert/strict";
import test from "node:test";
import { GlueRuntime } from "../dist/code/browser/glue/GlueRuntime.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { fakeGlueSession } from "../dist/code/browser/glue/GlueFakeSession.js";

/**
 * 2.07: a character the core marked for a new name (AT_LOGIN_RENAME → CHARACTER_FLAG_RENAME in the
 * list, Player.cpp:1545-1546) is never sent into the world — the core would load it, refuse it
 * (Player.cpp:18123-18127) and kick (CharacterHandler.cpp:753-756), and the screen would loop through
 * «disconnected → character select». The client's own EnterWorld (FUN_004d9bd0 in Wow.exe 12340)
 * raises FORCE_RENAME_CHARACTER instead, and its RenameCharacter (FUN_004d8d20) and the rename
 * answer's handler (FUN_004da090) are what these tests hold the C API to.
 */

const FIXTURE = {
  "Interface/GlueXML/GlueXML.toc": ["## Interface: 30300", "GlueStrings.lua", "GlueParent.xml"].join("\n"),
  "Interface/GlueXML/GlueStrings.lua": `
    GlueScreenInfo = {};
    SEEN = {};
    CHAR_RENAME_IN_PROGRESS = "Переименование персонажа...";
    function SetGlueScreen(name) end
  `,
  "Interface/GlueXML/GlueParent.xml": `<Ui>
    <Frame name="GlueParent" setAllPoints="true">
      <Scripts>
        <OnLoad>
          self:RegisterEvent("FORCE_RENAME_CHARACTER");
          self:RegisterEvent("OPEN_STATUS_DIALOG");
          self:RegisterEvent("CLOSE_STATUS_DIALOG");
          self:RegisterEvent("CHARACTER_LIST_UPDATE");
        </OnLoad>
        <OnEvent>SEEN[#SEEN + 1] = event .. " / " .. tostring(arg1) .. " / " .. tostring(arg2);</OnEvent>
      </Scripts>
    </Frame>
  </Ui>`,
};

/**
 * The canned three characters, the second one marked for a new name, and a world whose answer to
 * CMSG_CHAR_RENAME the test hands over when it chooses.
 */
async function renameStage() {
  const canned = fakeGlueSession("charselect");
  const base = await (await canned.connect()).characters();
  let characters = base.map((character, at) => (at === 1 ? { ...character, flags: character.flags | 0x4000 } : character));
  const renames = [];
  const entered = [];
  let answer;
  const world = {
    characters: async () => characters.map((character) => ({ ...character })),
    deleteCharacter: async () => 71,
    renameCharacter: (guid, name) => {
      renames.push([guid, name]);
      return new Promise((resolve) => { answer = resolve; });
    },
    close: () => {},
  };
  const runtime = new GlueRuntime({
    provider: createFixtureProvider(FIXTURE),
    api: {
      locale: "ruRU",
      session: { connect: async () => world },
      enterWorld: (request) => entered.push([request.index, request.character.name]),
    },
  });
  await runtime.load();
  runtime.session.beginSession(canned.auth);
  await runtime.session.connect(canned.realm);
  const lua = (source) => {
    runtime.vm.setGlobal("__result", undefined);
    const outcome = runtime.vm.execute(`__result = (function() ${source} end)()`, "@glue-rename-probe");
    assert.equal(outcome.ok, true, `${source}: ${outcome.error ?? ""}`);
    return runtime.vm.getGlobal("__result");
  };
  const seen = () => {
    const text = lua('return table.concat(SEEN, "\\n")');
    return typeof text === "string" && text ? text.split("\n") : [];
  };
  const clearSeen = () => lua("SEEN = {}; return 1");
  const settle = async () => {
    for (let round = 0; round < 6; round++) await new Promise((resolve) => setImmediate(resolve));
  };
  clearSeen();
  return {
    runtime, lua, seen, clearSeen, settle, renames, entered, base,
    answer: (result) => answer(result),
    rename: (at, name) => { characters = characters.map((character, index) => (index === at ? { ...character, name, flags: character.flags & ~0x4000 } : character)); },
  };
}

test("EnterWorld on a character marked for a new name opens the rename dialog instead of the world", async () => {
  const stage = await renameStage();
  try {
    stage.lua("SelectCharacter(2); return 1");
    stage.clearSeen();
    stage.lua("EnterWorld(); return 1");
    assert.deepEqual(stage.entered, [], "the host is not asked to enter the world");
    // The event carries the key, and CharacterSelect.lua:286-289 prints `_G[message]`.
    assert.deepEqual(stage.seen(), ["FORCE_RENAME_CHARACTER / CHAR_RENAME_DESCRIPTION / nil"]);

    stage.lua("SelectCharacter(1); return 1");
    stage.lua("EnterWorld(); return 1");
    assert.deepEqual(stage.entered, [[1, "Аларин"]], "an unmarked character still goes in");
  } finally {
    stage.runtime.close();
  }
});

test("RenameCharacter sends the name, answers true so the dialog hides, and shows the refusal", async () => {
  const stage = await renameStage();
  try {
    stage.lua("SelectCharacter(2); return 1");
    stage.clearSeen();
    assert.equal(stage.lua('return RenameCharacter(2, "  Ана ")'), true);
    assert.deepEqual(stage.renames, [[stage.base[1].guid, "Ана"]]);
    assert.deepEqual(stage.seen(), ["OPEN_STATUS_DIALOG / CANCEL / Переименование персонажа..."]);

    // FUN_004da090: every refusal but a name in use is the screen's own CHAR_RENAME_FAILED.
    stage.clearSeen();
    stage.answer({ result: 89 });
    await stage.settle();
    assert.deepEqual(stage.seen(), [
      "CLOSE_STATUS_DIALOG / nil / nil",
      "FORCE_RENAME_CHARACTER / CHAR_RENAME_FAILED / nil",
    ]);

    stage.clearSeen();
    assert.equal(stage.lua('return RenameCharacter(2, "Аларин")'), true);
    stage.answer({ result: 50 });
    await stage.settle();
    assert.deepEqual(stage.seen().slice(1), [
      "CLOSE_STATUS_DIALOG / nil / nil",
      "FORCE_RENAME_CHARACTER / CHAR_CREATE_NAME_IN_USE / nil",
    ]);
    assert.deepEqual(stage.entered, []);
  } finally {
    stage.runtime.close();
  }
});

test("a successful rename rereads the list and carries on into the world, as the client does", async () => {
  const stage = await renameStage();
  try {
    stage.lua("SelectCharacter(2); return 1");
    assert.equal(stage.lua('return RenameCharacter(2, "Ана")'), true);
    stage.clearSeen();
    stage.rename(1, "Ана");
    stage.answer({ result: 0, guid: stage.base[1].guid, name: "Ана" });
    await stage.settle();
    assert.deepEqual(stage.seen(), [
      "CLOSE_STATUS_DIALOG / nil / nil",
      "CHARACTER_LIST_UPDATE / nil / nil",
    ], "no rename dialog again");
    assert.equal(stage.lua("return (GetCharacterInfo(2))"), "Ана");
    // FUN_004da090 → FUN_004d9bd0: the renamed character, still selected, enters the world.
    assert.deepEqual(stage.entered, [[2, "Ана"]]);
  } finally {
    stage.runtime.close();
  }
});

test("RenameCharacter refuses what it can see is wrong without sending anything", async () => {
  const stage = await renameStage();
  try {
    stage.lua("SelectCharacter(2); return 1");
    stage.clearSeen();
    // FUN_004d8d20 checks the name itself first; a refusal keeps the dialog up with its reason.
    assert.equal(stage.lua('return RenameCharacter(2, "   ")'), false);
    assert.equal(stage.lua('return RenameCharacter(2, "А")'), false);
    assert.equal(stage.lua('return RenameCharacter(9, "Ана")'), false);
    assert.deepEqual(stage.seen(), [
      "FORCE_RENAME_CHARACTER / CHAR_NAME_NO_NAME / nil",
      "FORCE_RENAME_CHARACTER / CHAR_NAME_TOO_SHORT / nil",
      "FORCE_RENAME_CHARACTER / CHAR_RENAME_FAILED / nil",
    ]);
    assert.deepEqual(stage.renames, []);
  } finally {
    stage.runtime.close();
  }
});

test("cancelling the rename's status dialog drops the answer that arrives after it", async () => {
  const stage = await renameStage();
  try {
    stage.lua("SelectCharacter(2); return 1");
    assert.equal(stage.lua('return RenameCharacter(2, "Ана")'), true);
    // The CANCEL dialog's button: GlueDialog.lua runs StatusDialogClick().
    stage.lua("StatusDialogClick(); return 1");
    stage.clearSeen();
    stage.answer({ result: 89 });
    await stage.settle();
    assert.deepEqual(stage.seen(), [], "no dialog for an answer nobody is waiting for");
    assert.deepEqual(stage.entered, []);
  } finally {
    stage.runtime.close();
  }
});

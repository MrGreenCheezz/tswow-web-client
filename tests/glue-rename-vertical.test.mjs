import assert from "node:assert/strict";
import test from "node:test";

// The client's own CharacterSelect.lua/.xml out of the MPQ chain: the rename dialog as the corpus
// draws it, driven through the same C API the screen calls. A machine without the client skips.
let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

test("the stock rename dialog opens for a marked character and its OK sends the new name", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { GlueRuntime } = await import("../dist/code/browser/glue/GlueRuntime.js");
  const { fakeGlueSession } = await import("../dist/code/browser/glue/GlueFakeSession.js");
  const chain = await clientArchives(clientDirectory);
  const canned = fakeGlueSession("charselect");
  const base = await (await canned.connect()).characters();
  // The second character carries CHARACTER_FLAG_RENAME, as the core lists one with AT_LOGIN_RENAME.
  const characters = base.map((character, at) => (at === 1 ? { ...character, flags: character.flags | 0x4000 } : character));
  const renames = [];
  const entered = [];
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
      session: {
        connect: async () => ({
          characters: async () => characters.map((character) => ({ ...character })),
          deleteCharacter: async () => 71,
          renameCharacter: async (guid, name) => { renames.push([guid, name]); return { result: 89 }; },
          close: () => {},
        }),
      },
      enterWorld: (request) => entered.push(request.index),
    },
  });
  const lua = (source) => {
    runtime.vm.setGlobal("__result", undefined);
    const outcome = runtime.vm.execute(`__result = (function() ${source} end)()`, "@glue-rename-vertical");
    assert.equal(outcome.ok, true, `${source}: ${outcome.error ?? ""}`);
    return runtime.vm.getGlobal("__result");
  };
  try {
    await runtime.load();
    runtime.session.beginSession(canned.auth);
    await runtime.session.connect(canned.realm);
    assert.equal(runtime.api.setGlueScreen("charselect"), true);
    lua("CharacterSelect_SelectCharacter(2); return 1");
    assert.equal(lua("return CharacterSelect.selectedIndex"), 2);

    // The screen's own Enter World button.
    lua("CharacterSelect_EnterWorld(); return 1");
    assert.deepEqual(luaErrors, [], "unhandled Lua errors while asking for a new name");
    assert.deepEqual(entered, []);
    const dialog = runtime.bridge.getFrame("CharacterRenameDialog");
    const text = runtime.bridge.getFrame("CharacterRenameText1");
    assert.equal(dialog?.visible, true, "CharacterRenameDialog is shown");
    assert.equal(text?.text, runtime.vm.globalString("CHAR_RENAME_DESCRIPTION"));

    // OK with a name: the dialog's own OnClick calls RenameCharacter(selectedIndex, text).
    lua('CharacterRenameEditBox:SetText("Ана"); CharacterRenameButton1:Click(); return 1');
    assert.deepEqual(renames, [[characters[1].guid, "Ана"]]);
    assert.equal(dialog?.visible, false, "RenameCharacter answered true, so the stock OnClick hid it");

    // The core refuses (89): FORCE_RENAME_CHARACTER brings the dialog back with CHAR_RENAME_FAILED.
    for (let round = 0; round < 6; round++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(luaErrors, []);
    assert.equal(dialog?.visible, true);
    assert.equal(text?.text, runtime.vm.globalString("CHAR_RENAME_FAILED"));
  } finally {
    runtime.close();
    chain.close();
  }
});

import assert from "node:assert/strict";
import test from "node:test";

// 3.46 (15.11, lane misc8): a rename moves the character's own WTF folder to the new name (Wow.exe 0x4da090 →
// 0x4e2870: MoveFile of WTF\Account\<A>\<realm>\<old>, then the add-on state tables re-read) — here the browser's
// per-character AddOns.txt and saved variables; a folder already under the new name stops the move.
const { moveGlueCharacterFolder } = await import("../dist/code/browser/glue/GlueCharacterRename.js");
const { GlueAddonList, GLUE_ADDONS_STORAGE_PREFIX, glueWorldAddonStates } = await import("../dist/code/browser/glue/GlueAddons.js");

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

const addonsKey = (character, realm = "Мир") => JSON.stringify([GLUE_ADDONS_STORAGE_PREFIX, "ACCOUNT", realm, character]);
// framexml/FrameXmlSavedVariables.ts's v2 key (tests/framexml-saved-variables.test.mjs pins the same form).
const svKey = (character, name = "MyDB", realm = "Мир") => JSON.stringify(["webclient-addon-v2", "ACCOUNT", realm, character, "myaddon", name]);

test("the old name's folder moves to the new name; the account's and other realms' entries stay", () => {
  const storage = memoryStorage({
    [addonsKey("Артас")]: "MyAddon: disabled\r\n",
    [svKey("Артас")]: "{\"v\":1}",
    [svKey(null, "MyGlobalDB")]: "{\"v\":2}",
    [svKey("Артас", "MyDB", "Другой мир")]: "{\"v\":3}",
    [addonsKey("Джайна")]: "MyAddon: enabled\r\n",
  });
  assert.equal(moveGlueCharacterFolder(storage, "account", "Мир", "Артас", "Артемида"), true);
  assert.deepEqual([...storage.map.keys()].sort(), [
    addonsKey("Артемида"), svKey("Артемида"), svKey(null, "MyGlobalDB"), svKey("Артас", "MyDB", "Другой мир"), addonsKey("Джайна"),
  ].sort());
  assert.equal(storage.getItem(svKey("Артемида")), "{\"v\":1}");
});

test("a folder already under the new name stops the move, as MoveFile onto an existing folder fails", () => {
  const storage = memoryStorage({ [svKey("Артас")]: "old", [addonsKey("Артемида")]: "MyAddon: enabled\r\n" });
  assert.equal(moveGlueCharacterFolder(storage, "ACCOUNT", "Мир", "Артас", "Артемида"), false);
  assert.equal(storage.getItem(svKey("Артас")), "old");
  assert.equal(storage.getItem(svKey("Артемида")), null);
});

test("the add-on states follow the renamed character in the glue's list", async () => {
  const storage = memoryStorage({ [addonsKey("Артас")]: "MyAddon: disabled\r\n" });
  let characters = ["Артас"];
  const list = new GlueAddonList({
    load: async () => ({ installed: [{ name: "MyAddon", enabled: true, loadOnDemand: false }], checkAddonVersion: false }),
    storage,
    identity: () => ({ account: "account", realm: "Мир", characters }),
  });
  await list.load();
  list.handOver("Артас");
  characters = ["Артемида"];
  list.renameCharacter("Артас", "Артемида");
  assert.equal(storage.getItem(addonsKey("Артемида")), "MyAddon: disabled\r\n");
  assert.equal(storage.getItem(addonsKey("Артас")), null);
  list.handOver("Артемида");
  assert.equal(glueWorldAddonStates()?.enabled.get("myaddon"), false, "the add-on stays off for the renamed character");
});

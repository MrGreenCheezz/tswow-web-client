import assert from "node:assert/strict";
import test from "node:test";

// The chat keys against a key table the player already saved. `/` (openChatSlash) and `R`
// (replyWhisper) are newer than any table saved before the stock chat took Enter, and walking used
// to sit on `/`: a saved table has to lose its old default there and keep every key it chose.
const { DEFAULT_BINDINGS, INPUT_ACTIONS, actionFor, bindingsOf, useBindingStorage } =
  await import("../dist/code/browser/input/Bindings.js");

const STORAGE_KEY = "webclient.keybindings.v1";

function fakeStorage(seed) {
  const values = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    read: (key) => values.get(key),
  };
}

/** What `persist` wrote before openChatSlash and replyWhisper existed: every action, walk on `/`. */
function savedBeforeTheChange() {
  const table = {};
  for (const { action } of INPUT_ACTIONS) table[action] = [...DEFAULT_BINDINGS[action]];
  table.toggleWalkRun = ["Slash", ""];
  delete table.openChatSlash;
  delete table.replyWhisper;
  return table;
}

test.after(() => useBindingStorage(fakeStorage()));

test("a table saved before `/` opened the chat moves walking off `/`", () => {
  const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify(savedBeforeTheChange()) });
  useBindingStorage(storage);
  assert.equal(actionFor("Slash"), "openChatSlash", "the old default walk key is the chat key now");
  assert.equal(actionFor("NumpadDivide"), "toggleWalkRun");
  assert.equal(actionFor("KeyR"), "replyWhisper");
  assert.equal(JSON.parse(storage.read(STORAGE_KEY)).toggleWalkRun[0], "Slash", "loading writes nothing back");
});

test("the newer chat keys never take a key the saved table gives to something else", () => {
  // `R` on a bar slot and the keypad `/` on another: `reindex` lists replyWhisper and walking
  // before the bar, so without the rule both keys changed hands on upgrade.
  const customised = savedBeforeTheChange();
  customised.action5 = ["KeyR", ""];
  customised.action6 = ["NumpadDivide", ""];
  useBindingStorage(fakeStorage({ [STORAGE_KEY]: JSON.stringify(customised) }));
  assert.equal(actionFor("KeyR"), "action5");
  assert.deepEqual([...bindingsOf("replyWhisper")], ["", ""]);
  assert.equal(actionFor("NumpadDivide"), "action6");
  assert.deepEqual([...bindingsOf("toggleWalkRun")], ["", ""], "walking is left unbound rather than taking a saved key");
  assert.equal(actionFor("Slash"), "openChatSlash");
});

test("a walk key the player chose stays theirs", () => {
  // Saved after the change: the table says where `/` goes itself, so walking on `/` is a choice.
  useBindingStorage(fakeStorage({
    [STORAGE_KEY]: JSON.stringify({ toggleWalkRun: ["Slash", ""], openChatSlash: ["", ""] }),
  }));
  assert.equal(actionFor("Slash"), "toggleWalkRun");
  // Saved before the change, but not on the old default.
  useBindingStorage(fakeStorage({
    [STORAGE_KEY]: JSON.stringify({ ...savedBeforeTheChange(), toggleWalkRun: ["KeyZ", "Slash"] }),
  }));
  assert.deepEqual([...bindingsOf("toggleWalkRun")], ["KeyZ", "Slash"]);
  assert.equal(actionFor("Slash"), "toggleWalkRun", "a pair that is not exactly the old default is kept whole");
  assert.deepEqual([...bindingsOf("openChatSlash")], ["", ""], "and the newer chat key yields its `/` to it");
});

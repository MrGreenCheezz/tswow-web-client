import assert from "node:assert/strict";
import test from "node:test";

// 5.37 (11.11): macro action buttons as Wow.exe packs them (0x40000000 | id; a character macro's id 0x1000000+n is
// ACTION_BUTTON_CMACRO 0x41 + n), this client's old 0x40 + 37..54 buttons still read, and the view rebuilt from
// the server's words when the macros change.

const { viewActionButton, wireActionButton, macroIndexOfButton } = await import("../dist/code/browser/ui/MacroButtons.js");
const { parseMacroSlot, macroIdInSlot, macroSlotOfId } = await import("../dist/code/browser/ui/MacroSlot.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");

const CRLF = "\r\n";
const lines = (...rows) => rows.map((row) => row + CRLF).join("");

// Account: Wow.exe ids 2 (slot 2) and 40 (no slot of that number: slot 1). Character: Wow.exe's 0x1000002 (slot 38)
// and a macro this client made at slot 40 before 5.37 (JSON), which is given id 0x1000004.
const account = parseMacroSlot(lines("MACRO 2 \"Two\" X", "END", "MACRO 40 \"Forty\" X", "END"), false);
const character = parseMacroSlot('[{"index":38,"name":"Mine","body":"/m"},{"index":40,"name":"Made here","body":"/h"}]', true);
const lookup = {
  indexOfId: (id) => macroSlotOfId(account, id) ?? macroSlotOfId(character, id),
  idAt: (index) => macroIdInSlot(index <= 36 ? account : character, index),
};

test("Wow.exe's buttons read as the macro they name", () => {
  assert.deepEqual(viewActionButton({ slot: 0, action: 2, type: 0x40 }, lookup), { slot: 0, action: 2, type: 0x40 });
  assert.deepEqual(viewActionButton({ slot: 1, action: 40, type: 0x40 }, lookup), { slot: 1, action: 1, type: 0x40 },
    "account id 40 is the macro in slot 1; Wow.exe's own macro wins over an old character button 40");
  assert.deepEqual(viewActionButton({ slot: 2, action: 2, type: 0x41 }, lookup), { slot: 2, action: 38, type: 0x40 },
    "0x41 + 2 is character id 0x1000002");
  assert.deepEqual(viewActionButton({ slot: 3, action: 5, type: 0x00 }, lookup), { slot: 3, action: 5, type: 0x00 }, "a spell is a spell");
  assert.deepEqual(viewActionButton({ slot: 4, action: 9, type: 0x41 }, lookup), { slot: 4, action: 9, type: 0x41 }, "no such macro: kept as it is");
});

test("this client's buttons go out in Wow.exe's words", () => {
  assert.deepEqual(wireActionButton({ slot: 0, action: 1, type: 0x40 }, lookup), { slot: 0, action: 40, type: 0x40 });
  assert.deepEqual(wireActionButton({ slot: 0, action: 38, type: 0x40 }, lookup), { slot: 0, action: 2, type: 0x41 });
  assert.deepEqual(wireActionButton({ slot: 0, action: 40, type: 0x40 }, lookup), { slot: 0, action: 4, type: 0x41 });
  assert.deepEqual(wireActionButton({ slot: 0, action: 17, type: 0x40 }, lookup), { slot: 0, action: 17, type: 0x40 }, "an empty slot stays");
});

test("an old 0x40 + 37..54 button is the character macro it meant when no Wow.exe account macro has that id", () => {
  const noForty = { ...lookup, indexOfId: (id) => (id === 40 ? undefined : lookup.indexOfId(id)) };
  assert.equal(macroIndexOfButton({ action: 40, type: 0x40 }, noForty), 40);
  // Placed again it is written as Wow.exe's 0x41 + 4.
  assert.deepEqual(wireActionButton(viewActionButton({ slot: 7, action: 40, type: 0x40 }, noForty), noForty), { slot: 7, action: 4, type: 0x41 });
  assert.equal(macroIndexOfButton({ action: 39, type: 0x40 }, noForty), undefined, "no macro in slot 39");
});

test("the world's view is rebuilt from the server's words when the macros change", () => {
  let known = false;
  const late = {
    indexOfId: (id) => (known ? lookup.indexOfId(id) : undefined),
    idAt: (index) => (known ? lookup.idAt(index) : undefined),
  };
  const events = [];
  const world = {
    actionButtons: [{ slot: 2, action: 2, type: 0x41 }],
    actionButtonsWire: [{ slot: 2, action: 2, type: 0x41 }],
    actionButtonCodec: { view: (button) => viewActionButton(button, late), wire: (button) => wireActionButton(button, late) },
    events: { emit: (name) => events.push(name) },
  };
  WorldClient.prototype.reviewActionButtons.call(world);
  assert.deepEqual(events, [], "nothing changed: no event");
  known = true;
  WorldClient.prototype.reviewActionButtons.call(world);
  assert.deepEqual(world.actionButtons, [{ slot: 2, action: 38, type: 0x40 }]);
  assert.deepEqual(world.actionButtonsWire, [{ slot: 2, action: 2, type: 0x41 }], "the server's words are not rewritten");
  assert.deepEqual(events, ["ACTION_BUTTONS_CHANGED"]);
});

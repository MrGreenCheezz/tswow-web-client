import assert from "node:assert/strict";
import test from "node:test";

// The page-wide modifier tracker behind IsShiftKeyDown/IsModifiedClick and MODIFIER_STATE_CHANGED:
// sides from KeyboardEvent.code, the whole state repaired from any event's flags, the click's
// button in the client's numbering, and a lost focus letting go of everything.

const { ModifierTracker, pageModifiers } = await import("../dist/code/browser/input/Modifiers.js");

const held = (tracker) => Object.entries(tracker.state())
  .filter(([key, value]) => key !== "button" && value).map(([key]) => key).join(",");

test("each side of a modifier is its own key, and a change is reported once, in order", () => {
  const tracker = new ModifierTracker();
  const changes = [];
  const stop = tracker.onChange((key, down) => changes.push(`${key}:${down ? 1 : 0}`));
  tracker.key({ type: "keydown", code: "ShiftRight", shiftKey: true, ctrlKey: false, altKey: false });
  // The OS autorepeat of a held key changes nothing.
  tracker.key({ type: "keydown", code: "ShiftRight", shiftKey: true, ctrlKey: false, altKey: false });
  tracker.key({ type: "keydown", code: "AltLeft", shiftKey: true, ctrlKey: false, altKey: true });
  assert.equal(held(tracker), "RSHIFT,LALT");
  tracker.key({ type: "keyup", code: "ShiftRight", shiftKey: false, ctrlKey: false, altKey: true });
  assert.equal(held(tracker), "LALT");
  // A letter carries the state too: Alt was released while the page had no keyup for it.
  tracker.key({ type: "keydown", code: "KeyA", shiftKey: false, ctrlKey: false, altKey: false });
  assert.equal(held(tracker), "");
  assert.deepEqual(changes, ["RSHIFT:1", "LALT:1", "RSHIFT:0", "LALT:0"]);
  stop();
  tracker.key({ type: "keydown", code: "ControlLeft", shiftKey: false, ctrlKey: true, altKey: false });
  assert.equal(changes.length, 4, "an unsubscribed listener hears nothing");
});

test("a click records its button as the client numbers it and repairs the modifiers from its flags", () => {
  const tracker = new ModifierTracker();
  assert.equal(tracker.state().button, 0, "no click yet");
  tracker.pointer({ button: 0, shiftKey: false, ctrlKey: false, altKey: false });
  assert.equal(tracker.state().button, 1, "BUTTON1 is the left button");
  tracker.pointer({ button: 2, shiftKey: false, ctrlKey: false, altKey: false });
  assert.equal(tracker.state().button, 2, "BUTTON2 is the right one");
  tracker.pointer({ button: 1, shiftKey: false, ctrlKey: false, altKey: false });
  assert.equal(tracker.state().button, 3, "BUTTON3 the middle");
  // Shift held with no keydown seen (pressed before the page had focus): the left side stands in.
  tracker.pointer({ button: 0, shiftKey: true, ctrlKey: false, altKey: false });
  assert.equal(held(tracker), "LSHIFT");
  tracker.release();
  assert.equal(held(tracker), "", "a lost focus lets go of everything");
});

test("without a window the page tracker exists and holds nothing", () => {
  const page = pageModifiers();
  assert.equal(page, pageModifiers(), "one tracker per page");
  assert.equal(held(page), "");
  assert.equal(page.state().button, 0);
});

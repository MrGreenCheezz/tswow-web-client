// 5.17 (11.11): CURSOR_UPDATE on a change of what the pointer shows (input/HardwareCursor.ts; Wow.exe 0x00616800,
// 0x00616830, 0x00616920 raise event 0x113) and SetCursor's nil for a new path that does not load (0x00616830 via
// 0x005104A0), framexml/FrameXmlSetCursor.ts.
import assert from "node:assert/strict";
import test from "node:test";

globalThis.document = {
  body: { classList: { add() {}, remove() {} } },
  documentElement: { style: { setProperty() {}, removeProperty() {} } },
  addEventListener() {},
};
globalThis.fetch = async () => ({ ok: false, status: 404 });

const cursors = await import("../dist/code/browser/input/Cursors.js");
const hardware = await import("../dist/code/browser/input/HardwareCursor.js");
const setCursor = await import("../dist/code/browser/framexml/FrameXmlSetCursor.js");
cursors.useCursorPictures((path) => `http://gateway.invalid/texture/${path}`);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("one CURSOR_UPDATE per change of the shown cursor, whichever side changes it", () => {
  let updates = 0;
  const stop = hardware.onHardwareCursorChange(() => { updates++; });
  try {
    hardware.setWorldCursor("Speak");
    assert.equal(updates, 1, "the hover over an NPC");
    hardware.setWorldCursor("Speak");
    assert.equal(updates, 1, "the same cursor again: nothing (0x00616800 compares the id)");
    setCursor.frameXmlSetCursor("INSPECT_CURSOR");
    assert.equal(updates, 2, "SetCursor over the interface");
    hardware.setWorldCursor("Attack");
    assert.equal(updates, 2, "the interface's choice is what shows");
    setCursor.frameXmlSetCursor("ATTACK_CURSOR");
    assert.equal(updates, 3);
    setCursor.frameXmlResetCursor();
    assert.equal(updates, 3, "back to the world's Attack: the same cursor, no event");
    hardware.setWorldCursor("");
    assert.equal(updates, 4, "the mode's own");
    assert.equal(hardware.hardwareCursor(), "");
  } finally {
    stop();
  }
});

test("SetCursor answers nil for a new path whose picture is known not to load, 1 for the same path again", async () => {
  assert.deepEqual(setCursor.frameXmlSetCursor("Interface\\Cursor\\Missing"), [1], "not known yet: the picture comes later");
  await settle();
  await settle();
  assert.equal(cursors.cursorPictureFailed(cursors.pathCursorName("Interface\\Cursor\\Missing")), true);
  assert.deepEqual(setCursor.frameXmlSetCursor("interface\\cursor\\MISSING"), [1], "the same path (no case): 1");
  setCursor.frameXmlSetCursor("ATTACK_CURSOR");
  assert.deepEqual(setCursor.frameXmlSetCursor("Interface\\Cursor\\Missing"), [1],
    "a table cursor in between leaves the last path loaded as it was");
  setCursor.frameXmlSetCursor("Interface\\Cursor\\Other");
  assert.deepEqual(setCursor.frameXmlSetCursor("Interface\\Cursor\\Missing"), [undefined], "loaded anew and failed: nil");
  setCursor.frameXmlResetCursor();
});

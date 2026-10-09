// 05.10-5.17: the stock SetCursor/ResetCursor (framexml/FrameXmlSetCursor.ts, Wow.exe 0x005104A0,
// 0x00510920, 0x00616830) and the lock types' cursors from /dbc/locks?v=1 (gateway/LockMetadata.ts,
// browser/LockClient.ts, tools/dbd/LockType.dbd).
import assert from "node:assert/strict";
import test from "node:test";

/** Just enough of a document for the class, the variable and the world canvas's pointerover. */
function fakeDocument() {
  const classes = new Set();
  const props = new Map();
  const listeners = [];
  return {
    classes, props, listeners,
    body: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } },
    documentElement: {
      style: {
        setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k),
        getPropertyValue: (k) => props.get(k) ?? "",
      },
    },
    addEventListener: (type, listener) => listeners.push([type, listener]),
    over(id) { for (const [type, listener] of listeners) if (type === "pointerover") listener({ target: { id } }); },
  };
}

const doc = fakeDocument();
globalThis.document = doc;
const setCursor = await import("../dist/code/browser/framexml/FrameXmlSetCursor.js");
const cursors = await import("../dist/code/browser/input/Cursors.js");
const seam = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

test("a table name selects its cursor and answers 1; nil or a table resets and answers nothing", () => {
  assert.deepEqual(setCursor.frameXmlSetCursor("INSPECT_CURSOR"), [1]);
  assert.equal(setCursor.frameXmlChosenCursor(), "Inspect");
  assert.deepEqual(setCursor.frameXmlSetCursor("cast_error_cursor"), [1], "compared without case");
  assert.equal(setCursor.frameXmlChosenCursor(), "UnableCast");
  assert.deepEqual(setCursor.frameXmlSetCursor("VEHICLE_CURSOR"), [1]);
  assert.equal(setCursor.frameXmlChosenCursor(), "vehichleCursor");
  assert.deepEqual(setCursor.frameXmlSetCursor(undefined), []);
  assert.equal(setCursor.frameXmlChosenCursor(), undefined);
  setCursor.frameXmlSetCursor("BUY_CURSOR");
  assert.deepEqual(setCursor.frameXmlSetCursor({}), []);
  assert.equal(setCursor.frameXmlChosenCursor(), undefined);
  setCursor.frameXmlSetCursor("BUY_CURSOR");
  assert.deepEqual(setCursor.frameXmlResetCursor(), []);
  assert.equal(setCursor.frameXmlChosenCursor(), undefined);
});

test("any other string is a file path of its own, read as given with .blp added", () => {
  assert.deepEqual(setCursor.frameXmlSetCursor("Interface\\CURSOR\\Driver"), [1]);
  const key = setCursor.frameXmlChosenCursor();
  assert.equal(key, cursors.pathCursorName("Interface\\CURSOR\\Driver"));
  assert.equal(cursors.cursorTexturePath(key), "Interface\\CURSOR\\Driver.blp");
  assert.equal(cursors.cursorTexturePath(cursors.pathCursorName("Interface\\Cursor\\Point.blp")), "Interface\\Cursor\\Point.blp");
  assert.equal(cursors.cursorTexturePath("Point"), "Interface\\Cursor\\Point.blp", "table files unchanged");
  setCursor.frameXmlSetCursor("UI-Cursor-Size");
  assert.equal(setCursor.frameXmlChosenCursor(), cursors.pathCursorName("UI-Cursor-Size"), "not Interface\\Cursor\\UI-Cursor-Size");
  setCursor.frameXmlResetCursor();
});

test("the choice is drawn over the stock interface and ends when the pointer reaches the world", () => {
  setCursor.frameXmlSetCursor("ATTACK_CURSOR");
  assert.equal(doc.classes.has("framexml-set-cursor"), true);
  // No pictures in this test: the keyword stands in (input/Cursors.ts fallbackFor).
  assert.equal(doc.props.get("--framexml-set-cursor"), "pointer");
  doc.over("framexml-world-stage");
  assert.equal(setCursor.frameXmlChosenCursor(), "Attack", "over the interface it stays");
  doc.over("world-canvas");
  assert.equal(setCursor.frameXmlChosenCursor(), undefined);
  assert.equal(doc.classes.has("framexml-set-cursor"), false);
  assert.equal(doc.props.has("--framexml-set-cursor"), false);
});

test("the seam table answers SetCursor/ResetCursor with these, over the bank's inert ResetCursor", () => {
  const table = seam.FRAMEXML_SEAM_BINDINGS;
  assert.deepEqual(table.SetCursor({}, ["MAIL_CURSOR"]), [1]);
  assert.equal(setCursor.frameXmlChosenCursor(), "Mail");
  assert.deepEqual(table.ResetCursor({}, []), []);
  assert.equal(setCursor.frameXmlChosenCursor(), undefined);
});

// 05.10 review: the choice belonged to the interface that made it — the stock UI going away (logout,
// /reload: the seam detached or attached to a new pump) leaves no cursor behind for the next one.
test("detaching or re-attaching the live seam forgets the chosen cursor", async () => {
  const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
  const events = { on: () => () => {}, emit() {} };
  const world = {
    state: { selfGuid: 0x10n, objects: new Map() }, knownSpells: [], auras: new Map(), casts: new Map(),
    cooldownSnapshots: new Map(), itemCooldowns: new Map(), mirrorTimers: new Map(), itemTemplates: new Map(),
    actionButtons: [], aurasFor: () => [], cooldownRemaining: () => 0, cooldownState: () => undefined,
    isActiveMountSpell: () => false, events, targetGuid: undefined, chatLog: [], channels: new Map(),
    names: new Map(), creatureTemplates: new Map(), displayName: () => "",
  };
  const live = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, monotonic: () => 1000,
    globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const pump = { fire: () => 1, now: () => 100 };
  live.attach(pump);
  setCursor.frameXmlSetCursor("INSPECT_CURSOR");
  live.attach({ fire: () => 1, now: () => 100 });
  assert.equal(setCursor.frameXmlChosenCursor(), undefined, "a new interface starts with the mode's own");
  setCursor.frameXmlSetCursor("INSPECT_CURSOR");
  live.detach();
  assert.equal(setCursor.frameXmlChosenCursor(), undefined);
  assert.equal(doc.classes.has("framexml-set-cursor"), false);
});

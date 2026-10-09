// Plan item 3.32: the four extra action bars live on the server. Wow.exe's SetActionBarToggles
// (0x5a8290) packs its first four arguments into one byte (bit i = bar i + 1) and sends
// CMSG_SET_ACTIONBAR_TOGGLES (0x2BF) on every call; GetActionBarToggles (0x5a8790) reads the
// player's PLAYER_FIELD_BYTES byte 2, where the core stores that byte (MiscHandler.cpp:1018-1031).
import assert from "node:assert/strict";
import test from "node:test";

const { createFrameXmlOptionsModel, FRAMEXML_OPTIONS_BINDINGS, actionBarToggleBits } =
  await import("../dist/code/browser/framexml/FrameXmlOptions.js");
const { createFrameXmlSettingsCVar } = await import("../dist/code/browser/framexml/FrameXmlSettingsCVar.js");
const { defaultSettings } = await import("../dist/code/browser/ui/SettingsModel.js");
const { buildSetActionBarToggles } = await import("../dist/code/world/ActionBarProtocol.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

function settings(overrides = {}) {
  let values = { ...defaultSettings(), ...overrides };
  const writes = [];
  const cvars = createFrameXmlSettingsCVar({
    getSettings: () => values,
    setSetting: (id, value) => { writes.push([id, value]); values = { ...values, [id]: value }; },
  });
  return { cvars, writes, values: () => values };
}

test("the packet is one byte of the four bar bits", () => {
  assert.deepEqual([...buildSetActionBarToggles(0x05)], [0x05]);
  assert.deepEqual([...buildSetActionBarToggles(0x0a)], [0x0a]);
  assert.deepEqual([...buildSetActionBarToggles(0)], [0]);
  assert.equal(actionBarToggleBits([true, false, false, false]), 0x01, "bottom left is bit 0");
  assert.equal(actionBarToggleBits([false, true, false, false]), 0x02, "bottom right is bit 1");
  assert.equal(actionBarToggleBits([false, false, true, false]), 0x04, "right is bit 2");
  assert.equal(actionBarToggleBits([false, false, false, true]), 0x08, "right two is bit 3");
});

test("SetActionBarToggles sends the byte on every call and writes only changed settings", () => {
  const { cvars, writes, values } = settings();
  const sent = [];
  let byte;
  const model = createFrameXmlOptionsModel(cvars, { toggles: () => byte, send: (bits) => sent.push(bits) });
  const seam = { options: model };
  FRAMEXML_OPTIONS_BINDINGS.SetActionBarToggles(seam, [1, nil(), nil(), nil(), 1]);
  assert.deepEqual(sent, [], "the server's byte is not known yet: the browser settings are not sent over it");
  assert.equal(values().actionBarBottomLeft, true, "the settings are still written");
  byte = 0x01;
  FRAMEXML_OPTIONS_BINDINGS.SetActionBarToggles(seam, [1, nil(), "1", "0", 1]);
  assert.deepEqual(sent, [0x05]);
  assert.equal(values().actionBarBottomLeft, true);
  assert.equal(values().actionBarRight, true);
  const settingWrites = writes.length;
  FRAMEXML_OPTIONS_BINDINGS.SetActionBarToggles(seam, [1, nil(), 1, nil()]);
  assert.deepEqual(sent, [0x05, 0x05], "Wow.exe sends even when nothing changed");
  assert.equal(writes.length, settingWrites, "the settings are not rewritten");
});

test("GetActionBarToggles answers the server byte once known, the settings before", () => {
  const { cvars } = settings({ actionBarBottomLeft: true });
  let byte;
  const model = createFrameXmlOptionsModel(cvars, { toggles: () => byte, send: () => {} });
  const seam = { options: model };
  assert.deepEqual(FRAMEXML_OPTIONS_BINDINGS.GetActionBarToggles(seam, []), [true, false, false, false]);
  byte = 0x0a;
  assert.deepEqual(FRAMEXML_OPTIONS_BINDINGS.GetActionBarToggles(seam, []), [false, true, false, true],
    "the server wins over the browser settings");
  byte = 0;
  assert.deepEqual(FRAMEXML_OPTIONS_BINDINGS.GetActionBarToggles(seam, []), [false, false, false, false]);
});

test("the live seam reads PLAYER_FIELD_BYTES byte 2 and sends through the world", () => {
  const selfGuid = 0x10n;
  const fields = new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, (1 << 8) | (1 << 24)]]);
  const sent = [];
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, { guid: selfGuid, fields }]]) },
    actionButtons: [], casts: new Map(), cooldownRemaining: () => 0,
    setActionBarToggles: (bits) => sent.push(bits),
  };
  const { cvars } = settings({ actionBarRight: true });
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {},
    targetGuid: () => undefined, settingsCVar: cvars,
  });
  const get = () => [...FRAMEXML_SEAM_BINDINGS.GetActionBarToggles(seam, [])];
  assert.deepEqual(get(), [false, false, true, false], "no field yet: the settings");
  // Byte 2 = 0x09, with neighbouring bytes and a stray high bit that are not bars.
  fields.set(UPDATE_FIELDS.PLAYER_FIELD_BYTES.offset, 0x7f | (0x19 << 16) | (0x33 << 24));
  assert.deepEqual(get(), [true, false, false, true]);
  FRAMEXML_SEAM_BINDINGS.SetActionBarToggles(seam, [nil(), 1, nil(), nil(), nil()]);
  assert.deepEqual(sent, [0x02]);
});

function nil() { return undefined; }

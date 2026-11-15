import assert from "node:assert/strict";
import test from "node:test";

// widgets9 (15.11): the input bits by constructor (Wow.exe 0x00970520, 0x0096be50, 0x0096df30, 0x00966b70; getters
// 0x004a1060 / 0x004a0f60), GetTexCoord (0x0048c7f0, defaults 0x00484470), Set/GetPushedTextOffset (0x00977f60 /
// 0x00978040, default 0x00970520), ColorSelect's HSV (0x00970f50 / 0x00970fd0, 0x00984f60 / 0x00985030, default
// 0x0096df30), RegisterAllEvents (0x0049f0e0), GetSpellTexture's weapon icons (0x0053dc20 → 0x005a84d0 / 0x005a85e0)
// and UploadSettings/DownloadSettings (0x006b9c60 / 0x006b9ca0).
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { GlueWidgetBinder } = await import("../dist/code/browser/glue/GlueWidgets.js");
const { FrameXmlUiBridge } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlRuntime.js");
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { frameXmlSpellWeaponIcon } = await import("../dist/code/browser/framexml/FrameXmlSpellWeaponIcon.js");
const { registerAccountDataFlush } = await import("../dist/code/browser/AccountDataFlush.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function fixture() {
  const vm = new GlueLuaVm();
  const bridge = new FrameXmlUiBridge();
  const binder = new GlueWidgetBinder(vm, bridge);
  bridge.setRuntime(binder);
  vm.registerGlobal("CreateFrame", (args) => [bridge.CreateFrame(
    String(args[0] ?? "Frame"),
    args[1] === undefined ? undefined : String(args[1]),
    args[2],
    args[3] === undefined ? undefined : String(args[3]),
  )]);
  const run = (source) => {
    const result = vm.execute(source, "@widgets9-test");
    assert.equal(result.ok, true, result.error ?? "chunk failed");
  };
  const get = (name) => vm.getGlobal(name);
  return { vm, bridge, run, get };
}

test("input bits: Button, CheckButton, Slider, ColorSelect and EditBox take the mouse from their constructor, a Frame does not", () => {
  const { vm, run, get } = fixture();
  try {
    run(`
      local function m(t) return CreateFrame(t):IsMouseEnabled() end
      local function k(t) return CreateFrame(t):IsKeyboardEnabled() end
      mB, mC, mS, mCS, mE, mF = m("Button"), m("CheckButton"), m("Slider"), m("ColorSelect"), m("EditBox"), m("Frame")
      kB, kE = k("Button"), k("EditBox")
      local b = CreateFrame("Button") b:EnableMouse(false) off = b:IsMouseEnabled()
      b:EnableMouse() on = b:IsMouseEnabled()
      b:EnableMouse(0) zero = b:IsMouseEnabled()
      local f = CreateFrame("Frame") f:EnableKeyboard(true) fk = f:IsKeyboardEnabled()`);
    for (const name of ["mB", "mC", "mS", "mCS", "mE", "kE", "on", "fk"]) assert.equal(get(name), 1, name);
    for (const name of ["mF", "kB", "off", "zero"]) assert.equal(get(name), undefined, name);
  } finally {
    vm.close();
  }
});

test("GetTexCoord: a new texture's corners, both SetTexCoord forms read back in UL, LL, UR, LR order", () => {
  const { vm, run, get } = fixture();
  try {
    run(`
      local t = CreateFrame("Frame"):CreateTexture()
      a = { t:GetTexCoord() }
      t:SetTexCoord(0.25, 0.75, 0.1, 0.9) b = { t:GetTexCoord() }
      t:SetTexCoord(0, 1, 1, 1, 0, 0, 1, 0) c = { t:GetTexCoord() }`);
    void get;
    const list = (name) => Array.from({ length: 8 }, (_, index) => vmIndex(vm, name, index + 1));
    assert.deepEqual(list("a"), [0, 0, 0, 1, 1, 0, 1, 1]);
    assert.deepEqual(list("b"), [0.25, 0.1, 0.25, 0.9, 0.75, 0.1, 0.75, 0.9].map(Math.fround));
    assert.deepEqual(list("c"), [0, 1, 1, 1, 0, 0, 1, 0]);
  } finally {
    vm.close();
  }
});

function vmIndex(vm, table, index) {
  const result = vm.execute(`__v = ${table}[${index}]`, "@widgets9-index");
  assert.equal(result.ok, true);
  return vm.getGlobal("__v");
}

test("PushedTextOffset: the constructor's ±0.001 diagonal units, SetPushedTextOffset's float round trip, its usage error", () => {
  const { vm, run, get } = fixture();
  try {
    run(`
      local b = CreateFrame("Button", "Pushy")
      dx, dy = b:GetPushedTextOffset()
      b:SetPushedTextOffset(1, -1) sx, sy = b:GetPushedTextOffset()
      ok, err = pcall(b.SetPushedTextOffset, b, 1)`);
    // 0.001 × 0.75 × aspect × 1024 / (aspect / √(aspect² + 1)) = 1.28 at 4:3, kept through floats.
    assert.ok(Math.abs(get("dx") - 1.28) < 1e-4 && Math.abs(get("dy") + 1.28) < 1e-4, `${get("dx")}, ${get("dy")}`);
    assert.ok(Math.abs(get("sx") - 1) < 1e-5 && Math.abs(get("sy") + 1) < 1e-5, `${get("sx")}, ${get("sy")}`);
    assert.equal(get("ok"), false);
    assert.match(String(get("err")), /Usage: Pushy:SetPushedTextOffset\(x, y\)/);
  } finally {
    vm.close();
  }
});

test("ColorSelect: white from the constructor, HSV kept as given, SetColorRGB's HSV with −1 for a grey", () => {
  const { vm, run, get } = fixture();
  try {
    run(`
      local c = CreateFrame("ColorSelect")
      r0, g0, b0 = c:GetColorRGB()
      h0, s0, v0 = c:GetColorHSV()
      fired = 0 c:SetScript("OnColorSelect", function(self, r, g, b) fired = fired + 1 fr, fg, fb = r, g, b end)
      c:SetColorHSV(120, 1, 1) h1, s1, v1 = c:GetColorHSV() r1, g1, b1 = c:GetColorRGB()
      c:SetColorRGB(0.5, 0.5, 0.5) h2, s2, v2 = c:GetColorHSV()
      c:SetColorRGB(1, 0, 0) h3, s3, v3 = c:GetColorHSV()`);
    assert.deepEqual([get("r0"), get("g0"), get("b0")], [1, 1, 1]);
    assert.deepEqual([get("h0"), get("s0"), get("v0")], [0, 0, 1]);
    assert.deepEqual([get("h1"), get("s1"), get("v1")], [120, 1, 1]);
    assert.deepEqual([get("r1"), get("g1"), get("b1")], [0, 1, 0]);
    assert.deepEqual([get("fr"), get("fg"), get("fb")], [1, 0, 0], "the last call's colour");
    assert.equal(get("h2"), -1);
    assert.equal(get("s2"), 0);
    assert.ok(Math.abs(get("v2") - 128 / 255) < 1e-6);
    assert.deepEqual([get("h3"), get("s3"), get("v3")], [0, 1, 1]);
    assert.equal(get("fired"), 3);
  } finally {
    vm.close();
  }
});

test("RegisterAllEvents: every dispatched event, less the ones unregistered by name, until UnregisterAllEvents", () => {
  const { vm, bridge, run, get } = fixture();
  try {
    run(`seen = {} T = CreateFrame("Frame") T:SetScript("OnEvent", function(self, e) seen[#seen + 1] = e end)
      T:RegisterAllEvents() T:UnregisterEvent("B_EVENT")`);
    assert.equal(bridge.hasEventListeners("A_EVENT"), true);
    bridge.dispatchEvent("A_EVENT");
    bridge.dispatchEvent("B_EVENT");
    run(`T:RegisterEvent("B_EVENT")`);
    bridge.dispatchEvent("B_EVENT");
    run(`T:UnregisterAllEvents()`);
    bridge.dispatchEvent("A_EVENT");
    run(`n = #seen first, second = seen[1], seen[2]`);
    assert.equal(get("n"), 2);
    assert.deepEqual([get("first"), get("second")], ["A_EVENT", "B_EVENT"]);
  } finally {
    vm.close();
  }
});

test("<PushedTextOffset> in a Button's XML is what GetPushedTextOffset answers", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Scene.xml\nRead.lua",
      "interface/framexml/scene.xml": `<Ui><Button name="Declared"><PushedTextOffset><AbsDimension x="2" y="-3"/></PushedTextOffset></Button></Ui>`,
      "interface/framexml/read.lua": `px, py = Declared:GetPushedTextOffset()`,
    }),
    subset: ["Scene.xml", "Read.lua"], exercise: false,
  });
  await boot.load();
  try {
    assert.ok(Math.abs(boot.vm.getGlobal("px") - 2) < 1e-5, String(boot.vm.getGlobal("px")));
    assert.ok(Math.abs(boot.vm.getGlobal("py") + 3) < 1e-5, String(boot.vm.getGlobal("py")));
  } finally {
    boot.close?.();
  }
});

test("GetSpellTexture's weapon icons: Attack shows the main hand or Spell-Reset, Auto Shot the ranged item but not a thrown one", () => {
  const items = new Map([[1, { itemClass: 2, subClass: 7, icon: "Interface\\Icons\\Sword" }],
    [2, { itemClass: 2, subClass: 2, icon: "Interface\\Icons\\Bow" }], [3, { itemClass: 2, subClass: 16, icon: "Interface\\Icons\\Knife" }]]);
  const player = (slots, flags = {}) => ({
    form: flags.form ?? 0, unitFlags: flags.unitFlags ?? 0, unitFlags2: flags.unitFlags2 ?? 0,
    slotEntry: (slot) => slots[slot], itemKind: (entry) => items.get(entry), itemTexture: (entry) => items.get(entry)?.icon,
  });
  const attack = { effects: [78, 0, 0], attributes: [0, 0, 0] };
  const autoShot = { effects: [2, 0, 0], attributes: [0x2, 0, 0x20] };
  const plain = { effects: [2, 0, 0], attributes: [0x2, 0, 0] };
  assert.equal(frameXmlSpellWeaponIcon(attack, () => player({ 16: 1 })), "Interface\\Icons\\Sword");
  assert.equal(frameXmlSpellWeaponIcon(attack, () => player({})), "Interface\\Buttons\\Spell-Reset");
  assert.equal(frameXmlSpellWeaponIcon(attack, () => player({ 16: 1 }, { unitFlags: 0x200000 })), "Interface\\Buttons\\Spell-Reset");
  assert.equal(frameXmlSpellWeaponIcon(attack, () => player({ 16: 1 }, { form: 1 })), undefined, "a form's AttackIconID is not known here");
  assert.equal(frameXmlSpellWeaponIcon(autoShot, () => player({ 18: 2 })), "Interface\\Icons\\Bow");
  assert.equal(frameXmlSpellWeaponIcon(autoShot, () => player({ 18: 3 })), undefined);
  assert.equal(frameXmlSpellWeaponIcon(autoShot, () => player({ 18: 2 }, { unitFlags2: 0x400 })), undefined);
  assert.equal(frameXmlSpellWeaponIcon(plain, () => player({ 18: 2 })), undefined);
});

test("follow-up: a bar slot with Attack shows the main-hand item's icon and repaints (ACTIONBAR_SLOT_CHANGED) with the weapon", async () => {
  const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
  const { FRAMEXML_SEAM_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const { ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");
  // Fixture ids (not dataset rows): spell 900001 is an Attack-shaped record, items 900101/900102 two weapons.
  const MAIN_HAND = UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + 15 * 2;
  const item = (guid, entry) => ({ guid, typeId: 1, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry]]) });
  const player = { guid: 1n, typeId: 4, fields: new Map([[MAIN_HAND, 7]]) };
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, player], [7n, item(7n, 900101)], [8n, item(8n, 900102)]]) },
    actionButtons: [{ slot: 0, action: 900001, type: ACTION_BUTTON_SPELL }],
    casts: new Map(), cooldownSnapshots: new Map(), itemCooldowns: new Map(), mirrorTimers: new Map(),
    itemTemplates: new Map([[900101, { found: true, entry: 900101, itemClass: 2, subClass: 7 }],
      [900102, { found: true, entry: 900102, itemClass: 2, subClass: 4 }]]),
    cooldownRemaining: () => 0, cooldownState: () => undefined, isActiveMountSpell: () => false,
    events: { on: () => () => {} },
  };
  const icons = { 900101: "Interface\\Icons\\Sword", 900102: "Interface\\Icons\\Mace" };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined,
    spell: (id) => id === 900001 ? { id, name: "Атака", rank: "", iconPath: "Interface\\Icons\\Own", effects: [78, 0, 0], attributes: [0, 0, 0] } : undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    itemTexture: (entry) => icons[entry],
  });
  const fired = [];
  seam.attach({ now: () => 1, fire: (name, ...args) => { fired.push([name, ...args]); return 1; } });
  try {
    seam.tick(1);
    assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetActionTexture(seam, [1])], ["Interface\\Icons\\Sword"]);
    fired.length = 0;
    player.fields.set(MAIN_HAND, 8);
    seam.tick(2);
    assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetActionTexture(seam, [1])], ["Interface\\Icons\\Mace"]);
    assert.ok(fired.some(([name]) => name === FRAMEXML_SEAM_EVENTS.actionSlotChanged), "the bar repaints");
    player.fields.set(MAIN_HAND, 0);
    seam.tick(3);
    assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetActionTexture(seam, [1])], ["Interface\\Buttons\\Spell-Reset"]);
  } finally {
    seam.detach();
  }
});

test("UploadSettings and DownloadSettings send the registered stores' pending writes and answer nothing", () => {
  let calls = 0;
  const unregister = registerAccountDataFlush(() => { calls += 1; });
  try {
    assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.UploadSettings({}, [])], []);
    assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.DownloadSettings({}, [])], []);
    assert.equal(calls, 2);
  } finally {
    unregister();
  }
});

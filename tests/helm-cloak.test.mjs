import assert from "node:assert/strict";
import test from "node:test";

// 6.09 (line A7a): «Показывать шлем / плащ». The packets themselves are `showing-helm.test.mjs`;
// this is the stock C API (InterfaceOptionsPanels.xml:571-645) and the look without the hidden piece.

// `ui/Frames.ts` resolves its DOM handles at import: the fake document of `shapeshift.test.mjs`.
/** The document `self-name.test.mjs` uses: `ui/Dom.ts` resolves its handles once, at import. */
function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      title: "", hidden: false, disabled: false, onerror: null, src: "", id: "", value: "", options: [],
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: {
        add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
        remove(...names) { node.className = node.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
        toggle(name, on) { if (on) this.add(name); else this.remove(name); },
        contains(name) { return node.className.split(" ").includes(name); },
      },
      append(...nodes) { node.children.push(...nodes); },
      prepend(...nodes) { node.children.unshift(...nodes); },
      appendChild(child) { node.children.push(child); return child; },
      replaceChildren(...nodes) { node.children = [...nodes]; },
      remove() {}, focus() {}, blur() {},
      addEventListener() {}, removeEventListener() {},
      setAttribute(name, value) { node[name] = value; },
      getAttribute(name) { return node[name] ?? null; },
      removeAttribute(name) { delete node[name]; },
      querySelector() { return make("div"); }, querySelectorAll() { return []; }, closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }; },
      getContext() { return null; },
    };
    return node;
  };
  return {
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }), createDocumentFragment: () => make("fragment"),
    body: make("body"), documentElement: make("html"), head: make("head"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) {
        node = make("div");
        node.id = id;
        byId.set(id, node);
      }
      return node;
    },
    querySelector() { return make("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

globalThis.document = fakeDocument();
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const {
  FRAMEXML_HELM_CLOAK_BINDINGS, frameXmlShowArgument, liveFrameXmlHelmCloak,
} = await import("../dist/code/browser/framexml/FrameXmlHelmCloak.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_OPTIONS_UNAVAILABLE } = await import("../dist/code/browser/framexml/FrameXmlOptions.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { unitModelFor, visibleEquipmentFor } = await import("../dist/code/browser/ui/Frames.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const HIDE_HELM = 0x400;
const HIDE_CLOAK = 0x800;

function host(flags) {
  const sent = [];
  return { sent, flags, helmCloak: { playerFlags: () => flags, send: (part, show) => sent.push([part, show]) } };
}
const call = (seam, name, ...args) => FRAMEXML_HELM_CLOAK_BINDINGS[name](seam, args);

test("ShowingHelm/ShowingCloak answer 1 while shown and nil while hidden or without a player", () => {
  assert.deepEqual(call(host(0), "ShowingHelm"), [1]);
  assert.deepEqual(call(host(0), "ShowingCloak"), [1]);
  assert.deepEqual(call(host(HIDE_HELM), "ShowingHelm"), [], "Wow.exe 0x0051bfd0 pushes nil, not false");
  assert.deepEqual(call(host(HIDE_HELM), "ShowingCloak"), [1], "bit 10 is the helm's alone");
  assert.deepEqual(call(host(HIDE_CLOAK), "ShowingCloak"), [], "bit 11 (0x0051c040)");
  assert.deepEqual(call(host(HIDE_CLOAK), "ShowingHelm"), [1]);
  assert.deepEqual(call(host(undefined), "ShowingHelm"), [], "no player: nil");
  assert.deepEqual(call({}, "ShowingCloak"), [], "a seam without the host: nil");
});

test("ShowHelm/ShowCloak send only when the flag says otherwise, and never write it", () => {
  const shown = host(0);
  call(shown, "ShowHelm", "1");
  call(shown, "ShowCloak", true);
  assert.deepEqual(shown.sent, [], "already shown: nothing goes out (0x006e0e00 tests the bit first)");
  call(shown, "ShowHelm", "0");
  call(shown, "ShowCloak", false);
  assert.deepEqual(shown.sent, [["helm", false], ["cloak", false]]);

  const hidden = host(HIDE_HELM | HIDE_CLOAK);
  call(hidden, "ShowHelm", "1");
  call(hidden, "ShowCloak", 1);
  call(hidden, "ShowHelm", "0");
  assert.deepEqual(hidden.sent, [["helm", true], ["cloak", true]], "hidden and asked to hide: nothing");

  const nobody = host(undefined);
  call(nobody, "ShowHelm", "0");
  call({}, "ShowCloak", "0");
  assert.deepEqual(nobody.sent, [], "no player: nothing");
});

test("the argument is 0x00815500 with default true: the stock panel's \"0\" is false", () => {
  assert.equal(frameXmlShowArgument("0"), false, "the panel's SetValue passes the string");
  assert.equal(frameXmlShowArgument("1"), true);
  assert.equal(frameXmlShowArgument(undefined), false, "nil is false whatever the default");
  assert.equal(frameXmlShowArgument(null), false);
  assert.equal(frameXmlShowArgument(0), false);
  assert.equal(frameXmlShowArgument(0.5), false, "truncated");
  assert.equal(frameXmlShowArgument(2), true);
  assert.equal(frameXmlShowArgument("no"), false);
  assert.equal(frameXmlShowArgument("false"), false);
  assert.equal(frameXmlShowArgument("yes"), true);
  assert.equal(frameXmlShowArgument("off"), false);
  assert.equal(frameXmlShowArgument("DISABLED"), false);
  assert.equal(frameXmlShowArgument("on"), true);
  assert.equal(frameXmlShowArgument(""), true, "an unknown string is the default");
  assert.equal(frameXmlShowArgument("maybe"), true);
  assert.equal(frameXmlShowArgument({}), true, "a table is the default");
});

test("the seam carries the four functions and the Display panel's two boxes are no longer disabled", () => {
  for (const name of ["ShowHelm", "ShowCloak", "ShowingHelm", "ShowingCloak"]) {
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], FRAMEXML_HELM_CLOAK_BINDINGS[name], name);
  }
  assert.equal(FRAMEXML_OPTIONS_UNAVAILABLE.has("InterfaceOptionsDisplayPanelShowHelm"), false);
  assert.equal(FRAMEXML_OPTIONS_UNAVAILABLE.has("InterfaceOptionsDisplayPanelShowCloak"), false);
});

const SELF_GUID = 0x10n;
function playerObject(guid = SELF_GUID) {
  return { guid, typeId: 4, fields: new Map() };
}
const setField = (object, name, value) => object.fields.set(UPDATE_FIELDS[name].offset, value);

test("the live host reads the active player's PLAYER_FLAGS and sends through WorldClient", () => {
  const self = playerObject();
  const sent = [];
  const world = {
    state: { selfGuid: SELF_GUID, objects: new Map([[SELF_GUID, self]]) },
    setShowingHelm: (show) => sent.push(["helm", show]),
    setShowingCloak: (show) => sent.push(["cloak", show]),
  };
  const live = liveFrameXmlHelmCloak(() => world);
  assert.equal(live.playerFlags(), 0);
  setField(self, "PLAYER_FLAGS", HIDE_CLOAK);
  assert.equal(live.playerFlags(), HIDE_CLOAK);
  live.send("cloak", true);
  live.send("helm", false);
  assert.deepEqual(sent, [["cloak", true], ["helm", false]]);
  assert.equal(liveFrameXmlHelmCloak(() => undefined).playerFlags(), undefined);
  world.state.selfGuid = undefined;
  assert.equal(live.playerFlags(), undefined, "before the player exists");
});

test("LiveWorldSeam: PLAYER_FLAGS_CHANGED(\"player\") on a hide bit, and the C API through the seam", () => {
  const self = playerObject();
  const listeners = new Map();
  const store = {
    events: { on: () => () => {} },
    field(_subject, name, listener) { listeners.set(name, listener); return () => listeners.delete(name); },
  };
  const sent = [];
  const world = {
    state: { selfGuid: SELF_GUID, objects: new Map([[SELF_GUID, self]]) },
    targetGuid: undefined, group: undefined, partyStats: new Map(), raidTargets: new Map(), totems: new Map(),
    casts: new Map(), actionButtons: [], events: { on: () => () => {} }, aurasFor: () => [],
    cooldownState: () => undefined, cooldownRemaining: () => 0, names: new Map(), creatureTemplates: new Map(),
    setShowingHelm: (show) => sent.push(["helm", show]),
    setShowingCloak: (show) => sent.push(["cloak", show]),
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store, spell: () => undefined, focusGuid: () => undefined,
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const fired = [];
  seam.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; }, now: () => 100 });
  try {
    fired.length = 0;
    setField(self, "PLAYER_FLAGS", HIDE_HELM);
    listeners.get("PLAYER_FLAGS")?.(self, SELF_GUID);
    assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.playerFlags, "player"]], "the panel's box re-reads on this");
    assert.deepEqual(FRAMEXML_SEAM_BINDINGS.ShowingHelm(seam, []), []);
    assert.deepEqual(FRAMEXML_SEAM_BINDINGS.ShowingCloak(seam, []), [1]);
    FRAMEXML_SEAM_BINDINGS.ShowHelm(seam, ["1"]);
    FRAMEXML_SEAM_BINDINGS.ShowCloak(seam, ["0"]);
    assert.deepEqual(sent, [["helm", true], ["cloak", false]]);
    fired.length = 0;
    setField(self, "PLAYER_FLAGS", HIDE_HELM | HIDE_CLOAK);
    listeners.get("PLAYER_FLAGS")?.(self, SELF_GUID);
    assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.playerFlags, "player"]], "the cloak bit too");
  } finally {
    seam.detach();
  }
});

// ---- the look: a hidden helm or cloak is not worn (6.09 change 3) -----------------------------

const HEAD_ENTRY = 100;
const CHEST_ENTRY = 200;
const BACK_ENTRY = 300;
function dressed(flags) {
  const player = playerObject(0x20n);
  setField(player, "UNIT_FIELD_DISPLAYID", 49);
  setField(player, "UNIT_FIELD_NATIVEDISPLAYID", 49);
  setField(player, "UNIT_FIELD_BYTES_0", 1 | (1 << 8));
  setField(player, "PLAYER_VISIBLE_ITEM_1_ENTRYID", HEAD_ENTRY);
  setField(player, "PLAYER_VISIBLE_ITEM_5_ENTRYID", CHEST_ENTRY);
  setField(player, "PLAYER_VISIBLE_ITEM_15_ENTRYID", BACK_ENTRY);
  if (flags !== undefined) setField(player, "PLAYER_FLAGS", flags);
  return player;
}
const items = {
  generation: 1,
  rows: new Map([
    [HEAD_ENTRY, { displayId: 1001, inventoryType: 1 }],
    [CHEST_ENTRY, { displayId: 1005, inventoryType: 5 }],
    [BACK_ENTRY, { displayId: 1016, inventoryType: 16 }],
  ]),
  loaded: [],
  get(entry) { return this.rows.get(entry); },
  load(entries) { this.loaded.push(...entries); return Promise.resolve(); },
};
const slotsOf = (equipment) => equipment.map((item) => item.slot).sort((a, b) => a - b);

test("visibleEquipmentFor leaves out slot 0 under HIDE_HELM and slot 14 under HIDE_CLOAK", () => {
  assert.deepEqual(slotsOf(visibleEquipmentFor(dressed(0), items)), [0, 4, 14]);
  assert.deepEqual(slotsOf(visibleEquipmentFor(dressed(HIDE_HELM), items)), [4, 14]);
  assert.deepEqual(slotsOf(visibleEquipmentFor(dressed(HIDE_CLOAK), items)), [0, 4]);
  assert.deepEqual(slotsOf(visibleEquipmentFor(dressed(HIDE_HELM | HIDE_CLOAK | 0x2), items)), [4]);
  items.loaded.length = 0;
  visibleEquipmentFor(dressed(HIDE_HELM), items);
  assert.ok(items.loaded.includes(HEAD_ENTRY), "the hidden row is still loaded, so the look does not wait on it");
  const creature = dressed(HIDE_HELM);
  creature.typeId = 3;
  assert.deepEqual(slotsOf(visibleEquipmentFor(creature, items)), [0, 4, 14], "only a player's flags count");
});

test("unitModelFor does not hand back the old look after the flag changes", () => {
  const asked = [];
  const models = {
    generation: 1,
    get: () => ({ id: 49, model: "Character\\Human\\Male\\HumanMale.m2", scale: 1, collisionHeight: 2, mountHeight: 0, textures: "" }),
    playerAppearance(...args) {
      asked.push(args);
      return { body: [], hair: "", cloak: "", skinExtra: "", geosets: [0], attached: [], worn: slotsOf(args[7]) };
    },
  };
  const player = dressed(0);
  const first = unitModelFor(player, models, items);
  assert.deepEqual(first.appearance.worn, [0, 4, 14]);
  assert.equal(unitModelFor(player, models, items), first, "unchanged fields: the memo answers");
  setField(player, "PLAYER_FLAGS", HIDE_HELM);
  const second = unitModelFor(player, models, items);
  assert.notEqual(second, first, "the flag is part of the memo key");
  assert.deepEqual(second.appearance.worn, [4, 14]);
  assert.equal(asked.at(-1)[8], 1, "the class goes along (6.10)");
  setField(player, "PLAYER_FLAGS", HIDE_HELM | 0x1);
  assert.equal(unitModelFor(player, models, items), second, "a flag that is not a hide bit keeps the memo");
});

// ---- 05.10 review of A7a-A ------------------------------------------------------------------

test("05.10 review: ShowHelm() with no argument is 0x00815500's default (true), an explicit nil is false", () => {
  // 0x00815500 switches on lua_type: LUA_TNONE (-1, past the top) takes the default, LUA_TNIL (0)
  // returns 0 (.runtime/re-2026-10-02/a403-review/d2.c, 0x815500). The bridge's args are lua_gettop long.
  const hidden = host(HIDE_HELM | HIDE_CLOAK);
  call(hidden, "ShowHelm");
  call(hidden, "ShowCloak");
  assert.deepEqual(hidden.sent, [["helm", true], ["cloak", true]], "no argument: show");
  const shown = host(0);
  call(shown, "ShowHelm");
  assert.deepEqual(shown.sent, [], "no argument on a shown helm: nothing");
  call(shown, "ShowHelm", undefined);
  call(shown, "ShowCloak", null);
  assert.deepEqual(shown.sent, [["helm", false], ["cloak", false]], "an explicit nil hides");
});

test("05.10 review: the session warm-up asks for the look unitModelFor asks for (hidden pieces left out)", async () => {
  const { SessionAssetWarmup } = await import("../dist/code/browser/AssetWarmup.js");
  for (const flags of [0, HIDE_HELM, HIDE_CLOAK, HIDE_HELM | HIDE_CLOAK]) {
    const warmed = [];
    const framed = [];
    const metadata = { id: 49, model: "Character\Human\Male\HumanMale.m2", scale: 1, collisionHeight: 2, mountHeight: 0, textures: "" };
    const controller = new SessionAssetWarmup({
      environment: { baseUrl: "http://gateway.test", model() { return undefined; } },
      creatureModels: { request() {}, get: () => metadata, playerAppearance(...args) { warmed.push(args); return undefined; } },
      itemMetadata: items,
      spellVisuals: { get() { return undefined; } },
    }, { now: () => 0 });
    const player = dressed(flags);
    controller.tick({ player, environment: [], actionButtons: [] });
    controller.dispose();
    unitModelFor(player, { generation: 1, get: () => metadata, playerAppearance(...args) { framed.push(args); return undefined; } }, items);
    assert.equal(warmed.length, 1);
    assert.deepEqual(slotsOf(warmed[0][7]), slotsOf(framed[0][7]), `flags 0x${flags.toString(16)}: the same worn list`);
    assert.deepEqual(warmed[0], framed[0], `flags 0x${flags.toString(16)}: the same request`);
  }
});
